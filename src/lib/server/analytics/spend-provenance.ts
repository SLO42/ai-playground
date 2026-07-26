// COMPLETION-LEDGER Wave A — the SERVER-side spend-provenance reader: one row → the two honesty
// legs (`detail.estimated` provenance + priced/unpriced coverage) every cost aggregator now folds.
//
// The pure vocabulary + the plain-language sentences live in `$lib/client/spend-provenance-core`
// (browser-safe, shared verbatim with /reports so the server's numbers and the UI's words can never
// drift). THIS module is the DB-facing half: it decides, per scanned `agent_event` row, whether the
// row's spend is ESTIMATED and whether it is PRICED, and accumulates both across a bucket.
//
// It is the ONE place those two questions are answered, so every aggregator classifies identically
// and a future writer has exactly one contract to satisfy.
//
// ── STRICTNESS ON `estimated` IS DELIBERATE (`=== true`, nothing else) ──
// A row with no `detail`, a non-object `detail`, a `detail` with no `estimated` key, or
// `estimated: false` counts as MEASURED. Every agent_event written before DS-2 falls in that bucket
// and was genuinely measured (or genuinely unpriced), so the default is honest rather than a mass
// reclassification of history. A truthy-ish value (`"true"`, `1`) is NOT accepted: our sole writer
// stamps a real boolean (concierge/wire.ts meterConciergeTurn), so a truthy-coerce would only ever
// let a malformed/unknown row silently CLAIM estimate provenance it never earned.
//
// ── WHAT COUNTS AS "METERED" (the coverage denominator) ──
// A row is metered when it reported token usage (`tokens_in`/`tokens_out` is a finite number) OR it
// already carries a cost. That is exactly the set `resolveCostUsd` (events.ts) is willing to price:
// a bare `spawn` row has no tokens, so it can never resolve a cost and is legitimately un-meterable.
// Counting spawns as "unpriced" would fabricate a bad coverage ratio out of correct behavior — the
// denominator must be "rows that COULD have a price", not "rows".

import {
	emptySpendProvenance,
	type SpendProvenance
} from '$lib/client/spend-provenance-core';

export type { SpendProvenance };
export {
	costCoverage,
	describeCostCoverage,
	describeEstimatedSpend,
	describeSpendProvenance,
	emptySpendProvenance,
	fmtUsd,
	hasSpendDisclosure,
	spendBadge,
	sumSpendProvenance,
	type CostCoverage,
	type CoverageLevel
} from '$lib/client/spend-provenance-core';

/** The sub-shape of an `agent_event.detail` this module reads (FLEXIBLE object — all keys optional). */
export interface EstimateProvenance {
	/** TRUE ⇒ the row's token/cost figures are a heuristic, not a provider report (DS-2 wire.ts). */
	estimated?: unknown;
	/** How the legs were derived — 'measured-usage' | 'partial-stream' | 'worst-case-cap' | 'none'. */
	estimate_basis?: unknown;
	/** Plain-language explanation of the estimate, surfaced verbatim on the row. */
	estimate_note?: unknown;
}

/**
 * Is THIS row's spend an ESTIMATE rather than a measurement? Pure, total, never throws — it is
 * called once per scanned row in every aggregator fold.
 *
 * Shadow paths (all covered by spend-provenance.test.ts):
 *   • nil            — `null` / `undefined` detail ⇒ false (measured; the pre-DS-2 default).
 *   • empty          — `{}` / `[]` / `''` / a number ⇒ false (no provenance claimed ⇒ not an estimate).
 *   • upstream error — a detail whose `estimated` is a string/number/NaN ⇒ false (see the strictness
 *                      note above: an unrecognised shape may not claim estimate provenance).
 *   • happy          — `{ estimated: true, … }` ⇒ true.
 */
export function isEstimatedRow(detail: unknown): boolean {
	if (detail === null || typeof detail !== 'object') return false;
	return (detail as EstimateProvenance).estimated === true;
}

/** The minimal row projection the fold needs (every field optional — a NONE column arrives absent). */
export interface SpendRow {
	detail?: unknown;
	cost_usd?: number | null;
	tokens_in?: number | null;
	tokens_out?: number | null;
}

/** True when the row reported usage the pricing chokepoint COULD have priced (see the note above). */
export function isMeteredRow(row: SpendRow): boolean {
	return (
		isFiniteNumber(row.cost_usd) || isFiniteNumber(row.tokens_in) || isFiniteNumber(row.tokens_out)
	);
}

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/** Mutable accumulator the folds carry while scanning; collapsed by {@link sealSpendProvenance}. */
export interface SpendProvenanceAccumulator {
	_estUsd: number;
	_estPriced: boolean;
	_estRows: number;
	_priced: number;
	_unpriced: number;
}

/** A fresh, zeroed spend-provenance accumulator (one per aggregation bucket). */
export function newSpendProvenanceAccumulator(): SpendProvenanceAccumulator {
	return { _estUsd: 0, _estPriced: false, _estRows: 0, _priced: 0, _unpriced: 0 };
}

/**
 * Fold ONE scanned row into a bucket's spend-provenance accumulator. Never throws — a malformed row
 * degrades to "measured, un-metered", which adds nothing and claims nothing.
 *
 * Two independent legs, deliberately decoupled:
 *   • ESTIMATE — an estimated row always increments `estimatedRowCount`; it adds to the dollar leg
 *     only when it actually resolved a price (an unpriced estimate contributes no fake $0).
 *   • COVERAGE — a metered row lands in `priced` or `unpriced`; a non-metered row (a bare spawn)
 *     lands in neither, so correct un-meterable rows never depress the coverage ratio.
 */
export function accumulateSpendProvenance(
	acc: SpendProvenanceAccumulator,
	row: SpendRow | null | undefined
): void {
	if (!row || typeof row !== 'object') return;
	const priced = isFiniteNumber(row.cost_usd);
	if (isEstimatedRow(row.detail)) {
		acc._estRows++;
		if (priced) {
			acc._estUsd += row.cost_usd as number;
			acc._estPriced = true;
		}
	}
	if (!isMeteredRow(row)) return; // un-meterable (no tokens, no cost) — not a coverage gap.
	if (priced) acc._priced++;
	else acc._unpriced++;
}

/** Collapse an accumulator into the public {@link SpendProvenance} (null-until-priced, F-008). */
export function sealSpendProvenance(acc: SpendProvenanceAccumulator): SpendProvenance {
	return {
		spendEstimatedUsd: acc._estPriced ? acc._estUsd : null,
		estimatedRowCount: acc._estRows,
		pricedRowCount: acc._priced,
		unpricedRowCount: acc._unpriced
	};
}

/** The zeroed public leg — re-exported for empty/disconnected loader branches (honest, not absent). */
export const EMPTY_SPEND_PROVENANCE: SpendProvenance = emptySpendProvenance();
