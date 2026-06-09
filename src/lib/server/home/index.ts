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

// ── Services health (portfolio-wide, for the "services up" MetricCard) ─────────────
//
// Home only needs a HEALTH ROLLUP, not the full ServicesManager control surface — a
// cheap read of the `service` table's self-reported status. "up" = status 'running'.

/** A compact services-health rollup for the Home metric (all from real `service` rows). */
export interface ServicesHealth {
	/** Services whose last self-report was status='running'. */
	up: number;
	/** Total `service` rows known. */
	total: number;
}

/**
 * Read the services-health rollup from REAL `service` rows (F-008). Returns up/total;
 * total=0 ⇒ the Home card renders an honest "—" (no rows yet), never a fake "0/0 up".
 */
export async function readServicesHealth(db: Db): Promise<ServicesHealth> {
	const [rows] = await db.query<[Array<{ status?: string }>]>(
		`SELECT status FROM service;`
	);
	const list = rows ?? [];
	const up = list.filter((r) => r.status === 'running').length;
	return { up, total: list.length };
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
		`SELECT id, type, at, model, session, project
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
