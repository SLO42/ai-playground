import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for V1R-1 ("retire the v1 residue") — the defect class is a
 * FROZEN doc asserted as LIVE / as a source of truth.
 *
 * Two real defects motivated this suite, both shipped by the commit that was
 * supposed to be fixing exactly this class:
 *
 *  1. `CLAUDE.md` and `docs/README.md` freshly certified `docs/fails.md` as "live
 *     and current". Measured, it is a bidirectional FORK of the docs-checkout copy:
 *     this copy is missing entries that are named hard rules in the operating
 *     manual (F-052 / F-058 / F-059), and the other copy is missing 28 other entries.
 *     A reader trusting "live" skips the other ledger and never sees those rules.
 *
 *  2. `docs/DESIGN-SYSTEM.md` still called `docs/design-system/` CSS the "source of
 *     truth" after the 🔒 mono-body rule (operator, 2026-06-10) superseded it —
 *     a pointer that misdirects a reader into copying pre-lock typography.
 *
 * These files have no runtime surface, so nothing else in the suite can catch them
 * regressing. The checks below are deliberately SELF-VERIFYING rather than plain
 * string matches: FORKED_ONLY_UPSTREAM is re-derived against the actual `## F-NNN`
 * headings, so appending one of those entries here fails the test and forces the
 * fork marker to be corrected instead of silently going stale again.
 *
 * The first cut of this suite enumerated the two files it had just seen fail, which
 * is the very mistake it was written to prevent: a THIRD instance of the same claim
 * survived in `docs/DECISIONS.md` ("still live and append-only") and passed green,
 * because that file was never read. The guard below therefore scans EVERY markdown
 * file in the worktree and is fail-closed for files that do not exist yet — a new
 * doc is guarded by default. Its only exemption is the frozen-snapshot set, and even
 * that is not hand-listed: it is parsed out of `CLAUDE.md`'s own declaration, so a
 * doc cannot quietly exempt itself without the operating manual saying it is history.
 *
 * Portability: everything asserted lives inside THIS worktree. The docs checkout
 * (`F:\code\ai-playground\docs\`) is intentionally NOT read — it is not guaranteed
 * to exist wherever the suite runs, and a test that needs it would be the same
 * "assume the other copy" mistake this suite exists to prevent.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file with EOLs normalized — the Edit tool flips LF→CRLF here (F-054). */
function readDoc(...segments: string[]): string {
	return readFileSync(join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * F-entry ids that exist ONLY in the docs-checkout copy of fails.md, measured
 * 2026-08-05. The fork marker in docs/fails.md promises these are absent here;
 * the tests below hold both the marker and the file to that promise.
 */
const FORKED_ONLY_UPSTREAM = [
	'F-048',
	'F-049',
	'F-050',
	'F-051',
	'F-052',
	'F-053',
	'F-054',
	'F-055',
	'F-058',
	'F-059',
	'F-060'
];

/**
 * The REVERSE direction of the fork: `## F-NNN` ids defined only in THIS worktree's
 * copy, measured 2026-08-05 by `comm`-ing the two id sets (local 47, upstream 30).
 *
 * Written out in full on purpose. The marker first stated this as the range
 * `F-017..F-047`, which is the min and max of the set rather than the set — it swept
 * in F-019, F-020, F-045 and F-046, all of which the docs-checkout copy DOES carry.
 * That is not pedantry: the fork marker designates re-unification an operator action
 * and this list is that merge's input, and F-020's own Date line records that
 * duplicate F-019 numbering ALREADY bit once here ("keeping both F-019s would have
 * made the promised cross-branch sync yield two different entries under one id").
 * A wrong id here re-creates a logged failure.
 */
const FORKED_ONLY_LOCAL = [
	'F-017',
	'F-018',
	...Array.from({ length: 24 }, (_, i) => `F-${String(21 + i).padStart(3, '0')}`), // F-021..F-044
	'F-047',
	'F-057'
];

/** The false range the docs must never re-state. Kept as the exact shipped string. */
const FALSE_REVERSE_RANGE = 'F-017..F-047';

/** Ids inside that range which BOTH copies carry — the reason the range was wrong. */
const SHARED_INSIDE_FALSE_RANGE = ['F-019', 'F-020', 'F-045', 'F-046'];

/** Every `## F-NNN` entry id actually defined in this worktree's fails.md. */
function localFailIds(): Set<string> {
	const ids = readDoc('docs', 'fails.md').matchAll(/^## (F-\d+)/gm);
	return new Set([...ids].map((m) => m[1]));
}

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'.playground',
	'build',
	'dist',
	'coverage'
]);

/** Every markdown file in the worktree, as repo-relative posix paths. */
function repoMarkdownFiles(dir = repoRoot, rel: string[] = []): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...repoMarkdownFiles(join(dir, entry.name), [...rel, entry.name]));
		} else if (entry.name.endsWith('.md')) {
			out.push([...rel, entry.name].join('/'));
		}
	}
	return out;
}

/**
 * The docs CLAUDE.md itself declares to be a frozen 2026-06 snapshot. Parsed, not
 * hand-listed: a doc may only be exempt from the currency check if the operating
 * manual says out loud that it is history.
 */
function frozenSnapshotDocs(): Set<string> {
	const bullet = /^- Frozen local snapshot[\s\S]*?(?=\n- )/m.exec(readDoc('CLAUDE.md'));
	return new Set([...(bullet?.[0] ?? '').matchAll(/`(docs\/[^`]+\.md)`/g)].map((m) => m[1]));
}

/** Expand a compact id list like `F-017, F-018, F-021..F-044, F-047` into every id. */
function expandIdList(compact: string): string[] {
	const out: string[] = [];
	for (const part of compact.split(',').map((s) => s.trim())) {
		const range = /^(F-\d+)\.\.(F-\d+)$/.exec(part);
		if (range) {
			for (let n = Number(range[1].slice(2)); n <= Number(range[2].slice(2)); n++) {
				out.push(`F-${String(n).padStart(3, '0')}`);
			}
		} else if (/^F-\d+$/.test(part)) {
			out.push(part);
		}
	}
	return out;
}

/**
 * Pull the `**missing 28 entries: ...**` claim out of a prose doc and expand it.
 * CLAUDE.md and docs/README.md state the set compactly for readability; this makes
 * the compact form checkable against the measured one instead of trusted.
 */
function statedReverseForkSet(doc: string): string[] {
	const claim = /missing 28 entries: ([^*]+)\*\*/.exec(doc);
	return expandIdList((claim?.[1] ?? '').replace(/\n>?\s*/g, ' '));
}

describe('docs pointers do not certify frozen docs as live', () => {
	it('fails.md is not claimed to be "live and current" / the full set', () => {
		// The exact phrasings that shipped and were wrong. If either returns, the
		// reader is told one ledger suffices — which is how F-052/F-058/F-059 got missed.
		const claudeMd = readDoc('CLAUDE.md');
		const readme = readDoc('docs', 'README.md');

		expect(claudeMd).not.toMatch(/`docs\/fails\.md` — live and append-only/);
		expect(readme).not.toMatch(/file in this directory that is live and current/);

		// ...and both must actively send the reader to BOTH copies.
		expect(claudeMd).toMatch(/FORKED/);
		expect(claudeMd).toMatch(/Scan BOTH/i);
		expect(readme).toMatch(/forked/i);
		expect(readme).toMatch(/both/i);
	});

	it('the fork marker names every entry this copy is actually missing', () => {
		const failsMd = readDoc('docs', 'fails.md');

		// The marker must exist and be recognizable as a MARK (never a deletion).
		expect(failsMd).toMatch(/STALE-PROPOSED: 2026-08-05/);

		for (const id of FORKED_ONLY_UPSTREAM) {
			expect(
				failsMd.includes(id),
				`fork marker in docs/fails.md must name ${id} as absent from this copy`
			).toBe(true);
		}
	});

	it('the entries the marker calls absent really are absent from this copy', () => {
		// This is the anti-staleness check: if someone later appends one of these
		// entries HERE, the marker becomes wrong and this test says so — the exact
		// silent drift that produced the original defect.
		const present = localFailIds();
		const wronglyPresent = FORKED_ONLY_UPSTREAM.filter((id) => present.has(id));

		expect(
			wronglyPresent,
			'these ids are now defined in docs/fails.md — update the fork marker + FORKED_ONLY_UPSTREAM'
		).toEqual([]);
	});

	it('fails.md still parses as a real ledger (guards the id-scan above)', () => {
		// Without this, a botched edit that broke every `## F-NNN` heading would make
		// the "really absent" check pass vacuously.
		const present = localFailIds();
		expect(present.size).toBeGreaterThan(40);
		expect(present.has('F-001')).toBe(true);
		expect(present.has('F-057')).toBe(true);
	});

	it('NO markdown in the worktree certifies fails.md as live/current/the full set', () => {
		// The class guard. Enumerating the known-bad files is what let a third instance
		// ship in docs/DECISIONS.md; this reads every .md there is.
		const frozen = frozenSnapshotDocs();
		expect(
			frozen.size,
			"parsed CLAUDE.md's frozen-snapshot bullet and got nothing — the exemption list " +
				'must never silently become empty (that would make this check vacuous)'
		).toBeGreaterThan(0);

		// Words that assert the file is whole / trustworthy on its own...
		const CURRENCY_CLAIM = /\b(live|current|authoritative|complete|up-to-date|unified|in sync|synced|the full set)\b/i;
		// ...unless the same breath discloses the fork. These are the only escapes, and
		// they are deliberately narrow: generic doc-status words like "frozen" or "stale"
		// are NOT escapes, because they routinely describe some neighbouring file. Scoped
		// loosely, DECISIONS.md:50's "still live and append-only" slipped through on the
		// strength of the *next bullet* calling the other planning docs frozen.
		const FORK_DISCLOSURE = /\b(fork|forked|neither|both)\b|not the full set/i;

		const offenders: string[] = [];
		for (const file of repoMarkdownFiles()) {
			if (frozen.has(file)) continue; // declared history by CLAUDE.md, read as such
			const lines = readDoc(...file.split('/')).split('\n');
			lines.forEach((line, i) => {
				if (!line.includes('fails.md')) return;
				// Judge the SENTENCE that names fails.md, not the line and not a window:
				// a claim may wrap onto the next line, but a currency word sitting in a
				// neighbouring sentence is about some other doc ("**4.5 Docs current.**").
				const sentences = `${line}\n${lines[i + 1] ?? ''}`.split(/(?<=[.;:])[\s\n]+/);
				const about = sentences.filter((s) => s.includes('fails.md')).join(' ');
				if (CURRENCY_CLAIM.test(about) && !FORK_DISCLOSURE.test(about)) {
					offenders.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			});
		}

		expect(
			offenders,
			'these lines assert docs/fails.md is live/current/whole without disclosing that it ' +
				'is a bidirectional fork — a reader trusting them skips the other ledger and ' +
				'never sees F-052 / F-058 / F-059'
		).toEqual([]);
	});

	it('the reverse-direction fork set is the measured 28 ids, never the F-017..F-047 range', () => {
		const failsMd = readDoc('docs', 'fails.md');
		const claudeMd = readDoc('CLAUDE.md');
		const readme = readDoc('docs', 'README.md');

		expect(FORKED_ONLY_LOCAL).toHaveLength(28);

		for (const [name, doc] of [
			['docs/fails.md', failsMd],
			['CLAUDE.md', claudeMd],
			['docs/README.md', readme]
		] as const) {
			expect(doc.includes(FALSE_REVERSE_RANGE), `${name} restates the false range`).toBe(false);
		}

		// The marker itself is the merge input, so it must name every id outright.
		for (const id of FORKED_ONLY_LOCAL) {
			expect(
				failsMd.includes(id),
				`fork marker in docs/fails.md must name ${id} as absent from the docs-checkout copy`
			).toBe(true);
		}

		// The two prose docs may compress the set — but the compression must expand to it.
		expect(statedReverseForkSet(claudeMd), 'CLAUDE.md').toEqual(FORKED_ONLY_LOCAL);
		expect(statedReverseForkSet(readme), 'docs/README.md').toEqual(FORKED_ONLY_LOCAL);
	});

	it('the ids the reverse-direction claim names really are defined in this copy', () => {
		// Self-verifying, same as the forward direction: if one of these is ever deleted
		// here the claim "absent from THAT copy, present here" becomes a lie, and an
		// operator merging on it re-runs the F-019 duplicate-numbering failure.
		const present = localFailIds();
		const missing = FORKED_ONLY_LOCAL.filter((id) => !present.has(id));

		expect(missing, 'claimed present-only-here but not defined in docs/fails.md').toEqual([]);

		// And the four ids the old range wrongly swallowed are in this copy too — they
		// are shared, which is exactly why they must not appear in the absent-from-there list.
		for (const id of SHARED_INSIDE_FALSE_RANGE) {
			expect(present.has(id), `${id} is carried by BOTH copies`).toBe(true);
			expect(FORKED_ONLY_LOCAL).not.toContain(id);
		}
	});

	it('DESIGN-SYSTEM.md does not point at the superseded design-phase CSS as truth', () => {
		const designSystem = readDoc('docs', 'DESIGN-SYSTEM.md');

		expect(designSystem).not.toMatch(
			/\*\*source of truth is the CSS\*\* in \[`docs\/design-system\/`\]/
		);
		// It must instead point at the app tokens and retract the old pointer.
		expect(designSystem).toMatch(/live source of truth is the app's token CSS/);
		expect(designSystem).toMatch(/historical design-phase reference/);
		expect(designSystem).toMatch(/mono-body rule/);
	});

	it('the design-phase CSS really does still violate the mono-body rule', () => {
		// Grounds the warning above in a fact rather than an assertion (D-039 spirit):
		// --type-body is built from --font-sans (Lastik), not a mono face.
		const typography = readDoc('docs', 'design-system', 'tokens', 'typography.css');
		expect(typography).toMatch(/--type-body:\s+.*var\(--font-sans\)/);
	});
});
