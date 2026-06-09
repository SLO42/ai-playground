// TASK 10.5 — process-wide services-manager runtime + control surface for /services.
//
// The /services page (UI-SPEC §45/§210) needs a LIVE control surface over the local
// services (Ollama / SurrealDB / engine), backed by REAL processes (F-008). The
// ServicesManager (3.5) owns the supervision loop but is not otherwise instantiated in
// the long-lived SvelteKit process — this module is the single place that builds + holds
// it, registering the real ServiceAdapters once and exposing the page's read + act paths.
//
// CONTROLLABILITY is honest, per the dashboard's actual authority (UI-SPEC §210):
//   • ollama    — fully controllable: the adapter discovers the running process (even if
//                 started externally) and can stop / restart it (F-001/F-002). The dashboard
//                 does NOT route its own requests through Ollama, so acting on it is safe.
//   • surrealdb — health-observed but NOT operator-controllable from here: the dashboard
//                 READS from this exact server and did not spawn it (db:up owns its
//                 lifecycle), so a stop/restart would sever the control plane and a fresh
//                 spawn would collide on the bound port. We say so plainly rather than ship a
//                 dead/dangerous button (D-038 #5 — no dead controls; #6 — honest).
//   • dashboard — status-only self-report (it cannot start/stop itself, UI-SPEC §210).
//
// The DB is the source of truth for STATUS (the `service` rows the manager/heartbeat write
// + that the page live-tails over SSE). This module merges that persisted status with each
// adapter's controllability + a live health probe so the page is both live and honest.

import { env } from '$env/dynamic/private';
import type { Db } from '../db/client';
import {
	ServicesManager,
	SERVICE_NAMES,
	type ServiceName,
	type ServiceAction,
	type OperateResult,
	type ServiceRow
} from './manager';
import { OllamaServiceAdapter } from './ollama-adapter';

/** A service the page renders: persisted status + live capabilities (honest control). */
export interface ServiceView extends Omit<ServiceRow, 'id'> {
	id: string | null;
	/** True if the operator can start/stop/restart this service from the surface. */
	controllable: boolean;
	/** A live, bounded health-probe result (null when the adapter has no probe / errored). */
	liveHealthy: boolean | null;
	/** Honest one-line note explaining WHY a service is not controllable (else undefined). */
	note?: string;
}

/** The data the /services loader returns (services + the controllable set, honest). */
export interface ServicesData {
	services: ServiceView[];
}

/** Static metadata per managed service — purpose copy + whether it is operator-controllable. */
const META: Record<ServiceName, { label: string; purpose: string; controllable: boolean; note?: string }> = {
	ollama: {
		label: 'Ollama',
		purpose: 'Local model server (gpt-oss + embeddings) — the cheap/offline routing slot.',
		controllable: true
	},
	surrealdb: {
		label: 'SurrealDB',
		purpose: 'The single datastore (document · graph · vector). The dashboard reads from it.',
		controllable: false,
		note: 'Externally managed (db:up owns its lifecycle); the dashboard reads from this server, so it cannot stop/restart its own datastore from here.'
	},
	engine: {
		label: 'Engine',
		purpose: 'The orchestration engine that drives Claude Code sessions from the task queue.',
		controllable: false,
		note: 'In-process with the dashboard (the orchestrator runs inside this server); manage it via the server lifecycle, not from here.'
	},
	dashboard: {
		label: 'Dashboard',
		purpose: 'This control-plane app. Status-only — it cannot start or stop itself.',
		controllable: false,
		note: 'Status-only self-report (UI-SPEC §210) — the dashboard cannot start/stop itself.'
	}
};

/** The runtime singleton (one per server process). */
let manager: ServicesManager | null = null;
let ollama: OllamaServiceAdapter | null = null;

/**
 * Build (once) + return the process-wide ServicesManager with its real adapters
 * registered. Idempotent — subsequent calls return the same instance. The `db` is the
 * runtime least-priv handle the manager records status/incidents through.
 */
export function getServicesManager(db: Db): ServicesManager {
	if (manager) return manager;
	manager = new ServicesManager(db);
	ollama = new OllamaServiceAdapter({ host: ollamaHost() });
	manager.register(ollama);
	return manager;
}

/** Resolve the Ollama base url from env (loopback; D-003 — no `/v1` suffix). */
function ollamaHost(): string {
	return (env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
}

/**
 * Read the live services view (F-008): persisted `service` rows merged with per-adapter
 * controllability + a bounded live health probe. Services with NO row yet still render
 * (status 'unknown') so the operator sees the full managed set, never a fabricated row.
 */
export async function readServices(db: Db): Promise<ServicesData> {
	getServicesManager(db);
	const persisted = await db.query<[ServiceRow[]]>(`SELECT * FROM service;`).then(([r]) => r ?? []);
	const byName = new Map<string, ServiceRow>();
	for (const row of persisted) byName.set(String(row.name), normRow(row));

	const views: ServiceView[] = [];
	for (const name of SERVICE_NAMES) {
		const meta = META[name];
		const row = byName.get(name);
		// Live health probe for adapters that expose one (Ollama). Bounded + best-effort.
		let liveHealthy: boolean | null = null;
		let livePid: number | undefined;
		if (name === 'ollama' && ollama) {
			liveHealthy = await ollama.health().catch(() => null);
			if (liveHealthy === true) {
				// Discover the live pid so a probe-true service shows a truthful pid even
				// when the persisted row is stale (e.g. left 'stopped' after a host restart).
				livePid = (await ollama.discoverPid().catch(() => null)) ?? undefined;
			}
		}
		// RECONCILE persisted status with the live probe (F-008 — never present a stale
		// 'stopped'/'crashed' as current truth for a service the probe sees healthy). The
		// live probe is ground truth for liveness; when it says healthy the displayed
		// status is 'running' regardless of what the (lagging) persisted row last wrote.
		let status = row ? row.status : 'unknown';
		if (liveHealthy === true) status = 'running';
		else if (liveHealthy === false && status === 'running') status = 'stopped';
		const view: ServiceView = {
			id: row ? row.id : null,
			name,
			status,
			pid: livePid ?? row?.pid,
			checked_at: row ? row.checked_at : '',
			controllable: meta.controllable,
			liveHealthy
		};
		if (meta.note) view.note = meta.note;
		views.push(view);
	}
	return { services: views };
}

/**
 * Perform an operator lifecycle action on a controllable service (UI-SPEC §210). Validates
 * the name + action at the boundary, refuses a non-controllable service (honest — never a
 * dead/dangerous control), then delegates to the manager (which records the audit incident +
 * notification). Returns the {@link OperateResult}.
 */
export async function operateService(
	db: Db,
	name: string,
	action: string
): Promise<OperateResult> {
	if (!(SERVICE_NAMES as readonly string[]).includes(name)) {
		throw new ServiceControlError(`unknown service "${name}"`);
	}
	const svc = name as ServiceName;
	if (!META[svc].controllable) {
		throw new ServiceControlError(`service "${name}" is not operator-controllable from here`);
	}
	if (action !== 'start' && action !== 'stop' && action !== 'restart') {
		throw new ServiceControlError(`unknown action "${action}" (expected start|stop|restart)`);
	}
	const mgr = getServicesManager(db);
	return mgr.operate(svc, action as ServiceAction);
}

/** Thrown on an invalid service-control request (bad name / action / non-controllable). */
export class ServiceControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServiceControlError';
	}
}

/** Coerce a persisted row's id/datetime to plain JSON (F-013 — datetime → ISO string). */
function normRow(row: ServiceRow): ServiceRow {
	return {
		id: String(row.id),
		name: row.name,
		status: row.status,
		pid: row.pid != null ? Number(row.pid) : undefined,
		checked_at: isoString(row.checked_at)
	};
}

/** Coerce a SurrealDB datetime (DateTime/Date/string) to an ISO string (F-013). */
function isoString(at: unknown): string {
	if (at instanceof Date) return at.toISOString();
	if (typeof at === 'string') return at;
	if (at && typeof (at as { toISOString?: unknown }).toISOString === 'function') {
		try {
			return (at as { toISOString: () => string }).toISOString();
		} catch {
			return '';
		}
	}
	return '';
}

/** TEST hook: reset the singleton so a test can rebuild it against a fresh db. */
export function __resetServicesRuntime(): void {
	manager = null;
	ollama = null;
}
