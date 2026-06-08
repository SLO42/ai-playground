// server/claude-code — agent_slot sync from config/agent-pool.yaml (TASK 1.4;
// DATA-MODEL §4.3; depends on: db, config).
//
// agent_slot is a CONFIG/STAT MIRROR of the pool (NOT a live allocation table —
// agents are spawned per-task, no idle pool). syncAgentSlots upserts one row per
// pool slot and PRUNES rows whose slot was removed, so the mirror tracks the file.
// `busy` is a denormalized stat snapshot (schema DEFAULT false) — never the
// authoritative "is this slot free" source.
//
// Boundary discipline (D-016): the record id `agent_slot:<id>` is validated at the
// chokepoint BEFORE interpolation; all values bind as $param. Slot ids may carry a
// hyphen (e.g. "coder-1") which is not a legal record-id char, so we normalise
// hyphen→underscore for the id segment and validate the result; the original id is
// preserved verbatim in the `name` column.

import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { AgentPool } from '../config/index';

/** The schema's agent_slot.tier ASSERT domain (DATA-MODEL §4.3). */
export const SLOT_TIERS = ['local', 'haiku', 'sonnet', 'opus'] as const;
export type SlotTier = (typeof SLOT_TIERS)[number];

/** A persisted agent_slot row (SDK RecordId coerced to a plain string). */
export interface AgentSlotRow {
	id: string;
	name: string;
	tier: SlotTier;
	role: string;
	busy: boolean;
}

/**
 * Map a pool tier name → the schema's agent_slot.tier ASSERT value. A tier whose
 * provider is ollama maps to "local" regardless of its config name; otherwise a
 * tier name that is itself a valid slot tier (haiku/sonnet/opus) passes through.
 * Anything else falls back to "local" (the safe, $0/offline default).
 */
export function slotTierOf(pool: AgentPool, tierName: string): SlotTier {
	const tier = pool.tiers[tierName];
	if (tier && tier.provider === 'ollama') return 'local';
	if ((SLOT_TIERS as readonly string[]).includes(tierName)) return tierName as SlotTier;
	return 'local';
}

/** Normalise a slot id into a record-id segment (hyphen→underscore), then validate. */
function slotRecordId(slotId: string): string {
	const seg = slotId.replace(/-/g, '_');
	return assertRecordId(`agent_slot:${seg}`);
}

/**
 * Sync the pool's slots into the agent_slot mirror. Upserts one row per slot
 * (idempotent — re-running is a no-op) and prunes rows whose slot is no longer in
 * the pool. Returns the number of slots written.
 */
export async function syncAgentSlots(db: Db, pool: AgentPool): Promise<number> {
	// Validate + resolve every slot FIRST so a bad id aborts before any write.
	const resolved = pool.slots.map((s) => ({
		recordId: slotRecordId(s.id),
		name: s.id,
		tier: slotTierOf(pool, s.tier),
		role: s.role
	}));

	for (const r of resolved) {
		// UPSERT MERGE: first write seeds the schema DEFAULT busy=false; a re-sync only
		// touches name/tier/role, preserving busy (the stat snapshot). MERGE (not CONTENT)
		// keeps the idempotent path a true update, never a reset.
		await db.query(`UPSERT ${r.recordId} MERGE $content RETURN NONE;`, {
			content: { name: r.name, tier: r.tier, role: r.role }
		});
	}

	// Prune rows whose slot was removed from the pool. Names bind as a $param list.
	const keepNames = resolved.map((r) => r.name);
	await db.query(`DELETE agent_slot WHERE name NOT IN $keep;`, { keep: keepNames });

	return resolved.length;
}

/** List the agent_slot mirror rows (coerced to plain JSON). */
export async function listAgentSlots(db: Db): Promise<AgentSlotRow[]> {
	const [rows] = await db.query<[(AgentSlotRow & { id: unknown })[]]>(
		`SELECT * FROM agent_slot ORDER BY name;`
	);
	return rows.map((r) => ({
		id: String(r.id),
		name: r.name,
		tier: r.tier,
		role: r.role,
		busy: r.busy ?? false
	}));
}
