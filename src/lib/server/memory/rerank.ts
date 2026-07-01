// S2 — learned reranker (COGNITIVE-ARCHITECTURE §5; D-030 ranking-only).
//
// An ACAN-STYLE learned reranker over `retrieval_outcome` utilization labels. It is a
// RE-ORDERING LAYER on top of the heuristic recall candidate set (recall.ts) — the WMR
// heuristic stays the BASELINE and the FALLBACK. When the reranker has no trustworthy
// signal (cold start: too few feature-bearing labeled outcome rows, or a single-class set),
// `trainReranker` returns null and recall keeps the baseline WMR order — an HONEST passthrough
// (F-008), never a fabricated learned score.
//
// WHY LINEAR, NOT A CROSS-ENCODER: the doc marks the BGE cross-encoder OPTIONAL. This slice is
// a lightweight, deterministic, in-process logistic model over the SAME features the heuristic
// already computes (cosine, historical utility, recency, was-neighbor) — trained offline from
// the outcome rows by batch gradient descent with a fixed schedule (weights init to 0, no RNG),
// so it is fully reproducible and unit-testable. No new external dependency.
//
// DATA SOURCE (real labels only): each `retrieval_outcome` row recorded AFTER m0075 carries the
// recall-time feature breakdown (`feat_cosine`/`feat_utility`/`feat_recency`, + the existing
// `was_neighbor`) and a label — `utilized` (bool), refined by the S1 `llm_relevance` verdict
// (helpful/pin ⇒ positive; irrelevant/outdated ⇒ negative). Rows written before m0075 have NONE
// features and are skipped (not enough signal ⇒ passthrough). No training data is invented.
//
// D-026: features are NUMERIC only (no content) — nothing screened is read or persisted here.

import type { Db } from '../db/client';
import { StringRecordId } from 'surrealdb';
import { assertRecordId } from '../db/validate';

/** The learned reranker feature names (stable order — the persisted weight fields mirror these). */
export const RERANK_FEATURES = ['cosine', 'utility', 'recency', 'wasNeighbor'] as const;
export type RerankFeatureName = (typeof RERANK_FEATURES)[number];

/** The per-candidate feature vector — the SAME signals recall's WMR score reads. */
export interface RerankFeatures {
	/** cosine similarity to the query (§7.2 boundary; typically [0,1]). */
	cosine: number;
	/** historical utilization curve util/(util+3) ∈ [0,1) (retrieval_outcome, D-030). */
	utility: number;
	/** recency decay ∈ [0,1] (half-life). */
	recency: number;
	/** 1 when the candidate arrived via 1-hop graph expansion, else 0. */
	wasNeighbor: number;
}

/** The learned linear weights (a logit = w·features + bias). */
export interface RerankWeights {
	cosine: number;
	utility: number;
	recency: number;
	wasNeighbor: number;
	bias: number;
}

/** One labeled training example: features + a {0,1} utilization label. */
export interface LabeledExample {
	features: RerankFeatures;
	label: number;
}

/**
 * OFF by default. The reranker is opt-in until (a) live feature-bearing labels accrue and (b)
 * the eval harness shows reranked ≥ baseline. Even when enabled, `recall()` still passes through
 * the baseline order on cold start (no active weights). Flip to enable once both hold.
 */
export const RERANK_DEFAULT_ENABLED = false;

/**
 * Minimum feature-bearing labeled examples before training is trustworthy, and the minimum count
 * in EACH class. Below either, `trainReranker` returns null ⇒ recall passes through baseline.
 */
export const RERANK_MIN_EXAMPLES = 20;
export const RERANK_MIN_PER_CLASS = 5;

// Fixed training schedule ⇒ deterministic (weights init to 0, no randomness).
const LEARNING_RATE = 0.3;
const ITERATIONS = 400;
const L2 = 1e-4;

/** Sigmoid (numerically guarded). */
function sigmoid(z: number): number {
	if (z >= 0) {
		const e = Math.exp(-z);
		return 1 / (1 + e);
	}
	const e = Math.exp(z);
	return e / (1 + e);
}

/**
 * The learned score for one candidate = the raw logit (w·features + bias). Ordering by the logit
 * is identical to ordering by the sigmoid probability (monotone), so no sigmoid is needed to rank.
 */
export function scoreFeatures(f: RerankFeatures, w: RerankWeights): number {
	return (
		w.cosine * f.cosine +
		w.utility * f.utility +
		w.recency * f.recency +
		w.wasNeighbor * f.wasNeighbor +
		w.bias
	);
}

/**
 * Map an S1 `llm_relevance` verdict + `utilized` bool to a {0,1} training label. The explicit
 * verdict (when present) OVERRIDES the implicit utilization signal: helpful/pin ⇒ 1,
 * irrelevant/outdated ⇒ 0; absent verdict ⇒ fall back to `utilized`.
 */
export function labelFor(utilized: boolean, llmRelevance?: string | null): number {
	if (llmRelevance === 'helpful' || llmRelevance === 'pin') return 1;
	if (llmRelevance === 'irrelevant' || llmRelevance === 'outdated') return 0;
	return utilized ? 1 : 0;
}

/**
 * Train the reranker from labeled examples by deterministic batch gradient descent on the
 * logistic loss (L2-regularized). Returns null on COLD START — too few examples or a single-class
 * set — so the caller passes through the baseline order rather than scoring on noise (F-008).
 */
export function trainReranker(examples: LabeledExample[]): RerankWeights | null {
	if (examples.length < RERANK_MIN_EXAMPLES) return null;
	let pos = 0;
	for (const e of examples) if (e.label >= 0.5) pos++;
	const neg = examples.length - pos;
	if (pos < RERANK_MIN_PER_CLASS || neg < RERANK_MIN_PER_CLASS) return null;

	const w: RerankWeights = { cosine: 0, utility: 0, recency: 0, wasNeighbor: 0, bias: 0 };
	const n = examples.length;
	for (let it = 0; it < ITERATIONS; it++) {
		let gC = 0, gU = 0, gR = 0, gN = 0, gB = 0;
		for (const ex of examples) {
			const p = sigmoid(scoreFeatures(ex.features, w));
			const err = p - ex.label;
			gC += err * ex.features.cosine;
			gU += err * ex.features.utility;
			gR += err * ex.features.recency;
			gN += err * ex.features.wasNeighbor;
			gB += err;
		}
		w.cosine -= LEARNING_RATE * (gC / n + L2 * w.cosine);
		w.utility -= LEARNING_RATE * (gU / n + L2 * w.utility);
		w.recency -= LEARNING_RATE * (gR / n + L2 * w.recency);
		w.wasNeighbor -= LEARNING_RATE * (gN / n + L2 * w.wasNeighbor);
		w.bias -= LEARNING_RATE * (gB / n);
	}
	return w;
}

/**
 * Re-order a candidate set by the learned score (descending). Pure — returns a NEW array, never
 * mutates the input. `sortKey` reads each item's features; the reranker re-orders the SAME set
 * the heuristic produced (baseline preserved as the fallback when this is not called).
 */
export function applyRerank<T>(
	candidates: T[],
	features: (c: T) => RerankFeatures,
	weights: RerankWeights
): T[] {
	return candidates
		.map((c) => ({ c, s: scoreFeatures(features(c), weights) }))
		.sort((a, b) => b.s - a.s)
		.map((x) => x.c);
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Load the feature-bearing labeled examples from `retrieval_outcome` (rows recorded after m0075
 * carry `feat_*`; older rows are excluded — `feat_cosine IS NOT NONE`). Label = `labelFor`.
 * Read-only, numeric-only (D-026). This is the reranker's TRAINING INPUT (D-030 ranking-only).
 */
export async function loadTrainingExamples(db: Db, project?: string): Promise<LabeledExample[]> {
	const projFilter = project ? `AND memory.project = $project` : '';
	const [rows] = await db.query<
		[
			Array<{
				feat_cosine: number;
				feat_utility: number;
				feat_recency: number;
				was_neighbor?: boolean;
				utilized?: boolean;
				llm_relevance?: string | null;
			}>
		]
	>(
		`SELECT feat_cosine, feat_utility, feat_recency, was_neighbor, utilized, llm_relevance
		   FROM retrieval_outcome
		  WHERE feat_cosine IS NOT NONE
		    AND feat_utility IS NOT NONE
		    AND feat_recency IS NOT NONE
		    ${projFilter};`,
		project ? { project: link(project) } : {}
	);
	const out: LabeledExample[] = [];
	for (const r of rows) {
		out.push({
			features: {
				cosine: Number(r.feat_cosine) || 0,
				utility: Number(r.feat_utility) || 0,
				recency: Number(r.feat_recency) || 0,
				wasNeighbor: r.was_neighbor ? 1 : 0
			},
			label: labelFor(r.utilized === true, r.llm_relevance)
		});
	}
	return out;
}

/**
 * Load the ACTIVE learned weights (the most recently trained `reranker_model` row with
 * status='active'). Returns null when no model has been trained yet — the cold-start signal
 * `recall()` reads to stay on the baseline order (F-008 honest passthrough).
 */
export async function loadActiveWeights(db: Db): Promise<RerankWeights | null> {
	const [rows] = await db.query<
		[
			Array<{
				w_cosine: number;
				w_utility: number;
				w_recency: number;
				w_neighbor: number;
				bias: number;
			}>
		]
	>(
		// SurrealDB requires every ORDER BY idiom to appear in the projection (F-020) — SELECT
		// created_at so `ORDER BY created_at` is legal; it is ignored in the mapping below.
		`SELECT w_cosine, w_utility, w_recency, w_neighbor, bias, created_at
		   FROM reranker_model
		  WHERE status = "active"
		  ORDER BY created_at DESC
		  LIMIT 1;`
	);
	if (!rows.length) return null;
	const r = rows[0];
	return {
		cosine: Number(r.w_cosine) || 0,
		utility: Number(r.w_utility) || 0,
		recency: Number(r.w_recency) || 0,
		wasNeighbor: Number(r.w_neighbor) || 0,
		bias: Number(r.bias) || 0
	};
}

export interface SaveWeightsMeta {
	nExamples: number;
	/** Measured eval delta (reranked − baseline on a metric), when known. */
	evalDelta?: number;
}

/**
 * Persist a freshly-trained model as the new ACTIVE `reranker_model`, retiring any prior active
 * model first (so `loadActiveWeights` always resolves at most one). Additive telemetry — never
 * prunes memory or mutates a recall default (D-030/D-015). Returns the new row id.
 */
export async function saveWeights(
	db: Db,
	weights: RerankWeights,
	meta: SaveWeightsMeta
): Promise<string> {
	await db.query(`UPDATE reranker_model SET status = "retired" WHERE status = "active";`);
	const content: Record<string, unknown> = {
		w_cosine: weights.cosine,
		w_utility: weights.utility,
		w_recency: weights.recency,
		w_neighbor: weights.wasNeighbor,
		bias: weights.bias,
		n_examples: meta.nExamples,
		status: 'active'
	};
	if (meta.evalDelta != null && Number.isFinite(meta.evalDelta)) content.eval_delta = meta.evalDelta;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE reranker_model CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(rows[0].id);
}

/**
 * Train from the live outcome rows and persist if trainable. Returns the weights (and whether
 * they were persisted) or a cold-start reason. This is the OFFLINE training entry point (a
 * maintenance/heartbeat caller); `recall()` only ever READS the active weights, never trains.
 */
export async function trainAndPersist(
	db: Db,
	opts?: { project?: string; evalDelta?: number; persist?: boolean }
): Promise<{ weights: RerankWeights | null; nExamples: number; persisted: boolean; reason?: string }> {
	const examples = await loadTrainingExamples(db, opts?.project);
	const weights = trainReranker(examples);
	if (!weights) {
		return {
			weights: null,
			nExamples: examples.length,
			persisted: false,
			reason:
				examples.length < RERANK_MIN_EXAMPLES
					? `cold start — ${examples.length} feature-bearing labeled rows (< ${RERANK_MIN_EXAMPLES} required)`
					: `cold start — single-class label set (need ≥ ${RERANK_MIN_PER_CLASS} of each class)`
		};
	}
	let persisted = false;
	if (opts?.persist !== false) {
		await saveWeights(db, weights, { nExamples: examples.length, evalDelta: opts?.evalDelta });
		persisted = true;
	}
	return { weights, nExamples: examples.length, persisted };
}
