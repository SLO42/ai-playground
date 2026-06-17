// server/create/anti-sycophancy — the SINGLE SOURCE of the anti-sycophancy banned-phrase
// list + its detector (CREATE-SPEC §3).
//
// CREATE-SPEC §3 mandates that the create agent's clarifiers and proposal TAKE POSITIONS:
// state what WILL/WON'T work on the evidence in the brief, and pair every position with its
// FALSIFIER (the evidence that would change it). The five hedge phrases below are the banned
// sycophantic openers — language that defers instead of committing. This module is the SINGLE
// SOURCE of that list: PM-SPEC §1 / pm-panel.ts's falsifier convention references THIS, so the
// list lives here once and is never re-typed elsewhere.
//
// Pure module (no DB, no I/O, no runes) — safe to import anywhere on the server.

/**
 * The banned sycophantic phrases (CREATE-SPEC §3). Lower-cased, canonical forms — the
 * detector matches case-insensitively and tolerates straight/curly apostrophes. This is the
 * SINGLE SOURCE: do not re-declare this list anywhere else (PM-SPEC §1 references it).
 *
 * Frozen so a downstream consumer cannot mutate the shared source.
 */
export const BANNED_SYCOPHANCY_PHRASES: readonly string[] = Object.freeze([
	'that is an interesting approach',
	'there are many ways to think about this',
	'you might want to consider',
	'that could work',
	'i can see why you would think that'
]);

/** One detected banned-phrase hit: which phrase, and the character index where it began. */
export interface SycophancyHit {
	/** The canonical banned phrase (from BANNED_SYCOPHANCY_PHRASES) that matched. */
	phrase: string;
	/** Byte index into the NORMALIZED text where the match began (for audit/explain). */
	index: number;
}

/** The result of scanning text for banned phrases. `clean` ⇔ `hits.length === 0`. */
export interface SycophancyScan {
	clean: boolean;
	hits: SycophancyHit[];
}

/**
 * Normalize text for matching: lower-case, fold curly apostrophes (’ → ') and the
 * contraction-eliding "'d/'ll/'re/'s/n't" so "you'd think that" matches the canonical
 * "you would think that", and collapse internal whitespace runs to a single space.
 *
 * Shadow paths (SHADOW PATHS rail): nil/undefined → '' (no throw); empty → '' (clean).
 */
function normalize(text: string | null | undefined): string {
	if (text == null) return '';
	let s = String(text).toLowerCase();
	// Fold curly/smart apostrophes to a straight one BEFORE expanding contractions.
	s = s.replace(/[‘’ʼ]/g, "'");
	// Expand the contractions that appear in the banned phrases' natural variants so a
	// hedge written "you'd think that" / "I'd think that" still trips. Order matters:
	// expand "'d think" before stripping generic apostrophes.
	s = s
		.replace(/\byou'd\b/g, 'you would')
		.replace(/\bi'd\b/g, 'i would')
		.replace(/\bthat's\b/g, 'that is')
		.replace(/\bthere's\b/g, 'there is');
	// Collapse any whitespace run (incl. newlines/tabs) to a single space, then trim.
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

/**
 * Scan `text` for any banned sycophantic phrase (CREATE-SPEC §3). Case-insensitive,
 * apostrophe/contraction-tolerant, whitespace-insensitive. Returns EVERY hit (not just the
 * first) so the caller can report all offending spans.
 *
 * EVERY ERROR HAS A NAME: this does not throw — it RETURNS a structured verdict. The trigger
 * is "a banned phrase is present in agent-authored text"; the catcher is whoever calls this at
 * the proposal/clarifier boundary; the user-visible effect is the proposal being rejected
 * (SycophancyError, thrown by the caller) rather than a hedge reaching the operator.
 *
 * Shadow paths: nil input → clean (nothing to scan); empty/whitespace → clean.
 */
export function scanForSycophancy(text: string | null | undefined): SycophancyScan {
	const norm = normalize(text);
	if (norm === '') return { clean: true, hits: [] };
	const hits: SycophancyHit[] = [];
	for (const phrase of BANNED_SYCOPHANCY_PHRASES) {
		// A phrase may appear more than once; find every occurrence.
		let from = 0;
		for (;;) {
			const idx = norm.indexOf(phrase, from);
			if (idx === -1) break;
			hits.push({ phrase, index: idx });
			from = idx + phrase.length;
		}
	}
	// Stable order: by position, then by phrase, so the report is deterministic.
	hits.sort((a, b) => a.index - b.index || a.phrase.localeCompare(b.phrase));
	return { clean: hits.length === 0, hits };
}

/** Convenience boolean: does `text` contain ANY banned phrase? */
export function hasSycophancy(text: string | null | undefined): boolean {
	return !scanForSycophancy(text).clean;
}

/**
 * The named error the proposal/clarifier boundary throws when agent-authored text trips the
 * anti-sycophancy detector. Carries the hits so the caller can surface exactly which phrases
 * (and where) offended — never a bare catch-all.
 */
export class SycophancyError extends Error {
	readonly hits: SycophancyHit[];
	constructor(message: string, hits: SycophancyHit[]) {
		super(message);
		this.name = 'SycophancyError';
		this.hits = hits;
	}
}

/**
 * Assert that every string in `texts` is free of banned phrases, throwing SycophancyError
 * (NAMED) listing all offending phrases when any trips. Used by the proposal generator to
 * enforce §3 across the clarifiers + every position string before a proposal is returned.
 *
 * Shadow paths: empty array → no-op (vacuously clean); nil/empty members → skipped (clean).
 */
export function assertNoSycophancy(texts: readonly (string | null | undefined)[]): void {
	const allHits: SycophancyHit[] = [];
	for (const t of texts) {
		const scan = scanForSycophancy(t);
		if (!scan.clean) allHits.push(...scan.hits);
	}
	if (allHits.length > 0) {
		const phrases = [...new Set(allHits.map((h) => h.phrase))];
		throw new SycophancyError(
			`anti-sycophancy violation (CREATE-SPEC §3): ${allHits.length} banned-phrase hit(s) — ` +
				`[${phrases.map((p) => JSON.stringify(p)).join(', ')}]`,
			allHits
		);
	}
}
