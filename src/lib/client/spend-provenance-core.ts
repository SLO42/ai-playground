// COMPLETION-LEDGER Wave A — SPEND PROVENANCE: the pure vocabulary for "how real is this dollar
// figure?", shared by the server aggregators and the /reports UI.
//
// THE TWO HOLES THIS CLOSES. A cost total on /reports could lie in two INDEPENDENT ways, and both
// are the same F-008 failure class (a plausible-looking value presented as a measurement) moved up
// one layer — from the ROW to the SUM:
//
//   1. ESTIMATED dollars silently folded in. DS-2 (concierge/wire.ts meterConciergeTurn) made a
//      single ROW honest: a cloud concierge turn that times out or throws is metered from partial
//      usage or a bounded worst-case cap, and that row carries `detail.estimated` /
//      `detail.estimate_basis` / `detail.estimate_note`. But `rollup.ts` / `provider-usage.ts` /
//      `project-usage.ts` all `Σ cost_usd` across measured AND estimated rows into ONE number, and
//      the UI rendered it bare — so a total that is part guesswork read as fully measured.
//
//   2. UNPRICED rows silently omitted from the denominator. `resolveCostUsd` (analytics/events.ts)
//      leaves `cost_usd` NULL — deliberately, F-008 — whenever the model is absent from
//      config/pricing.yaml (or predates the CG-1 pricing chokepoint). Those rows still carry TOKENS
//      and still count as runs, so a bucket renders "9 runs / 20.2k tok" next to a confident
//      "$0.00" that is real arithmetic over a DISHONEST denominator: live, the opus tier was 18 rows
//      of which only 2 were priced (Σ $0.000570 → rounded to `$0.00`).
//
// So a figure needs BOTH disclosures: what share is ESTIMATED, and what share of the metered rows
// actually carries a price. This module is the single place that defines those two legs and the
// plain-language sentences the UI renders — one contract, one vocabulary, no per-surface drift.
//
// PURE + BROWSER-SAFE (no DB, no imports) so the /reports page and the server folds share it
// verbatim. The server-side row reader + accumulator live in
// `src/lib/server/analytics/spend-provenance.ts`, which builds on these types.

/**
 * The provenance legs every cost aggregate now carries ALONGSIDE its `costUsd` total. Each field is
 * honest-by-construction — none of them ever manufactures a figure:
 *
 *   • `spendEstimatedUsd` stays NULL until an estimated row actually carried a PRICED cost. An
 *     unpriced estimated row (a local/$0 turn, or a cloud turn on an unpriced model) never
 *     manufactures a $0 estimate leg, exactly as `costUsd` never manufactures a $0 total (F-008).
 *   • `estimatedRowCount` counts EVERY row whose spend is estimated, priced or not — so the operator
 *     still sees "3 rows here are estimated" even when their priced contribution is null.
 *   • `pricedRowCount` / `unpricedRowCount` split the METERED rows (rows that reported token usage
 *     and/or a cost — i.e. rows that COULD carry a price) by whether a price actually resolved.
 *     A bare `spawn` row carries no tokens and no cost: it is legitimately un-meterable and is
 *     counted in NEITHER, so it can never drag the coverage denominator down.
 *
 * A reader therefore distinguishes honest states that used to be indistinguishable: fully measured
 * and fully priced; partly estimated; partly priced; and "nothing here could be priced at all".
 */
export interface SpendProvenance {
	/** Σ cost_usd across the PRICED rows in this bucket whose spend is ESTIMATED; null when none. */
	spendEstimatedUsd: number | null;
	/** How many rows in this bucket carry estimated spend (priced or not). 0 ⇒ nothing estimated. */
	estimatedRowCount: number;
	/** METERED rows that DID resolve a cost_usd (an explicit $0 counts — local is a genuine zero). */
	pricedRowCount: number;
	/** METERED rows that did NOT resolve a cost_usd (model absent from pricing.yaml, or pre-CG-1). */
	unpricedRowCount: number;
}

/** A zeroed provenance leg — the honest "nothing recorded here" value (all four states false/0). */
export function emptySpendProvenance(): SpendProvenance {
	return { spendEstimatedUsd: null, estimatedRowCount: 0, pricedRowCount: 0, unpricedRowCount: 0 };
}

/**
 * How complete a bucket's PRICING is:
 *   • `unmetered` — no row in the bucket could carry a price (only spawns / token-less rows). The
 *                   total is necessarily null; there is no coverage question to answer.
 *   • `none`      — metered rows exist but NOT ONE resolved a price. The total is null and MUST
 *                   render "—": a `$0.00` here would be the exact lie this module exists to stop.
 *   • `partial`   — some metered rows are priced, some are not. The total is REAL but INCOMPLETE —
 *                   it is a floor, not the cost of the runs shown.
 *   • `full`      — every metered row is priced. The total is complete (nothing to disclose).
 */
export type CoverageLevel = 'unmetered' | 'none' | 'partial' | 'full';

/** The resolved pricing coverage of a bucket: level + the raw counts the UI shows. */
export interface CostCoverage {
	level: CoverageLevel;
	/** priced / metered in [0,1]; null when nothing was metered (no denominator to divide by). */
	ratio: number | null;
	/** Rows that resolved a price. */
	priced: number;
	/** Rows that COULD have resolved a price (priced + unpriced). */
	metered: number;
}

/**
 * Classify a bucket's pricing coverage from its provenance legs. Pure + total; never throws.
 *
 * Shadow paths (covered by spend-provenance-core.test.ts):
 *   • nil/empty — a zeroed leg ⇒ 'unmetered', ratio null (no denominator invented).
 *   • zero-priced — metered > 0, priced 0 ⇒ 'none', ratio 0.
 *   • partial — 2 of 9 ⇒ 'partial', ratio 2/9.
 *   • happy — priced === metered ⇒ 'full', ratio 1.
 */
export function costCoverage(p: SpendProvenance): CostCoverage {
	const priced = Math.max(0, p.pricedRowCount | 0);
	const metered = priced + Math.max(0, p.unpricedRowCount | 0);
	if (metered === 0) return { level: 'unmetered', ratio: null, priced: 0, metered: 0 };
	const ratio = priced / metered;
	const level: CoverageLevel = priced === 0 ? 'none' : priced === metered ? 'full' : 'partial';
	return { level, ratio, priced, metered };
}

/** True when a bucket has ANYTHING to disclose — an estimated share OR incomplete pricing. */
export function hasSpendDisclosure(p: SpendProvenance): boolean {
	const c = costCoverage(p);
	return p.estimatedRowCount > 0 || c.level === 'none' || c.level === 'partial';
}

/**
 * Format a dollar figure WITHOUT the rounding lie. `$${n.toFixed(2)}` turns a real Σ $0.000570 into
 * a confident `$0.00`, which reads as "these runs were free" — they were not. A positive figure that
 * would round to zero renders `<$0.01` instead; a genuine zero renders `$0.00`; null renders '—'
 * (F-008: absent is never dressed as a number).
 */
export function fmtUsd(c: number | null | undefined): string {
	if (typeof c !== 'number' || !Number.isFinite(c)) return '—';
	if (c === 0) return '$0.00';
	if (c > 0 && c < 0.005) return '<$0.01';
	if (c < 0 && c > -0.005) return '>-$0.01';
	return `$${c.toFixed(2)}`;
}

/**
 * The plain-language ESTIMATED-share sentence rendered next to a total. Returns null when there is
 * NOTHING to disclose (no estimated rows) so the caller renders no badge at all — an always-on
 * "0 estimated" chip would be noise, and an absent badge already means "nothing estimated here".
 *
 * `total` is the bucket's `costUsd` (may be null when nothing was priced).
 */
export function describeEstimatedSpend(p: SpendProvenance, total: number | null): string | null {
	if (p.estimatedRowCount <= 0) return null;
	const rows = `${p.estimatedRowCount} ${p.estimatedRowCount === 1 ? 'row' : 'rows'}`;
	if (p.spendEstimatedUsd == null) {
		return `${rows} here carry ESTIMATED spend, but none of them resolved a price — they add nothing to the figure shown.`;
	}
	const est = fmtUsd(p.spendEstimatedUsd);
	if (total == null || total <= 0) {
		return `${est} of this figure is ESTIMATED, not measured (${rows}) — a turn ended before the provider reported its usage, so the spend is derived from a bounded heuristic.`;
	}
	const share = Math.round((p.spendEstimatedUsd / total) * 100);
	return `${est} of the ${fmtUsd(total)} shown is ESTIMATED, not measured (${share}% · ${rows}) — those turns ended before the provider reported usage, so their spend is derived from a bounded heuristic.`;
}

/**
 * The plain-language PRICED-COVERAGE sentence rendered next to a total. Returns null when there is
 * nothing to disclose — coverage is 'full' (every metered row priced) or 'unmetered' (no row could
 * carry a price, and the total is already an honest '—').
 *
 * This is the disclosure that stops "9 runs / 20.2k tok · $0.00" from reading as "those runs cost
 * nothing" when in truth only 2 of 9 metered rows ever resolved a price.
 */
export function describeCostCoverage(p: SpendProvenance): string | null {
	const c = costCoverage(p);
	if (c.level === 'full' || c.level === 'unmetered') return null;
	if (c.level === 'none') {
		return `No cost shown: none of the ${c.metered} metered ${c.metered === 1 ? 'run' : 'runs'} here resolved a price — their model is absent from config/pricing.yaml (or predates cost metering), so the spend is UNKNOWN, not zero.`;
	}
	const pctPriced = Math.round(c.ratio! * 100);
	return `Only ${c.priced} of ${c.metered} metered runs here resolved a price (${pctPriced}%) — the figure shown is a FLOOR, not the full cost. The other ${c.metered - c.priced} ran on a model absent from config/pricing.yaml (or predate cost metering).`;
}

/** Both disclosures for one bucket, in the order they matter; empty array ⇒ nothing to disclose. */
export function describeSpendProvenance(p: SpendProvenance, total: number | null): string[] {
	const out: string[] = [];
	const cov = describeCostCoverage(p);
	if (cov) out.push(cov);
	const est = describeEstimatedSpend(p, total);
	if (est) out.push(est);
	return out;
}

/**
 * A COMPACT badge label for a table cell (the sentences above are for cards/tooltips). Returns null
 * when there is nothing to disclose, so a fully-measured, fully-priced cell stays clean.
 *   • 'unpriced'   — nothing priced; the cell itself shows '—'.
 *   • '2/9 priced' — a floor figure.
 *   • 'est.'       — the figure includes estimated dollars.
 * A cell that is BOTH partial and estimated shows both, e.g. '2/9 priced · est.'.
 */
export function spendBadge(p: SpendProvenance): string | null {
	const c = costCoverage(p);
	const parts: string[] = [];
	if (c.level === 'none') parts.push('unpriced');
	else if (c.level === 'partial') parts.push(`${c.priced}/${c.metered} priced`);
	if (p.estimatedRowCount > 0) parts.push('est.');
	return parts.length ? parts.join(' · ') : null;
}

/** Sum a set of provenance legs into one (window totals across days/buckets). Pure. */
export function sumSpendProvenance(legs: readonly SpendProvenance[]): SpendProvenance {
	let usd: number | null = null;
	let estRows = 0;
	let priced = 0;
	let unpriced = 0;
	for (const leg of legs) {
		if (leg.spendEstimatedUsd != null) usd = (usd ?? 0) + leg.spendEstimatedUsd;
		estRows += leg.estimatedRowCount;
		priced += leg.pricedRowCount;
		unpriced += leg.unpricedRowCount;
	}
	return {
		spendEstimatedUsd: usd,
		estimatedRowCount: estRows,
		pricedRowCount: priced,
		unpricedRowCount: unpriced
	};
}
