import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	TERMINAL_RUN_STATUSES,
	NON_TERMINAL_RUN_STATUSES,
	isScoredStatus
} from './interview-status';

// ── THE SCHEMA-PARITY TEST ────────────────────────────────────────────────────────────────
// The prior review flagged that the status sweeps hand-COPIED the enum: a comment claiming "the
// whole schema enum" over a literal array that nothing checked. A status added to
// `db/schema.ts` tomorrow would simply be absent from every sweep, and every test would stay
// green while the new status went unclassified.
//
// So this test does not restate the enum — it PARSES it out of the schema source and compares.
// The classification in `interview-status.ts` is then provably exhaustive, and adding a status
// to the ASSERT fails HERE, by name, until someone decides whether it is scored.
//
// It reads the source text rather than importing `schemaMigrations` on purpose: the enum is a
// SurrealQL string literal inside a migration, so there is no exported value to import, and
// booting the migration list to read one ASSERT would drag the whole server tree into a
// client-side unit test.
const SCHEMA_PATH = fileURLToPath(new URL('../server/db/schema.ts', import.meta.url));

// THE ANCHOR MUST READ THE *EFFECTIVE* ENUM, NOT THE FIRST ONE WRITTEN.
// This parser originally used `src.match(...)` — no /g — which returns the FIRST occurrence.
// That is the wrong end of the file. A field is not defined once here: the dominant migration
// idiom in `schema.ts` is a SECOND `DEFINE FIELD OVERWRITE <field> ON <table>` in a LATER
// migration, and SurrealDB `OVERWRITE` semantics mean the LAST one applied is the one in force
// (measured in this file: `type ON agent_event` ×6, `kind ON scene_event` ×4, `status ON task` ×2,
// `op ON role_event` ×2). So a migration that WIDENS `interview_run.status` tomorrow would leave
// this test reading the narrow original enum and passing green with the new status unclassified —
// i.e. the exact defect class the parity test exists to close would still be open.
// Now: every occurrence, LAST wins, and zero occurrences throw.
//
// TWO MORE SILENT-GREEN MODES OF THE SAME CLASS, both closed below. The first cut matched
// `DEFINE FIELD OVERWRITE status ... {0,200}? ASSERT $value IN [...]` — a DEFINE plus a lazy
// 200-char window. That shape is blind in two ways, and BOTH end in a green test over an
// unanchored gate, which is worse than no test at all:
//
//   ① A LATER re-DEFINE THAT DROPS THE ASSERT WAS INVISIBLE. `DEFINE FIELD OVERWRITE status ON
//      interview_run TYPE string DEFAULT "running";` is a perfectly ordinary migration line, and
//      it makes the column accept ANY string. The old pattern simply failed to match it, silently
//      fell back to the earlier constrained DEFINE, and reported the OLD enum as effective — so
//      the parity test would keep certifying a classification that the schema no longer enforces.
//      Worse, the 200-char window could jump the statement boundary entirely and bind a
//      NEIGHBOURING field's `ASSERT $value IN [...]` to the status DEFINE (the fields around it —
//      `tier`, `error_reason` — carry their own enums), reporting some other column's values as
//      the status set. Fixed by matching a whole STATEMENT: `[^;]*` cannot cross the `;`, so the
//      ASSERT found always belongs to this field, and an effective DEFINE with no ASSERT THROWS.
//
//   ② A re-DEFINE WITHOUT `OVERWRITE` WAS INVISIBLE, and "last wins" is not even true for one.
//      F-015 blesses `IF NOT EXISTS` alongside `OVERWRITE`, and the old pattern hard-required the
//      literal `OVERWRITE` — so `DEFINE FIELD IF NOT EXISTS status ON interview_run ...` matched
//      nothing and the parser read the older DEFINE. That is right by accident and wrong in
//      general: `IF NOT EXISTS` is a NO-OP over an existing field, so the EARLIER define stays
//      effective — the opposite of last-wins — while a bare `DEFINE FIELD` re-define errors
//      outright. Rather than guess apply history from source text, the parser now SEES both forms
//      and THROWS when a re-define is anything other than `OVERWRITE`, naming the form it found.
//
// The polarity of every one of these is "throw and make a human re-anchor", never "assume".
const STATUS_DEFINE_RE =
	/DEFINE FIELD\s+(OVERWRITE|IF NOT EXISTS)?\s*status\s+ON\s+(?:TABLE\s+)?interview_run\b([^;]*);/g;
const ASSERT_ENUM_RE = /ASSERT\s+\$value\s+IN\s+\[([^\]]*)\]/;
const QUOTED_RE = /(["'])([^"']+)\1/g;

/**
 * The EFFECTIVE `interview_run.status` ASSERT set for a schema source.
 *
 * Exposed with an injectable `src` so the last-wins property itself is testable without mutating
 * the real `schema.ts` (the only way the original bug was found was by hand-editing it).
 *
 * EVERY ERROR HERE HAS A NAME. Four throws, four distinct causes, each stated in the message:
 * no DEFINE at all (renamed/dropped field), a non-OVERWRITE re-define (apply order unknowable
 * from source), an effective DEFINE with no ASSERT (column unconstrained), and an ASSERT whose
 * list yields no values (quoting the parser does not understand).
 */
export function parseStatusEnum(src: string): string[] {
	// F-054: the editor flips LF→CRLF on this repo, so normalize before any multi-line match.
	const matches = [...src.replace(/\r\n/g, '\n').matchAll(STATUS_DEFINE_RE)];
	if (matches.length === 0) {
		throw new Error(
			'could not locate the interview_run.status ASSERT in db/schema.ts — the field was renamed, ' +
				'reshaped, or the ASSERT was dropped. Re-anchor this test before trusting any status gate.'
		);
	}
	// ② Every RE-define must be an OVERWRITE for "last textual wins" to hold.
	for (let i = 1; i < matches.length; i++) {
		if (matches[i][1] !== 'OVERWRITE') {
			throw new Error(
				`re-DEFINE #${i + 1} of interview_run.status is '${matches[i][1] ?? 'a bare DEFINE FIELD'}', ` +
					'not OVERWRITE — which definition is EFFECTIVE can no longer be read off the source ' +
					'text (IF NOT EXISTS is a no-op over an existing field, so the EARLIER one stays in ' +
					'force; a bare re-DEFINE errors on apply). Re-anchor this test before trusting any ' +
					'status gate.'
			);
		}
	}
	// LAST, not first: later migrations OVERWRITE earlier ones.
	const body = matches[matches.length - 1][2];
	// ① The EFFECTIVE define must itself carry the ASSERT. Scoped to this statement by `[^;]*`,
	// so a neighbouring field's enum can never be mistaken for the status enum.
	const assert = ASSERT_ENUM_RE.exec(body);
	if (!assert) {
		throw new Error(
			'the EFFECTIVE DEFINE of interview_run.status carries NO `ASSERT $value IN [...]` — the ' +
				'column accepts any string, so the status classification in interview-status.ts is ' +
				'anchored to nothing. Restore the ASSERT or re-anchor this test.'
		);
	}
	const statuses = [...assert[1].matchAll(QUOTED_RE)].map((x) => x[2]);
	if (statuses.length === 0) {
		throw new Error(
			`the interview_run.status ASSERT list parsed to ZERO values (raw: '${assert[1].trim()}') — an ` +
				'empty set makes every parity assertion vacuously true. Re-anchor this test.'
		);
	}
	return statuses;
}

/** The `interview_run.status` ASSERT set, read out of the live schema source. */
function schemaStatuses(): string[] {
	return parseStatusEnum(readFileSync(SCHEMA_PATH, 'utf8'));
}

// ── REGRESSION: the anchor must survive a LATER re-DEFINE ─────────────────────────────────────
// These are the tests that would have failed on the first-match parser. They are the reason the
// parity guarantee below is worth anything.
describe('schema anchor — the parser reads the EFFECTIVE enum', () => {
	const FIRST = `
		DEFINE FIELD OVERWRITE status          ON interview_run TYPE string DEFAULT "running"
			ASSERT $value IN ["running","adjudicating","passed","failed","error"];
	`;
	const WIDENED = `
		DEFINE FIELD OVERWRITE status          ON interview_run TYPE string DEFAULT "running"
			ASSERT $value IN ["running","adjudicating","passed","failed","error","cancelled"];
	`;

	it('takes the LAST re-DEFINE, not the first — a later migration widening the enum is seen', () => {
		// The exact shape of a widening migration in this repo: the original DEFINE stays in its
		// original migration, and a later migration re-DEFINEs the field with a bigger ASSERT.
		expect(parseStatusEnum(`${FIRST}\n-- ...later migration...\n${WIDENED}`)).toContain('cancelled');
	});

	it('a later NARROWING re-DEFINE is seen too — the anchor is not "the union"', () => {
		expect(parseStatusEnum(`${WIDENED}\n${FIRST}`)).not.toContain('cancelled');
	});

	it('a single DEFINE still parses (the ordinary case is unchanged)', () => {
		expect(parseStatusEnum(FIRST)).toEqual([
			'running',
			'adjudicating',
			'passed',
			'failed',
			'error'
		]);
	});

	it('ZERO occurrences throws loudly rather than yielding an empty set', () => {
		// An empty set would make every parity assertion below vacuously pass.
		expect(() => parseStatusEnum('DEFINE FIELD OVERWRITE tier ON interview_run TYPE string;')).toThrow(
			/could not locate the interview_run\.status ASSERT/
		);
	});

	it('CRLF source is normalized before matching (F-054)', () => {
		expect(parseStatusEnum(FIRST.replace(/\n/g, '\r\n'))).toContain('adjudicating');
	});

	// ── BLINDNESS MODE ① — an effective re-DEFINE that DROPPED the ASSERT ─────────────────
	const NO_ASSERT = `
		DEFINE FIELD OVERWRITE status          ON interview_run TYPE string DEFAULT "running";
	`;

	it('a LATER re-DEFINE that DROPS the ASSERT throws — it does not fall back to the older enum', () => {
		// The silent-green mode: the column now accepts ANY string, but the old parser skipped the
		// unasserted DEFINE and reported the earlier, narrow enum as effective.
		expect(() => parseStatusEnum(`${FIRST}\n-- ...later migration...\n${NO_ASSERT}`)).toThrow(
			/EFFECTIVE DEFINE of interview_run\.status carries NO/
		);
	});

	it('a neighbouring field’s ASSERT can never be mistaken for the status enum', () => {
		// The 200-char lookahead could jump the `;` and bind the NEXT field's enum. Statement-scoped
		// matching makes that impossible: this must throw, not return ["local","haiku"].
		const NEIGHBOUR = `
			DEFINE FIELD OVERWRITE status ON interview_run TYPE string DEFAULT "running";
			DEFINE FIELD OVERWRITE tier   ON interview_run TYPE string ASSERT $value IN ["local","haiku"];
		`;
		expect(() => parseStatusEnum(NEIGHBOUR)).toThrow(/carries NO/);
	});

	// ── BLINDNESS MODE ② — a re-DEFINE that is not an OVERWRITE ───────────────────────────
	it('an `IF NOT EXISTS` re-DEFINE throws — last-wins is FALSE for a no-op re-define', () => {
		const INE = FIRST.replace('DEFINE FIELD OVERWRITE', 'DEFINE FIELD IF NOT EXISTS').replace(
			'"error"]',
			'"error","cancelled"]'
		);
		expect(() => parseStatusEnum(`${FIRST}\n${INE}`)).toThrow(/is 'IF NOT EXISTS', not OVERWRITE/);
	});

	it('a BARE re-DEFINE (no modifier) throws too — it errors on apply, so the source lies', () => {
		const BARE = FIRST.replace('DEFINE FIELD OVERWRITE', 'DEFINE FIELD');
		expect(() => parseStatusEnum(`${FIRST}\n${BARE}`)).toThrow(
			/is 'a bare DEFINE FIELD', not OVERWRITE/
		);
	});

	it('a SINGLE `IF NOT EXISTS` define is fine — there is nothing earlier for it to no-op over', () => {
		const INE = FIRST.replace('DEFINE FIELD OVERWRITE', 'DEFINE FIELD IF NOT EXISTS');
		expect(parseStatusEnum(INE)).toContain('adjudicating');
	});

	it('an ASSERT list the parser cannot read throws rather than yielding an empty set', () => {
		const EMPTY = 'DEFINE FIELD OVERWRITE status ON interview_run TYPE string ASSERT $value IN [];';
		expect(() => parseStatusEnum(EMPTY)).toThrow(/parsed to ZERO values/);
	});

	it('single-quoted SurrealQL string literals parse (the enum is not double-quote-only)', () => {
		const SQ = "DEFINE FIELD OVERWRITE status ON interview_run TYPE string ASSERT $value IN ['passed','failed'];";
		expect(parseStatusEnum(SQ)).toEqual(['passed', 'failed']);
	});
});

// ── THE APPLY-ORDER GROUNDING ────────────────────────────────────────────────────────────────
// Taking the LAST textual DEFINE is only correct if textual order equals APPLY order. The
// previous version of this test asserted that the `const mNNNN_name: Migration = {` DECLARATIONS
// are in ascending id order — but declaration order is not the authority. `runMigrations` walks
// the exported `schemaMigrations` ARRAY, in array order. Two silent-green gaps followed:
//
//   • an array whose entries are REORDERED relative to the declarations (or relative to id order)
//     applies a later-declared migration FIRST, so the last DEFINE in the text is not the last
//     one applied — and the old test, reading only declarations, stayed green;
//   • a migration const DECLARED but never added to the array is NEVER APPLIED at all, yet a
//     textual parser reads its DDL as effective. That is not hypothetical: `m0087`/`m0088` are
//     already claimed on paper by two specs, so a half-landed migration const is a live shape.
//
// So the grounding now reads the ARRAY — the real authority — and pins it to the declarations.
describe('the anchor rests on APPLY order — schemaMigrations, not declaration order', () => {
	const src = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');

	/** The migration consts DECLARED in the file, in textual order. */
	const declared = [...src.matchAll(/^const (m\d{4}_\w+): Migration = \{/gm)].map((m) => m[1]);

	/** The migration consts EXPORTED in `schemaMigrations`, in APPLY order. */
	const applied = (() => {
		const open = src.indexOf('export const schemaMigrations: Migration[] = [');
		if (open === -1) throw new Error('schemaMigrations array not found in db/schema.ts');
		const close = src.indexOf('\n];', open);
		if (close === -1) throw new Error('schemaMigrations array is not terminated by "\\n];"');
		return [...src.slice(open, close).matchAll(/^\s*(m\d{4}_\w+),?\s*$/gm)].map((m) => m[1]);
	})();

	it('the exported array is non-trivial (the parse itself is checked)', () => {
		expect(applied.length).toBeGreaterThan(50);
	});

	it('no migration is listed twice — a duplicate would apply its DDL out of band', () => {
		const seen = new Set<string>();
		const dupes = applied.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
		expect(dupes, `duplicated in schemaMigrations: ${dupes.join(', ')}`).toEqual([]);
	});

	it('every DECLARED migration is EXPORTED — a declared-but-unlisted one never applies', () => {
		const listed = new Set(applied);
		const orphans = declared.filter((n) => !listed.has(n));
		expect(
			orphans,
			`declared in schema.ts but absent from schemaMigrations (its DDL NEVER applies, yet a ` +
				`textual parser reads it as effective): ${orphans.join(', ')}`
		).toEqual([]);
	});

	it('every EXPORTED migration is DECLARED in this file', () => {
		const known = new Set(declared);
		const ghosts = applied.filter((n) => !known.has(n));
		expect(ghosts, `listed in schemaMigrations but not declared here: ${ghosts.join(', ')}`).toEqual(
			[]
		);
	});

	it('APPLY order equals TEXTUAL order — the premise the last-wins parser rests on', () => {
		// If these ever diverge, "the last DEFINE in the file" stops meaning "the last one applied"
		// and `parseStatusEnum` must be re-anchored to walk the array instead of the raw source.
		expect(applied).toEqual(declared);
	});

	it('APPLY order is ascending by migration id', () => {
		const ids = applied.map((n) => Number(n.slice(1, 5)));
		const outOfOrder = ids.filter((id, i) => i > 0 && id <= ids[i - 1]);
		expect(outOfOrder, `schemaMigrations out of id order at: ${outOfOrder.join(', ')}`).toEqual([]);
	});
});

describe('interview_run status classification', () => {
	it('parses a non-empty status enum out of the live schema (the anchor itself is checked)', () => {
		const statuses = schemaStatuses();
		expect(statuses.length).toBeGreaterThan(1);
		// A sanity floor: the two statuses the whole scoring rule turns on must be in there. If this
		// fails the regex matched the wrong DEFINE and every assertion below is meaningless.
		expect(statuses).toEqual(expect.arrayContaining(['passed', 'failed']));
	});

	it('classifies EVERY schema status exactly once — no gap, no invention', () => {
		const schema = new Set(schemaStatuses());
		const classified = new Set([...TERMINAL_RUN_STATUSES, ...NON_TERMINAL_RUN_STATUSES]);

		// A status the schema admits but nobody classified would default to "not scored" at runtime
		// (correct, fail-closed) but would be UNREVIEWED — the whole point is that the decision is
		// deliberate. Name the offenders so the failure is actionable.
		const unclassified = [...schema].filter((s) => !classified.has(s));
		expect(unclassified, `schema statuses with no classification: ${unclassified.join(', ')}`).toEqual(
			[]
		);

		// The mirror: a status classified here that the schema no longer admits is dead rule surface.
		const stale = [...classified].filter((s) => !schema.has(s));
		expect(stale, `classified statuses the schema no longer admits: ${stale.join(', ')}`).toEqual([]);
	});

	it('the terminal and non-terminal sets are disjoint', () => {
		const both = [...TERMINAL_RUN_STATUSES].filter((s) => NON_TERMINAL_RUN_STATUSES.has(s));
		expect(both).toEqual([]);
	});

	it('only passed/failed are scored, across the whole schema enum', () => {
		for (const status of schemaStatuses()) {
			expect(isScoredStatus(status), `status '${status}'`).toBe(
				status === 'passed' || status === 'failed'
			);
		}
	});
});

describe('isScoredStatus shadow paths — the allow-list never fails open', () => {
	it('nil input is not scored', () => {
		expect(isScoredStatus(null)).toBe(false);
		expect(isScoredStatus(undefined)).toBe(false);
	});

	it('empty / whitespace input is not scored', () => {
		expect(isScoredStatus('')).toBe(false);
		expect(isScoredStatus('  ')).toBe(false);
	});

	it('a non-string that slipped past the types is not scored', () => {
		expect(isScoredStatus(0 as unknown as string)).toBe(false);
		expect(isScoredStatus({} as unknown as string)).toBe(false);
		expect(isScoredStatus([] as unknown as string)).toBe(false);
	});

	it('an UNKNOWN future status is not scored — this is the whole property', () => {
		expect(isScoredStatus('cancelled')).toBe(false);
		expect(isScoredStatus('superseded')).toBe(false);
		expect(isScoredStatus('PASSED')).toBe(false); // case-exact; no fuzzy match into "scored"
	});
});
