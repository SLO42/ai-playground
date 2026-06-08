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

import type { Db } from '../db/client';

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
