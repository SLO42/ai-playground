// THE HIRING FEED — unit contract for the view layer (operator review §5 / §13).
//
// Two decisions are pinned here because getting either wrong reproduces the original defect:
//   • the broken-run filter must HIDE without LYING — the hidden count is always recoverable, and
//     "everything broke" must never look like "nothing happened";
//   • a stated fact must trace to a real column — `recall —` may only appear when the run genuinely
//     planted nothing, never as a stand-in for "we did not look".

import { describe, it, expect } from 'vitest';
import {
	ceremonyFacts,
	filterCeremonies,
	groupHiringCeremonies,
	type HiringCeremonyLike
} from './hiring-ledger-core';

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
