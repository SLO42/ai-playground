// LOOP SHAPE CORE — the pure primitives + ladder derivation (loop-shape-core.ts). No DB, no runes: it
// only proves the HONEST mapping (F-008) — a primitive is satisfied ONLY when its checklist item is
// explicitly checked; the ladder reflects the derived phase and is not-applicable for 'unknown'.

import { describe, it, expect } from 'vitest';
import {
	loopPrimitives,
	shapeSatisfied,
	loopLadder,
	type ShapeSource
} from './loop-shape-core';

const source: ShapeSource = {
	phase: 'L3',
	cadenceLabel: 'tick-window 24/day',
	stateLabel: 'driving',
	ticksUsed: 3,
	ticksMax: 24
};

describe('loopPrimitives — honest satisfied mapping (F-008)', () => {
	it('returns the six primitives in loop order', () => {
		const p = loopPrimitives(source, {});
		expect(p.map((x) => x.key)).toEqual(['goal', 'trigger', 'action', 'check', 'state', 'handoff']);
	});

	it('a primitive is satisfied ONLY when its governing checklist item is explicitly true', () => {
		const p = loopPrimitives(source, { single_goal: true, cadence: false });
		const byKey = Object.fromEntries(p.map((x) => [x.key, x]));
		expect(byKey.goal.satisfied).toBe(true); // single_goal checked
		expect(byKey.trigger.satisfied).toBe(false); // cadence explicitly false
		expect(byKey.action.satisfied).toBe(false); // attempt_cap absent ⇒ unchecked
	});

	it('a null/absent checklist ⇒ every primitive unsatisfied (undeclared has declared nothing)', () => {
		const p = loopPrimitives(source, null);
		expect(p.every((x) => x.satisfied === false)).toBe(true);
		expect(shapeSatisfied(p)).toBe(0);
	});

	it('a non-boolean checklist value counts as UNCHECKED (only true satisfies)', () => {
		const p = loopPrimitives(source, { single_goal: 1 as unknown as boolean });
		expect(p.find((x) => x.key === 'goal')?.satisfied).toBe(false);
	});

	it('surfaces live details honestly (cadence / tick window / state), null elsewhere', () => {
		const p = loopPrimitives(source, {});
		const byKey = Object.fromEntries(p.map((x) => [x.key, x]));
		expect(byKey.trigger.detail).toBe('tick-window 24/day');
		expect(byKey.action.detail).toBe('3/24 this window');
		expect(byKey.state.detail).toBe('driving');
		expect(byKey.goal.detail).toBeNull();
		expect(byKey.check.detail).toBeNull();
		expect(byKey.handoff.detail).toBeNull();
	});

	it('no tick window ⇒ action detail null (never fabricated)', () => {
		const p = loopPrimitives({ ...source, ticksMax: null, ticksUsed: null }, {});
		expect(p.find((x) => x.key === 'action')?.detail).toBeNull();
	});
});

describe('loopLadder — L1→L2→L3 from the derived phase', () => {
	it('L2 → applicable, L1+L2 reached, L2 active, L3 not reached', () => {
		const l = loopLadder('L2');
		expect(l.applicable).toBe(true);
		const byKey = Object.fromEntries(l.rungs.map((r) => [r.key, r]));
		expect(byKey.L1.reached).toBe(true);
		expect(byKey.L2.reached).toBe(true);
		expect(byKey.L2.active).toBe(true);
		expect(byKey.L3.reached).toBe(false);
		expect(byKey.L1.active).toBe(false);
	});

	it("phase 'unknown' ⇒ not applicable, no rung reached (honest — ladder does not apply)", () => {
		const l = loopLadder('unknown');
		expect(l.applicable).toBe(false);
		expect(l.rungs.every((r) => r.reached === false && r.active === false)).toBe(true);
		expect(l.current).toBe('unknown');
	});

	it('L3 → every rung reached, L3 active', () => {
		const l = loopLadder('L3');
		expect(l.rungs.every((r) => r.reached)).toBe(true);
		expect(l.rungs.find((r) => r.key === 'L3')?.active).toBe(true);
	});
});
