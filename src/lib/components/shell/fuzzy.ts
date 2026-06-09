/**
 * Fuzzy subsequence matcher + ranker for the CommandPalette (UI-SPEC §3, §148).
 *
 * Pure, DOM-free logic so it is unit-testable in the node vitest env (mirrors
 * the nav.ts / nav.test.ts split). The palette component renders the result;
 * this module decides what matches and in what order.
 *
 * Matching model: a query matches a target if every query char appears, in
 * order, somewhere in the target (a subsequence) — the standard command-palette
 * "type a few letters of anywhere in the label" behaviour. Scoring rewards
 * contiguous runs, word-boundary starts, and earlier matches so the best hit
 * floats to the top.
 */

/** A scored match with the index span the query covered (for highlight). */
export interface FuzzyMatch {
	/** Higher = better. 0 only ever returned alongside `matched:false`. */
	score: number;
	/** Whether the query matched at all. */
	matched: boolean;
	/** Indices in the target that the query chars landed on (for highlighting). */
	positions: number[];
}

const SCORE_FIRST_CHAR = 12; // query's first char == target's first char
const SCORE_WORD_BOUNDARY = 8; // matched char follows a separator / case-boundary
const SCORE_CONSECUTIVE = 6; // matched char immediately follows the previous match
const SCORE_BASE = 1; // any in-order match
const PENALTY_GAP = 0.5; // per skipped char between matches (distance penalty)

function isBoundary(target: string, i: number): boolean {
	if (i === 0) return true;
	const prev = target[i - 1];
	const cur = target[i];
	if (prev === ' ' || prev === '/' || prev === '-' || prev === '_' || prev === '.') return true;
	// camelCase / lowerUpper boundary
	if (prev === prev.toLowerCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase())
		return true;
	return false;
}

/**
 * Score `query` against `target`. Case-insensitive. An empty query matches
 * everything with a neutral score (so the palette shows the full list at rest).
 */
export function fuzzyScore(query: string, target: string): FuzzyMatch {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return { score: SCORE_BASE, matched: true, positions: [] };

	const t = target.toLowerCase();
	const positions: number[] = [];
	let score = 0;
	let ti = 0;
	let lastMatch = -1;

	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		// advance through the target to the next occurrence of this query char
		let found = -1;
		for (let k = ti; k < t.length; k++) {
			if (t[k] === ch) {
				found = k;
				break;
			}
		}
		if (found === -1) return { score: 0, matched: false, positions: [] };

		positions.push(found);
		let charScore = SCORE_BASE;
		if (found === 0 && qi === 0) charScore += SCORE_FIRST_CHAR;
		if (isBoundary(target, found)) charScore += SCORE_WORD_BOUNDARY;
		if (lastMatch !== -1 && found === lastMatch + 1) charScore += SCORE_CONSECUTIVE;
		if (lastMatch !== -1) charScore -= (found - lastMatch - 1) * PENALTY_GAP;

		score += charScore;
		lastMatch = found;
		ti = found + 1;
	}

	// shorter targets that match the same query are slightly preferred (tighter hit)
	score += Math.max(0, 4 - target.length / 12);
	return { score, matched: true, positions };
}

/** A rankable item: anything with a primary `label` and optional `keywords`. */
export interface Rankable {
	label: string;
	keywords?: string[];
}

/**
 * Rank a list of items against the query, dropping non-matches. The best of
 * (label, …keywords) score is used so a hit on an alias still surfaces the item.
 * Stable for equal scores (preserves input order via index tiebreak).
 */
export function rankItems<T extends Rankable>(
	query: string,
	items: readonly T[]
): Array<{ item: T; match: FuzzyMatch }> {
	const q = query.trim();
	const scored = items.map((item, index) => {
		const targets = [item.label, ...(item.keywords ?? [])];
		let best: FuzzyMatch = { score: 0, matched: false, positions: [] };
		// the label match carries the highlight positions; keyword matches only lift score
		const labelMatch = fuzzyScore(q, item.label);
		best = labelMatch;
		for (let i = 1; i < targets.length; i++) {
			const m = fuzzyScore(q, targets[i]);
			if (m.matched && m.score > best.score) {
				// keep label positions if the label matched, else use the keyword's (no highlight)
				best = { score: m.score, matched: true, positions: labelMatch.matched ? labelMatch.positions : [] };
			}
		}
		return { item, match: best, index };
	});

	return scored
		.filter((s) => s.match.matched)
		.sort((a, b) => (b.match.score - a.match.score) || (a.index - b.index))
		.map(({ item, match }) => ({ item, match }));
}
