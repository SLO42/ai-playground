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
	type ServiceAdapter,
	type ServiceName,
	type ServiceAction,
	type OperateResult,
	type ServiceRow
} from './manager';
import { OllamaServiceAdapter } from './ollama-adapter';

/** A service the page renders: persisted status + live capabilities (honest control). */
export interface ServiceView extends Omit<ServiceRow, 'id' | 'last_seen_at'> {
	id: string | null;
	/** True if the operator can start/stop/restart this service from the surface. */
	controllable: boolean;
	/** A live, bounded health-probe result (null when the adapter has no probe / errored). */
	liveHealthy: boolean | null;
	/** ISO instant the service was LAST observed running, or null (renders "—"; 14.4b). */
	lastSeenAt: string | null;
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

/** The probe surface readServices needs (the real OllamaServiceAdapter, or a test double). */
export interface OllamaProbe {
	health(): Promise<boolean>;
	discoverPid(): Promise<number | null>;
}

/** The runtime singleton (one per server process). */
let manager: ServicesManager | null = null;
let ollama: (ServiceAdapter & OllamaProbe) | null = null;

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
 *
 * TASK 14.4a/b hardening (audit-confirmed F-008 findings):
 *   • probe-false is REAL knowledge — a row-less or 'unknown' service the probe cannot
 *     reach reads 'stopped', not 'unknown'.
 *   • when the probe CONTRADICTS the persisted self-report, the stale row ITSELF is
 *     corrected (recordObservedStatus) — so every other reader of the `service` table
 *     (home "services up" rollup, statusbar) converges, not just this view. A
 *     running→down flip seeds `last_seen_at` from the stale row's checked_at — the last
 *     instant the service was reported alive.
 *   • a probe-down service NEVER renders its old pid as if current — pid is omitted and
 *     `lastSeenAt` carries the honest "last seen" instant instead.
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
		// status is 'running' regardless of what the (lagging) persisted row last wrote,
		// and when it says down a 'running'/'unknown' claim reads 'stopped' (14.4a).
		let status = row ? row.status : 'unknown';
		if (liveHealthy === true) status = 'running';
		else if (liveHealthy === false && (status === 'running' || status === 'unknown')) {
			status = 'stopped';
		}

		// Honest "last seen": the persisted stamp, else — on the very flip where a stale
		// 'running' row meets a dead probe — the row's checked_at (the last moment it was
		// reported alive). Probe-true means it is seen RIGHT NOW.
		let lastSeenAt: string | null = row?.last_seen_at ?? null;
		if (!lastSeenAt && row?.status === 'running' && liveHealthy === false && row.checked_at) {
			lastSeenAt = row.checked_at;
		}
		if (liveHealthy === true) lastSeenAt = new Date().toISOString();

		// CORRECT THE STALE ROW ITSELF on a probe contradiction (14.4a — F-008). Best-effort:
		// a failed corrective write degrades to the (still honest) reconciled view.
		if (row && liveHealthy !== null && row.status !== status) {
			const seed =
				status !== 'running' && !row.last_seen_at && lastSeenAt ? new Date(lastSeenAt) : undefined;
			await getServicesManager(db)
				.recordObservedStatus(name, status, status === 'running' ? (livePid ?? null) : null, seed)
				.catch(() => {});
		}

		const view: ServiceView = {
			id: row ? row.id : null,
			name,
			status,
			// NEVER a stale pid presented as current: a probe-down service shows no pid (14.4b).
			pid: liveHealthy === false ? undefined : (livePid ?? row?.pid),
			checked_at: row ? row.checked_at : '',
			controllable: meta.controllable,
			liveHealthy,
			lastSeenAt
		};
		if (meta.note) view.note = meta.note;
		views.push(view);
	}
	return { services: views };
}

/**
 * Roll the probe-reconciled views into the Home "services up" figure (14.4a). Only
 * services with a KNOWN state count toward the ratio — a row-less, unprobed service is
 * honestly 'unknown' and is EXCLUDED rather than dressed as up or down (F-008). total=0
 * still means "no real signal yet" and renders "—" upstream.
 */
export function summarizeServices(views: ServiceView[]): { up: number; total: number } {
	const known = views.filter((v) => v.status !== 'unknown');
	return { up: known.filter((v) => v.status === 'running').length, total: known.length };
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
		checked_at: isoString(row.checked_at),
		last_seen_at: row.last_seen_at != null ? isoString(row.last_seen_at) || undefined : undefined
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

/**
 * TEST hook: replace the ollama probe adapter so readServices' live probe is
 * deterministic in tests (no dependence on a real Ollama on the test host). Registers
 * the double with the manager too, so operate/tick paths see the same adapter.
 */
export function __setOllamaAdapterForTest(db: Db, adapter: ServiceAdapter & OllamaProbe): void {
	getServicesManager(db);
	ollama = adapter;
	manager!.register(adapter);
}
