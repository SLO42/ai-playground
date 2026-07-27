// THE SD-1 BANNER'S RISK WORDING — one definition, severity-accurate.
//
// WHY THIS MODULE EXISTS. The /services budget-safety banner fires when an autonomous loop is
// armed AND at least one token ceiling is the 0 (uncapped) sentinel. It rendered ONE piece of
// copy for that whole condition: "armed with no token ceiling … unattended spend can grow
// without a backstop". But the condition covers three materially different exposures, and with
// the SHIPPED config (`spend.dailyTokenBudget: 15000000`) the global ceiling IS armed — so
// "no token ceiling" and "without a backstop" were simply false.
//
// F-008 honesty cuts BOTH ways. A warning that OVERSTATES is as dishonest as one that hides,
// and it is worse than useless operationally: an alarm that cries wolf about a backstop that
// demonstrably exists is an alarm the operator learns to discount, which is how the real
// both-uncapped case gets ignored when it finally happens.
//
// It lives in `$lib/shared` (not `$lib/server`) because `/services/+page.svelte` compiles into
// the CLIENT bundle and must not reach into the server tree — the same reason
// `interview-status.ts` sits here. It is pure data: no DB, no I/O, no config read.
//
// The INPUT is structural, not an import of the server's `BudgetSafety`, precisely so this
// module stays client-safe; `BudgetSafety` satisfies it by shape.

/** The fields of the SD-1 verdict this copy depends on (server `BudgetSafety` satisfies it). */
export interface BudgetCeilings {
	/** The armed GLOBAL daily token budget, normalized (0 = uncapped). */
	dailyTokenBudget: number;
	/** The armed PER-PROJECT token budget, normalized (0 = uncapped). */
	perProjectTokenBudget: number;
	/** True iff the global daily ceiling is the 0 (uncapped) sentinel. */
	dailyUncapped: boolean;
	/** True iff the per-project ceiling is the 0 (uncapped) sentinel. */
	perProjectUncapped: boolean;
	/** At least one loop armed AND at least one ceiling uncapped. */
	uncappedWhileArmed: boolean;
}

/** Severity-accurate copy for the SD-1 banner. */
export interface BudgetRiskCopy {
	/** Banner eyebrow — distinguishes fully vs partially uncapped at a glance. */
	eyebrow: string;
	/** Completes the headline "N autonomous loop(s) are armed …". */
	headline: string;
	/** The risk sentence. Names the SURVIVING backstop whenever there is one. */
	risk: string;
	/** True only when NOTHING caps total spend — the one case that may claim "no backstop". */
	fullyUncapped: boolean;
}

/** Format a token count for display. Fixed locale so server and client render identically. */
function tokens(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * Describe the SD-1 risk in words that MATCH the actual exposure.
 *
 * The three cases, and why they are not the same warning:
 *   • BOTH ceilings uncapped        — genuinely unbounded. Only this may say "no backstop".
 *   • daily armed, per-project off  — total spend IS bounded by the daily ceiling; the residual
 *                                     risk is that ONE project consumes the whole allowance.
 *   • per-project armed, daily off  — each project is bounded, but the number of projects
 *                                     spending in parallel is not.
 *
 * Returns `null` in the safe state, so the caller renders nothing rather than a fabricated
 * alarm (F-008). Pure — trivially unit-testable, which is the point: the banner's own render
 * path is gated behind config the tests must not mutate.
 */
export function describeBudgetRisk(safety: BudgetCeilings): BudgetRiskCopy | null {
	if (!safety.uncappedWhileArmed) return null;

	if (safety.dailyUncapped && safety.perProjectUncapped) {
		return {
			eyebrow: 'autonomy · uncapped spend',
			headline: 'with no token ceiling',
			risk: 'Both ceilings are off, so unattended spend can grow without a backstop.',
			fullyUncapped: true
		};
	}

	if (safety.dailyUncapped) {
		return {
			eyebrow: 'autonomy · partially uncapped spend',
			headline: 'with no daily token ceiling',
			risk:
				`The per-project ceiling is still armed at ${tokens(safety.perProjectTokenBudget)} tokens, ` +
				'so each project is bounded — but the number of projects spending in parallel is not.',
			fullyUncapped: false
		};
	}

	return {
		eyebrow: 'autonomy · partially uncapped spend',
		headline: 'with no per-project token ceiling',
		risk:
			`The daily ceiling is still armed at ${tokens(safety.dailyTokenBudget)} tokens, so total ` +
			'spend is still bounded — but a single project can consume the whole allowance.',
		fullyUncapped: false
	};
}
