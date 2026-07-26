import { describe, it, expect } from 'vitest';
import {
	accumulateSpendProvenance,
	isEstimatedRow,
	isMeteredRow,
	newSpendProvenanceAccumulator,
	sealSpendProvenance
} from './spend-provenance';

// COMPLETION-LEDGER Wave A VERIFY (part 2) — the SERVER-side row reader.
//
// This is where a wrong answer would silently reclassify history: a loose `estimated` check would
// let malformed rows CLAIM estimate provenance, and a wrong "metered" definition would either
// fabricate a bad coverage ratio (counting token-less spawns as unpriced) or hide a real gap.

describe('isEstimatedRow (strict — `=== true` and nothing else)', () => {
	it('happy: an explicit boolean true is an estimate', () => {
		expect(isEstimatedRow({ estimated: true, estimate_basis: 'worst-case-cap' })).toBe(true);
	});

	it('nil: null/undefined detail is MEASURED (the pre-DS-2 default for all history)', () => {
		expect(isEstimatedRow(null)).toBe(false);
		expect(isEstimatedRow(undefined)).toBe(false);
	});

	it('empty: an empty object / array / string / number claims nothing', () => {
		expect(isEstimatedRow({})).toBe(false);
		expect(isEstimatedRow([])).toBe(false);
		expect(isEstimatedRow('')).toBe(false);
		expect(isEstimatedRow(0)).toBe(false);
	});

	it('upstream error: a truthy-ISH value may NOT claim estimate provenance', () => {
		expect(isEstimatedRow({ estimated: 'true' })).toBe(false);
		expect(isEstimatedRow({ estimated: 1 })).toBe(false);
		expect(isEstimatedRow({ estimated: Number.NaN })).toBe(false);
		expect(isEstimatedRow({ estimated: false })).toBe(false);
	});
});

describe('isMeteredRow (the coverage denominator)', () => {
	it('a bare spawn (no tokens, no cost) is NOT metered — it can never resolve a price', () => {
		expect(isMeteredRow({})).toBe(false);
		expect(isMeteredRow({ tokens_in: null, tokens_out: null, cost_usd: null })).toBe(false);
	});

	it('a row reporting tokens IS metered, priced or not', () => {
		expect(isMeteredRow({ tokens_in: 100 })).toBe(true);
		expect(isMeteredRow({ tokens_out: 40 })).toBe(true);
		expect(isMeteredRow({ tokens_in: 0, tokens_out: 0 })).toBe(true);
	});

	it('a row carrying a cost is metered even with no token counts', () => {
		expect(isMeteredRow({ cost_usd: 0.02 })).toBe(true);
		expect(isMeteredRow({ cost_usd: 0 })).toBe(true);
	});

	it('upstream error: a non-finite number is not usable and does not meter the row', () => {
		expect(isMeteredRow({ tokens_in: Number.NaN, cost_usd: Number.POSITIVE_INFINITY })).toBe(false);
	});
});

describe('accumulateSpendProvenance / sealSpendProvenance', () => {
	function fold(rows: Array<Record<string, unknown>>) {
		const acc = newSpendProvenanceAccumulator();
		for (const r of rows) accumulateSpendProvenance(acc, r);
		return sealSpendProvenance(acc);
	}

	it('empty input seals to the honest zero leg (dollar figure NULL, not 0)', () => {
		expect(fold([])).toEqual({
			spendEstimatedUsd: null,
			estimatedRowCount: 0,
			pricedRowCount: 0,
			unpricedRowCount: 0
		});
	});

	it('nil rows are absorbed, never thrown on', () => {
		const acc = newSpendProvenanceAccumulator();
		accumulateSpendProvenance(acc, null);
		accumulateSpendProvenance(acc, undefined);
		expect(sealSpendProvenance(acc).pricedRowCount).toBe(0);
	});

	it('reproduces the LIVE opus bucket: 9 spawns + 9 completions, only 2 priced', () => {
		const rows: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 9; i++) rows.push({ type: 'spawn' }); // token-less: not metered
		for (let i = 0; i < 7; i++) rows.push({ tokens_in: 1000, tokens_out: 200 }); // metered, unpriced
		rows.push({ tokens_in: 1000, tokens_out: 200, cost_usd: 0.00028 });
		rows.push({ tokens_in: 1000, tokens_out: 200, cost_usd: 0.00029 });

		const leg = fold(rows);
		// The spawns must NOT drag the denominator — 9 metered rows, not 18.
		expect(leg.pricedRowCount).toBe(2);
		expect(leg.unpricedRowCount).toBe(7);
		expect(leg.estimatedRowCount).toBe(0);
		expect(leg.spendEstimatedUsd).toBeNull();
	});

	it('an UNPRICED estimated row counts as estimated but manufactures no $0 estimate leg', () => {
		const leg = fold([{ tokens_in: 10, detail: { estimated: true, estimate_basis: 'worst-case-cap' } }]);
		expect(leg.estimatedRowCount).toBe(1);
		expect(leg.spendEstimatedUsd).toBeNull(); // NOT 0 — F-008
		expect(leg.unpricedRowCount).toBe(1);
	});

	it('a PRICED estimated row lands in BOTH the estimate leg and the priced coverage', () => {
		const leg = fold([
			{ tokens_in: 10, cost_usd: 0.5, detail: { estimated: true } },
			{ tokens_in: 10, cost_usd: 1.5 }
		]);
		expect(leg.estimatedRowCount).toBe(1);
		expect(leg.spendEstimatedUsd).toBeCloseTo(0.5, 6);
		expect(leg.pricedRowCount).toBe(2);
		expect(leg.unpricedRowCount).toBe(0);
	});

	it('an explicit $0 (local/ollama) counts as PRICED — a real free, not a coverage gap', () => {
		const leg = fold([{ tokens_in: 500, tokens_out: 100, cost_usd: 0 }]);
		expect(leg.pricedRowCount).toBe(1);
		expect(leg.unpricedRowCount).toBe(0);
	});

	it('upstream error: a malformed detail never claims estimate provenance', () => {
		const leg = fold([{ tokens_in: 5, cost_usd: 1, detail: { estimated: 'yes' } }]);
		expect(leg.estimatedRowCount).toBe(0);
		expect(leg.spendEstimatedUsd).toBeNull();
	});
});
