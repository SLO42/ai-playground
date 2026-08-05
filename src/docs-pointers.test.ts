import { readFileSync } from 'node:fs';
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
 *     manual (F-052 / F-058 / F-059), and the other copy is missing F-017..F-047.
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

/** Every `## F-NNN` entry id actually defined in this worktree's fails.md. */
function localFailIds(): Set<string> {
	const ids = readDoc('docs', 'fails.md').matchAll(/^## (F-\d+)/gm);
	return new Set([...ids].map((m) => m[1]));
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
