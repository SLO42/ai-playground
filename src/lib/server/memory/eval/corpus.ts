// MEMORY-SPEC §11 re-validation harness — labeled fixture corpus.
//
// A SMALL, hand-labeled coding-domain corpus so recall quality is MEASURABLE (graded
// relevance per query) and the novelty gate has explicit near-dup FAMILIES to suppress.
// Every memory has a stable string `ref` (NOT a SurrealDB id — the harness stores rows and
// maps ref→id at runtime). Relevance grades are 2 = directly answers, 1 = related/supporting,
// 0 = irrelevant (the rest of the corpus). nDCG/precision/recall read these grades.
//
// F-008: this is a FIXTURE corpus for measurement, never product data. It is deliberately
// authored to contain redundant near-dup families (so the §4.6 novelty-gate cut can be
// measured) and topically-disjoint distractors (so precision is not trivially 1.0).

export interface CorpusItem {
	ref: string;
	content: string;
	/** Family label — items sharing a family are intentional near-dups (novelty-gate targets). */
	family?: string;
}

export interface EvalQuery {
	id: string;
	query: string;
	/** ref → graded relevance (2 directly-relevant, 1 supporting). Unlisted refs are 0. */
	relevance: Record<string, number>;
}

// ── Corpus ──────────────────────────────────────────────────────────────────────────
// Topic clusters: DEPLOY, RUNES, DB, SECURITY, plus a near-dup family and distractors.

export const CORPUS: CorpusItem[] = [
	// DEPLOY cluster
	{ ref: 'deploy-1', content: 'the deploy pipeline builds the dashboard with the SvelteKit node adapter' },
	{ ref: 'deploy-2', content: 'deploy config runs npm run build then svelte-check with zero errors before shipping' },
	{ ref: 'deploy-3', content: 'the dashboard is served on port 5173 in dev and built for the node adapter in prod' },

	// RUNES cluster
	{ ref: 'runes-1', content: 'Svelte 5 reactive state uses the dollar-state rune not writable stores' },
	{ ref: 'runes-2', content: 'derived values use the dollar-derived rune and side effects use the dollar-effect rune' },
	{ ref: 'runes-3', content: 'runes only compile inside dot-svelte or dot-svelte-dot-ts modules not plain ts' },

	// DB cluster
	{ ref: 'db-1', content: 'SurrealDB starts on port 8000 and migrations run via npm run db up' },
	{ ref: 'db-2', content: 'every SurrealDB migration define statement must use overwrite to stay idempotent' },
	{ ref: 'db-3', content: 'coerce every SurrealDB datetime to an iso string in the row normalizer never raw' },

	// SECURITY cluster
	{ ref: 'sec-1', content: 'untrusted memory is treated as data and fenced never as model instructions' },
	{ ref: 'sec-2', content: 'a planted private key candidate is quarantined and never embedded or recalled' },

	// NEAR-DUP FAMILY (novelty-gate target): four near-identical phrasings of the same fact.
	{ ref: 'dup-a', content: 'the gateway binds to loopback only on port 18789 for security', family: 'gateway-loopback' },
	{ ref: 'dup-b', content: 'the gateway binds loopback only on port 18789 for security reasons', family: 'gateway-loopback' },
	{ ref: 'dup-c', content: 'gateway binds to loopback only port 18789 for the security policy', family: 'gateway-loopback' },
	{ ref: 'dup-d', content: 'the openclaw gateway binds loopback only on port 18789 per security', family: 'gateway-loopback' },

	// Distractors (irrelevant to every query — keep precision honest).
	{ ref: 'noise-1', content: 'the cat sat on the mat in the warm afternoon sun by the window' },
	{ ref: 'noise-2', content: 'a grocery list with milk eggs bread coffee beans and ripe bananas' },
	{ ref: 'noise-3', content: 'the tallest mountain above sea level is everest in the himalayas' }
];

// ── Queries with graded relevance ────────────────────────────────────────────────────

export const QUERIES: EvalQuery[] = [
	{
		id: 'q-deploy',
		query: 'how is the dashboard deploy pipeline configured and built',
		relevance: { 'deploy-1': 2, 'deploy-2': 2, 'deploy-3': 1, 'db-1': 1 }
	},
	{
		id: 'q-runes',
		query: 'how do svelte 5 runes work for reactive state and effects',
		relevance: { 'runes-1': 2, 'runes-2': 2, 'runes-3': 1 }
	},
	{
		id: 'q-db-migrate',
		query: 'how should surrealdb migrations and datetimes be handled',
		relevance: { 'db-2': 2, 'db-3': 2, 'db-1': 1 }
	},
	{
		id: 'q-security',
		query: 'how is untrusted memory and secret material handled securely',
		relevance: { 'sec-1': 2, 'sec-2': 2 }
	},
	{
		id: 'q-gateway',
		query: 'what port does the gateway bind to and how',
		// The family is the relevant answer; the novelty gate should surface ONE of them,
		// not flood the top-k with all four near-dups.
		relevance: { 'dup-a': 2, 'dup-b': 2, 'dup-c': 2, 'dup-d': 2 }
	}
];

/** The near-dup family refs, grouped — used to measure novelty-gate suppression. */
export function dupFamilies(): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const item of CORPUS) {
		if (!item.family) continue;
		(out[item.family] ??= []).push(item.ref);
	}
	return out;
}
