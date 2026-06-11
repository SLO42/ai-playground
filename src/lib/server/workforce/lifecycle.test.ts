import { describe, expect, it } from 'vitest';
import {
	assertRunTransition,
	assertTransition,
	canRunTransition,
	canTransition,
	INTERVIEWABLE_LIFECYCLES,
	LifecycleError,
	ROLE_VERSION_LIFECYCLES,
	RunStatusError
} from './lifecycle';

// TASK 16.3 VERIFY (§2.2) — the FULL lifecycle matrix, exhaustively: every (from, to)
// pair is asserted against the spec's legal set, so an accidental new edge (or a lost
// one) fails loudly. Pure — no DB.

const LEGAL: Record<string, string[]> = {
	draft: ['interviewing', 'withdrawn'],
	interviewing: ['passed', 'failed', 'error'],
	passed: ['retired', 'withdrawn'],
	failed: [],
	error: ['interviewing', 'withdrawn'],
	withdrawn: [],
	retired: []
};

describe('role_version lifecycle matrix (§2.2 — one enum, exhaustive)', () => {
	it('covers every declared lifecycle', () => {
		expect(Object.keys(LEGAL).sort()).toEqual([...ROLE_VERSION_LIFECYCLES].sort());
	});

	for (const from of ROLE_VERSION_LIFECYCLES) {
		for (const to of ROLE_VERSION_LIFECYCLES) {
			const legal = LEGAL[from].includes(to);
			it(`${from} → ${to} is ${legal ? 'LEGAL' : 'ILLEGAL'}`, () => {
				expect(canTransition(from, to)).toBe(legal);
				if (legal) {
					expect(() => assertTransition(from, to)).not.toThrow();
				} else {
					expect(() => assertTransition(from, to)).toThrow(LifecycleError);
				}
			});
		}
	}

	it('failed is terminal — a fix is a NEW version (no laundering)', () => {
		expect(LEGAL.failed).toEqual([]);
	});

	it('withdrawn is reachable from draft, passed, and unretired error — and nowhere else', () => {
		const sources = ROLE_VERSION_LIFECYCLES.filter((from) => canTransition(from, 'withdrawn'));
		expect(sources.sort()).toEqual(['draft', 'error', 'passed']);
	});

	it('retired is reachable ONLY from passed (explicit operator act)', () => {
		const sources = ROLE_VERSION_LIFECYCLES.filter((from) => canTransition(from, 'retired'));
		expect(sources).toEqual(['passed']);
	});

	it('unknown states are never legal (fail closed)', () => {
		expect(canTransition('bogus', 'passed')).toBe(false);
		expect(canTransition('passed', 'bogus')).toBe(false);
		expect(() => assertTransition('bogus', 'passed')).toThrow(LifecycleError);
	});

	it('the error names from, to, and the legal set', () => {
		try {
			assertTransition('failed', 'passed');
			expect.unreachable('must throw');
		} catch (e) {
			expect(e).toBeInstanceOf(LifecycleError);
			expect((e as Error).message).toContain("'failed' → 'passed'");
			expect((e as Error).message).toContain('terminal');
		}
	});

	it('interviewable set: draft/interviewing/error/passed/retired — never failed/withdrawn', () => {
		expect([...INTERVIEWABLE_LIFECYCLES].sort()).toEqual(
			['draft', 'error', 'interviewing', 'passed', 'retired'].sort()
		);
	});
});

describe('interview_run status machine (§3.4)', () => {
	it('running fans out to adjudicating/passed/failed/error', () => {
		for (const to of ['adjudicating', 'passed', 'failed', 'error']) {
			expect(canRunTransition('running', to)).toBe(true);
		}
	});

	it('adjudicating resolves ONLY to passed/failed (operator resolution)', () => {
		expect(canRunTransition('adjudicating', 'passed')).toBe(true);
		expect(canRunTransition('adjudicating', 'failed')).toBe(true);
		expect(canRunTransition('adjudicating', 'error')).toBe(false);
		expect(canRunTransition('adjudicating', 'running')).toBe(false);
	});

	it('terminal run statuses accept nothing', () => {
		for (const from of ['passed', 'failed', 'error']) {
			for (const to of ['running', 'adjudicating', 'passed', 'failed', 'error']) {
				expect(canRunTransition(from, to)).toBe(false);
			}
		}
		expect(() => assertRunTransition('passed', 'failed')).toThrow(RunStatusError);
	});
});
