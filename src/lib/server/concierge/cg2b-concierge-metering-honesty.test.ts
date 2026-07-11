// CG-2b VERIFY — the concierge budget gate must not claim metering it does not do.
//
// Regression guard for the FAILED D-038 review of commit bdca0d3 (finding #2, the sibling the first
// pass left un-swept). providerToLlmFn's comment sold the CG-2 gate as metering: "it is metered HERE
// at its one bounded-call site" and, on the local exemption, "still metered for observability." Both
// are FALSE: the concierge Stage-2 turn is a direct provider call (NOT launchSession), and the
// concierge module writes NO agent_event completion row — the ONLY rows tokensSpentSince counts — so
// NEITHER the local NOR the cloud concierge turn is ever metered. This is the exact false-behavior-
// comment class that fix 984f945 (finding #3) + its guard exist to eliminate (CLAUDE.md §2 grounding
// / D-039 spirit / criterion-6 honesty).
//
// The guard is COUPLED to the code, not a bare string ban: it derives whether the concierge module
// actually meters (any completion-event write), and only then are metering claims permitted. So when
// the tracked observability followUp lands a real completion write, this test does NOT need editing —
// the claim becomes legitimate the moment the write exists. Static source-text scan (mirrors
// cg2b-pmreview-no-budget-recourse + cg2-budget-override-ui); CRLF-normalized (F-054) so the Edit
// tool's LF->CRLF flip on Windows cannot break the matches.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const wireSrc = read(join(HERE, 'wire.ts'));

/** The providerToLlmFn slice of wire.ts — where the CG-2 gate + its comment live. */
function providerToLlmFnSlice(): string {
	const start = wireSrc.indexOf('function providerToLlmFn(');
	const end = wireSrc.indexOf('function buildConciergeLlm(');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return wireSrc.slice(start, end);
}

/** Does the concierge module actually meter — i.e. write an agent_event completion row anywhere? */
function conciergeMetersSpend(): boolean {
	const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
	return files.some((f) => {
		const src = read(join(HERE, f));
		return /type:\s*['"]completion['"]/.test(src) || /writeAgentEvent\s*\(/.test(src);
	});
}

describe('CG-2b — concierge budget gate is honest about (not) metering (static guard)', () => {
	it('still wires the CG-2 gate with the provider threaded (the gate itself is intact)', () => {
		const slice = providerToLlmFnSlice();
		expect(slice).toMatch(/await enforceTokenBudget\(db, \{/);
		expect(slice).toMatch(/provider: providerKind/);
	});

	it('does NOT claim the turn is metered while the concierge writes no completion row', () => {
		if (conciergeMetersSpend()) return; // if metering ever lands, the claim becomes legitimate
		const slice = providerToLlmFnSlice();
		// The two false claims the review flagged — neither may reappear while the turn is un-metered.
		expect(slice).not.toMatch(/metered HERE at its one bounded-call site/i);
		expect(slice).not.toMatch(/still metered for observability/i);
		// And no bare "is metered" assertion about this turn (the gate is not metering).
		expect(slice).not.toMatch(/so it is metered/i);
	});

	it('states the honest un-metered reality (a positive grounding assertion, not just an absence)', () => {
		if (conciergeMetersSpend()) return;
		const slice = providerToLlmFnSlice();
		expect(slice).toMatch(/un-metered/i);
		expect(slice).toMatch(/writes NO agent_event completion row/);
	});

	it('spend-budget.ts no longer claims the concierge turn is "still metered at events.ts"', () => {
		const budgetSrc = read(join(HERE, '..', 'analytics', 'spend-budget.ts'));
		// The two docstrings that specifically named the concierge / always-on local brain as metered.
		expect(budgetSrc).not.toContain('Tokens are STILL metered at the events.ts completion write for observability');
		expect(budgetSrc).not.toMatch(/never refused by the budget\. Tokens are still metered at/);
	});
});
