// hire-why-core — the EVENT LINE of the /agents hiring feed.
//
// The sweep this file exists for: the ceremony HEADER (hiring-ledger-core.ts, `ceremonyFacts`)
// suppresses every score fact on a non-terminal run, and the event line beneath it MUST obey the
// same rule. It did not: `emitGauntletScored` fires on EVERY finalize status and the
// 'adjudicating' finalize supplies planted_total/planted_found, so the line stated
// `adjudicating · recall 2/4 (50%)` under a header that deliberately withheld that figure.
//
// The first three cases below are that defect, pinned. The rest are the same status sweep the
// sibling module got, so the two surfaces can never drift apart silently again.

import { describe, it, expect } from 'vitest';
import { hireWhy, hireFalsifier } from './hire-why-core';
import {
	TERMINAL_RUN_STATUSES,
	NON_TERMINAL_RUN_STATUSES
} from '$lib/shared/interview-status';

/** The exact detail `emitGauntletScored` writes for the 'adjudicating' finalize
 *  (workforce/gauntlet.ts passes planted_total + planted_found; false_positives is NOT written). */
const adjudicatingDetail = {
	role_slug: 'code-reviewer',
	status: 'adjudicating',
	recall: 0.5,
	planted_found: 2,
	planted_total: 4,
	ambiguous_count: 2,
	lifecycle_before: 'interviewing',
	lifecycle_after: 'interviewing'
};

describe('hireWhy — interviewed: score facts require a TERMINAL run', () => {
	it('states NO recall on an adjudicating run, even though the detail carries the numbers', () => {
		const why = hireWhy('interviewed', adjudicatingDetail);
		expect(why).toBe('adjudicating');
		expect(why).not.toContain('recall');
		expect(why).not.toContain('2/4');
		expect(why).not.toContain('50%');
	});

	it('states NO FP on an adjudicating run that somehow carries the column', () => {
		// Defensive: false_positives defaults to 0 in the schema, so a reader that ever picks the
		// column straight off the row must not print "0 FP" as though the pass bar had measured it.
		const why = hireWhy('interviewed', { ...adjudicatingDetail, false_positives: 0 });
		expect(why).toBe('adjudicating');
		expect(why).not.toContain('FP');
	});

	it('states NO score on a running run', () => {
		const why = hireWhy('interviewed', {
			status: 'running',
			recall: 0,
			planted_found: 0,
			planted_total: 4,
			false_positives: 0
		});
		expect(why).toBe('running');
		expect(why).not.toContain('recall');
		expect(why).not.toContain('FP');
	});

	it('states the score on a passed run', () => {
		expect(
			hireWhy('interviewed', {
				status: 'passed',
				recall: 1,
				planted_found: 4,
				planted_total: 4,
				false_positives: 0
			})
		).toBe('passed · recall 4/4 (100%) · 0 FP');
	});

	it('states the score on a failed run', () => {
		expect(
			hireWhy('interviewed', {
				status: 'failed',
				recall: 0.25,
				planted_found: 1,
				planted_total: 4,
				false_positives: 3
			})
		).toBe('failed · recall 1/4 (25%) · 3 FP');
	});

	it('omits the percentage when the row recorded no recall ratio', () => {
		expect(
			hireWhy('interviewed', { status: 'failed', planted_found: 1, planted_total: 4 })
		).toBe('failed · recall 1/4');
	});

	it('emits no recall fragment at all when the row planted nothing (never "recall —")', () => {
		const why = hireWhy('interviewed', { status: 'passed', planted_found: 0, planted_total: 0 });
		expect(why).toBe('passed');
		expect(why).not.toContain('recall');
	});

	it('treats an ABSENT status as non-terminal (conservative), like ceremonyFacts', () => {
		const why = hireWhy('interviewed', { recall: 0.5, planted_found: 2, planted_total: 4 });
		expect(why).toBe('');
	});

	it('sweeps the WHOLE live schema enum — derived, not hand-listed', () => {
		// Both sets come from $lib/shared/interview-status, whose parity test PARSES the
		// interview_run ASSERT out of db/schema.ts. So adding a status to the schema forces a
		// classification there, and this sweep picks it up automatically — the gap that let the
		// event line ship ungated while its sibling header was correct.
		expect(NON_TERMINAL_RUN_STATUSES.size).toBeGreaterThan(0);
		for (const status of NON_TERMINAL_RUN_STATUSES) {
			const why = hireWhy('interviewed', { ...adjudicatingDetail, status, false_positives: 3 });
			expect(why, status).not.toContain('recall');
			expect(why, status).not.toContain('FP');
		}
		for (const status of TERMINAL_RUN_STATUSES) {
			const why = hireWhy('interviewed', { ...adjudicatingDetail, status, false_positives: 3 });
			expect(why, status).toContain('recall 2/4 (50%)');
			expect(why, status).toContain('3 FP');
		}
	});

	it('treats an UNKNOWN future status as non-terminal — the allow-list never fails open', () => {
		// The interview_run status enum can grow (db/schema.ts). A new value must inherit
		// suppression, not full score rendering.
		for (const status of ['queued', 'paused', 'cancelled', 'superseded']) {
			const why = hireWhy('interviewed', { ...adjudicatingDetail, status });
			expect(why, status).toBe(status);
			expect(why, status).not.toContain('recall');
		}
	});

	it('still states the non-score facts on a broken run', () => {
		expect(
			hireWhy('interviewed', {
				status: 'error',
				error_reason: 'spawn_failure',
				planted_total: 4,
				planted_found: 0
			})
		).toBe('error · spawn_failure');
	});

	it('still states demotion_withheld on a terminal failed evidence run', () => {
		expect(
			hireWhy('interviewed', {
				status: 'failed',
				recall: 0.5,
				planted_found: 2,
				planted_total: 4,
				false_positives: 1,
				demotion_withheld: true
			})
		).toBe('failed · recall 2/4 (50%) · 1 FP · evidence only — no demotion');
	});
});

describe('hireWhy — candidate_considered: terminal BY CONSTRUCTION upstream', () => {
	it('states the recall it was handed (recruiter-hire refuses a non-terminal run)', () => {
		expect(
			hireWhy('candidate_considered', {
				recommendation: 'hire',
				recall: 1,
				planted_found: 4,
				planted_total: 4,
				escalated: 2
			})
		).toBe('recommends hire · recall 4/4 (100%) · 2 escalated');
	});

	it('leaves no dangling separator when the brief recorded no plants', () => {
		expect(
			hireWhy('candidate_considered', { recommendation: 'no_hire', planted_total: 0 })
		).toBe('recommends no_hire');
	});

	it('says "—" rather than inventing a recommendation', () => {
		expect(hireWhy('candidate_considered', {})).toBe('recommends —');
	});
});

describe('hireWhy — the remaining ops keep their recorded facts', () => {
	it('gauntlet_started', () => {
		expect(
			hireWhy('gauntlet_started', {
				trigger: 'campaign',
				tier: 'opus',
				model_id: 'claude-opus-4-8',
				planted_total: 4
			})
		).toBe('campaign · opus · claude-opus-4-8 · 4 plants');
	});

	it('adjudicated', () => {
		expect(
			hireWhy('adjudicated', {
				items: 2,
				confirmed_hits: 1,
				false_positives: 1,
				dismissed: 0,
				status_after: 'passed'
			})
		).toBe('2 item(s) · 1 confirmed · 1 FP · 0 dismissed · → passed');
	});

	it('reversioned falls back to the lifecycle it came from', () => {
		expect(hireWhy('reversioned', { from_lifecycle: 'failed' })).toBe('from failed');
		expect(hireWhy('reversioned', {})).toBe('from a failed version');
		expect(hireWhy('reversioned', { reason: 'operator re-key' })).toBe('operator re-key');
	});

	it('hired / hire_rejected carry the override + cert facts', () => {
		expect(
			hireWhy('hired', {
				recommendation: 'hire',
				overrode_recommendation: true,
				cert_flipped: true,
				staffed_in_same_act: true
			})
		).toBe('recruiter recommended hire · OPERATOR OVERRODE · cert flipped · staffed in same act');
		expect(hireWhy('hire_rejected', { recommendation: 'no_hire' })).toBe(
			'recruiter recommended no_hire'
		);
	});

	it('staffed', () => {
		expect(hireWhy('staffed', { project: 'atelier', source: 'hire', re_staff: true })).toBe(
			'atelier · hire · re-staff'
		);
	});

	it('an unknown op renders nothing rather than guessing', () => {
		expect(hireWhy('teleported', { status: 'passed', planted_found: 4, planted_total: 4 })).toBe('');
	});

	it('an undefined detail never throws and never fabricates', () => {
		expect(hireWhy('interviewed', undefined)).toBe('');
		expect(hireWhy('staffed', undefined)).toBe('');
	});
});

describe('hireFalsifier', () => {
	it('returns the recorded falsifier', () => {
		expect(hireFalsifier({ falsifier: 'recall rested on 4 plants only' })).toBe(
			'recall rested on 4 plants only'
		);
	});

	it('returns null for absent / blank / non-string', () => {
		expect(hireFalsifier(undefined)).toBeNull();
		expect(hireFalsifier({})).toBeNull();
		expect(hireFalsifier({ falsifier: '   ' })).toBeNull();
		expect(hireFalsifier({ falsifier: 42 })).toBeNull();
	});
});
