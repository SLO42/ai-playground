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
const STATUS_ASSERT_RE =
	/DEFINE FIELD OVERWRITE status\s+ON interview_run[\s\S]{0,200}?ASSERT \$value IN \[([^\]]+)\]/g;

/**
 * The EFFECTIVE `interview_run.status` ASSERT set for a schema source.
 *
 * Exposed with an injectable `src` so the last-wins property itself is testable without mutating
 * the real `schema.ts` (the only way the original bug was found was by hand-editing it).
 */
export function parseStatusEnum(src: string): string[] {
	// F-054: the editor flips LF→CRLF on this repo, so normalize before any multi-line match.
	const matches = [...src.replace(/\r\n/g, '\n').matchAll(STATUS_ASSERT_RE)];
	if (matches.length === 0) {
		throw new Error(
			'could not locate the interview_run.status ASSERT in db/schema.ts — the field was renamed, ' +
				'reshaped, or the ASSERT was dropped. Re-anchor this test before trusting any status gate.'
		);
	}
	// LAST, not first: later migrations OVERWRITE earlier ones.
	const last = matches[matches.length - 1];
	return [...last[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
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

	it('"last textual DEFINE = last applied" is grounded: migrations are declared in id order', () => {
		// Taking the LAST match is only correct if the file's textual order matches the order
		// `schemaMigrations` applies them. Both are numerically ordered by construction — assert it
		// rather than assume it, since the whole anchor rests on it.
		const src = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
		const ids = [...src.matchAll(/^const m(\d{4})_\w+: Migration = \{/gm)].map((m) =>
			Number(m[1])
		);
		expect(ids.length).toBeGreaterThan(50);
		const outOfOrder = ids.filter((id, i) => i > 0 && id <= ids[i - 1]);
		expect(outOfOrder, `migration consts declared out of id order: ${outOfOrder.join(', ')}`).toEqual(
			[]
		);
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
