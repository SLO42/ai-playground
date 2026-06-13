import { describe, expect, it } from 'vitest';
import { isRunBusy, setRunBusy, type AdjBusyMap } from './adj-busy';

// TASK 16.7b regression — per-run adjudication busy isolation (DEFECT 1).
//
// The defect: a single shared `adjBusy` scalar meant submitting ANY one adjudicating
// run disabled the 'Resolve all & finalize' button on EVERY queued run. These tests pin
// the fix's contract: busy is keyed by run id; toggling one run never disables another.
describe('adj-busy — per-run isolation contract (16.7b)', () => {
	it('happy: marking run A busy leaves run B resolvable (the cross-form coupling fix)', () => {
		let map: AdjBusyMap = {};
		map = setRunBusy(map, 'interview_run:A', true);
		// A's own button disables…
		expect(isRunBusy(map, 'interview_run:A')).toBe(true);
		// …but B (and any other queued run) stays enabled — the whole point of the fix.
		expect(isRunBusy(map, 'interview_run:B')).toBe(false);
	});

	it('resolving A clears only A; a concurrently-busy B stays busy', () => {
		let map: AdjBusyMap = {};
		map = setRunBusy(map, 'interview_run:A', true);
		map = setRunBusy(map, 'interview_run:B', true);
		map = setRunBusy(map, 'interview_run:A', false); // A's submit resolves
		expect(isRunBusy(map, 'interview_run:A')).toBe(false);
		expect(isRunBusy(map, 'interview_run:B')).toBe(true);
	});

	it('nil/empty: an unknown run id (never submitted) is not busy — button enabled', () => {
		const map: AdjBusyMap = {};
		expect(isRunBusy(map, 'interview_run:never-touched')).toBe(false);
	});

	it('empty: an explicit false reads as not-busy (button enabled), distinct from absent', () => {
		const map = setRunBusy({}, 'interview_run:A', false);
		expect(isRunBusy(map, 'interview_run:A')).toBe(false);
	});

	it('setRunBusy is immutable (new ref) so $state reactivity fires; prior map untouched', () => {
		const before: AdjBusyMap = { 'interview_run:A': true };
		const after = setRunBusy(before, 'interview_run:B', true);
		expect(after).not.toBe(before); // new object reference
		expect(before['interview_run:B']).toBeUndefined(); // original not mutated
		expect(after['interview_run:A']).toBe(true); // existing flag preserved
	});
});
