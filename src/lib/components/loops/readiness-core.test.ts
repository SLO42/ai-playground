// READINESS-CORE VERIFY — the pure Loop Design Checklist evaluator (LOOP-ENGINEERING.md:47-58). No DB,
// no runes: it grades a persisted checklist state into green/missing. The gate (arm-gate.ts) and the UI
// both depend on these exact semantics, so they are pinned here: green ONLY when every item is an explicit
// `true`; an absent/falsey item is missing (F-008 — never assume readiness).

import { describe, it, expect } from 'vitest';
import {
	READINESS_CHECKLIST,
	evaluateReadiness,
	phaseRequiresReadiness,
	type ChecklistState
} from './readiness-core';

const ALL_IDS = READINESS_CHECKLIST.map((i) => i.id);

function allChecked(): ChecklistState {
	const s: ChecklistState = {};
	for (const id of ALL_IDS) s[id] = true;
	return s;
}

describe('evaluateReadiness — green path', () => {
	it('every item checked ⇒ green, zero missing, checked == total', () => {
		const r = evaluateReadiness(allChecked());
		expect(r.green).toBe(true);
		expect(r.missing).toEqual([]);
		expect(r.checked).toBe(r.total);
		expect(r.total).toBe(READINESS_CHECKLIST.length);
	});
});

describe('evaluateReadiness — missing paths (each item, honest)', () => {
	it('null/undefined/empty state ⇒ everything missing, not green', () => {
		for (const empty of [null, undefined, {} as ChecklistState]) {
			const r = evaluateReadiness(empty);
			expect(r.green).toBe(false);
			expect(r.checked).toBe(0);
			expect(r.missing.length).toBe(READINESS_CHECKLIST.length);
		}
	});

	it('dropping ANY single item flips green→false and names exactly that item', () => {
		for (const id of ALL_IDS) {
			const state = allChecked();
			delete state[id];
			const r = evaluateReadiness(state);
			expect(r.green).toBe(false);
			expect(r.checked).toBe(ALL_IDS.length - 1);
			expect(r.missing.map((m) => m.id)).toEqual([id]);
		}
	});

	it('a non-true value (false / truthy non-boolean) counts as UNCHECKED', () => {
		const state = allChecked();
		// @ts-expect-error — deliberately a non-boolean to prove only `=== true` counts
		state[ALL_IDS[0]] = 'yes';
		state[ALL_IDS[1]] = false;
		const r = evaluateReadiness(state);
		expect(r.green).toBe(false);
		expect(r.missing.map((m) => m.id).sort()).toEqual([ALL_IDS[0], ALL_IDS[1]].sort());
	});
});

describe('checklist shape + phase gate', () => {
	it('has exactly 9 items with stable unique ids', () => {
		expect(READINESS_CHECKLIST.length).toBe(9);
		expect(new Set(ALL_IDS).size).toBe(9);
	});

	it('only L3 (autonomy) requires the readiness gate', () => {
		expect(phaseRequiresReadiness('L1')).toBe(false);
		expect(phaseRequiresReadiness('L2')).toBe(false);
		expect(phaseRequiresReadiness('L3')).toBe(true);
	});
});
