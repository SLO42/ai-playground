// SD-1 banner WORDING — the copy must match the actual exposure.
//
// The defect: the banner rendered the both-uncapped copy ("armed with no token ceiling …
// unattended spend can grow without a backstop") whenever EITHER ceiling was 0. With the
// shipped config the global daily ceiling IS armed (15,000,000), so that claim was false.
// F-008 honesty cuts both ways — an alarm that overstates is one the operator learns to
// discount, which is how the real both-uncapped case gets ignored when it happens.
//
// These are unit tests rather than a render check on purpose: the banner's render path is
// gated behind config that a test must NOT mutate (the shipped ceilings stay shipped), so
// the wording decision was extracted into this pure function to be testable at all.

import { describe, it, expect } from 'vitest';
import { describeBudgetRisk, type BudgetCeilings } from './budget-risk';

/** A verdict shaped like the server's BudgetSafety, with both ceilings armed by default. */
function ceilings(over: Partial<BudgetCeilings> = {}): BudgetCeilings {
	return {
		dailyTokenBudget: 15_000_000,
		perProjectTokenBudget: 5_000_000,
		dailyUncapped: false,
		perProjectUncapped: false,
		uncappedWhileArmed: false,
		...over
	};
}

describe('describeBudgetRisk — the banner never claims more risk than exists', () => {
	it('the SAFE state renders NOTHING (no fabricated alarm, F-008)', () => {
		expect(describeBudgetRisk(ceilings())).toBeNull();
	});

	it('safe wins even if a ceiling is 0 but no loop is armed (uncapped alone is harmless)', () => {
		// An uncapped ceiling with nothing driving spend is not a risk — the verdict field is
		// the authority, and the copy must not second-guess it from the raw ceilings.
		const copy = describeBudgetRisk(
			ceilings({ perProjectTokenBudget: 0, perProjectUncapped: true, uncappedWhileArmed: false })
		);
		expect(copy).toBeNull();
	});

	// ── THE DEFECT: only ONE ceiling off must NOT claim "no backstop" ───────────────────
	it('per-project uncapped ONLY: names the surviving daily ceiling, never "no backstop"', () => {
		const copy = describeBudgetRisk(
			ceilings({ perProjectTokenBudget: 0, perProjectUncapped: true, uncappedWhileArmed: true })
		);
		expect(copy).not.toBeNull();
		expect(copy!.fullyUncapped).toBe(false);
		// The false claims are GONE.
		expect(copy!.risk).not.toMatch(/without a backstop/i);
		expect(copy!.headline).not.toBe('with no token ceiling');
		// The true statement is present, with the real armed number.
		expect(copy!.risk).toContain('15,000,000');
		expect(copy!.risk).toMatch(/still bounded/i);
		// …and the ACTUAL residual risk is named, not hidden.
		expect(copy!.risk).toMatch(/single project can consume the whole allowance/i);
		expect(copy!.headline).toContain('per-project');
		expect(copy!.eyebrow).toContain('partially uncapped');
	});

	it('daily uncapped ONLY: names the surviving per-project ceiling + the parallel-projects risk', () => {
		const copy = describeBudgetRisk(
			ceilings({ dailyTokenBudget: 0, dailyUncapped: true, uncappedWhileArmed: true })
		);
		expect(copy!.fullyUncapped).toBe(false);
		expect(copy!.risk).not.toMatch(/without a backstop/i);
		expect(copy!.risk).toContain('5,000,000');
		// Each project is bounded, but the COUNT of projects is not — the honest residual risk.
		expect(copy!.risk).toMatch(/projects spending in parallel is not/i);
		expect(copy!.headline).toContain('daily');
		expect(copy!.eyebrow).toContain('partially uncapped');
	});

	// ── The genuinely-unbounded case KEEPS its loud wording (the fix must not under-warn) ──
	it('BOTH uncapped: the "no backstop" language is retained — this is the real thing', () => {
		const copy = describeBudgetRisk(
			ceilings({
				dailyTokenBudget: 0,
				perProjectTokenBudget: 0,
				dailyUncapped: true,
				perProjectUncapped: true,
				uncappedWhileArmed: true
			})
		);
		expect(copy!.fullyUncapped).toBe(true);
		expect(copy!.risk).toMatch(/without a backstop/i);
		expect(copy!.headline).toBe('with no token ceiling');
		expect(copy!.eyebrow).toBe('autonomy · uncapped spend');
		// It must NOT name a surviving ceiling — there is none.
		expect(copy!.risk).not.toMatch(/still armed/i);
	});

	it('the three cases produce three DISTINCT messages (severity is not flattened)', () => {
		const both = describeBudgetRisk(
			ceilings({
				dailyTokenBudget: 0,
				perProjectTokenBudget: 0,
				dailyUncapped: true,
				perProjectUncapped: true,
				uncappedWhileArmed: true
			})
		)!;
		const dailyOff = describeBudgetRisk(
			ceilings({ dailyTokenBudget: 0, dailyUncapped: true, uncappedWhileArmed: true })
		)!;
		const perProjOff = describeBudgetRisk(
			ceilings({ perProjectTokenBudget: 0, perProjectUncapped: true, uncappedWhileArmed: true })
		)!;
		expect(new Set([both.risk, dailyOff.risk, perProjOff.risk]).size).toBe(3);
		expect(new Set([both.headline, dailyOff.headline, perProjOff.headline]).size).toBe(3);
	});

	it('token counts are grouped for readability and locale-stable across server/client', () => {
		const copy = describeBudgetRisk(
			ceilings({ perProjectTokenBudget: 0, perProjectUncapped: true, uncappedWhileArmed: true })
		)!;
		// Fixed 'en-US' grouping — an SSR/CSR mismatch here would hydrate-warn.
		expect(copy.risk).toContain('15,000,000');
		expect(copy.risk).not.toContain('15000000');
	});
});
