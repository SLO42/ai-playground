// CG-2-1 VERIFY — spend-budget.ts must not claim the concierge Stage-2 turn is un-metered.
//
// Regression guard for the FAILED D-038 review of commit c574ad5 (CG-2-1). Wiring meterConciergeTurn
// (wire.ts) falsified two docstrings in the COUPLED spend-budget.ts that still asserted the concierge
// Stage-2 turn "writes no completion row" / is "un-metered" (the local-exemption provider docstring
// and the isLocalProvider docstring). That is exactly the false-metering-comment honesty class the
// cg2b guard exists to catch — but cg2b's spend-budget assertions only banned two OTHER specific
// strings, missing these two docstrings. This guard closes that gap.
//
// COUPLED to the code, not a bare string ban: it derives whether the concierge module actually meters
// (any completion-event write). Only WHILE it meters are the false "un-metered" claims forbidden — so
// if metering were ever removed, the honest reality would flip back and this guard would not lie.
// Static source-text scan; CRLF-normalized (F-054) so the Edit tool's LF->CRLF flip cannot break it.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const budgetSrc = read(join(HERE, 'spend-budget.ts'));

/** Does the concierge module actually meter — i.e. write an agent_event completion row anywhere? */
function conciergeMetersSpend(): boolean {
	const dir = join(HERE, '..', 'concierge');
	const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
	return files.some((f) => {
		const src = read(join(dir, f));
		return /type:\s*['"]completion['"]/.test(src) || /writeAgentEvent\s*\(/.test(src);
	});
}

describe('CG-2-1 — spend-budget.ts is honest that the concierge turn is metered (static guard)', () => {
	it('does NOT claim the concierge Stage-2 turn writes no completion row while it is metered', () => {
		if (!conciergeMetersSpend()) return; // metering removed ⇒ the un-metered claim would be honest
		// Defect #1 (local-exemption provider docstring) + defect #2 (isLocalProvider docstring): both
		// asserted the concierge turn writes no completion row / is not counted. Neither may reappear.
		expect(budgetSrc).not.toMatch(/the concierge Stage-2 turn[^.]*writes no completion row/i);
		expect(budgetSrc).not.toMatch(/simply not counted \(an accepted observability gap\)/i);
		expect(budgetSrc).not.toMatch(/\(the concierge Stage-2 turn\) writes no completion row and is un-metered/i);
	});

	it('states the honest metered reality — the turn is metered at wire.ts meterConciergeTurn', () => {
		if (!conciergeMetersSpend()) return;
		// A positive grounding assertion (not just an absence): both docstrings must name the real site.
		const hits = budgetSrc.match(/meterConciergeTurn/g) ?? [];
		expect(hits.length).toBeGreaterThanOrEqual(2);
	});
});
