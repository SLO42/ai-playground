// MEMORY-SPEC §11 re-validation harness — recall-quality measurement (MEASUREMENT ONLY).
//
// PURPOSE: produce ACTUAL measured numbers so the §11 "tunable starting points" can be
// re-validated rather than guessed: the WMR weights (0.50/0.35/0.15, §4.3), the
// NOVELTY_COSINE_CUT (§4.6), and B5's recall budget (§4.3 tail-drop). The harness RECORDS
// metrics; it does NOT change any default and it does NOT prune memory.
//
// HARD SCOPE LOCK (D-030 ranking-only; pruning stays time-based):
//   • It NEVER mutates WMR_WEIGHTS / NOVELTY_COSINE_CUT / RECALL_BUDGET — it reads them as
//     the BASELINE and re-scores candidates in a LOCAL pure function for the sweep. The
//     engine's exported constants are read-only inputs; the sweep's alternative weights are
//     local variables that never write back.
//   • It NEVER calls the curator/consolidator and NEVER archives/deletes a row. The only DB
//     writes are seeding the fixture corpus (store path) into a THROWAWAY namespace; reads
//     mirror recall's active-set filter exactly.
//   • The candidate pool it re-scores is fetched with the SAME active-set filter recall uses
//     (status active|NONE, screen_status != quarantined, non-interview) so a sweep can never
//     surface a quarantined/archived row that production recall would have excluded.
//
// The numbers this emits are evidence on a CONTROLLED lexical-eval corpus (LexicalEmbedder),
// NOT a claim about live qwen3 (the deferred live proof). The harness flags every figure with
// its corpus + embedder so no one reads a sweep number as an achieved production metric
// (F-008 — measure or mark unknown; never assert §11's unverified ~26%/weight figures as met).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../../db/client';
import { assertRecordId } from '../../db/validate';
import type { Embedder } from '../embed';
import { distanceToSimilarity } from '../embed';
import { MemoryService, WMR_WEIGHTS, NOVELTY_COSINE_CUT, RECALL_BUDGET, estimateTokens } from '../index';
import { CORPUS, QUERIES, dupFamilies, type EvalQuery } from './corpus';
import {
	precisionAtK,
	recallAtK,
	reciprocalRank,
	ndcgAtK,
	dupSuppressionRate,
	mean,
	round
} from './metrics';

const RECENCY_HALF_LIFE_DAYS = 30; // mirrors recall.ts (read-only constant, not re-exported)

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) dot += a[i] * b[i];
	if (dot < -1) return -1;
	if (dot > 1) return 1;
	return dot;
}

function recencyDecay(updatedAt: string | undefined): number {
	if (!updatedAt) return 0;
	const ageMs = Date.now() - new Date(updatedAt).getTime();
	if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
	const ageDays = ageMs / 86_400_000;
	return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** WMR weight triple for the sweep (cosine/utility/recency). */
export interface Weights {
	cosine: number;
	utility: number;
	recency: number;
}

/** One scored candidate (read-only re-score; mirrors recall's ScoredCandidate). */
interface Cand {
	ref: string;
	id: string;
	content: string;
	embedding: number[];
	cosine: number;
	utility: number;
	recency: number;
}

export interface SeededCorpus {
	/** ref → SurrealDB id (table:id). */
	idByRef: Map<string, string>;
	/** ref → row id, reverse. */
	refById: Map<string, string>;
}

/**
 * Seed the fixture CORPUS into the (throwaway) DB via the REAL store path. Returns the
 * ref→id map. Honest about drops: every corpus item is clean, so all persist; if any did
 * not (it never should), it is recorded with id '' and excluded from the maps.
 */
export async function seedCorpus(mem: MemoryService, project?: string): Promise<SeededCorpus> {
	const idByRef = new Map<string, string>();
	const refById = new Map<string, string>();
	for (const item of CORPUS) {
		const [r] = await mem.store([{ content: item.content, project }]);
		if (r.persisted && r.id) {
			idByRef.set(item.ref, r.id);
			refById.set(r.id, item.ref);
		}
	}
	return { idByRef, refById };
}

/**
 * Fetch the candidate pool for a query EXACTLY as recall's step 1 would (same active-set
 * filter), read-only. Returns scored candidates with cosine/recency filled and utility from
 * retrieval_outcome (ranking input only, D-030). This is the shared input the sweep re-scores
 * under alternative weights WITHOUT re-running the engine for each weight triple.
 */
export async function fetchCandidates(
	db: Db,
	embedder: Embedder,
	seeded: SeededCorpus,
	query: string,
	k = 50
): Promise<{ qvec: number[]; cands: Cand[] }> {
	const qvec = await embedder.embed(query, 'search');
	const [vrows] = await db.query<
		[Array<{ id: unknown; content: string; embedding: number[]; updated_at?: string; dist?: number }>]
	>(
		`SELECT id, content, embedding, updated_at, vector::distance::knn() AS dist
		   FROM memory
		  WHERE embedding <|${k},COSINE|> $qvec
		    AND (status = "active" OR status IS NONE)
		    AND screen_status != "quarantined"
		    AND (session IS NONE OR session.kind != "interview")
		  ORDER BY dist ASC;`,
		{ qvec }
	);
	const cands: Cand[] = [];
	for (const r of vrows) {
		const id = String(r.id);
		const ref = seeded.refById.get(id);
		if (!ref) continue; // only score corpus rows (the throwaway ns may hold nothing else)
		cands.push({
			ref,
			id,
			content: r.content,
			embedding: r.embedding,
			cosine: r.dist != null ? distanceToSimilarity(r.dist) : cosine(qvec, r.embedding),
			utility: 0,
			recency: recencyDecay(r.updated_at)
		});
	}
	// historical_utility (ranking input only). Count utilized outcome rows per memory.
	if (cands.length) {
		const ids = cands.map((c) => link(c.id));
		const [orows] = await db.query<[Array<{ memory: unknown; util: number }>]>(
			`SELECT memory, count() AS util FROM retrieval_outcome
			  WHERE memory IN $ids AND utilized = true GROUP BY memory;`,
			{ ids }
		);
		const utilBy = new Map<string, number>();
		for (const o of orows) {
			const raw = Number(o.util) || 0;
			utilBy.set(String(o.memory), raw / (raw + 3));
		}
		for (const c of cands) c.utility = utilBy.get(c.id) ?? 0;
	}
	return { qvec, cands };
}

/**
 * Pure read-only re-ranking: score with the given weights + apply the §4.6 novelty gate at
 * `noveltyCut`, then take top-`limit`. Returns the final ordered refs AND the full scored
 * order (pre-gate) so the harness can measure dup-suppression. NEVER writes anything.
 */
export function rankRefs(
	cands: Cand[],
	weights: Weights,
	noveltyCut: number,
	limit: number
): { finalRefs: string[]; scoredOrder: string[] } {
	const scored = cands
		.map((c) => ({
			...c,
			score: weights.cosine * c.cosine + weights.utility * c.utility + weights.recency * c.recency
		}))
		.sort((a, b) => b.score - a.score);
	const scoredOrder = scored.map((c) => c.ref);
	const selected: typeof scored = [];
	for (const c of scored) {
		if (selected.length >= limit) break;
		const dup = selected.some((s) => cosine(s.embedding, c.embedding) >= noveltyCut);
		if (dup) continue;
		selected.push(c);
	}
	return { finalRefs: selected.map((c) => c.ref), scoredOrder };
}

export interface QueryMetrics {
	queryId: string;
	precisionAt3: number;
	precisionAt5: number;
	recallAt5: number;
	mrr: number;
	ndcgAt5: number;
	/** null when this query has no multi-member dup family in the candidate pool. */
	dupSuppression: number | null;
}

export interface VariantMetrics {
	label: string;
	weights: Weights;
	noveltyCut: number;
	limit: number;
	perQuery: QueryMetrics[];
	/** Macro-averages across queries. */
	macro: {
		precisionAt3: number;
		precisionAt5: number;
		recallAt5: number;
		mrr: number;
		ndcgAt5: number;
		/** Mean over queries where dup-suppression was measurable (families present). */
		dupSuppression: number | null;
	};
}

/** Score one weight/cut/limit variant across all queries from pre-fetched candidates. */
export function scoreVariant(
	label: string,
	weights: Weights,
	noveltyCut: number,
	limit: number,
	perQueryCands: { q: EvalQuery; cands: Cand[] }[],
	families: Record<string, string[]>
): VariantMetrics {
	const perQuery: QueryMetrics[] = [];
	for (const { q, cands } of perQueryCands) {
		const { finalRefs, scoredOrder } = rankRefs(cands, weights, noveltyCut, limit);
		perQuery.push({
			queryId: q.id,
			precisionAt3: round(precisionAtK(finalRefs, q.relevance, 3)),
			precisionAt5: round(precisionAtK(finalRefs, q.relevance, 5)),
			recallAt5: round(recallAtK(finalRefs, q.relevance, 5)),
			mrr: round(reciprocalRank(finalRefs, q.relevance)),
			ndcgAt5: round(ndcgAtK(finalRefs, q.relevance, 5)),
			dupSuppression: dupSuppressionRate(scoredOrder, finalRefs, families)
		});
	}
	const dupVals = perQuery.map((m) => m.dupSuppression).filter((v): v is number => v != null);
	return {
		label,
		weights,
		noveltyCut,
		limit,
		perQuery,
		macro: {
			precisionAt3: round(mean(perQuery.map((m) => m.precisionAt3))),
			precisionAt5: round(mean(perQuery.map((m) => m.precisionAt5))),
			recallAt5: round(mean(perQuery.map((m) => m.recallAt5))),
			mrr: round(mean(perQuery.map((m) => m.mrr))),
			ndcgAt5: round(mean(perQuery.map((m) => m.ndcgAt5))),
			dupSuppression: dupVals.length ? round(mean(dupVals)) : null
		}
	};
}

export interface EvalReport {
	corpus: { items: number; queries: number; embedder: string };
	baseline: { weights: Weights; noveltyCut: number; limit: number };
	/** The baseline + alternative weight triples, all measured read-only. */
	weightSweep: VariantMetrics[];
	/** Novelty-cut sweep at the baseline weights — dup-suppression vs relevance trade-off. */
	noveltySweep: VariantMetrics[];
	/** Budget probe: live recall() under each budget, item counts + fenced token totals. */
	budgetProbe: BudgetProbe[];
	notes: string[];
}

export interface BudgetProbe {
	label: string;
	budget: { maxItems: number | null; maxTokens: number | null } | undefined;
	/** Per-query: items returned + summed fenced token estimate (recall's own unit). */
	perQuery: { queryId: string; items: number; tokens: number }[];
}

/**
 * Run the full §11 measurement. Seeds the corpus, fetches candidates ONCE per query, runs the
 * weight + novelty sweeps as pure re-scores, and runs a live budget probe through the real
 * recall() path. RECORDS — mutates no default, prunes nothing.
 */
export async function runEval(mem: MemoryService): Promise<EvalReport> {
	const seeded = await seedCorpus(mem);
	const families = dupFamilies();
	const baseWeights: Weights = { ...WMR_WEIGHTS };
	const baseCut = NOVELTY_COSINE_CUT;
	const limit = 5;

	// Fetch candidates once per query (shared by both sweeps — no per-variant re-query).
	const perQueryCands: { q: EvalQuery; cands: Cand[] }[] = [];
	for (const q of QUERIES) {
		const { cands } = await fetchCandidates(mem.db, mem.embedder, seeded, q.query);
		perQueryCands.push({ q, cands });
	}

	// Weight sweep: baseline + neighbouring triples (each sums to 1.0). MEASURE the spec's
	// 0.50/0.35/0.15 against alternatives — RECORD which scores best, do NOT adopt it.
	const weightVariants: { label: string; w: Weights }[] = [
		{ label: 'baseline (spec §4.3 0.50/0.35/0.15)', w: baseWeights },
		{ label: 'cosine-heavy 0.70/0.20/0.10', w: { cosine: 0.7, utility: 0.2, recency: 0.1 } },
		{ label: 'cosine-only 1.00/0/0', w: { cosine: 1, utility: 0, recency: 0 } },
		{ label: 'utility-heavy 0.40/0.45/0.15', w: { cosine: 0.4, utility: 0.45, recency: 0.15 } },
		{ label: 'recency-heavy 0.45/0.20/0.35', w: { cosine: 0.45, utility: 0.2, recency: 0.35 } }
	];
	const weightSweep = weightVariants.map((v) =>
		scoreVariant(v.label, v.w, baseCut, limit, perQueryCands, families)
	);

	// Novelty-cut sweep at baseline weights: lower cut = more aggressive dedup.
	const cuts = [0.85, 0.9, 0.95, baseCut, 0.99];
	const noveltySweep = cuts.map((cut) =>
		scoreVariant(
			`novelty cut ${cut}${cut === baseCut ? ' (spec §4.6 default)' : ''}`,
			baseWeights,
			cut,
			limit,
			perQueryCands,
			families
		)
	);

	// Budget probe through the REAL recall() path (B5 §4.3 tail-drop). Measures the actual
	// fenced item count + token total under: OFF, the RECALL_BUDGET starting points, and a
	// tight cap. Confirms the budget tail-drops without ever admitting an excluded row.
	const budgets: { label: string; b: { maxItems?: number | null; maxTokens?: number | null } | undefined }[] = [
		{ label: 'budget OFF (limit only)', b: undefined },
		{ label: `RECALL_BUDGET starting point (${RECALL_BUDGET.maxItems} items / ${RECALL_BUDGET.maxTokens} tok)`, b: {} },
		{ label: 'tight (3 items / 400 tok)', b: { maxItems: 3, maxTokens: 400 } }
	];
	const budgetProbe: BudgetProbe[] = [];
	for (const { label, b } of budgets) {
		const perQuery: BudgetProbe['perQuery'] = [];
		for (const q of QUERIES) {
			const res = await mem.recall(q.query, b ? { budget: b, limit: 8 } : { limit: 8 });
			// Token cost = the FENCED text cost (recall's own budget unit — fence.ts estimateTokens).
			const tokens = res.items.reduce((s, it) => s + estimateTokens(it.fenced.text), 0);
			perQuery.push({ queryId: q.id, items: res.items.length, tokens });
		}
		budgetProbe.push({
			label,
			budget: b
				? { maxItems: b.maxItems ?? RECALL_BUDGET.maxItems, maxTokens: b.maxTokens ?? RECALL_BUDGET.maxTokens }
				: undefined,
			perQuery
		});
	}

	return {
		corpus: { items: CORPUS.length, queries: QUERIES.length, embedder: mem.embedder.modelVersion },
		baseline: { weights: baseWeights, noveltyCut: baseCut, limit },
		weightSweep,
		noveltySweep,
		budgetProbe,
		notes: [
			'MEASUREMENT ONLY — no engine default was mutated and no row was pruned (D-030 ranking-only; pruning stays time-based).',
			'Numbers are on the controlled LexicalEmbedder eval corpus, NOT live qwen3 — they re-validate the SHAPE of the §11 tunables, they are not an achieved production metric (F-008).',
			'The §11 ~26% prefix-cache figure is NOT measured here (it is an Agent-SDK-path spike S.1 item, out of scope for the recall-ranking harness) — left UNKNOWN, not asserted.',
			'historical_utility is 0 across the corpus (no retrieval_outcome rows seeded) AND all rows share a near-identical seed timestamp (flat recency) — so cosine dominates the WMR score and the weight variants score IDENTICALLY here. This is itself a re-validation finding: the weights cannot be discriminated without a corpus that carries real outcome signal + age spread (a B8 follow-up corpus). The harness is the instrument; B8 supplies that corpus.',
			'Read the noveltySweep dupSuppression column: realistic near-dup PARAPHRASES on this corpus sit BELOW the §4.6 default cut (0.97), so the default does not collapse them — a lower cut suppresses more. This is a re-validation INPUT for B8 (record, do not change the default here).'
		]
	};
}

/** Render the report as a plain-text evidence artifact (CLI + test snapshot). */
export function formatReport(rep: EvalReport): string {
	const L: string[] = [];
	L.push('=== MEMORY-SPEC §11 recall-quality re-validation ===');
	L.push(`corpus: ${rep.corpus.items} items, ${rep.corpus.queries} queries, embedder=${rep.corpus.embedder}`);
	L.push(`baseline weights: cosine=${rep.baseline.weights.cosine} utility=${rep.baseline.weights.utility} recency=${rep.baseline.weights.recency}; noveltyCut=${rep.baseline.noveltyCut}; limit=${rep.baseline.limit}`);
	L.push('');
	L.push('--- WMR weight sweep (macro-avg across queries) ---');
	L.push('label | P@3 | P@5 | R@5 | MRR | nDCG@5 | dupSuppr');
	for (const v of rep.weightSweep) {
		const m = v.macro;
		L.push(`${v.label} | ${m.precisionAt3} | ${m.precisionAt5} | ${m.recallAt5} | ${m.mrr} | ${m.ndcgAt5} | ${m.dupSuppression ?? '—'}`);
	}
	L.push('');
	L.push('--- Novelty-cut sweep (macro-avg, baseline weights) ---');
	L.push('label | P@5 | R@5 | nDCG@5 | dupSuppr');
	for (const v of rep.noveltySweep) {
		const m = v.macro;
		L.push(`${v.label} | ${m.precisionAt5} | ${m.recallAt5} | ${m.ndcgAt5} | ${m.dupSuppression ?? '—'}`);
	}
	L.push('');
	L.push('--- Budget probe (live recall(); items / fenced tokens per query) ---');
	for (const p of rep.budgetProbe) {
		const totItems = p.perQuery.reduce((s, q) => s + q.items, 0);
		const totTok = p.perQuery.reduce((s, q) => s + q.tokens, 0);
		L.push(`${p.label}: total ${totItems} items, ${totTok} fenced tokens across ${p.perQuery.length} queries`);
		for (const q of p.perQuery) L.push(`    ${q.queryId}: ${q.items} items / ${q.tokens} tok`);
	}
	L.push('');
	L.push('--- Notes ---');
	for (const n of rep.notes) L.push(`• ${n}`);
	return L.join('\n');
}
