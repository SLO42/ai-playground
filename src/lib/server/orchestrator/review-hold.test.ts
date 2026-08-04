import { describe, it, expect } from 'vitest';
import { shouldHoldMergeBack, type ReviewHoldPolicy } from './orchestrator';
import type { GateOutcome } from './pre-commit-gate';

// PCG-1 REGRESSION — THE MERGE-HOLD POLICY, as a composition.
//
// WHY THIS FILE EXISTS. The permanent-hold defect was invisible to every existing test because
// each half was only ever exercised alone: the gate tests proved an unrunnable npm step is an
// honest 'skipped', the review tests proved a >= threshold change enqueues exactly one review —
// and nothing anywhere asserted what the two produce TOGETHER under the shipped boot.ts policy.
// Composed, they held every large change on every npm project (the WI-2 worktree has no
// node_modules and Windows npm is a `.cmd`, so the gate always skips) with NO automated release:
// boot.ts names the automated reviewer as DEFERRED, so a hold ends only when an operator acts.
// Atelier's own repo is an npm project (D-040), so the studio stopped its own autonomous line.
//
// The rule now lives in ONE exported pure function, and this file drives every combination of it.

/** A gate verdict shaped exactly as the drain reads it (only these two fields are consulted). */
function gate(status: GateOutcome['status'], unrunnable: boolean): Pick<GateOutcome, 'status' | 'unrunnable'> {
	return { status, unrunnable };
}

const NOTHING_TO_VERIFY = gate('skipped', false); // no build/lint/typecheck/test target at all
const ENVIRONMENT_SKIP = gate('skipped', true); // real checks, this working dir cannot run them
const GREEN = gate('passed', false);
const RED = gate('failed', false);

describe('shouldHoldMergeBack — the shipped default policy (unverified)', () => {
	const policy: ReviewHoldPolicy = 'unverified';

	it('HOLDS a triggered review when there was NOTHING to verify (the operator finding)', () => {
		expect(shouldHoldMergeBack(policy, true, NOTHING_TO_VERIFY)).toBe(true);
	});

	// THE REGRESSION. This returned true before the fix, for every npm project, forever.
	it('does NOT hold when the gate skipped because THIS ENVIRONMENT could not run the checks', () => {
		expect(shouldHoldMergeBack(policy, true, ENVIRONMENT_SKIP)).toBe(false);
	});

	it('does not hold a change the gate actually verified (green) — the pre-PCG-1 behaviour', () => {
		expect(shouldHoldMergeBack(policy, true, GREEN)).toBe(false);
	});

	it('does not hold when no review was triggered, whatever the gate said', () => {
		expect(shouldHoldMergeBack(policy, false, NOTHING_TO_VERIFY)).toBe(false);
		expect(shouldHoldMergeBack(policy, false, ENVIRONMENT_SKIP)).toBe(false);
		expect(shouldHoldMergeBack(policy, false, undefined)).toBe(false);
	});

	it('does not hold when the gate did not run at all (gate off ⇒ undefined)', () => {
		// With the gate disabled there is no 'skipped' verdict to key on; the drain behaves exactly
		// as it did before PCG-1 rather than holding on a verdict nobody produced.
		expect(shouldHoldMergeBack(policy, true, undefined)).toBe(false);
	});

	it('a RED gate is never a HOLD — it is a FAILURE, and the caller already withheld the merge', () => {
		// The drain guards this with !gateFailed as well; asserting it here keeps the rule itself
		// from ever being the thing that mislabels a red gate as "held for review".
		expect(shouldHoldMergeBack(policy, true, RED)).toBe(false);
	});
});

describe('shouldHoldMergeBack — the opt-in policies', () => {
	it("'always' holds every triggered review, including an environment skip", () => {
		expect(shouldHoldMergeBack('always', true, ENVIRONMENT_SKIP)).toBe(true);
		expect(shouldHoldMergeBack('always', true, GREEN)).toBe(true);
		expect(shouldHoldMergeBack('always', true, undefined)).toBe(true);
		// …but still only when a review was actually triggered.
		expect(shouldHoldMergeBack('always', false, GREEN)).toBe(false);
	});

	it("'never' holds nothing — the review is signal only", () => {
		expect(shouldHoldMergeBack('never', true, NOTHING_TO_VERIFY)).toBe(false);
		expect(shouldHoldMergeBack('never', true, ENVIRONMENT_SKIP)).toBe(false);
		expect(shouldHoldMergeBack('never', true, GREEN)).toBe(false);
	});
});
