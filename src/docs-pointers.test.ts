import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for V1R-1 ("retire the v1 residue").
 *
 * THE CLASS, in one sentence: **a file in this worktree tells the reader that a doc
 * in this worktree is live / current / authoritative / complete, when that doc is in
 * fact frozen, forked or retired** — and it does so without disclosing that.
 *
 * The class has now produced FIVE instances, and each of the first four was closed
 * one at a time while the fifth sat untouched in a file nobody had opened:
 *
 *   1. `CLAUDE.md`      — "`docs/fails.md` — live and append-only"
 *   2. `docs/README.md` — "the only file in this directory that is live and current"
 *   3. `docs/DESIGN-SYSTEM.md` — the superseded design-phase CSS called "source of truth"
 *   4. `docs/DECISIONS.md:50`  — "`docs/fails.md` … is still live and append-only"
 *   5. `docs/DEVELOPMENT.md:63` — "docs/fails.md   # failure log — live, append-only"
 *
 * Instances 1, 2 and 4 were AUTHORED BY THE COMMITS THAT WERE FIXING THIS CLASS. That
 * is the tell: enumeration cannot close this: the fixer re-types the claim in the next
 * file down. So the checks below scan a CORPUS, not a list of filenames.
 *
 * ── Why the previous guard reported green on instance 5 ────────────────────────────
 * It walked every `.md`, which was right, and then did this:
 *
 *     if (frozen.has(file)) continue;   // declared history by CLAUDE.md, read as such
 *
 * `frozen` is CLAUDE.md's frozen-snapshot bullet, which names exactly the seven docs
 * MOST likely to contain a stale liveness claim — `docs/DEVELOPMENT.md` among them.
 * The guard skipped the highest-yield files in the corpus and reported zero offenders.
 *
 * The root cause is an inversion, and it is worth naming because it is easy to repeat:
 * CLAUDE.md calling a doc frozen is evidence ABOUT THE DOC BEING TALKED ABOUT — it makes
 * claims about that doc checkable. It is NOT a licence for the doc DOING THE TALKING.
 * A frozen planning doc still misdirects a reader who opens it, and "CLAUDE.md says this
 * file is history" is a fact visible only to someone reading CLAUDE.md, which is precisely
 * the "inherited a liveness claim instead of measuring it" mistake that produced #1.
 *
 * So the frozen list has been moved from the EXEMPT side to the SUBJECT side, and there
 * is no file-level exemption at all: every markdown file in the worktree is scanned, and
 * files that do not exist yet are guarded by default.
 *
 * ── The two things that keep this from going vacuous ───────────────────────────────
 *  - The subject set (`notLiveDocs()`) is DERIVED — from CLAUDE.md's own frozen bullet
 *    UNION each doc's own supersession banner — and then asserted to still contain its
 *    load-bearing members, so it cannot silently shrink to the empty set and pass.
 *  - `offendingSentence()` is exercised directly against the five strings that actually
 *    shipped ("the predicate still bites"), so a corpus that is merely clean cannot be
 *    mistaken for a predicate that still works.
 *
 * ── Deliberate boundary ────────────────────────────────────────────────────────────
 * Markdown is scanned by bare basename (max sensitivity; prose about docs is what these
 * files are). Source files are scanned too, but only for a `docs/<NAME>.md`-QUALIFIED
 * reference — the form a code comment uses to point at a doc. Scanning source by bare
 * basename matches technical uses of the same words that have nothing to do with doc
 * currency (`launch-fixtures.ts:353` "…defects that pass CI but break live … (fails.md
 * F-015)"), and rewording live code to satisfy a doc-currency guard would be the tail
 * wagging the dog — it is also exactly the pressure that produced the blanket `continue`
 * this rewrite removes.
 *
 * Portability: everything asserted lives inside THIS worktree. The docs checkout
 * (`F:\code\ai-playground\docs\`) is intentionally NOT read — it is not guaranteed to
 * exist wherever the suite runs, and a test that needs it would be the same "assume the
 * other copy" mistake this suite exists to prevent.
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

/** Every file with one of `exts` in the worktree, as repo-relative posix paths. */
function repoFiles(exts: string[], dir = repoRoot, rel: string[] = []): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...repoFiles(exts, join(dir, entry.name), [...rel, entry.name]));
		} else if (exts.some((ext) => entry.name.endsWith(ext))) {
			out.push([...rel, entry.name].join('/'));
		}
	}
	return out;
}

const repoMarkdownFiles = () => repoFiles(['.md']);
const repoSourceFiles = () => repoFiles(['.ts', '.svelte', '.js', '.mjs']);

/**
 * A doc that says, in its own opening lines, that IT is not current — the banner a
 * reader who opens the file directly actually sees.
 *
 * The self-scoping matters and was got wrong first: a bare
 * `/frozen|superseded|retired/` over the head swept in `CLAUDE.md` (line 14 says the
 * `docs/` DIRECTORY is a frozen snapshot) and `docs/DESIGN-SYSTEM.md` (its intro says
 * it supersedes part of UI-SPEC). Both were then treated as not-live SUBJECTS, and
 * every ordinary mention of them elsewhere became a false offender. A doc talking
 * about another doc's status is not a doc declaring its own.
 *
 * So the marker must (a) sit on a heading or blockquote line — banners are formatted,
 * running prose is not — and (b) either be one of the unambiguous self-marks, or bind
 * a self-reference to a non-currency word inside the same clause.
 */
const SELF_MARK = /\b(retired copy|superseded snapshot|frozen snapshot|stale-proposed)\b/i;
const SELF_SCOPED_HISTORY =
	/\bthis (?:file|doc|copy|directory|set|is a)\b[^.\n]{0,90}?\b(?:frozen|superseded|retired|redirect|snapshot|no longer|not (?:the )?current)\b/i;

/** Docs CLAUDE.md itself declares to be a frozen 2026-06 snapshot. Parsed, not hand-listed. */
function frozenSnapshotDocs(): Set<string> {
	const bullet = /^- Frozen local snapshot[\s\S]*?(?=\n- )/m.exec(readDoc('CLAUDE.md'));
	return new Set([...(bullet?.[0] ?? '').matchAll(/`(docs\/[^`]+\.md)`/g)].map((m) => m[1]));
}

/** Docs that declare their OWN non-currency in their first 15 lines. */
function selfDeclaredHistoryDocs(): Set<string> {
	const out = new Set<string>();
	for (const file of repoMarkdownFiles()) {
		const head = readDoc(...file.split('/')).split('\n').slice(0, 15);
		const banner = head.some(
			(line) => /^\s*[>#]/.test(line) && (SELF_MARK.test(line) || SELF_SCOPED_HISTORY.test(line))
		);
		if (banner) out.add(file);
	}
	return out;
}

/**
 * The SUBJECT set: every doc in this worktree that is not a live source of truth,
 * derived two independent ways so neither source can quietly empty it.
 */
function notLiveDocs(): Set<string> {
	return new Set([...frozenSnapshotDocs(), ...selfDeclaredHistoryDocs()]);
}

/**
 * Words that assert a doc is whole / trustworthy on its own.
 *
 * `live` excludes the LOCATIONAL sense — "concrete values live in DESIGN-SYSTEM.md"
 * says where something resides, not that the doc is current (UI-SPEC.md:134).
 */
const CURRENCY_CLAIM =
	/\b(live(?!-)(?!\s+(?:in|at|on|under|inside|alongside)\b)|current|authoritative|complete|up-to-date|unified|in sync|synced|the full set|source of truth)\b/i;

/**
 * ...unless the same sentence discloses that it is not. Every word here is a real
 * disclosure of non-currency, and the escape is safe ONLY because it is judged over
 * the sentence naming the doc: a 2-line window let DECISIONS.md:50's "still live and
 * append-only" through on the strength of the NEXT bullet calling other docs frozen.
 */
const NOT_LIVE_DISCLOSURE =
	/\b(fork|forked|neither|frozen|stale|snapshot|supersed\w*|historical|retired|redirect|drifted|no longer|both)\b|not the full set/i;

/** A reference to the docs-checkout copy is a claim about THAT copy, not this one. */
const UPSTREAM_PATH = /F:\\code\\ai-playground\\docs\\[A-Za-z0-9.-]*/g;

/** A newline into a new markdown block ends the sentence — a bullet/row/heading is not a clause. */
const BLOCK_BREAK = /\n(?=\s*(?:[-*+>#|]|\d+\.)\s)/;

/**
 * Does `line` (plus its continuation) assert currency about `subject` without saying
 * it is not current? Returns the offending sentence, or null.
 *
 * Kept as one small pure function on purpose: the tests below run it against the
 * historical strings, so "no offenders in the corpus" cannot be confused with
 * "predicate quietly stopped matching".
 */
function offendingSentence(line: string, nextLine: string, subject: string): string | null {
	if (!line.includes(subject)) return null;
	// Judge the SENTENCE naming the doc, not the line and not a window: a claim may wrap
	// onto the next line, but a currency word in a neighbouring sentence is about some
	// other doc — PRODUCT.md:64 names MEMORY-SPEC.md and the NEXT BULLET happens to open
	// "**One source of truth.** State lives in SurrealDB". Hence the block break.
	const sentences = `${line}\n${nextLine}`.split(BLOCK_BREAK).flatMap((block) =>
		// `.)` closes a sentence too — "(Engine detail in MEMORY-SPEC.md.)"
		block.split(/(?<=[.;:!?]\)?)[\s\n]+/)
	);
	for (const sentence of sentences) {
		// Normalize markdown before judging: emphasis and line-wrapping split the
		// DISCLOSURE clean in half at DECISIONS.md:50 — "it is **not\n   the full set**"
		// read as a currency claim ("the full set") with no disclosure, when the file
		// says the opposite of what it was flagged for.
		const flat = sentence.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
		// Strip docs-checkout references — "the live ledger is
		// `F:\code\ai-playground\docs\DECISIONS.md`" is true and must not be flagged.
		const local = flat.replace(UPSTREAM_PATH, '<upstream>');
		if (!local.includes(subject)) continue;
		if (CURRENCY_CLAIM.test(local) && !NOT_LIVE_DISCLOSURE.test(local)) return flat.trim();
	}
	return null;
}

/** Scan a corpus for the class. `subjectsFor` decides how a doc is referenced there. */
function scanCorpus(files: string[], subjectsFor: (doc: string) => string[]): string[] {
	const subjects = [...notLiveDocs()].flatMap((doc) =>
		subjectsFor(doc).map((subject) => ({ doc, subject }))
	);
	const offenders: string[] = [];
	for (const file of files) {
		const lines = readDoc(...file.split('/')).split('\n');
		lines.forEach((line, i) => {
			for (const { doc, subject } of subjects) {
				// The ONLY skip in this scan, and it is load-bearing on another test rather
				// than taken on faith: a subject doc's own stale prose (fails.md's original
				// "synced to both branches … the full set") is handled by MARKING, never
				// deleting — CLAUDE.md §6. That marking is what makes the skip safe, so it
				// is asserted: every member of the subject set is either self-declared
				// history or is in CLAUDE.md's frozen list, and the "says so in its OWN
				// first lines" test forces the latter to carry a banner too. If that test
				// ever goes red, this skip is unsafe and the suite is already failing.
				if (file === doc) continue;
				const hit = offendingSentence(line, lines[i + 1] ?? '', subject);
				if (hit) offenders.push(`${file}:${i + 1} [${doc}] ${hit.slice(0, 160)}`);
			}
		});
	}
	return [...new Set(offenders)];
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

describe('the not-live doc set is derived, and cannot go vacuous', () => {
	it('CLAUDE.md still declares a frozen-snapshot set', () => {
		expect(
			frozenSnapshotDocs().size,
			"parsed CLAUDE.md's frozen-snapshot bullet and got nothing — every check below " +
				'would then be scanning for nothing and passing'
		).toBeGreaterThan(0);
	});

	it('every doc CLAUDE.md calls history says so in its OWN first lines', () => {
		// Otherwise "this file is frozen" is a fact only a CLAUDE.md reader has, and a
		// reader who opens the doc directly is told nothing — the same inherited-claim
		// mistake that certified fails.md as live without measuring it.
		const undeclared = [...frozenSnapshotDocs()].filter((f) => !selfDeclaredHistoryDocs().has(f));
		expect(
			undeclared,
			'CLAUDE.md calls these frozen but they do not; a reader opening them directly is ' +
				'given no signal. Add a supersession banner to the first 15 lines.'
		).toEqual([]);
	});

	it('the subject set still contains the docs that produced this class', () => {
		// Anti-vacuity: if a rename or a reworded banner drops one of these, the scans
		// below silently stop looking for the exact defects they exist to catch.
		const subjects = notLiveDocs();
		for (const doc of [
			'docs/fails.md',
			'docs/DECISIONS.md',
			'docs/DOCS-REALITY.md',
			'docs/README.md',
			'docs/DEVELOPMENT.md'
		]) {
			expect(subjects.has(doc), `${doc} dropped out of the not-live subject set`).toBe(true);
		}
	});
});

describe('no file certifies a frozen/forked doc as live', () => {
	it('the predicate still bites — every string that actually shipped is caught', () => {
		// The corpus being clean proves nothing if the predicate stopped matching. These
		// are the five real instances, verbatim.
		const shipped: [string, string, string][] = [
			['- `docs/fails.md` — live and append-only in this worktree.', '', 'docs/fails.md'],
			[
				'| `docs/fails.md` | The only file in this directory that is live and current. |',
				'',
				'docs/fails.md'
			],
			[
				'the **source of truth is the CSS** in [`docs/design-system/`] — copy the values.',
				'',
				'docs/design-system/'
			],
			['- `docs/fails.md` in this worktree is still live and append-only.', '', 'docs/fails.md'],
			['  docs/fails.md              # failure log — live, append-only', '', 'docs/fails.md']
		];
		for (const [line, next, subject] of shipped) {
			expect(offendingSentence(line, next, subject), `missed: ${line.trim()}`).not.toBeNull();
		}

		// ...and does not bite an honest disclosure, or a claim about the upstream copy.
		expect(
			offendingSentence(
				'- `docs/fails.md` — FORKED from the docs-checkout copy. Scan BOTH.',
				'',
				'docs/fails.md'
			)
		).toBeNull();
		expect(
			offendingSentence(
				'see D-000 in the live ledger, `F:\\code\\ai-playground\\docs\\DECISIONS.md`.',
				'',
				'DECISIONS.md'
			)
		).toBeNull();
	});

	it('NO markdown in the worktree asserts a not-live doc is live/current/whole', () => {
		const files = repoMarkdownFiles();
		// Non-vacuity: the walker must actually be finding the corpus.
		expect(files.length).toBeGreaterThan(20);
		expect(files).toContain('CLAUDE.md');
		expect(files).toContain('docs/DEVELOPMENT.md'); // the file the old `continue` skipped

		const offenders = scanCorpus(files, (doc) => [doc, doc.split('/').pop()!]);

		expect(
			offenders,
			'these lines tell a reader that a frozen/forked/retired doc is live, current or ' +
				'the whole story, without disclosing that it is not. A reader trusting them ' +
				'stops at one ledger and never sees F-052 / F-058 / F-059.'
		).toEqual([]);
	});

	it('NO source file points at a not-live doc as live/current/whole', () => {
		const files = repoSourceFiles();
		expect(files.length).toBeGreaterThan(100);

		// Qualified `docs/<NAME>.md` only — see the "deliberate boundary" note at the top.
		const offenders = scanCorpus(
			files.filter((f) => f !== 'src/docs-pointers.test.ts'), // this file quotes the defects verbatim
			(doc) => (doc.startsWith('docs/') ? [doc] : [])
		);

		expect(offenders, 'a code comment sends the reader to a frozen doc as if it were current').toEqual(
			[]
		);
	});
});

describe('the fails.md fork marker is accurate in both directions', () => {
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
});

describe('DESIGN-SYSTEM.md does not point at superseded CSS as truth', () => {
	it('the superseded design-phase pointer is retracted', () => {
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
