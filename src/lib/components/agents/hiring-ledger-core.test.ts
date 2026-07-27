// THE HIRING FEED — unit contract for the view layer (operator review §5 / §13).
//
// Two decisions are pinned here because getting either wrong reproduces the original defect:
//   • the broken-run filter must HIDE without LYING — the hidden count is always recoverable, and
//     "everything broke" must never look like "nothing happened";
//   • a stated fact must trace to a real column — `recall —` may only appear when the run genuinely
//     planted nothing, never as a stand-in for "we did not look".

import { describe, it, expect } from 'vitest';
import {
	ceremonyCountLabel,
	ceremonyFacts,
	filterCeremonies,
	groupHiringCeremonies,
	type HiringCeremonyLike
} from './hiring-ledger-core';
import {
	TERMINAL_RUN_STATUSES,
	NON_TERMINAL_RUN_STATUSES
} from '$lib/shared/interview-status';

function ceremony(over: Partial<HiringCeremonyLike> = {}): HiringCeremonyLike {
	return {
		key: 'interview_run:ok',
		run: {
			id: 'interview_run:ok',
			tier: 'opus',
			model_id: 'claude-opus-4-8',
			provider: 'claude',
			status: 'passed',
			planted_total: 10,
			planted_found: 9,
			false_positives: 1,
			recall: 0.9
		},
		runMissing: false,
		role: 'role:code_reviewer',
		role_slug: 'code-reviewer',
		role_name: 'Code Reviewer',
		events: [{ id: 'role_event:1', op: 'interviewed', at: '2026-06-15T15:16:00.000Z' }],
		at: '2026-06-15T15:16:00.000Z',
		errored: false,
		isRetry: false,
		...over
	};
}

const broken = (key: string, reason = 'spawn_failure') =>
	ceremony({
		key,
		errored: true,
		run: { id: key, status: 'error', error_reason: reason, tier: 'opus', model_id: 'claude-opus-4-8' }
	});

describe('filterCeremonies — hide the broken runs WITHOUT hiding that they exist', () => {
	it('the default view drops errored ceremonies and reports how many', () => {
		const v = filterCeremonies([ceremony(), broken('interview_run:b1'), broken('interview_run:b2')], false);
		expect(v.visible.map((c) => c.key)).toEqual(['interview_run:ok']);
		expect(v.hiddenCount).toBe(2);
	});

	it('showErrored restores every row — the filter is REVERSIBLE, the data is never lost', () => {
		const all = [ceremony(), broken('interview_run:b1')];
		const v = filterCeremonies(all, true);
		expect(v.visible).toHaveLength(2);
		expect(v.hiddenCount).toBe(0);
	});

	it('the §13 live proportion: 19 of 36 broken → 17 shown, 19 disclosed', () => {
		const all = [
			...Array.from({ length: 17 }, (_, i) => ceremony({ key: `interview_run:ok${i}` })),
			...Array.from({ length: 19 }, (_, i) => broken(`interview_run:bad${i}`))
		];
		const v = filterCeremonies(all, false);
		expect(v.visible).toHaveLength(17);
		expect(v.hiddenCount).toBe(19);
	});

	it('ALL broken → visible [] with a NON-ZERO hidden count (never "nothing happened")', () => {
		const v = filterCeremonies([broken('interview_run:b1'), broken('interview_run:b2')], false);
		expect(v.visible).toEqual([]);
		expect(v.hiddenCount).toBe(2); // the renderer must say "all N broke", not show the empty state
	});

	// ── Shadow paths ──────────────────────────────────────────────────────────────
	it('nil / non-array / empty → an empty view with NO filter control implied', () => {
		for (const input of [null, undefined, [], 'nope' as unknown as HiringCeremonyLike[]]) {
			expect(filterCeremonies(input, false)).toEqual({ visible: [], hiddenCount: 0 });
		}
	});

	it('groupHiringCeremonies is the same contract (the single page entry point)', () => {
		expect(groupHiringCeremonies([ceremony(), broken('x')], false).visible).toHaveLength(1);
		expect(groupHiringCeremonies(null, false)).toEqual({ visible: [], hiddenCount: 0 });
	});
});

describe('ceremonyFacts — every stated fact traces to a real column', () => {
	it('states recall with its numerator/denominator, FP, tier and model', () => {
		const texts = ceremonyFacts(ceremony()).map((f) => f.text);
		expect(texts).toContain('passed');
		expect(texts).toContain('recall 9/10 (90%)');
		expect(texts).toContain('1 FP');
		expect(texts).toContain('opus');
		expect(texts).toContain('claude-opus-4-8');
	});

	it('a run that planted NOTHING says `recall —` — undefined, not zero (F-008)', () => {
		const facts = ceremonyFacts(
			ceremony({ run: { id: 'r', status: 'passed', planted_total: 0, planted_found: 0, recall: null } })
		);
		const recall = facts.find((f) => f.kind === 'recall');
		expect(recall!.text).toBe('recall —');
		expect(recall!.detail).toMatch(/undefined — not zero/);
	});

	it('a BROKEN run names its error reason and is NOT given a recall line at all', () => {
		const facts = ceremonyFacts(broken('interview_run:b', 'scorer_error'));
		expect(facts.find((f) => f.kind === 'error')!.text).toBe('run broke · scorer_error');
		// A run that never produced a verdict has no recall to state — not even '—'.
		expect(facts.some((f) => f.kind === 'recall')).toBe(false);
	});

	it('a BROKEN run that HAD planted fixtures still states no score — 0/4 is not a verdict', () => {
		// THE LIVE SHAPE, and the one the fixture above misses: a run that planted its fixtures and
		// THEN died at spawn keeps planted_total=4 with planted_found at its 0 default. Rendering
		// that verbatim produced `recall 0/4 (0%)` on all 19 broken runs — reading as "the candidate
		// found none of them" about an agent that was never spawned. The zero is an uninitialised
		// column, not a measurement (F-008).
		const facts = ceremonyFacts(
			ceremony({
				errored: true,
				run: {
					id: 'interview_run:crashed',
					status: 'error',
					error_reason: 'spawn_failure',
					tier: 'opus',
					model_id: 'claude-opus-4-8',
					planted_total: 4,
					planted_found: 0,
					false_positives: 0,
					recall: 0
				}
			})
		);
		expect(facts.find((f) => f.kind === 'error')!.text).toBe('run broke · spawn_failure');
		expect(facts.some((f) => f.kind === 'recall')).toBe(false);
		// `0 FP` measures nothing on a run that never scored, either.
		expect(facts.some((f) => f.kind === 'fp')).toBe(false);
		// The facts that describe the RUN ITSELF (not the candidate's performance) still show.
		expect(facts.map((f) => f.kind)).toEqual(expect.arrayContaining(['error', 'tier', 'model']));
		expect(facts.some((f) => /0\/4|0%/.test(f.text))).toBe(false);
	});

	// ── The invariant is "a score is stated only when the run PRODUCED one" — NOT "error runs state
	//    no score". The first cut gated on `status !== 'error'`, which left every in-flight run
	//    stating the identical uninitialised-column lie the error path was fixed for. These cases
	//    pin the invariant at the NON-TERMINAL statuses, the gap that let it ship.
	//
	//    Column provenance (db/schema.ts `interview_run` + workforce/gauntlet.ts finalizes):
	//      planted_total    ← set at CREATION, so the denominator is real from t=0;
	//      planted_found    ← DEFAULT 0 until the scorer finalizes ('adjudicating' or terminal);
	//      false_positives  ← DEFAULT 0 until the PASS BAR finalizes (terminal ONLY — never on
	//                         'adjudicating').
	it('a RUNNING run states no score — the denominator is real, the numerator is a DEFAULT 0', () => {
		// Live the instant a gauntlet starts: HIRE_LIFECYCLE_OPS leads with 'gauntlet_started' and
		// the ledger row already points at the in-flight run, so this shape is on screen for the
		// whole duration of every interview.
		const facts = ceremonyFacts(
			ceremony({
				run: {
					id: 'interview_run:inflight',
					status: 'running',
					tier: 'opus',
					model_id: 'claude-opus-4-8',
					planted_total: 4,
					planted_found: 0,
					false_positives: 0
				}
			})
		);
		expect(facts.find((f) => f.kind === 'status')!.text).toBe('running');
		expect(facts.some((f) => f.kind === 'recall')).toBe(false); // not even the honest '—'
		expect(facts.some((f) => f.kind === 'fp')).toBe(false);
		expect(facts.some((f) => /0\/4|0%|0 FP/.test(f.text))).toBe(false);
		// The facts describing the RUN ITSELF are unaffected.
		expect(facts.map((f) => f.kind)).toEqual(expect.arrayContaining(['status', 'tier', 'model']));
	});

	it('an ADJUDICATING run states no score — planted_found is a LOWER BOUND, FP is still DEFAULT 0', () => {
		// The scorer HAS written planted_found here, but resolving the operator's ambiguous queue can
		// only raise it (`plantedFound++` on confirm_hit, §3.4) — so 3/5 is a figure that is going to
		// move, not a verdict. false_positives is never written on the 'adjudicating' finalize at all.
		const facts = ceremonyFacts(
			ceremony({
				run: {
					id: 'interview_run:queued',
					status: 'adjudicating',
					tier: 'sonnet',
					model_id: 'claude-sonnet-4-5',
					planted_total: 5,
					planted_found: 3,
					false_positives: 0
				}
			})
		);
		expect(facts.find((f) => f.kind === 'status')!.text).toBe('adjudicating');
		expect(facts.some((f) => f.kind === 'recall')).toBe(false);
		expect(facts.some((f) => f.kind === 'fp')).toBe(false);
		expect(facts.some((f) => /3\/5|60%|0 FP/.test(f.text))).toBe(false);
	});

	it('the invariant holds across EVERY non-terminal status, and only there', () => {
		// DERIVED, not hand-copied. The previous cut listed the statuses inline under a comment
		// claiming "the whole schema enum" — nothing checked that claim, so a status added to
		// db/schema.ts would simply have been absent from the sweep with every test still green.
		// These sets come from $lib/shared/interview-status, whose own parity test PARSES the
		// interview_run ASSERT out of the schema source and fails if the two disagree. So this
		// loop is now genuinely exhaustive over the live enum, transitively.
		const nonTerminal = [...NON_TERMINAL_RUN_STATUSES];
		expect(nonTerminal.length).toBeGreaterThan(0);
		for (const status of nonTerminal) {
			const facts = ceremonyFacts(
				ceremony({
					run: { id: 'r', status, planted_total: 8, planted_found: 0, false_positives: 0, recall: 0 }
				})
			);
			expect(facts.some((f) => f.kind === 'recall' || f.kind === 'fp')).toBe(false);
		}
		for (const status of TERMINAL_RUN_STATUSES) {
			const facts = ceremonyFacts(
				ceremony({
					run: { id: 'r', status, planted_total: 8, planted_found: 6, false_positives: 2, recall: 0.75 }
				})
			);
			expect(facts.find((f) => f.kind === 'recall')!.text).toBe('recall 6/8 (75%)');
			expect(facts.find((f) => f.kind === 'fp')!.text).toBe('2 FP');
		}
	});

	it('an UNKNOWN future status states no score — the allow-list never fails open', () => {
		// The property the derived sweep above cannot show by construction: a status that is in
		// NEITHER set (because nobody has classified it yet) must land on the withhold side.
		for (const status of ['cancelled', 'superseded', 'PASSED']) {
			const facts = ceremonyFacts(
				ceremony({
					run: { id: 'r', status, planted_total: 8, planted_found: 0, false_positives: 0, recall: 0 }
				})
			);
			expect(facts.some((f) => f.kind === 'recall' || f.kind === 'fp'), status).toBe(false);
			// The run's own non-score facts still render — withholding the score is not blanking the row.
			expect(facts.find((f) => f.kind === 'status')!.text).toBe(status);
		}
	});

	it('a run with an ABSENT status is treated as non-terminal — no score is invented', () => {
		const facts = ceremonyFacts(
			ceremony({ run: { id: 'r', status: null, planted_total: 4, planted_found: 0, false_positives: 0 } })
		);
		expect(facts.some((f) => f.kind === 'recall' || f.kind === 'fp')).toBe(false);
	});

	it('a broken run with NO recorded reason says so rather than implying one', () => {
		const facts = ceremonyFacts(
			ceremony({ errored: true, run: { id: 'r', status: 'error', error_reason: null } })
		);
		expect(facts.find((f) => f.kind === 'error')!.text).toBe('run broke · reason unrecorded');
	});

	it('an auto-retry and a stale fixture pool are badged from their own columns', () => {
		const facts = ceremonyFacts(
			ceremony({ isRetry: true, run: { ...ceremony().run!, retry_of: 'interview_run:first', stale: true } })
		);
		expect(facts.some((f) => f.kind === 'retry')).toBe(true);
		expect(facts.find((f) => f.kind === 'retry')!.detail).toContain('interview_run:first');
		expect(facts.some((f) => f.kind === 'stale')).toBe(true);
	});

	it('a DANGLING run pointer states exactly that, and nothing else', () => {
		const facts = ceremonyFacts(ceremony({ run: null, runMissing: true }));
		expect(facts).toHaveLength(1);
		expect(facts[0].kind).toBe('missing');
		expect(facts[0].text).toBe('run not found');
	});

	// ── Shadow paths ──────────────────────────────────────────────────────────────
	it('nil ceremony → [] (never a row of placeholder chips)', () => {
		expect(ceremonyFacts(null)).toEqual([]);
		expect(ceremonyFacts(undefined)).toEqual([]);
	});

	it('a ceremony that never HAD a run (e.g. a staffing act) states no run facts', () => {
		expect(ceremonyFacts(ceremony({ run: null, runMissing: false }))).toEqual([]);
	});

	it('a run with only SOME columns states only what it has — no invented zeros', () => {
		const facts = ceremonyFacts(ceremony({ run: { id: 'r', status: 'failed' } }));
		const kinds = facts.map((f) => f.kind);
		expect(kinds).toContain('status');
		expect(kinds).toContain('recall'); // the honest '—'
		expect(kinds).not.toContain('fp');
		expect(kinds).not.toContain('tier');
		expect(kinds).not.toContain('model');
	});
});

// ── ceremonyCountLabel — the header must not imply threading it did not do ──────────────
//
// LIVE GROUNDING (read-only probe of the dev DB, 2026-07-27): role_event holds exactly three ops
// — created(18) / fixture_activated(36) / interviewed(36) — and there are 36 interview_run rows.
// HIRE_LIFECYCLE_OPS selects only `interviewed`, and emitGauntletScored fires once per finalize,
// so the feed is 36 events over 36 runs: 1:1 BY CONSTRUCTION, not a failing join (the join
// demonstrably resolves — erroredCount 19 matches the DB's 19 status='error' rows exactly, and
// that number is only computable from hydrated run facts). Zero `gauntlet_started` rows exist
// because every run predates that emitter (wired at workforce/repo.ts). So the header must say
// "one event each" rather than "36 ceremonies · 36 events", which reads as folding that happened.
describe('ceremonyCountLabel', () => {
	const many = (n: number): HiringCeremonyLike[] =>
		Array.from({ length: n }, (_, i) => ceremony({ key: `interview_run:${i}` }));

	it('says "one event each" when nothing folded — the live 36·36 shape', () => {
		const label = ceremonyCountLabel(many(36), 36);
		expect(label.text).toBe('36 ceremonies · one event each');
		expect(label.text).not.toContain('36 events');
		expect(label.detail).toMatch(/nothing to fold yet/);
	});

	it('states both counts once grouping actually folds events', () => {
		const label = ceremonyCountLabel(many(12), 41);
		expect(label.text).toBe('12 ceremonies · 41 events');
		expect(label.detail).toBe('41 ledger events folded into 12 ceremonies');
	});

	it('singular grammar on one ceremony / one event', () => {
		expect(ceremonyCountLabel(many(1), 1).text).toBe('1 ceremony · one event each');
		expect(ceremonyCountLabel(many(1), 3).text).toBe('1 ceremony · 3 events');
	});

	// ── Shadow paths: nil, empty, and an upstream read that could not produce a total ──
	it('nil / empty ceremonies → the honest zero, no event arithmetic', () => {
		for (const input of [null, undefined, [] as HiringCeremonyLike[]]) {
			const label = ceremonyCountLabel(input, 0);
			expect(label.text).toBe('0 ceremonies');
			expect(label.detail).toBeNull();
		}
	});

	it('an absent / non-finite event total states only the ceremony count', () => {
		for (const total of [null, undefined, NaN, Infinity]) {
			const label = ceremonyCountLabel(many(4), total as number);
			expect(label.text).toBe('4 ceremonies');
			expect(label.detail).toMatch(/not available/);
		}
	});

	it('an IMPOSSIBLE total (fewer events than threads) is never published as arithmetic', () => {
		// A thread cannot exist without at least one event, so totalEvents < ceremonies means the
		// read model disagrees with itself. Print what we can stand behind, not the contradiction.
		const label = ceremonyCountLabel(many(9), 2);
		expect(label.text).toBe('9 ceremonies');
		expect(label.detail).toMatch(/not available/);
	});
});
