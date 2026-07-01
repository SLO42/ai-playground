// TASK 2.16 — record retrieval outcomes (DATA-MODEL §4.13; MEMORY-SPEC §4.5; D-030, D-022).
//
// Closes the link the ROADMAP names: an injected/recalled CITATION id → the success/failure
// of the SUBSEQUENT TOOL CALLS in that turn → a `retrieval_outcome` row. This is the data
// feed for the WMR `historical_utility` term (recall.ts), which DEFAULTS TO 0 until these
// rows exist (D-030). It is **ranker input ONLY** (D-030 RESOLVED): the curator's keep/prune
// (loop.ts) never reads it — outcome improves *what surfaces*, never *what survives*.
//
// 2.5 already wrote one row per injected item from a SINGLE caller-supplied boolean. 2.16
// adds the real aggregation layer: the runtime emits a `tool_call`/`tool_result` stream
// (each result carries `ok`), and `summarizeTurnTools` folds that stream into ONE per-turn
// `TurnToolOutcome` (succeeded / failed / total + a conservative overall `toolSuccess`).
// `recordTurnOutcomes` then ties that aggregated outcome to every injected citation and
// writes the rows — so a citation is linked to the ACTUAL downstream tool result, not a hand
// boolean. A turn with NO tool calls carries NO tool_success signal (NONE, never a fake
// boolean — F-008 / §6.1).
//
// Boundary discipline (D-016): every record-id link passes db/validate.assertRecordId and
// binds as StringRecordId; absent optionals are OMITTED, never set to explicit NULL
// (option<T> rejects NULL — MEMORY-SPEC §6.1). The model response is parsed for [#N]
// citation markers via the shared parseCitations (recall.ts) — one citation grammar.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { RuntimeEvent } from '../runtime/index';
import { parseCitations, markIngestedFindingsApplied, type RecallItem } from './recall';

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * The aggregated tool outcome for ONE turn, derived from the runtime event stream.
 * `toolSuccess` is the conservative overall signal: true ⇔ at least one tool ran AND
 * none failed; false ⇔ at least one tool failed; undefined ⇔ no tool ran (NO signal —
 * an answer-only turn is neither a success nor a failure of any recalled context).
 */
export interface TurnToolOutcome {
	total: number;
	succeeded: number;
	failed: number;
	/** undefined when total === 0 (no signal — recorded as NONE, never a fabricated bool). */
	toolSuccess?: boolean;
}

/**
 * Fold a runtime event stream into ONE per-turn tool outcome (§4.5 signal source). Only
 * `tool_result` events carry the success bit; `tool_call` is the request, not the result.
 * Conservative: ANY failed tool result makes the whole turn a failure (a half-failed turn
 * is not a clean win for the recalled context). A turn with zero tool results yields NO
 * `toolSuccess` — the recalled context cannot be credited or blamed for tool behaviour.
 */
export function summarizeTurnTools(events: Iterable<RuntimeEvent>): TurnToolOutcome {
	let succeeded = 0;
	let failed = 0;
	for (const ev of events) {
		if (ev.type === 'tool_result') {
			if (ev.ok) succeeded++;
			else failed++;
		}
	}
	const total = succeeded + failed;
	const out: TurnToolOutcome = { total, succeeded, failed };
	if (total > 0) out.toolSuccess = failed === 0;
	return out;
}

export interface RecordTurnOutcomesInput {
	/** Session this turn ran in (table:id; omitted ⇒ NONE). */
	session?: string;
	/** The message/turn that triggered recall (message table:id; omitted ⇒ NONE). */
	queryTurn?: string;
	/** The model's response text — scanned for [#N] citation markers (§4.5). */
	responseText: string;
	/** The items injected this turn (the recall result). */
	injected: RecallItem[];
	/**
	 * The runtime event stream for the turn — folded via summarizeTurnTools into the per-turn
	 * tool outcome. Pass this OR a pre-aggregated `outcome`; `events` wins if both are given.
	 */
	events?: Iterable<RuntimeEvent>;
	/** A pre-aggregated turn outcome (when the caller already folded the stream). */
	outcome?: TurnToolOutcome;
}

/**
 * Record one `retrieval_outcome` row per injected item (DATA-MODEL §4.13), tying each
 * injected/recalled citation to the AGGREGATED success/failure of the turn's subsequent tool
 * calls. Marks `cited` from [#N] parsing and `utilized` from cited-OR-implicit-path-hit (a
 * strong-scoring item that preceded a clean tool turn is credited even without a formal
 * citation). `tool_success` carries the per-turn aggregate ONLY when a tool actually ran
 * (otherwise OMITTED → NONE, §6.1). RANKER INPUT ONLY (D-030): nothing here prunes.
 * Records rows even when nothing was cited (a zero-utility row is still ranker signal).
 * Returns the created row ids.
 */
export async function recordTurnOutcomes(
	db: Db,
	input: RecordTurnOutcomesInput
): Promise<string[]> {
	const outcome = input.events ? summarizeTurnTools(input.events) : input.outcome;
	const toolSuccess = outcome?.toolSuccess; // undefined when no tool ran
	const cited = parseCitations(input.responseText);

	const ids: string[] = [];
	// BL-6: collect utilized ingested findings to mark-applied after the outcome rows land.
	const applied: { id: string; provenance?: string; utilized: boolean }[] = [];
	for (const item of input.injected) {
		const isCited = cited.has(item.citationId);
		// Implicit-path-hit rescue (§4.5): a high-scoring neighbour that clearly shaped the
		// answer is credited as utilized even without a formal citation — conservative proxy:
		// strong recall score AND the turn's tools cleanly succeeded.
		const implicit = !isCited && toolSuccess === true && item.score >= 0.6;
		const utilized = isCited || implicit;
		applied.push({ id: item.id, provenance: item.provenance, utilized });

		const content: Record<string, unknown> = {
			memory: link(item.id),
			cited: isCited,
			utilized,
			was_neighbor: item.wasNeighbor,
			score: item.score,
			// S2 (m0075): persist the recall-time feature breakdown so this row is a trainable
			// example for the learned reranker (rerank.ts). Numeric only — no content (D-026).
			feat_cosine: item.explain.cosine,
			feat_utility: item.explain.utility,
			feat_recency: item.explain.recency
		};
		if (input.session) content.session = link(input.session);
		if (input.queryTurn) content.query_turn = link(input.queryTurn);
		// OMIT tool_success when no tool ran — option<bool> rejects explicit NULL (§6.1).
		if (toolSuccess != null) content.tool_success = toolSuccess;
		if (isCited) content.citation_id = item.citationId;

		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE retrieval_outcome CONTENT $content RETURN AFTER;`,
			{ content }
		);
		ids.push(String(rows[0].id));
	}
	// BL-6 utilization loop: bump applied_count on the utilized ingested findings (enrichment
	// after the durable ranker rows — never a precondition; RANKING input only, never prunes, G3).
	await markIngestedFindingsApplied(db, applied);
	return ids;
}

// ── S1 retrieval feedback (DATA-MODEL §4.13 + m0073 `llm_relevance`; D-030) ──────────────
//
// Closes the S1 half of the cognitive loop: AFTER an outcome row exists (it already carries the
// query embedding + memory link, written above), an LLM/operator/concierge can stamp a post-hoc
// relevance VERDICT onto it — was the recalled memory actually helpful, irrelevant, outdated, or
// worth pinning? This is RANKER SIGNAL ONLY (D-030, like the rest of retrieval_outcome): it
// updates *what surfaces next time*, never *what survives* (the curator never reads it). The
// verdict UPDATEs an EXISTING row — it never creates one (a feedback for a non-existent outcome
// is a no-op, returned false, not a silent fabricated row, F-008).

/** The S1 relevance verdicts (lock-step with the m0073 `retrieval_outcome.llm_relevance` ASSERT). */
export const RETRIEVAL_FEEDBACK_VERDICTS = ['helpful', 'irrelevant', 'outdated', 'pin'] as const;
export type RetrievalFeedbackVerdict = (typeof RETRIEVAL_FEEDBACK_VERDICTS)[number];

/** Untrusted-input guard for the verdict (D-026): only the four ASSERT-legal values pass. */
export function isRetrievalFeedbackVerdict(v: unknown): v is RetrievalFeedbackVerdict {
	return typeof v === 'string' && (RETRIEVAL_FEEDBACK_VERDICTS as readonly string[]).includes(v);
}

/**
 * Stamp an S1 relevance verdict onto an EXISTING `retrieval_outcome` row (m0073 `llm_relevance`).
 * Validates the outcome id at the D-016 chokepoint and the verdict against the ASSERT set BEFORE
 * the write. Returns true when a row was updated, false when no row matched that id (a no-op — no
 * fabricated row). RANKER INPUT ONLY (D-030): this never prunes.
 */
export async function recordRetrievalFeedback(
	db: Db,
	outcomeId: string,
	verdict: RetrievalFeedbackVerdict
): Promise<boolean> {
	if (!isRetrievalFeedbackVerdict(verdict)) {
		throw new Error(`invalid retrieval-feedback verdict "${verdict}"; expected one of ${JSON.stringify(RETRIEVAL_FEEDBACK_VERDICTS)}`);
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`UPDATE $id SET llm_relevance = $verdict RETURN AFTER;`,
		{ id: link(outcomeId), verdict }
	);
	return rows.length > 0;
}
