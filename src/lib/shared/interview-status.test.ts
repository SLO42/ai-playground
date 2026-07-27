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

/** The `interview_run.status` ASSERT set, read out of the live schema source. */
function schemaStatuses(): string[] {
	// F-054: the editor flips LF→CRLF on this repo, so normalize before any multi-line match.
	const src = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
	const m = src.match(
		/DEFINE FIELD OVERWRITE status\s+ON interview_run[\s\S]{0,200}?ASSERT \$value IN \[([^\]]+)\]/
	);
	if (!m) {
		throw new Error(
			'could not locate the interview_run.status ASSERT in db/schema.ts — the field was renamed, ' +
				'reshaped, or the ASSERT was dropped. Re-anchor this test before trusting any status gate.'
		);
	}
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

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
