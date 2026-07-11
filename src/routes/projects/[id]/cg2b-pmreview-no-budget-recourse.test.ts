// CG-2b VERIFY — the pmReview action must NOT sell a token-budget "recourse" it can never reach.
//
// Regression guard for the FAILED D-038 review of commit bdca0d3 (finding #3): the pmReview action
// carried an `if (err instanceof TokenBudgetExceededError) return fail(402, { budgetExceeded })`
// branch justified by a comment claiming "a PM review can transitively spawn a proposal session
// (makePmProposalAgent -> launchSession), which enforces the global token budget." That is false.
// runPmReview's ENTIRE dependency tree (pm-review / pm-proposals / pm-concierge / pm-session /
// pm-triage) spawns NO session and calls NO enforceTokenBudget — makePmProposalAgent/launchSession
// is reached only by the pm-lifecycle BACKGROUND tick, never by this action. The 402 branch was
// therefore unreachable dead code (a grounding / no-guessing violation, CLAUDE.md §2 / D-039 spirit)
// sold as real operator recourse. It was removed; this guard locks it out.
//
// Static guard over the pmReview action SLICE of +page.server.ts (mirrors cg2-budget-override-ui
// and repo-create-ui). CRLF-normalized (F-054) so the Edit tool's LF->CRLF flip on Windows cannot
// break the source-text matches.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.server.ts'), 'utf8').replace(/\r\n/g, '\n');

/** The body of the pmReview action, from its declaration up to the next action (pmSchedule). */
function pmReviewSlice(): string {
	const start = src.indexOf('\tpmReview: async (');
	const end = src.indexOf('\tpmSchedule: async (');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe('CG-2b — pmReview action does not fake a budget recourse (static guard)', () => {
	it('still calls runPmReview (the action itself is intact)', () => {
		expect(pmReviewSlice()).toMatch(/await runPmReview\(/);
	});

	it('does NOT map a TokenBudgetExceededError -> 402 (the dead recourse is gone)', () => {
		const slice = pmReviewSlice();
		// The action may NAME the error in an explanatory comment, but must not branch on it,
		// return a 402, or emit the budgetExceeded envelope — runPmReview can never raise it.
		expect(slice).not.toMatch(/instanceof TokenBudgetExceededError/);
		expect(slice).not.toContain('fail(402');
		expect(slice).not.toContain('budgetExceeded');
	});

	it('does NOT carry the false "review transitively spawns a session" call-graph comment', () => {
		// The old comment justified the dead branch with a spawn path that this action never takes.
		expect(pmReviewSlice()).not.toMatch(/can transitively spawn a proposal session/);
	});

	it('a failure in the pass surfaces as an honest 500 (a review that throws is a genuine failure)', () => {
		expect(pmReviewSlice()).toMatch(/return fail\(500, \{ pm: \{ error: \(err as Error\)\.message \} \}\)/);
	});
});
