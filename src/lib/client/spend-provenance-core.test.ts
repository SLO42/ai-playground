import { describe, it, expect } from 'vitest';
import {
	costCoverage,
	describeCostCoverage,
	describeEstimatedSpend,
	describeSpendProvenance,
	emptySpendProvenance,
	fmtUsd,
	hasSpendDisclosure,
	spendBadge,
	sumSpendProvenance,
	type SpendProvenance
} from './spend-provenance-core';

// COMPLETION-LEDGER Wave A VERIFY (part 1) — the PURE spend-provenance vocabulary.
//
// These are the honesty rules themselves, so they are tested as rules, not as formatting: a figure
// that is partly estimated or partly unpriced must NEVER be presentable as a measurement, and an
// unpriced bucket must NEVER be presentable as $0 (F-008). Each function is exercised on all four
// shadow paths — nil, empty/zero-length, upstream-error (malformed), and happy.

function prov(over: Partial<SpendProvenance> = {}): SpendProvenance {
	return { ...emptySpendProvenance(), ...over };
}

describe('fmtUsd — money without the rounding lie', () => {
	it('renders a positive sub-cent figure as <$0.01, never $0.00 (the live opus-tier bug)', () => {
		// The real figure that rendered as a confident "$0.00": Σ over 2 priced opus rows.
		expect(fmtUsd(0.00057)).toBe('<$0.01');
		expect(fmtUsd(0.0049)).toBe('<$0.01');
	});

	it('renders a GENUINE zero as $0.00 (local/ollama is a real free, not a gap)', () => {
		expect(fmtUsd(0)).toBe('$0.00');
	});

	it('renders an absent figure as — (nil + malformed shadow paths)', () => {
		expect(fmtUsd(null)).toBe('—');
		expect(fmtUsd(undefined)).toBe('—');
		expect(fmtUsd(Number.NaN)).toBe('—');
		expect(fmtUsd(Number.POSITIVE_INFINITY)).toBe('—');
	});

	it('renders an ordinary figure at 2dp', () => {
		expect(fmtUsd(12.3456)).toBe('$12.35');
		expect(fmtUsd(0.01)).toBe('$0.01');
	});
});

describe('costCoverage — the priced denominator', () => {
	it('nil/empty: a zeroed leg is UNMETERED with a null ratio (no denominator invented)', () => {
		const c = costCoverage(emptySpendProvenance());
		expect(c.level).toBe('unmetered');
		expect(c.ratio).toBeNull();
		expect(c.metered).toBe(0);
	});

	it('zero-priced: metered rows with no price is NONE (never rendered as a $0 cost)', () => {
		const c = costCoverage(prov({ pricedRowCount: 0, unpricedRowCount: 9 }));
		expect(c.level).toBe('none');
		expect(c.ratio).toBe(0);
		expect(c.metered).toBe(9);
	});

	it('partial: the LIVE opus case — 2 of 9 metered runs priced', () => {
		const c = costCoverage(prov({ pricedRowCount: 2, unpricedRowCount: 7 }));
		expect(c.level).toBe('partial');
		expect(c.priced).toBe(2);
		expect(c.metered).toBe(9);
		expect(c.ratio).toBeCloseTo(2 / 9, 6);
	});

	it('happy: every metered row priced is FULL (nothing to disclose)', () => {
		const c = costCoverage(prov({ pricedRowCount: 4, unpricedRowCount: 0 }));
		expect(c.level).toBe('full');
		expect(c.ratio).toBe(1);
	});

	it('upstream error: negative/garbage counts are clamped, never producing a negative ratio', () => {
		const c = costCoverage(prov({ pricedRowCount: -3, unpricedRowCount: -1 }));
		expect(c.level).toBe('unmetered');
		expect(c.ratio).toBeNull();
	});
});

describe('describeCostCoverage — the unpriced-denominator disclosure', () => {
	it('says NOTHING when coverage is full (no always-on noise)', () => {
		expect(describeCostCoverage(prov({ pricedRowCount: 3 }))).toBeNull();
	});

	it('says NOTHING when nothing was metered (the total is already an honest —)', () => {
		expect(describeCostCoverage(emptySpendProvenance())).toBeNull();
	});

	it('names UNKNOWN, not zero, when nothing priced (the core F-008 rule)', () => {
		const msg = describeCostCoverage(prov({ unpricedRowCount: 5 }))!;
		expect(msg).toContain('UNKNOWN, not zero');
		expect(msg).toContain('5 metered runs');
		expect(msg).toContain('pricing.yaml');
	});

	it('calls a partly-priced figure a FLOOR and gives both counts', () => {
		const msg = describeCostCoverage(prov({ pricedRowCount: 2, unpricedRowCount: 7 }))!;
		expect(msg).toContain('2 of 9');
		expect(msg).toContain('FLOOR');
		expect(msg).toContain('22%');
	});
});

describe('describeEstimatedSpend — the estimated-share disclosure', () => {
	it('says NOTHING when no row is estimated', () => {
		expect(describeEstimatedSpend(emptySpendProvenance(), 4.2)).toBeNull();
	});

	it('estimated rows that never resolved a price add NOTHING to the figure (and say so)', () => {
		const msg = describeEstimatedSpend(prov({ estimatedRowCount: 3 }), 1.5)!;
		expect(msg).toContain('3 rows');
		expect(msg).toContain('add nothing');
	});

	it('reports the estimated share of the total when both are priced', () => {
		const msg = describeEstimatedSpend(
			prov({ estimatedRowCount: 2, spendEstimatedUsd: 1 }),
			4
		)!;
		expect(msg).toContain('ESTIMATED, not measured');
		expect(msg).toContain('25%');
	});

	it('nil/zero total: still names the estimate rather than dividing by zero', () => {
		const msg = describeEstimatedSpend(prov({ estimatedRowCount: 1, spendEstimatedUsd: 0.5 }), null)!;
		expect(msg).toContain('ESTIMATED');
		expect(msg).not.toContain('NaN');
		expect(msg).not.toContain('Infinity');
	});
});

describe('hasSpendDisclosure / describeSpendProvenance / spendBadge', () => {
	it('a fully measured, fully priced bucket discloses nothing at all', () => {
		const p = prov({ pricedRowCount: 6 });
		expect(hasSpendDisclosure(p)).toBe(false);
		expect(describeSpendProvenance(p, 3)).toEqual([]);
		expect(spendBadge(p)).toBeNull();
	});

	it('a bucket that is BOTH partly priced AND partly estimated discloses both, coverage first', () => {
		const p = prov({ pricedRowCount: 2, unpricedRowCount: 7, estimatedRowCount: 1, spendEstimatedUsd: 0.5 });
		expect(hasSpendDisclosure(p)).toBe(true);
		const lines = describeSpendProvenance(p, 2);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('FLOOR');
		expect(lines[1]).toContain('ESTIMATED');
		expect(spendBadge(p)).toBe('2/9 priced · est.');
	});

	it('badges the fully-unpriced bucket as "unpriced"', () => {
		expect(spendBadge(prov({ unpricedRowCount: 4 }))).toBe('unpriced');
	});
});

describe('sumSpendProvenance', () => {
	it('empty input sums to a zeroed leg with a NULL dollar figure (not 0)', () => {
		expect(sumSpendProvenance([])).toEqual(emptySpendProvenance());
	});

	it('stays null until a PRICED estimated leg lands, then adds', () => {
		const summed = sumSpendProvenance([
			prov({ estimatedRowCount: 2, pricedRowCount: 1, unpricedRowCount: 1 }),
			prov({ estimatedRowCount: 1, spendEstimatedUsd: 0.25, pricedRowCount: 3 })
		]);
		expect(summed.estimatedRowCount).toBe(3);
		expect(summed.spendEstimatedUsd).toBeCloseTo(0.25, 6);
		expect(summed.pricedRowCount).toBe(4);
		expect(summed.unpricedRowCount).toBe(1);
	});

	it('a set of legs with NO estimated dollars sums to null, never 0 (F-008)', () => {
		const summed = sumSpendProvenance([prov({ pricedRowCount: 2 }), prov({ unpricedRowCount: 1 })]);
		expect(summed.spendEstimatedUsd).toBeNull();
	});
});
