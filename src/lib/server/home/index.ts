// TASK 9.2 — Home / portfolio overview read model (UI-SPEC §6; F-008; D-019).
//
// The Home dashboard's server read model. It composes the at-a-glance portfolio +
// engine health from REAL rows only (F-008): the four headline metrics, a recent
// agent-activity feed, and a portfolio task summary (counts by status). Every figure
// traces to a row — a window with no rows yields an honest empty/null, never a
// zero-dressed-as-real fabrication. Degrades honestly (D-019): the loader calls these
// against a live DB handle; a connection loss is surfaced as connected:false upstream.
//
// These are plain READS off the DB singleton (NOT a second live query, §2.11). The page
// stays live by re-invalidating on the SSE `session`/`agent_event`/`service`/`task`
// watchers that hooks.server already runs.

import type { Db } from '../db/client';
import { activityLabel } from '../analytics/events';
import { readServices, summarizeServices } from '../services/runtime';

// ── Services health (portfolio-wide, for the "services up" MetricCard) ─────────────
//
// TASK 14.4a (audit-confirmed F-008): the metric previously read the `service` table's
// raw self-reported status, so a row left 'running' by a dead process kept Home claiming
// "1/1 up" for a day. The rollup now REUSES the /services probe-reconciled read path
// (runtime.readServices — same probe, same correction of the stale row) and counts only
// services with a KNOWN state. The card labels itself "probed", not "self-reported".

/** A compact services-health rollup for the Home metric (probe-reconciled; F-008). */
export interface ServicesHealth {
	/** Services whose PROBE-RECONCILED state is 'running'. */
	up: number;
	/** Services with a known (probed or persisted) state; 0 ⇒ honest "—". */
	total: number;
}

/**
 * Read the services-health rollup through the SAME probe-reconciled path /services uses
 * (14.4a — reuse, not duplicate). total=0 ⇒ the Home card renders an honest "—" (no real
 * signal yet), never a fake "0/0 up".
 */
export async function readServicesHealth(db: Db): Promise<ServicesHealth> {
	const { services } = await readServices(db);
	return summarizeServices(services);
}

// ── Recent activity feed (sessions + agent events) ─────────────────────────────────
//
// The transient feed from UI-SPEC §6 ("recent activity (sessions/tasks)"). We surface
// the most recent agent lifecycle events — each is a REAL `agent_event` row — annotated
// with the session/project it belongs to so the operator sees what the engine just did.

/** One recent-activity item (a real agent_event row; F-008). */
export interface ActivityItem {
	id: string;
	/** Lifecycle type: spawn | completion | error | escalation | cancel. */
	type: string;
	/** ISO timestamp of the event. */
	at: string;
	/** provider/model_id when the event carried a model, else null. */
	model: string | null;
	/** One-line identifying label from the persisted detail (summary/reason/error), else null (14.4c). */
	label: string | null;
	/** Linked session id (table:id) when present. */
	sessionId: string | null;
	/** Linked project id (table:id) when present. */
	projectId: string | null;
}

/**
 * Normalise a SurrealDB datetime to an ISO string. The 2.x JS SDK returns a `DateTime`
 * class instance (NOT a JS `Date`) — both expose `toISOString()`, so we accept either, and
 * fall back to a plain string. Anything else ⇒ '' (the feed renders "—" for it; honest).
 */
function iso(at: unknown): string {
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

/**
 * Read the most recent agent lifecycle events for the Home activity feed (F-008). Each
 * row is real; an empty engine yields an empty feed (honest), never fabricated entries.
 * `limit` bounds the scan.
 */
export async function listRecentActivity(db: Db, limit = 8): Promise<ActivityItem[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, type, at, model, session, project, detail
		   FROM agent_event ORDER BY at DESC LIMIT $lim;`,
		{ lim: limit }
	);
	return (rows ?? []).map((r) => {
		const m = (r.model ?? null) as Record<string, unknown> | null;
		const model =
			m && (m.provider || m.model_id)
				? `${String(m.provider ?? '?')}/${String(m.model_id ?? '?')}`
				: null;
		return {
			id: String(r.id),
			type: String(r.type ?? 'event'),
			at: iso(r.at),
			model,
			// 14.4c — the identifying content model-less events DO persist (detail.summary/
			// reason/error) now reaches the feed instead of rendering a bare "—".
			label: activityLabel(r.detail),
			sessionId: r.session ? String(r.session) : null,
			projectId: r.project ? String(r.project) : null
		};
	});
}

// ── Portfolio task summary (counts by status across all projects) ──────────────────
//
// UI-SPEC §6 "portfolio task summary". A roll-up of `task.status` across the whole
// portfolio — every count is a real GROUP BY over real rows (F-008). A status with no
// tasks is simply absent from the map (the page renders 0 only for the known statuses).

/** Counts of tasks by status across the portfolio (real GROUP BY; F-008). */
export interface TaskSummary {
	/** status → count, only for statuses that have ≥1 task. */
	byStatus: Record<string, number>;
	/** Total tasks across all statuses. */
	total: number;
}

/**
 * Roll task counts up by status across ALL projects (F-008). Uses a GROUP BY in SurrealQL
 * (DATA-MODEL §6.1 aggregation discipline) so the count is computed in the DB. An empty
 * `task` table yields { byStatus:{}, total:0 } — honest, not a fabricated board.
 */
export async function buildTaskSummary(db: Db): Promise<TaskSummary> {
	const [rows] = await db.query<[Array<{ status?: string; c?: number }>]>(
		`SELECT status, count() AS c FROM task GROUP BY status;`
	);
	const byStatus: Record<string, number> = {};
	let total = 0;
	for (const r of rows ?? []) {
		const status = String(r.status ?? 'unknown');
		const c = typeof r.c === 'number' ? r.c : 0;
		byStatus[status] = c;
		total += c;
	}
	return { byStatus, total };
}
