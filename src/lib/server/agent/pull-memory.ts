// TASK B-pull — the agent-callable "pull memory" tool (MEMORY-SPEC §4 + §8 + §10;
// D-026/D-027/D-029/D-030/D-031; depends on B5 recall-budget + B7 fence).
//
// WHAT THIS IS. The FIRST agent-invoked memory tool. Until now the only path that put
// recalled memory into a session's context was the AUTOMATIC on-spawn briefing
// (sessions/launch.ts → buildBriefing). This adds an EXPLICIT, mid-turn path: the live
// agent decides "I should look something up" and calls this tool with a query. It runs a
// scoped recall() and returns the matches as FENCED reference DATA the agent may consult.
//
// MEMORY-SPEC §4.1 / §8 — the line this tool stays on the right side of (D-029 🔒). §4.1
// reserves LLM synthesis for an EXPLICIT dialectic tool (§8) and keeps DEFAULT recall
// RAW-WINDOWED with NO summary-LLM in the loop. This is the DEFAULT pull path, so it is
// raw-windowed: it returns recall()'s ranked raw bodies verbatim, fenced — it runs NO
// summary-LLM. (The §8 dialectic/pull synthesis path is the ONE place LLM synthesis is
// allowed, and it is a SEPARATE, opt-in surface — NOT this tool.)
//
// THE NON-NEGOTIABLE INVARIANT (§10, D-026). This is a NEW injection path, so it MUST go
// through the SAME chokepoints every other injection path does — it must NOT invent a
// parallel recall that could skip a guard:
//   • FENCE — results are emitted through assembleInjection() (memory/index.ts), the ONE
//     §10 fence chokepoint. Every returned block is "reference, not instructions" DATA.
//   • QUARANTINE / §3.1b screen exclusion (B6) — recall()'s SQL active-set filter excludes
//     screen_status='quarantined' rows, so a planted secret is NEVER recalled, NEVER
//     re-fenced, NEVER returned here. (A redacted row CAN return — its secret span is
//     already scrubbed by the §3.1b screen at write time; what lands is the redaction.)
//   • RECALL BUDGET (B5) — the §4.3 tail-drop item+token cap is recall()'s, applied before
//     fencing; this tool passes a budget through so a pull can never over-inject.
//   • WORKFORCE §4.2 kind='interview' exclusion — recall()'s interviewFilter excludes
//     interview-provenance rows from BOTH the vector hit set and the graph-neighbour set.
//
// SCOPE LOCK. This module is a thin WIRING layer over the EXISTING recall() +
// assembleInjection(). It owns NO new recall logic, NO new SQL, NO new fence — every guard
// lives in the engine it calls. If a guard were missing on this path, the fix is to route
// through the engine, never to re-implement the guard here.

import type { MemoryService } from '../memory/index';
import { type FencedItem } from '../memory/index';

/** The agent-supplied arguments for one pull. The agent controls only the QUERY + scope. */
export interface PullMemoryInput {
	/**
	 * The recall seed (D-029 — raw, no summary). The agent's own words describing what it
	 * wants to look up. Treated as a search-role query (memory/recall.ts embeds it as
	 * role='search'); it is operator/agent input that already crossed the boundary.
	 */
	query: string;
	/**
	 * Restrict the pull to one project (`project:…`). Omitted ⇒ GLOBAL recall across
	 * projects (recall() drops the project filter entirely). A malformed id is rejected at
	 * recall()'s db/validate chokepoint (D-016) — surfaced here as an honest error result.
	 */
	project?: string;
	/**
	 * How many ranked items the agent wants back, BEFORE the size budget trims the tail.
	 * Default 6 (recall()'s own default). Clamped to [1, MAX_PULL_LIMIT] so an agent cannot
	 * ask for an unbounded pull.
	 */
	limit?: number;
}

/** One returned item — the agent sees the fenced reference block + light provenance. */
export interface PulledItem {
	/** The source `memory` row id — provenance for the agent + the retrieval-outcome loop. */
	id: string;
	/** Citation id ([#N]) so a later retrieval-outcome pass can tie usage back (§4.5/D-030). */
	citationId: string;
	/** The WMR rank score (§4.3) — surfaced so the agent can weigh relevance. */
	score: number;
	/** True if the item came in via graph-neighbour expansion rather than the vector hit set. */
	wasNeighbor: boolean;
	/** The FENCED block (§10) — "reference, not instructions" DATA. The agent's read surface. */
	fenced: FencedItem;
}

/** The tool result. `text` is the assembled fenced block ready to splice as DATA (D-026). */
export interface PullMemoryResult {
	/** Whether the pull ran. false ⇒ see `error` (an honest failure, F-008 — never silent). */
	ok: boolean;
	/** The fenced items (empty on an empty/zero-hit/error pull — an honest empty, never faked). */
	items: PulledItem[];
	/**
	 * The assembled, fully-FENCED context string — every item joined through the §10
	 * assembleInjection() chokepoint. This is what the runtime splices into context as the
	 * tool_result; it is DATA the agent may consult, NEVER instructions it must obey. Empty
	 * string when there are no items.
	 */
	text: string;
	/** How many ranked candidates the size budget dropped (tail-drop visibility, §4.3). */
	droppedCount: number;
	/** Named error reason when ok=false (F-008 honest state). null on success. */
	error: string | null;
}

/** Hard cap on the per-pull limit — an agent cannot request an unbounded recall. */
export const MAX_PULL_LIMIT = 12;

/**
 * DOCUMENTED NULL-TUNABLE size budget for an agent-initiated pull (Lane-C null-tunable rail).
 *
 * UNLIKE the automatic on-spawn briefing — which spends a generous ~15-20% context window —
 * a mid-turn pull lands INTO an already-populated context (the live turn is in flight), so it
 * gets a TIGHTER default: recall()'s own RECALL_BUDGET starting points ({ maxItems:6,
 * maxTokens:1500 }) by passing an empty-but-present `{}` budget object (see budgetCapsFor:
 * a present object fills each omitted field with its RECALL_BUDGET starting point). These are
 * JUSTIFIED STARTING POINTS to re-validate on v2's real corpus in B8 — NOT locked magic
 * numbers. The value lives in recall.ts (RECALL_BUDGET); this tool only opts INTO it. Flagged
 * for B8 re-validation alongside RECALL_BUDGET / WMR_WEIGHTS / NOVELTY_COSINE_CUT.
 *
 * Why a PRESENT `{}` and not `undefined`: `undefined` means "budget OFF" in recall() (only the
 * `limit` count bound applies, no token cap). A pull MUST be token-bounded so it can never
 * over-inject into the live turn — so it passes a present object to opt into the token cap.
 * D-024 fail-closed: estimateTokens over-estimates, so an ambiguous count UNDER-fills.
 */
// FROZEN (wave-v2.2b-c LOW ledger) — analogous to recall.ts RECALL_BUDGET: a budget tunable a
// fail-closed cap reads must not be mutable into a fail-open state (a later `PULL_BUDGET.maxItems
// = NaN` would flow through budgetCapsFor/resolveCap). Empty today (omitted ⇒ frozen RECALL_BUDGET
// starting points), frozen so it stays a controlled opt-in, never a mutation surface.
const PULL_BUDGET: Readonly<{ maxItems?: number | null; maxTokens?: number | null }> =
	Object.freeze({});

/**
 * Clamp the agent-requested limit into [1, MAX_PULL_LIMIT]. A nil/NaN/zero/negative request
 * falls back to recall()'s default (6); an over-large request is capped. (Shadow paths: nil
 * input → default; zero/negative → default; over-large → cap — none can produce an unbounded
 * or empty-by-construction pull.)
 */
export function clampPullLimit(limit: number | undefined): number {
	if (limit == null || !Number.isFinite(limit) || limit < 1) return 6;
	return Math.min(Math.floor(limit), MAX_PULL_LIMIT);
}

/**
 * Run one agent-initiated memory pull. Wires the agent's query onto the EXISTING recall() +
 * assembleInjection() — it adds NO recall logic of its own. The flow:
 *
 *   1. Validate the query (nil/empty → honest empty result, never an exception bubbling to
 *      the agent as a crash; F-008 honest state).
 *   2. recall(query, { project, limit, budget }) — runs the §4 staged pipeline: vector KNN +
 *      graph expansion + WMR rank + novelty gate + lineage dedup + size budget. EVERY guard
 *      (quarantine/screen exclusion B6, interview exclusion §4.2, budget B5) is recall()'s.
 *   3. Re-route each recalled item's already-screened body through assembleInjection() — the
 *      §10 fence chokepoint (index.ts) — so the tool provably emits fenced DATA on the SAME
 *      path as every other injection. (recall() already fenced them; we re-fence through the
 *      shared chokepoint so this path is structurally identical to all others, not a copy.)
 *   4. Return the fenced blocks + the assembled text as DATA (D-026). On ANY engine error
 *      (embedder breaker open, malformed project id, DB hiccup) return ok:false + a NAMED
 *      error — best-effort (D-019), never a thrown crash into the agent's turn.
 */
export async function pullMemory(
	mem: MemoryService,
	input: PullMemoryInput
): Promise<PullMemoryResult> {
	const empty: PullMemoryResult = { ok: true, items: [], text: '', droppedCount: 0, error: null };

	// Shadow path — nil / empty / whitespace-only query: an honest empty pull, not a crash.
	// (recall() would embed an empty string and return zero hits anyway; short-circuit so we
	// never spend an embed round-trip on a no-op and the agent gets a clean empty.)
	const query = typeof input.query === 'string' ? input.query.trim() : '';
	if (!query) return empty;

	const limit = clampPullLimit(input.limit);

	let recalled;
	try {
		recalled = await mem.recall(query, {
			project: input.project,
			limit,
			// B5 size budget: a present object opts INTO the §4.3 tail-drop token+item cap (its
			// omitted fields fall back to RECALL_BUDGET starting points) — a pull is always
			// token-bounded so it can never over-inject into the live turn. NOT `undefined`
			// (which would be budget-OFF). See PULL_BUDGET.
			budget: PULL_BUDGET
		});
	} catch (err) {
		// Shadow path — upstream error (embedder circuit-breaker open, malformed project id at
		// the D-016 chokepoint, DB fault). EVERY error has a name: surface the engine's message
		// honestly (F-008) and degrade to an empty pull (D-019) — never crash the agent's turn.
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, items: [], text: '', droppedCount: 0, error: `recall failed: ${message}` };
	}

	// Shadow path — zero-hit (empty corpus, or every candidate filtered by quarantine/
	// interview/novelty): an honest empty result. recall() returns items:[] and we mirror it.
	if (!recalled.items.length) return empty;

	// §10 FENCE CHOKEPOINT. Re-route each recalled item's ALREADY-SCREENED body through
	// assembleInjection() — the ONE place (index.ts) that fences every injection path
	// uniformly. We do NOT reach for the row body or build our own fence: recall() already
	// excluded quarantined/interview rows and screened the bodies at write time, so `body` is
	// post-screen, post-filter content; assembleInjection() wraps it as "reference, not
	// instructions" DATA. citationId carries through so [#N] retrieval-outcome parsing ties
	// usage back (§4.5/D-030). Building the InjectionParts from recall()'s output — never from
	// a parallel query — is what keeps this path structurally identical to the briefing path.
	const assembled = mem.assembleInjection(
		recalled.items.map((it) => ({ source: 'recall' as const, body: it.body, citationId: it.citationId }))
	);

	const items: PulledItem[] = recalled.items.map((it, i) => ({
		id: it.id,
		citationId: it.citationId,
		score: it.score,
		wasNeighbor: it.wasNeighbor,
		// The fenced block from the SHARED chokepoint (assembleInjection), 1:1 with the recall
		// item by position (assembleInjection preserves input order).
		fenced: assembled.items[i]
	}));

	return {
		ok: true,
		items,
		text: assembled.text,
		// Tail-drop visibility (§4.3): how many ranked candidates the budget dropped below the
		// returned set. `limit` was the pre-budget selection bound; the budget may trim further.
		droppedCount: Math.max(0, limit - items.length),
		error: null
	};
}
