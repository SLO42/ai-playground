// MEMORY-SPEC §11 re-validation harness — pure ranking-quality metrics.
//
// All functions here are PURE (ranked-ref list + graded-relevance map → number). No DB, no
// embedder, no engine state — so they unit-test trivially and the harness can reuse them
// across the WMR-weight sweep without re-running recall. Graded relevance: 2 = directly
// relevant, 1 = supporting, 0/absent = irrelevant.
//
// SHADOW PATHS (built + tested): empty ranking ⇒ 0 (not NaN); empty relevance map (no
// relevant items exist) ⇒ recall is defined as 1 (nothing to find = perfectly found) and
// precision 0; a ranking with refs not in the map ⇒ those count as grade 0. Every divide
// guards its denominator — no NaN escapes.

/** A relevance map: ref → graded relevance (>=1 relevant). Absent ref ⇒ 0. */
export type Relevance = Record<string, number>;

function gradeOf(rel: Relevance, ref: string): number {
	const g = rel[ref];
	return typeof g === 'number' && Number.isFinite(g) && g > 0 ? g : 0;
}

/** Count of refs with grade >= 1 in the relevance map. */
export function relevantCount(rel: Relevance): number {
	let n = 0;
	for (const k of Object.keys(rel)) if (gradeOf(rel, k) > 0) n++;
	return n;
}

/** precision@k — fraction of the top-k that are relevant (grade >= 1). */
export function precisionAtK(ranked: string[], rel: Relevance, k: number): number {
	if (k <= 0) return 0;
	const top = ranked.slice(0, k);
	if (top.length === 0) return 0;
	let hit = 0;
	for (const ref of top) if (gradeOf(rel, ref) > 0) hit++;
	return hit / top.length;
}

/**
 * recall@k — fraction of all relevant items captured in the top-k. When NOTHING is relevant
 * (empty map) recall is defined as 1 (there was nothing to miss) — a deliberate shadow-path
 * convention so an all-distractor query does not report a misleading 0.
 */
export function recallAtK(ranked: string[], rel: Relevance, k: number): number {
	const total = relevantCount(rel);
	if (total === 0) return 1;
	if (k <= 0) return 0;
	const top = new Set(ranked.slice(0, k));
	let hit = 0;
	for (const ref of Object.keys(rel)) if (gradeOf(rel, ref) > 0 && top.has(ref)) hit++;
	return hit / total;
}

/** Reciprocal rank of the FIRST relevant item (0 if none in the ranking). */
export function reciprocalRank(ranked: string[], rel: Relevance): number {
	for (let i = 0; i < ranked.length; i++) {
		if (gradeOf(rel, ranked[i]) > 0) return 1 / (i + 1);
	}
	return 0;
}

/** DCG@k over graded relevance (log2 discount, standard form). */
function dcgAtK(ranked: string[], rel: Relevance, k: number): number {
	let dcg = 0;
	const top = ranked.slice(0, k);
	for (let i = 0; i < top.length; i++) {
		const g = gradeOf(rel, top[i]);
		if (g > 0) dcg += g / Math.log2(i + 2); // i+2 because positions are 1-based
	}
	return dcg;
}

/**
 * nDCG@k — DCG normalized by the ideal DCG (relevant items sorted by grade desc). Returns 1
 * when there is nothing relevant (ideal == actual == 0) — the empty-relevance shadow path.
 */
export function ndcgAtK(ranked: string[], rel: Relevance, k: number): number {
	const ideal = Object.keys(rel)
		.map((ref) => gradeOf(rel, ref))
		.filter((g) => g > 0)
		.sort((a, b) => b - a);
	let idcg = 0;
	for (let i = 0; i < Math.min(ideal.length, k); i++) idcg += ideal[i] / Math.log2(i + 2);
	if (idcg === 0) return 1; // nothing relevant ⇒ trivially ideal
	return dcgAtK(ranked, rel, k) / idcg;
}

/**
 * Novelty-gate suppression rate over near-dup families: of the families that had >=2 members
 * in the CANDIDATE pool, what fraction ended up with AT MOST ONE member in the final ranking.
 * 1.0 ⇒ every redundant family was collapsed to a single representative (the gate working);
 * lower ⇒ near-dups leaked into the result. Families with <2 candidates are not counted (no
 * redundancy to suppress). Returns null when no multi-member family was even a candidate
 * (honest "not measurable on this query", never a fabricated 1.0).
 */
export function dupSuppressionRate(
	candidateRefs: string[],
	finalRefs: string[],
	families: Record<string, string[]>
): number | null {
	const candSet = new Set(candidateRefs);
	const finalCount = (refs: string[]) => {
		const s = new Set(finalRefs);
		return refs.filter((r) => s.has(r)).length;
	};
	let measurable = 0;
	let suppressed = 0;
	for (const refs of Object.values(families)) {
		const candidatesInFamily = refs.filter((r) => candSet.has(r));
		if (candidatesInFamily.length < 2) continue; // no redundancy to suppress
		measurable++;
		if (finalCount(refs) <= 1) suppressed++;
	}
	if (measurable === 0) return null;
	return suppressed / measurable;
}

/** Arithmetic mean guarding the empty case (⇒ 0). */
export function mean(xs: number[]): number {
	if (xs.length === 0) return 0;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Round to `dp` decimal places for stable report output. */
export function round(x: number, dp = 4): number {
	const f = 10 ** dp;
	return Math.round(x * f) / f;
}
