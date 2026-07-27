import { describe, expect, it } from 'vitest';
import { foldInterviews, type RawRun } from './track-record';

// ── §2.5 INTERVIEW PLANE — the terminality rule at the track-record surface ───────────────────
//
// THE DEFECT THIS PINS. `track-record.ts` declared its OWN terminality set —
// `const TERMINAL = new Set(['passed','failed','error'])` — a SECOND definition of "has this run
// produced a score", sitting alongside the canonical `$lib/shared/interview-status`. It disagreed
// with the canonical one on exactly one value: `'error'`.
//
// That disagreement is not academic. The runner finalizes a broken run (spawn_failure /
// scorer_error) with `planted_found: 0` and never runs the pass bar, so `false_positives` stays at
// its schema DEFAULT 0. Taking that row as "the latest terminal run" published `recall 0%` and
// `0 FP` on `/agents` under the heading "recall (latest)" — a damning measurement of an agent
// whose interview never ran. F-008, on a live surface, from a duplicated rule.
//
// These tests assert the BEHAVIOUR, not the import: swap `isScoredStatus` back for any local set
// that admits 'error' and the first case fails by name.

let seq = 0;
function run(over: Partial<RawRun> & { status: string }): RawRun {
	seq++;
	return {
		model_id: 'claude-sonnet-x',
		tier: 'sonnet',
		stale: false,
		planted_total: 4,
		planted_found: 0,
		false_positives: 0,
		cost_usd: null,
		started_at: `2026-07-2${(seq % 9) + 1}T00:00:00Z`,
		...over
	};
}

describe('foldInterviews — only a SCORED run may state recall / FP', () => {
	it('an ERROR run states NO recall and NO FP — it produced neither', () => {
		// The exact live shape: a spawn_failure finalize, planted_found 0, false_positives 0.
		const [cell] = foldInterviews([run({ status: 'error' })]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
		// The COUNT is still stated — counting runs by status claims no measurement.
		expect(cell.error).toBe(1);
		expect(cell.runs).toBe(1);
	});

	it('an ADJUDICATING run states no recall/FP — planted_found is a lower bound (§3.4)', () => {
		const [cell] = foldInterviews([run({ status: 'adjudicating', planted_found: 2 })]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
		expect(cell.adjudicating).toBe(1);
	});

	it('a RUNNING run states no recall/FP — the columns are uninitialised', () => {
		const [cell] = foldInterviews([run({ status: 'running' })]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
		expect(cell.running).toBe(1);
	});

	it('an UNKNOWN future status states no recall/FP — the gate is an allow-list', () => {
		const [cell] = foldInterviews([run({ status: 'cancelled', planted_found: 4 })]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
	});

	it('a PASSED run states its real score', () => {
		const [cell] = foldInterviews([
			run({ status: 'passed', planted_found: 4, false_positives: 1 })
		]);
		expect(cell.recall).toBe(1);
		expect(cell.falsePositives).toBe(1);
	});

	it('a FAILED run states its real score — a zero the pass bar actually measured', () => {
		const [cell] = foldInterviews([run({ status: 'failed', planted_found: 1 })]);
		expect(cell.recall).toBe(0.25);
		expect(cell.falsePositives).toBe(0);
	});

	it('THE REGRESSION: a NEWER error run does not shadow the older passing one', () => {
		// Newest-first, as the caller's ORDER BY delivers them. With 'error' wrongly treated as
		// terminal, this cell reported recall 0% / 0 FP and buried a real 100% certification.
		const [cell] = foldInterviews([
			run({ status: 'error' }),
			run({ status: 'passed', planted_found: 4, false_positives: 2 })
		]);
		expect(cell.recall).toBe(1);
		expect(cell.falsePositives).toBe(2);
		expect(cell.error).toBe(1);
		expect(cell.passed).toBe(1);
	});

	it('a run that planted NOTHING has an undefined recall — null, never 0 or 1', () => {
		const [cell] = foldInterviews([
			run({ status: 'passed', planted_total: 0, planted_found: 0, false_positives: 3 })
		]);
		expect(cell.recall).toBeNull();
		// FP is still real: the pass bar ran and counted them.
		expect(cell.falsePositives).toBe(3);
	});

	// ── SHADOW PATHS ─────────────────────────────────────────────────────────────────────
	it('SHADOW empty input → no cells (honest empty, not a zero row)', () => {
		expect(foldInterviews([])).toEqual([]);
	});

	it('SHADOW no scored run at all → recall and FP are null, counts still real', () => {
		const [cell] = foldInterviews([run({ status: 'running' }), run({ status: 'error' })]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
		expect(cell.runs).toBe(2);
	});

	it('SHADOW nil-ish status (a dangling/unrecorded column) is not scored', () => {
		const [cell] = foldInterviews([
			run({ status: null as unknown as string, planted_found: 4, false_positives: 9 })
		]);
		expect(cell.recall).toBeNull();
		expect(cell.falsePositives).toBeNull();
	});

	it('cells are split per model_id and each carries its own scored run', () => {
		const cells = foldInterviews([
			run({ model_id: 'a', status: 'passed', planted_found: 4 }),
			run({ model_id: 'b', status: 'error' })
		]);
		expect(cells.map((c) => c.model_id)).toEqual(['a', 'b']);
		expect(cells[0].recall).toBe(1);
		expect(cells[1].recall).toBeNull();
	});

	it('cost is summed across ALL runs (priced rows only) — it is spend, not a score', () => {
		// Cost is deliberately NOT gated on terminality: an errored run still burned tokens, and
		// cost_usd is summed from PRICED agent_event rows, not written by the pass bar.
		const [cell] = foldInterviews([
			run({ status: 'error', cost_usd: 0.5 }),
			run({ status: 'passed', planted_found: 4, cost_usd: 1.25 })
		]);
		expect(cell.costUsd).toBe(1.75);
		expect(cell.recall).toBe(1);
	});

	it('an entirely UNPRICED set leaves cost null, never a dressed-up 0 (F-008)', () => {
		const [cell] = foldInterviews([run({ status: 'passed', planted_found: 4 })]);
		expect(cell.costUsd).toBeNull();
	});
});
