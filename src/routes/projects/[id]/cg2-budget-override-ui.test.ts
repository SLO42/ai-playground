// CG-2 VERIFY — the operator-override CONFIRM surface on /projects/[id] (COST-GOVERNANCE-SPEC).
//
// Regression guard for the FAILED D-038 review of commit 6c547cc: the server-side override plumbing
// was built (launch + pmChat return fail(402){budgetExceeded} and read overrideBudget==='true') but
// +page.svelte had NO control that re-submits with overrideBudget=true and NO consumer of
// budgetExceeded — so once a budget was armed + hit, every interactive launch/PM turn was a dead-end.
//
// This is a static guard over +page.svelte (mirrors repo-create-ui.test.ts) so a refactor cannot
// silently re-drop the operator's ONLY UI recourse. CRLF-normalized (F-054) so the Edit tool's
// LF→CRLF flip on Windows cannot break the source-text matches.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8').replace(/\r\n/g, '\n');

describe('CG-2 operator token-budget override — the confirm surface exists & is wired (static guard)', () => {
	it('declares the two override confirm-state flags, reset after each submit (consent ≠ cap)', () => {
		expect(src).toMatch(/let launchOverride = \$state\(false\)/);
		expect(src).toMatch(/let pmOverride = \$state\(false\)/);
	});

	it('the LAUNCH form threads overrideBudget=true ONLY on an explicit confirm re-submit', () => {
		// The enhance submit-fn reads the state var (submit-time exact, not DOM-timing dependent)
		// and sets it on the outgoing formData.
		expect(src).toMatch(/if \(launchOverride\) formData\.set\('overrideBudget', 'true'\)/);
		// The confirm control is gated on the server's 402 budgetExceeded flag and arms the override.
		expect(src).toMatch(/'budgetExceeded' in form\.launch && form\.launch\.budgetExceeded/);
		expect(src).toMatch(/onclick=\{\(\) => \(launchOverride = true\)\}/);
		// And the override is reset after the submit resolves so a fresh launch never carries it.
		expect(src).toMatch(/launchOverride = false/);
	});

	it('the PM-CHAT form threads overrideBudget on confirm and KEEPS the message on a 402 refusal', () => {
		expect(src).toMatch(/if \(pmOverride\) formData\.set\('overrideBudget', 'true'\)/);
		// The message must clear ONLY on a real send — a budget refusal keeps it so the confirm
		// re-submit still carries the (server-required) message.
		expect(src).toMatch(/if \(result\.type === 'success'\) pmChatMessage = ''/);
		expect(src).toMatch(/pmFeedback && pmFeedback\.budgetExceeded/);
		expect(src).toMatch(/onclick=\{\(\) => \(pmOverride = true\)\}/);
		expect(src).toMatch(/pmOverride = false/);
	});

	it('both confirm controls are honest + design-system buttons (btn warn, alert-roled overspend)', () => {
		// Two "spend past budget" confirm buttons (launch + PM), using the existing .btn.warn token.
		const confirmBtns = src.match(/Confirm — spend past budget/g) ?? [];
		expect(confirmBtns.length).toBe(2);
		// The PM overspend warning surfaces the honest live spent/budget (F-008), role=alert, and a
		// SCOPE-AWARE label (CG2-2) — a per-project breach names this project's budget, not the daily one.
		expect(src).toMatch(/Over \{pmFeedback\.scope === 'project' \? "this project's" : 'the daily'\} token budget \(\{String\(pmFeedback\.spent\)\} of \{String\(pmFeedback\.budget\)\}/);
	});
});
