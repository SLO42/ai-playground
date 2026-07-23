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

/**
 * The managed service names (DATA-MODEL §4.7).
 *   • ollama    — a real, distinct process: registered with a live adapter + health probe → fully supervised.
 *   • surrealdb — a real, distinct process: the datastore this server READS THROUGH (observe-only, honest note).
 *   • dashboard — this SvelteKit server process itself (status-only self-report — it cannot act on itself).
 *
 * SVC-2 (SERVICES-SPEC §3) — `engine` was DROPPED. It named the orchestration engine, but that
 * engine runs IN-PROCESS with the dashboard (orchestrator.ts inside this same server) — it is NOT
 * a distinct OS process, has no adapter, no health probe, and nothing ever writes its `service`
 * row in v2. Listing it made the surface claim to manage a service that never existed/was managed;
 * it duplicated `dashboard`. Per the spec's sanctioned fix ("drop the name from SERVICE_NAMES"),
 * it is removed so /services reports only services that actually exist/are supervised (F-008).
 * (DATA-MODEL §4.7's name list is a descriptive comment on a free-string field, not an enforced
 * enum; its doc-comment should drop `engine` to match — tracked as a docs follow-up.)
 */
export const SERVICE_NAMES = ['ollama', 'surrealdb', 'dashboard'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export type ServiceStatus = 'running' | 'stopped' | 'crashed' | 'unknown';

/** An operator-initiated lifecycle action from the control surface (UI-SPEC §210). */
export type ServiceAction = 'start' | 'stop' | 'restart';

/** Past-tense verbs for the operator-action notification message. */
const PAST_TENSE: Record<ServiceAction, string> = {
	start: 'started',
	stop: 'stopped',
	restart: 'restarted'
};

/** The outcome of an operator {@link ServicesManager.operate} call. */
export interface OperateResult {
	name: ServiceName;
	action: ServiceAction;
	/** True if the adapter action succeeded. */
	ok: boolean;
	/** The error message when ok=false (honest — surfaced to the operator). */
	error?: string;
	/** The audit incident row written for this action (info on success, error on failure). */
	incident: IncidentRow;
}

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
	/** ISO instant the service was LAST observed running (14.4b — survives a down-write). */
	last_seen_at?: string;
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

function normService(row: { id: unknown; name: ServiceName; status: ServiceStatus; pid?: unknown; checked_at?: unknown; last_seen_at?: unknown }): ServiceRow {
	return {
		id: String(row.id),
		name: row.name,
		status: row.status,
		pid: row.pid != null ? Number(row.pid) : undefined,
		checked_at: row.checked_at != null ? String(row.checked_at) : '',
		last_seen_at: row.last_seen_at != null ? String(row.last_seen_at) : undefined
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

	/** Is a service registered with a live adapter (so it can be controlled)? */
	has(name: ServiceName): boolean {
		return this.entries.has(name);
	}

	/** The registered service names (those with a live adapter — controllable). */
	registered(): ServiceName[] {
		return [...this.entries.keys()];
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
	 * OPERATOR action: start / stop / restart a service from the control surface
	 * (UI-SPEC §210). Unlike the internal {@link tick} auto-restart (which logs an
	 * `error`/`critical` incident on a CRASH), an operator action logs an `info`
	 * incident + a notification recording WHO/WHAT changed — so the durable
	 * incidents history (UI-SPEC §208) carries an honest audit trail of every manual
	 * lifecycle action, success or failure. Returns the action result; throws ONLY on
	 * an unregistered service (the caller validated the name at the boundary).
	 */
	async operate(name: ServiceName, action: ServiceAction): Promise<OperateResult> {
		this.require(name);
		try {
			if (action === 'start') {
				await this.start(name);
			} else if (action === 'stop') {
				await this.stop(name);
			} else {
				// restart = stop then start, leaving the service desired-up + supervised.
				await this.stop(name);
				await this.start(name);
			}
			const incident = await recordIncident(this.db, {
				title: `Operator ${action} of service "${name}"`,
				detail: `manual ${action} succeeded from the services control surface`,
				severity: 'info'
			});
			await recordNotification(this.db, `Service "${name}" ${PAST_TENSE[action]} by operator`);
			return { name, action, ok: true, incident };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const incident = await recordIncident(this.db, {
				title: `Operator ${action} of service "${name}" failed`,
				detail: message,
				severity: 'error'
			});
			await recordNotification(this.db, `Service "${name}" ${action} failed — ${message}`);
			return { name, action, ok: false, error: message, incident };
		}
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

		// The honest WHY the service is considered down — reused for the incident detail AND
		// the first-class supervision analytics event so both name the same cause (SVC-1).
		const downReason =
			pid == null
				? 'no live pid recorded'
				: !pidAlive
					? `recorded pid ${pid} is not alive (tasklist)`
					: 'process alive but health probe failed';
		const attempt = entry.restartFailures + 1;

		// Service is DOWN while it should be up → record crash, log, auto-restart.
		await this.writeService(name, 'crashed', null);
		const incident = await recordIncident(this.db, {
			title: `Service "${name}" went down`,
			detail: `${downReason}; auto-restarting (attempt ${attempt}/${this.maxRestarts})`,
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
			await this.logSupervision(name, {
				reason: downReason,
				restarted: false,
				healthy: false,
				outcome: 'gave-up',
				attempt,
				maxRestarts: this.maxRestarts
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
				await this.logSupervision(name, {
					reason: downReason,
					restarted: true,
					healthy: true,
					outcome: 'recovered',
					attempt,
					maxRestarts: this.maxRestarts
				});
				return { name, wasDown: true, restarted: true, healthy: true, incident };
			}
			entry.restartFailures += 1;
			await this.writeService(name, 'crashed', null);
			await this.logSupervision(name, {
				reason: downReason,
				restarted: true,
				healthy: false,
				outcome: 'restart-unhealthy',
				attempt,
				maxRestarts: this.maxRestarts
			});
			return { name, wasDown: true, restarted: true, healthy: false, incident };
		} catch (err) {
			entry.restartFailures += 1;
			const message = err instanceof Error ? err.message : String(err);
			await recordIncident(this.db, {
				title: `Service "${name}" auto-restart failed`,
				detail: message,
				severity: 'critical'
			});
			await this.writeService(name, 'crashed', null);
			await this.logSupervision(name, {
				reason: downReason,
				restarted: true,
				healthy: false,
				outcome: 'restart-error',
				attempt,
				maxRestarts: this.maxRestarts,
				error: message
			});
			return { name, wasDown: true, restarted: true, healthy: false, incident };
		}
	}

	/**
	 * SVC-1 — write ONE first-class `agent_event` (type 'supervision') per detected-down +
	 * restart-attempt: which service, WHY it was considered down, and the restart OUTCOME —
	 * a queryable analytics fact (how/why, not a flat event), surfaced alongside the incident
	 * trail. A run-log type (no model/tokens/cost), so it is a raw $param-bound CREATE outside
	 * the priced writeAgentEvent chokepoint — mirroring the m0080 'maintenance' run-log
	 * precedent. BEST-EFFORT (F-014): an analytics-write fault is named + swallowed so a
	 * supervision fault can never crash the tick; the incident/notification trail already
	 * carries the durable record if this ever fails.
	 */
	private async logSupervision(
		name: ServiceName,
		info: {
			reason: string;
			restarted: boolean;
			healthy: boolean;
			outcome: 'recovered' | 'restart-unhealthy' | 'restart-error' | 'gave-up';
			attempt: number;
			maxRestarts: number;
			error?: string;
		}
	): Promise<void> {
		try {
			const detail: Record<string, unknown> = {
				service: name,
				reason: info.reason,
				restarted: info.restarted,
				healthy: info.healthy,
				outcome: info.outcome,
				attempt: info.attempt,
				max_restarts: info.maxRestarts,
				summary: `service "${name}" ${info.outcome} — ${info.reason}`
			};
			if (info.error !== undefined) detail.error = info.error;
			await this.db.query(`CREATE agent_event CONTENT { type: 'supervision', detail: $detail };`, {
				detail
			});
		} catch (err) {
			console.warn(
				`[services-manager] supervision analytics write failed for "${name}": ${(err as Error).message}`
			);
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
	 * OBSERVED-status corrector (TASK 14.4a — F-008). The /services read path probes a
	 * service live; when the probe CONTRADICTS the persisted self-report (e.g. a row
	 * still claiming 'running' for a process dead for a day), the stale row ITSELF is
	 * corrected — never just the rendered view — so every other reader of the `service`
	 * table (home rollup, statusbar) converges on the probed truth. `lastSeenAt` lets
	 * the caller seed the last-observed-running instant (the stale row's checked_at)
	 * on a running→down flip, so the surface can say "last seen <ago>" honestly.
	 */
	async recordObservedStatus(
		name: ServiceName,
		status: ServiceStatus,
		pid: number | null,
		lastSeenAt?: Date
	): Promise<void> {
		await this.writeService(name, status, pid, lastSeenAt);
	}

	/**
	 * Upsert the `service:<name>` row. `pid` is OMITTED (kept NONE) when null so the
	 * `option<int>` column never receives a NULL (§6.1). checked_at = now. A 'running'
	 * write IS a live observation, so it stamps `last_seen_at = now`; a down-write
	 * PRESERVES the prior stamp (MERGE) unless the caller seeds an explicit one (14.4b).
	 */
	private async writeService(
		name: ServiceName,
		status: ServiceStatus,
		pid: number | null,
		lastSeenAt?: Date
	): Promise<void> {
		const now = new Date();
		const content: Record<string, unknown> = {
			name,
			status,
			checked_at: now
		};
		if (pid != null) content.pid = pid;
		if (status === 'running') content.last_seen_at = now;
		else if (lastSeenAt) content.last_seen_at = lastSeenAt;
		// UPSERT by stable id so re-ticks mutate the same row (not append). MERGE (not
		// CONTENT) so `last_seen_at` survives a down-write; the stale pid is explicitly
		// UNSET when absent so it can never linger on a stopped/crashed row (§6.1).
		const sql = pid != null ? 'UPSERT $id MERGE $content;' : 'UPSERT $id MERGE $content; UPDATE $id UNSET pid;';
		await this.db.query(sql, {
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
