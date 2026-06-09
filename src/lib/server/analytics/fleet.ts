// TASK 2.4 — analytics: the agent fleet read model for /agents (UI-SPEC §198–200).
//
// /agents is the tier-centric usage LENS. Two read models, both from REAL rows (F-008):
//   • POOL — tier/role DEFINITIONS from `agent_slot` (a config/stat mirror, NOT live
//     allocation). We surface name/tier/role; we DO NOT read agent_slot.busy for
//     liveness (UI-SPEC §199 explicitly forbids it — it is not the source of truth).
//   • FLEET — running + recent `session` rows. Liveness comes from these (status =
//     running) — the same data the live AgentFleetGrid renders, never agent_slot.busy.
//
// These are plain READS off the DB singleton — NOT a second live query (§2.11). The page
// stays live by re-invalidating on the `session` watcher that hooks.server already runs.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A pool slot DEFINITION (config mirror — not live allocation). */
export interface PoolSlot {
	id: string;
	name: string;
	tier: string;
	role: string;
}

/** One running/recent session row for the fleet grid. */
export interface FleetSession {
	id: string;
	status: string;
	provider: string;
	modelId: string;
	tier: string | null;
	projectId: string | null;
	taskId: string | null;
	startedAt: string;
	endedAt: string | null;
}

/**
 * A fleet session with its project LABEL resolved — the cross-project fleet row for the
 * portfolio-wide session control surface on /claude-code (TASK 9.3). Same liveness rule
 * (`session.status`, never `agent_slot.busy`), with the owning project's name/slug joined
 * so the operator can see WHICH project each running session belongs to. A session with
 * no project link (a bare chat) carries `projectName: null` — an honest "no project", not
 * a fabricated label (F-008).
 */
export interface FleetSessionXP extends FleetSession {
	projectName: string | null;
	projectSlug: string | null;
	ccSessionId: string | null;
}

/** Read the pool slot definitions (config/stat mirror, UI-SPEC §199). */
export async function listPoolSlots(db: Db): Promise<PoolSlot[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, name, tier, role FROM agent_slot ORDER BY tier, role;`
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		name: String(r.name ?? ''),
		tier: String(r.tier ?? 'unknown'),
		role: String(r.role ?? '')
	}));
}

function iso(at: unknown): string {
	if (at instanceof Date) return at.toISOString();
	return typeof at === 'string' ? at : '';
}

/**
 * Read the live fleet: running sessions first (the active grid), then the most recent
 * finished ones for context. Liveness = `session.status`, never `agent_slot.busy` (§199).
 * `limit` bounds the recent tail.
 */
export async function listFleet(db: Db, limit = 30): Promise<FleetSession[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, model, project, task, started_at, ended_at
		   FROM session
		   ORDER BY started_at DESC LIMIT $lim;`,
		{ lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId: r.project ? String(r.project) : null,
			taskId: r.task ? String(r.task) : null,
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	// Running sessions float to the top (active grid), recent finished below.
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}

/**
 * Read the fleet scoped to ONE project — the same shape/ordering as {@link listFleet}
 * but only sessions whose `project` link matches. Used by the project detail page's
 * Sessions tab. Liveness = `session.status`, never `agent_slot.busy` (§199); every row
 * is a REAL session (F-008). The `project` id is validated/bound as a record link at the
 * D-016 chokepoint by the caller-supplied StringRecordId.
 */
export async function listFleetByProject(
	db: Db,
	projectId: string,
	limit = 30
): Promise<FleetSession[]> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, model, project, task, started_at, ended_at
		   FROM session
		   WHERE project = $project
		   ORDER BY started_at DESC LIMIT $lim;`,
		{ project, lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId: r.project ? String(r.project) : null,
			taskId: r.task ? String(r.task) : null,
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}

/**
 * Read the LIVE cross-project fleet for the portfolio-wide session-control surface
 * (TASK 9.3, /claude-code). Every running + recent `session` row ACROSS ALL projects, with
 * the owning project's name/slug joined via FETCH so each row carries its project LABEL.
 *
 * Liveness is `session.status` (UI-SPEC §199 — never `agent_slot.busy`), every row is a
 * REAL session (F-008): a session with no `project` link surfaces `projectName: null`
 * (an honest "no project", not an invented label). Running sessions float to the top
 * (the active fleet); the most recent finished ones follow for context, bounded by `limit`.
 */
export async function listFleetAcrossProjects(db: Db, limit = 40): Promise<FleetSessionXP[]> {
	// FETCH the linked project so name/slug come back inline — one query, no N+1. The
	// explicit `project_id` alias is the stable source for the raw id even after FETCH
	// expands `project` into the full object.
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, model, project, task, cc_session_id, started_at, ended_at,
		        project.id AS project_id, project.name AS project_name, project.slug AS project_slug
		   FROM session
		   ORDER BY started_at DESC LIMIT $lim
		   FETCH project;`,
		{ lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		const projectId = r.project_id ? String(r.project_id) : r.project ? String(r.project) : null;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId,
			projectName: r.project_name ? String(r.project_name) : null,
			projectSlug: r.project_slug ? String(r.project_slug) : null,
			taskId: r.task ? String(r.task) : null,
			ccSessionId: r.cc_session_id ? String(r.cc_session_id) : null,
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}
