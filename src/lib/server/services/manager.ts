// TASK 3.5 — services manager (start/stop/health/auto-restart; DATA-MODEL §4.7).
//
// Manages the lifecycle of the long-lived local services the platform depends on:
// SurrealDB, Ollama, and the engine. Each service plugs in as a `ServiceAdapter`
// (start / stop / health / pid) so the manager stays agnostic of HOW a given
// service is spawned — the SurrealDB adapter wraps the existing SurrealServer
// (db/provision.ts), Ollama/engine wrap their own spawners.
//
// Reconciliation (`tick`): for each registered service the manager asks the OS
// "is the recorded pid still alive?" (Windows-safe `tasklist`, F-001 — NEVER
// process.kill(pid,0)) AND asks the adapter for a health probe. A service that the
// manager believes should be RUNNING but is found dead is:
//   1. recorded `crashed` (service row updated),
//   2. logged as an `incident` row (DATA-MODEL §4.7) + a `notification`,
//   3. auto-restarted via the adapter, then recorded `running` again with the new pid.
// If the restart itself fails, a second (critical) incident is logged and the
// service is left `crashed` for the next tick to retry (bounded by maxRestarts).
//
// Stop is Windows-safe: the adapter's stop() is expected to taskkill //F //PID //T
// (F-002 — shell:true spawn wraps the real binary). The manager's `stop(name)` also
// flips the desired state to "stopped" so the next tick does NOT auto-restart it.
//
// Boundary discipline (D-016): every VALUE binds via $param. The `service` table is
// keyed by a stable record id `service:<name>` (name validated against a strict set),
// upserted so re-ticks update the same row instead of accumulating duplicates.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { isPidAlive } from './proc';
import {
	recordIncident,
	recordNotification,
	type IncidentRow,
	type NotificationRow
} from './incidents';

/** The managed service names (DATA-MODEL §4.7). dashboard = status-only self-report. */
export const SERVICE_NAMES = ['ollama', 'surrealdb', 'engine', 'dashboard'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export type ServiceStatus = 'running' | 'stopped' | 'crashed' | 'unknown';

/**
 * A pluggable service backend. The manager owns the supervision loop; the adapter
 * owns the spawn/kill specifics. `pid()` returns the current OS pid (or null if the
 * adapter has not spawned anything), used for the Windows-safe liveness probe.
 */
export interface ServiceAdapter {
	readonly name: ServiceName;
	/** Spawn (or re-spawn) the service. Resolves once it is accepting connections. */
	start(): Promise<void>;
	/** Stop the service. MUST be Windows-safe (taskkill //F //PID //T — F-002). */
	stop(): Promise<void>;
	/** True if the service is healthy right now (e.g. a ws:// / http probe). */
	health(): Promise<boolean>;
	/** The current OS pid, or null if not running. */
	pid(): number | null;
}

/** A persisted `service` row (SDK shapes coerced to plain JSON). */
export interface ServiceRow {
	id: string;
	name: ServiceName;
	status: ServiceStatus;
	pid?: number;
	checked_at: string;
}

/** What a single reconciliation pass did to one service. */
export interface TickResult {
	name: ServiceName;
	/** True if the manager observed the service dead while it should be running. */
	wasDown: boolean;
	/** True if an auto-restart was attempted this tick. */
	restarted: boolean;
	/** True if the restart succeeded (or the service was already healthy). */
	healthy: boolean;
	/** The incident row written iff the service was found down (else null). */
	incident: IncidentRow | null;
}

export interface ServicesManagerOptions {
	/** Max consecutive auto-restart attempts before giving up (default 3). */
	maxRestarts?: number;
}

interface Entry {
	adapter: ServiceAdapter;
	/** Desired state: true once start()'d via the manager, false once stop()'d. */
	desiredUp: boolean;
	/** Consecutive failed restart attempts (reset on a healthy observation). */
	restartFailures: number;
}

/** Build the stable `service:<name>` record id, validated at the D-016 chokepoint. */
function serviceRecordId(name: ServiceName): StringRecordId {
	return new StringRecordId(assertRecordId(`service:${name}`));
}

function normService(row: { id: unknown; name: ServiceName; status: ServiceStatus; pid?: unknown; checked_at?: unknown }): ServiceRow {
	return {
		id: String(row.id),
		name: row.name,
		status: row.status,
		pid: row.pid != null ? Number(row.pid) : undefined,
		checked_at: row.checked_at != null ? String(row.checked_at) : ''
	};
}

/**
 * Supervises a fixed set of local services. Construct, `register(adapter)`, then
 * `start(name)` to bring one up, and call `tick()` periodically (e.g. from the
 * heartbeat) to reconcile — dead services that should be up are auto-restarted and
 * their crash/recovery recorded as incidents + notifications.
 */
export class ServicesManager {
	private readonly entries = new Map<ServiceName, Entry>();
	private readonly maxRestarts: number;

	constructor(
		private readonly db: Db,
		opts: ServicesManagerOptions = {}
	) {
		this.maxRestarts = opts.maxRestarts ?? 3;
	}

	/** Register a service backend. Replaces any prior adapter for the same name. */
	register(adapter: ServiceAdapter): void {
		this.entries.set(adapter.name, {
			adapter,
			desiredUp: false,
			restartFailures: 0
		});
	}

	/** Start a registered service and mark it desired-up (so ticks supervise it). */
	async start(name: ServiceName): Promise<void> {
		const entry = this.require(name);
		entry.desiredUp = true;
		entry.restartFailures = 0;
		await entry.adapter.start();
		await this.writeService(name, 'running', entry.adapter.pid());
	}

	/** Stop a registered service and mark it desired-down (ticks will NOT restart). */
	async stop(name: ServiceName): Promise<void> {
		const entry = this.require(name);
		entry.desiredUp = false;
		await entry.adapter.stop();
		await this.writeService(name, 'stopped', null);
	}

	/**
	 * Reconcile every desired-up service. Returns a per-service result. A service
	 * that should be up but is found dead (pid gone AND/OR health probe fails) is
	 * recorded crashed, logged (incident + notification), then auto-restarted.
	 */
	async tick(): Promise<TickResult[]> {
		const results: TickResult[] = [];
		for (const [name, entry] of this.entries) {
			if (!entry.desiredUp) continue;
			results.push(await this.reconcile(name, entry));
		}
		return results;
	}

	private async reconcile(name: ServiceName, entry: Entry): Promise<TickResult> {
		const pid = entry.adapter.pid();
		// Windows-safe liveness (F-001) AND an app-level health probe — either being
		// false means the service is effectively down.
		const pidAlive = pid != null ? await isPidAlive(pid) : false;
		const healthy = pidAlive && (await entry.adapter.health());

		if (healthy) {
			entry.restartFailures = 0;
			await this.writeService(name, 'running', pid);
			return { name, wasDown: false, restarted: false, healthy: true, incident: null };
		}

		// Service is DOWN while it should be up → record crash, log, auto-restart.
		await this.writeService(name, 'crashed', null);
		const incident = await recordIncident(this.db, {
			title: `Service "${name}" went down`,
			detail: pid != null
				? `pid ${pid} is no longer alive; auto-restarting (attempt ${entry.restartFailures + 1}/${this.maxRestarts})`
				: `no live pid; auto-restarting (attempt ${entry.restartFailures + 1}/${this.maxRestarts})`,
			severity: 'error'
		});
		await recordNotification(this.db, `Service "${name}" crashed — auto-restarting`);

		if (entry.restartFailures >= this.maxRestarts) {
			// Give-up guard: do not thrash. Leave crashed; surface a critical incident.
			await recordIncident(this.db, {
				title: `Service "${name}" exceeded restart limit`,
				detail: `gave up after ${this.maxRestarts} consecutive restart failures`,
				severity: 'critical'
			});
			return { name, wasDown: true, restarted: false, healthy: false, incident };
		}

		try {
			await entry.adapter.start();
			const newPid = entry.adapter.pid();
			const ok = newPid != null && (await entry.adapter.health());
			if (ok) {
				entry.restartFailures = 0;
				await this.writeService(name, 'running', newPid);
				await recordNotification(this.db, `Service "${name}" recovered`);
				return { name, wasDown: true, restarted: true, healthy: true, incident };
			}
			entry.restartFailures += 1;
			await this.writeService(name, 'crashed', null);
			return { name, wasDown: true, restarted: true, healthy: false, incident };
		} catch (err) {
			entry.restartFailures += 1;
			await recordIncident(this.db, {
				title: `Service "${name}" auto-restart failed`,
				detail: err instanceof Error ? err.message : String(err),
				severity: 'critical'
			});
			await this.writeService(name, 'crashed', null);
			return { name, wasDown: true, restarted: true, healthy: false, incident };
		}
	}

	/** Read the current persisted state of every registered service. */
	async listServices(): Promise<ServiceRow[]> {
		const [rows] = await this.db.query<[ServiceRow[]]>(
			'SELECT * FROM service ORDER BY name ASC;'
		);
		return (rows ?? []).map((r) => normService(r as never));
	}

	/**
	 * Upsert the `service:<name>` row. `pid` is OMITTED (kept NONE) when null so the
	 * `option<int>` column never receives a NULL (§6.1). checked_at = now via UPDATE.
	 */
	private async writeService(name: ServiceName, status: ServiceStatus, pid: number | null): Promise<void> {
		const content: Record<string, unknown> = {
			name,
			status,
			checked_at: new Date()
		};
		if (pid != null) content.pid = pid;
		// UPSERT by stable id so re-ticks mutate the same row (not append). When pid is
		// omitted the prior pid would persist on a plain merge — so we use CONTENT to
		// fully replace the mutable fields, clearing pid back to NONE on stop/crash.
		await this.db.query('UPSERT $id CONTENT $content;', {
			id: serviceRecordId(name),
			content
		});
	}

	private require(name: ServiceName): Entry {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Service "${name}" is not registered.`);
		return entry;
	}
}

export type { IncidentRow, NotificationRow };
