// TASK 2.5 — two-tier learning loop + consolidator (MEMORY-SPEC §2, §5; D-027, D-021, D-031).
//
// D-027 two-tier loop:
//   • FAST tier (§2) — in-use writer fork. Every Nth user turn / Mth tool iteration, a
//     review subagent mines the just-finished turn and writes additively. In v2 this is
//     NOT an in-process thread (hermes' shape) — it is a `work_item` (D-021) drained by
//     the background queue, inheriting crash-safe claim tokens, daily caps, stale-GC. The
//     cadence is modulo-hydrated from PERSISTED session counters (§2.2) so it survives the
//     per-message agent rebuild. Tool-whitelisted to memory/skill writes only (§2.1).
//   • SLOW tier (§5) — periodic consolidator (curator). Inactivity-triggered batch merge
//     of near-dup families into umbrellas via `absorbed_into` forwarding (D-031 half 2),
//     archive-not-delete (D-015). The 3-signal classification accepts the model's
//     declaration UNLESS the deterministic guard overrides it for findings/pinned/Tier-0
//     (§5.2 security exception — a poisoned model must not "consolidate away" a finding).
//
// The fork ENQUEUE is the front half of D-022's self-improvement; this module owns the
// cadence + enqueue + the consolidator's deterministic forwarding. The actual review LLM
// call is drained by the orchestrator (shelling the host agent CLI, §9.3) — mocked here.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── §2.2 two-cadence nudge (modulo-hydrated from persisted counters) ───────────────

export interface ReviewCadence {
	/** Fire memory review every N user turns. */
	memoryEveryNTurns: number;
	/** Fire skill review every M tool iterations. */
	skillEveryMTools: number;
}

export const DEFAULT_CADENCE: ReviewCadence = { memoryEveryNTurns: 5, skillEveryMTools: 10 };

export type ReviewKind = 'memory' | 'skill' | 'combined';

/**
 * Decide whether a review fork should fire given the PERSISTED, MONOTONIC counters
 * (§2.2). Returns the review kind, or null. `combined` when both trip on the same turn
 * (run one fork, not two). Counters are never reset mid-session, so `% N` is meaningful.
 */
export function dueReview(
	userTurnCount: number,
	toolIterCount: number,
	cadence: ReviewCadence = DEFAULT_CADENCE
): ReviewKind | null {
	const mem = userTurnCount > 0 && userTurnCount % cadence.memoryEveryNTurns === 0;
	const skill = toolIterCount > 0 && toolIterCount % cadence.skillEveryMTools === 0;
	if (mem && skill) return 'combined';
	if (mem) return 'memory';
	if (skill) return 'skill';
	return null;
}

/**
 * Increment the persisted session counters (§2.2). Monotonic — never reset mid-session.
 * Returns the new counts so the caller can immediately test `dueReview`.
 */
export async function bumpCounters(
	db: Db,
	sessionId: string,
	delta: { userTurns?: number; toolIters?: number }
): Promise<{ userTurnCount: number; toolIterCount: number }> {
	const sid = assertRecordId(sessionId);
	const [rows] = await db.query<[Array<{ user_turn_count: number; tool_iter_count: number }>]>(
		`UPDATE $sid SET
		   user_turn_count = (user_turn_count OR 0) + $ut,
		   tool_iter_count = (tool_iter_count OR 0) + $ti
		 RETURN AFTER;`,
		{ sid: link(sid), ut: delta.userTurns ?? 0, ti: delta.toolIters ?? 0 }
	);
	return { userTurnCount: rows[0].user_turn_count, toolIterCount: rows[0].tool_iter_count };
}

// ── §2.1 enqueue the review fork as a work_item (D-021 queue, NOT an in-proc thread) ─

export interface EnqueueReviewInput {
	session: string; // table:id
	kind: ReviewKind;
	project?: string;
	/** The raw turn text the fork will mine (D-029 — raw, no summary). */
	turnText: string;
}

/**
 * Enqueue a memory/skill review fork as a `work_item` (§2.1, D-021). The payload carries
 * the turn text + review kind; the orchestrator drains it (shelling the host agent CLI,
 * §9.3) under the daily-spend / PID-lock / spawn-depth caps that double as the
 * poisoned-self-reinjection circuit breaker (§9.3). The work_type is whitelisted to the
 * memory writer; the dedup_scope keys on the session so one pending review per session.
 * Returns the work_item id, or null when a pending review for that session already exists
 * (the dedup_key UNIQUE constraint coalesces it).
 */
export async function enqueueReview(db: Db, input: EnqueueReviewInput): Promise<string | null> {
	const content: Record<string, unknown> = {
		work_type: 'memory_review',
		session: link(input.session),
		priority: 5,
		status: 'pending',
		payload: { kind: input.kind, turnText: input.turnText },
		// One pending review per session (active-window dedup, D-008).
		dedup_scope: assertRecordId(input.session)
	};
	if (input.project) content.project = link(input.project);
	try {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE work_item CONTENT $content RETURN AFTER;`,
			{ content }
		);
		return String(rows[0].id);
	} catch (err) {
		// dedup_key UNIQUE violation ⇒ a pending review already queued for this session.
		if (/already (contains|exists)|index|unique/i.test((err as Error).message)) return null;
		throw err;
	}
}

// ── §5 slow consolidator (curator) — archive-not-delete + absorbed_into forwarding ──

/** Classes the §5.2 security exception protects from model-declared consolidation. */
const PROTECTED_SOURCES = new Set(['finding', 'security_finding']);

export interface ConsolidateInput {
	/** The umbrella row the family is absorbed into (table:id). */
	umbrella: string;
	/** The member rows the model declared absorbed (table:id each). */
	members: string[];
	reason?: string;
}

export interface ConsolidateResult {
	absorbed: string[];
	/** Members the deterministic guard REFUSED to absorb (§5.2 security exception). */
	refused: string[];
	/** references edges rewritten to point at the umbrella (§5.1 forwarding). */
	rewiredEdges: number;
}

/**
 * Consolidate a near-dup family into an umbrella (§5.1, D-031 half 2). For each member:
 *   • The deterministic guard WINS over the model for findings/pinned/Tier-0 (§5.2): such
 *     a member is REFUSED — never buried — so a poisoned model can't consolidate away a
 *     security finding.
 *   • Otherwise the member is soft-archived (status="archived", NOT deleted — §5.3),
 *     stamped with `absorbed_into` + `superseded_by` = umbrella, and its inbound/outbound
 *     `references` edges are rewired to the umbrella so the graph stays traversable (no
 *     dangling edges, §5.1 forwarding).
 */
export async function consolidate(db: Db, input: ConsolidateInput): Promise<ConsolidateResult> {
	const umbrellaId = assertRecordId(input.umbrella);
	const absorbed: string[] = [];
	const refused: string[] = [];
	let rewiredEdges = 0;

	for (const memberRaw of input.members) {
		const memberId = assertRecordId(memberRaw);
		if (memberId === umbrellaId) continue;

		// §5.2 deterministic guard: refuse to absorb a protected class regardless of the
		// model's declaration. Check pinned (tier 0) + source-class.
		const [grows] = await db.query<[Array<{ tier?: number; source?: string }>]>(
			`SELECT tier, source FROM $m;`,
			{ m: link(memberId) }
		);
		const row = grows[0];
		const protectedClass =
			!!row && ((row.tier ?? 1) === 0 || (row.source ? PROTECTED_SOURCES.has(row.source) : false));
		if (protectedClass) {
			refused.push(memberId);
			continue;
		}

		// Rewire references edges pointing AT or FROM the member onto the umbrella (§5.1):
		// no dangling edges; the graph stays traversable. RETURN AFTER counts the rewired
		// edges per statement (one result entry per statement).
		const rewire = await db.query<[Array<unknown>, Array<unknown>]>(
			`UPDATE references SET out = $u WHERE out = $m RETURN AFTER;
			 UPDATE references SET in = $u WHERE in = $m RETURN AFTER;`,
			{ u: link(umbrellaId), m: link(memberId) }
		);
		rewiredEdges += (rewire[0]?.length ?? 0) + (rewire[1]?.length ?? 0);

		// Soft-archive the member (D-015) — never DELETE.
		await db.query(
			`UPDATE $m SET status = "archived", archived_at = time::now(),
			   archive_reason = $reason, absorbed_into = $u, superseded_by = $u;
			 CREATE memory_history CONTENT { memory: $m, op: "archive", after: { absorbed_into: $u } };`,
			{ m: link(memberId), u: link(umbrellaId), reason: input.reason ?? 'consolidated into umbrella' }
		);
		absorbed.push(memberId);
	}

	return { absorbed, refused, rewiredEdges };
}
