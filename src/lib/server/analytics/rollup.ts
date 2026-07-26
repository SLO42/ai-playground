// TASK 2.4 — analytics: daily rollups + anomaly flags (UI-SPEC §6 /reports; F-008).
//
// The analytics CONSUMER. It only QUERIES `agent_event` + `routing_event` (routing is
// their sole producer — §2.5); it never writes them. All figures are computed from REAL
// rows (F-008): a day with no events yields an empty rollup, never a zero-dressed-as-real
// fabrication, and cost is summed ONLY from rows that actually carry a priced cost_usd.
//
// SurrealQL discipline (DATA-MODEL §6.1 / project rules): aggregation uses GROUP BY +
// math::* / count(); array/set legality stays in JS. The day bucket is derived in JS
// from each row's `at` (we SELECT the raw rows in a bounded window, then fold) — this
// keeps the SQL simple and avoids time::format quirks across SurrealDB 2.x point builds,
// while the windowing LIMIT keeps the scan bounded.

import type { Db } from '../db/client';
import {
	accumulateSpendProvenance,
	newSpendProvenanceAccumulator,
	sealSpendProvenance,
	sumSpendProvenance,
	type SpendProvenance,
	type SpendProvenanceAccumulator
} from './spend-provenance';

/** One day's agent-activity rollup (all figures from real rows; F-008). */
export interface DailyRollup extends SpendProvenance {
	/** ISO date (YYYY-MM-DD), UTC. */
	day: string;
	/** Count of spawn events that day (runs started). */
	spawns: number;
	/** Count of completion events. */
	completions: number;
	/** Count of error events. */
	errors: number;
	/** Count of escalation events (tier upgrades). */
	escalations: number;
	/** Σ tokens_in across the day (completion rows carry the totals). */
	tokensIn: number;
	/** Σ tokens_out. */
	tokensOut: number;
	/**
	 * Σ cost_usd across rows that carried a PRICED cost; null when none were priced.
	 * NOTE: this is the FULL total over the rows that HAD a price — it can be dishonest in two
	 * independent ways, and the inherited {@link SpendProvenance} legs disclose both: it may include
	 * ESTIMATED dollars (`spendEstimatedUsd`/`estimatedRowCount`, DS-2), and it silently OMITS
	 * metered rows whose model resolved no price (`unpricedRowCount`), which makes it a FLOOR rather
	 * than the cost of the runs shown. Neither may be presented as a measurement (F-008).
	 */
	costUsd: number | null;
	/** Mean duration_ms across completion rows that reported one; null when none did. */
	avgDurationMs: number | null;
	/** Median (p50) duration_ms across rows that reported one; null when none did. */
	p50DurationMs: number | null;
	/** p95 duration_ms across rows that reported one; null when none did (the tail, not the mean). */
	p95DurationMs: number | null;
	/** error / (completions + errors) — the day's failure rate in [0,1]; null when no terminal rows.
	 *  This denominator is SOUND: both legs are terminal events, so the ratio is bounded by [0,1].
	 *
	 *  NOT SHIPPED, deliberately: a "completion rate" (completions / spawns). Live data proved the
	 *  denominator unsound — a run SPAWNED on day A completes on day B, so a day's completions are
	 *  not bounded by that day's spawns and the ratio rendered 1175%. A >100% "rate" is the same
	 *  dishonest-denominator defect this wave exists to remove, so the raw `completions` COUNT is
	 *  reported and no rate is derived from it. A sound version needs spawn→completion PAIRING
	 *  (cohort by the spawn's day, via parent_event_id / session), which is a real piece of work,
	 *  not a free column. */
	errorRate: number | null;
}

/** An anomaly flagged on a day's rollup, with the WHY so /reports can explain it. */
export interface Anomaly {
	day: string;
	kind: 'error-spike' | 'cost-spike' | 'escalation-spike' | 'no-activity';
	/** Human-readable explanation (asserted-conclusion style for the chart title). */
	message: string;
	/** The day's value that tripped the flag. */
	value: number;
	/** The baseline it was compared against (trailing mean), when applicable. */
	baseline?: number;
}

export interface ReportSummary {
	/** Daily rollups, oldest → newest. */
	days: DailyRollup[];
	/** Anomalies detected across the window. */
	anomalies: Anomaly[];
	/** Window totals (sum across days) — `costUsd` is the summed total; the inherited provenance
	 *  legs disclose the ESTIMATED share and the PRICED coverage behind it (F-008). */
	totals: SpendProvenance & {
		spawns: number;
		completions: number;
		errors: number;
		escalations: number;
		tokensIn: number;
		tokensOut: number;
		costUsd: number | null;
	};
}

/** Minimal raw agent_event projection the rollup folds. */
interface RawEvent {
	type: string;
	at: string | Date;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	duration_ms?: number | null;
	/** FLEXIBLE provenance object — read ONLY through isEstimatedRow (analytics/estimated.ts). */
	detail?: unknown;
}

/** UTC YYYY-MM-DD for a row's `at` (SurrealDB returns an ISO string or Date). */
function dayKey(at: string | Date): string {
	const d = at instanceof Date ? at : new Date(at);
	return d.toISOString().slice(0, 10);
}

function emptyRollup(day: string): DailyRollup {
	return {
		day,
		spawns: 0,
		completions: 0,
		errors: 0,
		escalations: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: null,
		avgDurationMs: null,
		p50DurationMs: null,
		p95DurationMs: null,
		errorRate: null,
		spendEstimatedUsd: null,
		estimatedRowCount: 0,
		pricedRowCount: 0,
		unpricedRowCount: 0
	};
}

/**
 * The q-th percentile of a duration sample by nearest-rank on the SORTED array (no interpolation —
 * the reported value is always a duration that really happened). Returns null for an empty sample:
 * a percentile of nothing is not 0 (F-008). `q` is clamped to [0,1]. Pure.
 */
export function percentileMs(sorted: readonly number[], q: number): number | null {
	if (sorted.length === 0) return null;
	const qq = Math.min(1, Math.max(0, q));
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(qq * sorted.length) - 1));
	return Math.round(sorted[idx]);
}

/**
 * Fold a flat list of agent_event rows into per-day rollups (pure — unit-testable with
 * no DB). Exposed separately so the anomaly pass and the loader can both reuse it and so
 * the math is verifiable in isolation.
 */
export function foldDaily(events: RawEvent[]): DailyRollup[] {
	const byDay = new Map<string, DailyRollup>();
	// Duration SAMPLES kept aside (DailyRollup exposes mean + p50 + p95; the raw array never leaves).
	// Retaining the array instead of a running sum/count is what makes the percentiles free.
	const durSamples = new Map<string, number[]>();
	// The spend-provenance split (estimated share + priced coverage), per day, beside the total.
	const provAccum = new Map<string, SpendProvenanceAccumulator>();

	for (const ev of events) {
		const key = dayKey(ev.at);
		let r = byDay.get(key);
		if (!r) {
			r = emptyRollup(key);
			byDay.set(key, r);
		}
		let prov = provAccum.get(key);
		if (!prov) {
			prov = newSpendProvenanceAccumulator();
			provAccum.set(key, prov);
		}
		// Read the row's spend provenance BEFORE the totals fold, so an estimated/unpriced row lands
		// in both the total AND the disclosure leg (never one without the other).
		accumulateSpendProvenance(prov, ev);
		switch (ev.type) {
			case 'spawn':
				r.spawns++;
				break;
			case 'completion':
				r.completions++;
				break;
			case 'error':
				r.errors++;
				break;
			case 'escalation':
				r.escalations++;
				break;
		}
		if (typeof ev.tokens_in === 'number') r.tokensIn += ev.tokens_in;
		if (typeof ev.tokens_out === 'number') r.tokensOut += ev.tokens_out;
		if (typeof ev.cost_usd === 'number') {
			r.costUsd = (r.costUsd ?? 0) + ev.cost_usd; // stays null until a PRICED row appears
		}
		if (typeof ev.duration_ms === 'number' && Number.isFinite(ev.duration_ms)) {
			const a = durSamples.get(key) ?? [];
			a.push(ev.duration_ms);
			durSamples.set(key, a);
		}
	}

	for (const [key, r] of byDay) {
		const sample = (durSamples.get(key) ?? []).slice().sort((a, b) => a - b);
		r.avgDurationMs = sample.length > 0 ? Math.round(sample.reduce((s, x) => s + x, 0) / sample.length) : null;
		r.p50DurationMs = percentileMs(sample, 0.5);
		r.p95DurationMs = percentileMs(sample, 0.95);
		const terminal = r.completions + r.errors;
		r.errorRate = terminal > 0 ? r.errors / terminal : null;
		const prov = provAccum.get(key);
		if (prov) Object.assign(r, sealSpendProvenance(prov));
	}

	return [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
}

/**
 * Detect anomalies over the daily series (pure). A day is flagged when a metric is well
 * above its TRAILING baseline (mean of prior days in the window) — so the flag is
 * trend-aware, not a fixed threshold (UI-SPEC §6: "trend-aware, not raw event lists").
 *
 *   • error-spike      — errorRate ≥ 0.5 AND ≥ 2× the trailing mean error rate
 *   • cost-spike       — costUsd ≥ 2× the trailing mean (only when costs are priced)
 *   • escalation-spike — escalations ≥ 2× the trailing mean AND ≥ 3 absolute
 *   • no-activity      — a day inside the active window with zero spawns
 *
 * The first day has no baseline, so spike rules need ≥1 prior day; the absolute floors
 * keep a 0→1 jump from screaming "spike".
 */
export function detectAnomalies(days: DailyRollup[]): Anomaly[] {
	const out: Anomaly[] = [];
	for (let i = 0; i < days.length; i++) {
		const d = days[i];
		const prior = days.slice(0, i);

		// no-activity: a day with terminal/spawn activity absent but surrounded by activity.
		if (d.spawns === 0 && i > 0 && i < days.length) {
			out.push({
				day: d.day,
				kind: 'no-activity',
				message: `No agent runs started on ${d.day}.`,
				value: 0
			});
		}

		if (prior.length > 0) {
			// error-spike
			const priorRates = prior.map((p) => p.errorRate).filter((x): x is number => x != null);
			if (d.errorRate != null && d.errorRate >= 0.5 && priorRates.length > 0) {
				const base = priorRates.reduce((s, x) => s + x, 0) / priorRates.length;
				if (d.errorRate >= 2 * Math.max(base, 0.0001)) {
					out.push({
						day: d.day,
						kind: 'error-spike',
						message: `Error rate ${(d.errorRate * 100).toFixed(0)}% on ${d.day} — ${(d.errorRate / Math.max(base, 0.0001)).toFixed(1)}× the prior average.`,
						value: d.errorRate,
						baseline: base
					});
				}
			}

			// cost-spike (only meaningful when costs are priced)
			const priorCosts = prior.map((p) => p.costUsd).filter((x): x is number => x != null);
			if (d.costUsd != null && priorCosts.length > 0) {
				const base = priorCosts.reduce((s, x) => s + x, 0) / priorCosts.length;
				if (base > 0 && d.costUsd >= 2 * base) {
					out.push({
						day: d.day,
						kind: 'cost-spike',
						message: `Spend $${d.costUsd.toFixed(2)} on ${d.day} — ${(d.costUsd / base).toFixed(1)}× the prior average.`,
						value: d.costUsd,
						baseline: base
					});
				}
			}

			// escalation-spike
			const priorEsc = prior.map((p) => p.escalations);
			const baseEsc = priorEsc.reduce((s, x) => s + x, 0) / priorEsc.length;
			if (d.escalations >= 3 && d.escalations >= 2 * Math.max(baseEsc, 0.5)) {
				out.push({
					day: d.day,
					kind: 'escalation-spike',
					message: `${d.escalations} escalations on ${d.day} — well above the prior average of ${baseEsc.toFixed(1)}.`,
					value: d.escalations,
					baseline: baseEsc
				});
			}
		}
	}
	return out;
}

/** Sum window totals across the daily rollups. */
function sumTotals(days: DailyRollup[]): ReportSummary['totals'] {
	const t = {
		spawns: 0,
		completions: 0,
		errors: 0,
		escalations: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: null as number | null
	};
	for (const d of days) {
		t.spawns += d.spawns;
		t.completions += d.completions;
		t.errors += d.errors;
		t.escalations += d.escalations;
		t.tokensIn += d.tokensIn;
		t.tokensOut += d.tokensOut;
		if (d.costUsd != null) t.costUsd = (t.costUsd ?? 0) + d.costUsd;
	}
	// The provenance legs sum the SAME way the total does (the dollar leg stays null until a priced
	// estimated row lands), so the window headline can disclose both "X of this total is estimated"
	// AND "only N of M metered runs are priced" (F-008).
	return { ...t, ...sumSpendProvenance(days) };
}

export interface RollupOptions {
	/** How many days back to include (default 14). */
	windowDays?: number;
	/** Restrict to one project (record id `project:…`); omitted ⇒ portfolio-wide. */
	projectId?: string;
	/** Hard cap on rows scanned (safety bound; default 50_000). */
	maxRows?: number;
}

/**
 * Build the full report summary (daily rollups + anomalies + totals) from REAL
 * `agent_event` rows in the trailing window. Project filter binds via $param; the row
 * cap bounds the scan. F-008: every figure traces to a real row — no fabrication.
 */
export async function buildReportSummary(db: Db, opts: RollupOptions = {}): Promise<ReportSummary> {
	const windowDays = opts.windowDays ?? 14;
	const maxRows = opts.maxRows ?? 50_000;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	// Bind the project filter as a record link via the SDK (StringRecordId), not interpolation.
	const params: Record<string, unknown> = { since, lim: maxRows };
	let where = `at >= $since`;
	if (opts.projectId) {
		const { StringRecordId } = await import('surrealdb');
		const { assertRecordId } = await import('../db/validate');
		params.pid = new StringRecordId(assertRecordId(opts.projectId));
		where += ` AND project = $pid`;
	}

	// F-020: `at` (the ORDER BY idiom) is in the projection. `detail` carries the DS-2 spend
	// provenance (`detail.estimated`) the estimated-vs-measured disclosure leg is folded from —
	// without it every aggregate silently reports guesswork as measurement.
	const [rows] = await db.query<[RawEvent[]]>(
		`SELECT type, at, tokens_in, tokens_out, cost_usd, duration_ms, detail
		   FROM agent_event WHERE ${where} ORDER BY at ASC LIMIT $lim;`,
		params
	);

	const days = foldDaily(rows ?? []);
	return { days, anomalies: detectAnomalies(days), totals: sumTotals(days) };
}

// ── Per-tier usage (for /agents — tier-centric LENS, UI-SPEC §198) ────────────────

/**
 * Usage rolled up per tier from real agent_event rows (F-008).
 *
 * `costUsd` is Σ over the rows that RESOLVED a price — which is NOT the same as the cost of the runs
 * shown. The inherited {@link SpendProvenance} legs are what make the difference visible: how much of
 * the figure is ESTIMATED, and how many of the metered runs actually carry a price. This card is
 * where the dishonesty was worst — an opus bucket of 18 rows with 2 priced rendered a confident
 * "$0.00" next to "9 runs / 20.2k tok", which reads as "opus cost nothing". It did not.
 */
export interface TierUsage extends SpendProvenance {
	tier: string;
	provider: string;
	/** The DISTINCT model ids that ran in this bucket, sorted. Ends the 'unknown'-tier opacity: a
	 *  bucket whose tier is unset still names the models behind it. Empty ⇒ no row carried a model. */
	models: string[];
	runs: number;
	/** Completion events in the bucket (the terminal counterpart of `runs`). A COUNT, not a rate:
	 *  a spawn in this bucket may complete in another window, so completions/runs is not bounded by
	 *  [0,1] and is deliberately NOT derived (see the DailyRollup.errorRate note). */
	completions: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number | null;
	avgDurationMs: number | null;
}

interface RawTierRow {
	tier?: string | null;
	provider?: string | null;
	model_id?: string | null;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	duration_ms?: number | null;
	type?: string;
	/** FLEXIBLE provenance object — read ONLY through the spend-provenance module. */
	detail?: unknown;
}

/**
 * Roll completion+spawn events up per (tier, provider) for the /agents usage LENS.
 * Aggregated from real rows only (F-008). A run with no tier on its model lands under
 * the 'unknown' bucket rather than being dropped — honest, not silently lossy.
 */
export async function buildTierUsage(db: Db, opts: RollupOptions = {}): Promise<TierUsage[]> {
	const windowDays = opts.windowDays ?? 30;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
	// `detail` carries the DS-2 estimate provenance; `model.model_id` names the concrete model behind
	// each bucket (an 'unknown' tier used to be a dead end — now the model ids explain it). F-020 is
	// satisfied trivially here: this query has no ORDER BY / GROUP BY (the fold + sort happen in JS).
	const [rows] = await db.query<[RawTierRow[]]>(
		`SELECT model.tier AS tier, model.provider AS provider, model.model_id AS model_id,
		        tokens_in, tokens_out, cost_usd, duration_ms, type, detail
		   FROM agent_event WHERE at >= $since AND type IN ["spawn","completion"] LIMIT 50000;`,
		{ since }
	);

	type TierAcc = TierUsage & {
		_durSum: number;
		_durN: number;
		_models: Set<string>;
	} & SpendProvenanceAccumulator;
	const byKey = new Map<string, TierAcc>();
	for (const r of rows ?? []) {
		const tier = (r.tier as string) || 'unknown';
		const provider = (r.provider as string) || 'unknown';
		const key = `${provider}:${tier}`;
		let u = byKey.get(key);
		if (!u) {
			u = {
				tier,
				provider,
				models: [],
				runs: 0,
				completions: 0,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: null,
				avgDurationMs: null,
				spendEstimatedUsd: null,
				estimatedRowCount: 0,
				pricedRowCount: 0,
				unpricedRowCount: 0,
				_durSum: 0,
				_durN: 0,
				_models: new Set<string>(),
				...newSpendProvenanceAccumulator()
			};
			byKey.set(key, u);
		}
		// Count one run per spawn (the lifecycle start); completions carry the totals.
		if (r.type === 'spawn') u.runs++;
		else if (r.type === 'completion') u.completions++;
		if (typeof r.model_id === 'string' && r.model_id.trim()) u._models.add(r.model_id.trim());
		if (typeof r.tokens_in === 'number') u.tokensIn += r.tokens_in;
		if (typeof r.tokens_out === 'number') u.tokensOut += r.tokens_out;
		if (typeof r.cost_usd === 'number') u.costUsd = (u.costUsd ?? 0) + r.cost_usd;
		accumulateSpendProvenance(u, r);
		if (typeof r.duration_ms === 'number') {
			u._durSum += r.duration_ms;
			u._durN++;
		}
	}

	return [...byKey.values()]
		.map(({ _durSum, _durN, _models, _estUsd, _estPriced, _estRows, _priced, _unpriced, ...u }) => ({
			...u,
			models: [..._models].sort(),
			avgDurationMs: _durN > 0 ? Math.round(_durSum / _durN) : null,
			...sealSpendProvenance({ _estUsd, _estPriced, _estRows, _priced, _unpriced })
		}))
		.sort((a, b) => b.runs - a.runs);
}

// ── Shell tickers (Statusbar/Topbar always-on awareness strip, UI-SPEC §3) ─────────
//
// The always-visible shell shows: running agents · today's tokens · today's cost. These
// are the live counters the operator glances at on EVERY screen, so they MUST be REAL
// (F-008) — a count from real `session`/`agent_event` rows, or an honest null → "—" when
// the figure has no real source yet (e.g. no priced run ⇒ cost stays null, never a fake $0).
//
// "running agents" = sessions whose status is exactly 'running' (the same liveness source
// the fleet grid uses — §199, never agent_slot.busy). "today" = the current UTC day, the
// same day bucket the daily rollup uses, so the ticker and /reports agree.

/** The live shell counters (all from real rows; null ⇒ render "—", never a fake number). */
export interface ShellMetrics extends SpendProvenance {
	/** Sessions with status='running' right now (live agent count). */
	runningAgents: number;
	/** Σ (tokens_in + tokens_out) across today's agent_event rows. */
	tokensToday: number;
	/**
	 * Σ cost_usd across today's PRICED rows; null when none were priced (never a fake $0).
	 * The inherited {@link SpendProvenance} legs disclose the two ways this figure can mislead — the
	 * ESTIMATED portion (derived, not provider-reported) and the UNPRICED metered rows it omits — so
	 * the always-on ticker can flag a partly-derived / partly-priced day instead of presenting it as
	 * a measurement (F-008).
	 */
	costToday: number | null;
}

/**
 * Read the live shell tickers from REAL rows (F-008). One round-trip, two cheap reads:
 *   • running-agent count   — COUNT(session WHERE status='running')
 *   • today's token + cost   — Σ over agent_event rows whose `at` is in the current UTC day
 * Cost stays null until a priced row appears in the window (we never dress an unpriced
 * day as $0). The current-day window binds via $since so the scan is bounded to today.
 */
export async function buildShellMetrics(db: Db): Promise<ShellMetrics> {
	// Start of the current UTC day (matches dayKey's UTC bucketing so the ticker == /reports).
	const startOfDay = new Date();
	startOfDay.setUTCHours(0, 0, 0, 0);

	const [running, todays] = await db.query<[Array<{ c: number }>, RawEvent[]]>(
		`SELECT count() AS c FROM session WHERE status = 'running' GROUP ALL;
		 SELECT type, at, tokens_in, tokens_out, cost_usd, detail FROM agent_event
		   WHERE at >= $since LIMIT 50000;`,
		{ since: startOfDay }
	);

	const runningAgents = running?.[0]?.c ?? 0;

	let tokensToday = 0;
	let costToday: number | null = null;
	const prov = newSpendProvenanceAccumulator();
	for (const ev of todays ?? []) {
		if (typeof ev.tokens_in === 'number') tokensToday += ev.tokens_in;
		if (typeof ev.tokens_out === 'number') tokensToday += ev.tokens_out;
		if (typeof ev.cost_usd === 'number') costToday = (costToday ?? 0) + ev.cost_usd;
		accumulateSpendProvenance(prov, ev);
	}

	return { runningAgents, tokensToday, costToday, ...sealSpendProvenance(prov) };
}
