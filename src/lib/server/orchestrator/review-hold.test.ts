import { describe, it, expect } from 'vitest';
import { shouldHoldMergeBack, resolveSessionExitState, type ReviewHoldPolicy } from './orchestrator';
import type { GateOutcome, GateStatus } from './pre-commit-gate';

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

// ── REGRESSION (the follow-on DoD-review's finding #3): 'gate-unknown' MUST NOT be stamped on a run
//    whose gate already answered.
//
//    THE DEFECT. `postTaskFaulted` is set by a catch spanning the ENTIRE post-task block — the gate,
//    the terminal transition, the commit, the review, the completion-event write and the game-verify
//    dispatch. The drain read it as "no gate verdict exists", so a DB fault on the completion event
//    produced a drain-ledger row saying `gate_verdict: 'none — the post-task loop faulted before one
//    was produced'` and a session note saying "the pre-commit gate produced NO verdict" — with a
//    green verdict in hand. The row was false; the operator reading it would re-run a task whose
//    checks had already passed.
//
//    WHAT THE FIX IS NOT. It is NOT "merge it, the gate was green" — the gate runs BEFORE the commit
//    (post-task.ts step 0), so a green verdict says nothing about whether the work was committed. A
//    fault between the two leaves the branch with no commits, and the 'done' merge path reads that
//    as noop-empty and TEARS THE WORKTREE DOWN (F-007). Both cases still WITHHOLD, identically. Only
//    the stamped reason differs — which is the whole finding: the withhold was right, the claim was
//    not.
describe('resolveSessionExitState — the post-task fault says WHICH kind of unverified it is', () => {
	const base = {
		gateFailed: false,
		ok: true,
		postTaskFaulted: false,
		gateArmed: true,
		gateVerdict: undefined as GateStatus | undefined,
		reviewHeld: false
	};

	it('a fault with NO verdict produced is gate-unknown (the honest original case)', () => {
		expect(resolveSessionExitState({ ...base, postTaskFaulted: true })).toBe('gate-unknown');
	});

	it('a fault AFTER a verdict is post-task-faulted — never the "no verdict" claim', () => {
		for (const verdict of ['passed', 'skipped', 'failed'] as const) {
			expect(
				resolveSessionExitState({ ...base, postTaskFaulted: true, gateVerdict: verdict })
			).toBe('post-task-faulted');
		}
	});

	it('BOTH fault cases withhold the merge — the fix changes the reason, never the safety', () => {
		// The property that actually protects the work: neither is 'done', so both ride merge-back's
		// `exitState !== 'done'` preserve branch (no FF, no teardown — F-007).
		expect(resolveSessionExitState({ ...base, postTaskFaulted: true })).not.toBe('done');
		expect(
			resolveSessionExitState({ ...base, postTaskFaulted: true, gateVerdict: 'passed' })
		).not.toBe('done');
	});

	it('with the gate NOT armed a post-task fault is unchanged — byte-identical to pre-PCG-1 (F-053)', () => {
		expect(
			resolveSessionExitState({ ...base, postTaskFaulted: true, gateArmed: false })
		).toBe('done');
		expect(
			resolveSessionExitState({
				...base,
				postTaskFaulted: true,
				gateArmed: false,
				reviewHeld: true
			})
		).toBe('review-held');
	});

	it('a RED gate outranks a fault and a hold — the most actionable reason wins', () => {
		expect(
			resolveSessionExitState({
				...base,
				gateFailed: true,
				postTaskFaulted: true,
				gateVerdict: 'failed',
				reviewHeld: true
			})
		).toBe('gate-failed');
	});

	it('a failed session outranks both fault states, and a clean run still merges', () => {
		expect(
			resolveSessionExitState({ ...base, ok: false, postTaskFaulted: true, gateVerdict: 'passed' })
		).toBe('failed');
		expect(resolveSessionExitState({ ...base, gateVerdict: 'passed' })).toBe('done');
		expect(resolveSessionExitState({ ...base, gateVerdict: 'passed', reviewHeld: true })).toBe(
			'review-held'
		);
	});
});
