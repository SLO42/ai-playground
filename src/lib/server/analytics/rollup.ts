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

/** One day's agent-activity rollup (all figures from real rows; F-008). */
export interface DailyRollup {
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
	/** Σ cost_usd across rows that carried a PRICED cost; null when none were priced. */
	costUsd: number | null;
	/** Mean duration_ms across completion rows that reported one; null when none did. */
	avgDurationMs: number | null;
	/** error / (completions + errors) — the day's failure rate in [0,1]; null when no terminal rows. */
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
	/** Window totals (sum across days). */
	totals: {
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
		errorRate: null
	};
}

/**
 * Fold a flat list of agent_event rows into per-day rollups (pure — unit-testable with
 * no DB). Exposed separately so the anomaly pass and the loader can both reuse it and so
 * the math is verifiable in isolation.
 */
export function foldDaily(events: RawEvent[]): DailyRollup[] {
	const byDay = new Map<string, DailyRollup>();
	// duration accumulators kept aside (DailyRollup only exposes the mean).
	const durAccum = new Map<string, { sum: number; n: number }>();

	for (const ev of events) {
		const key = dayKey(ev.at);
		let r = byDay.get(key);
		if (!r) {
			r = emptyRollup(key);
			byDay.set(key, r);
		}
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
		if (typeof ev.duration_ms === 'number') {
			const a = durAccum.get(key) ?? { sum: 0, n: 0 };
			a.sum += ev.duration_ms;
			a.n++;
			durAccum.set(key, a);
		}
	}

	for (const [key, r] of byDay) {
		const a = durAccum.get(key);
		r.avgDurationMs = a && a.n > 0 ? Math.round(a.sum / a.n) : null;
		const terminal = r.completions + r.errors;
		r.errorRate = terminal > 0 ? r.errors / terminal : null;
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
	return t;
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

	const [rows] = await db.query<[RawEvent[]]>(
		`SELECT type, at, tokens_in, tokens_out, cost_usd, duration_ms
		   FROM agent_event WHERE ${where} ORDER BY at ASC LIMIT $lim;`,
		params
	);

	const days = foldDaily(rows ?? []);
	return { days, anomalies: detectAnomalies(days), totals: sumTotals(days) };
}

// ── Per-tier usage (for /agents — tier-centric LENS, UI-SPEC §198) ────────────────

/** Usage rolled up per tier from real agent_event rows (F-008). */
export interface TierUsage {
	tier: string;
	provider: string;
	runs: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number | null;
	avgDurationMs: number | null;
}

interface RawTierRow {
	tier?: string | null;
	provider?: string | null;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	duration_ms?: number | null;
	type?: string;
}

/**
 * Roll completion+spawn events up per (tier, provider) for the /agents usage LENS.
 * Aggregated from real rows only (F-008). A run with no tier on its model lands under
 * the 'unknown' bucket rather than being dropped — honest, not silently lossy.
 */
export async function buildTierUsage(db: Db, opts: RollupOptions = {}): Promise<TierUsage[]> {
	const windowDays = opts.windowDays ?? 30;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
	const [rows] = await db.query<[RawTierRow[]]>(
		`SELECT model.tier AS tier, model.provider AS provider,
		        tokens_in, tokens_out, cost_usd, duration_ms, type
		   FROM agent_event WHERE at >= $since AND type IN ["spawn","completion"] LIMIT 50000;`,
		{ since }
	);

	const byKey = new Map<string, TierUsage & { _durSum: number; _durN: number }>();
	for (const r of rows ?? []) {
		const tier = (r.tier as string) || 'unknown';
		const provider = (r.provider as string) || 'unknown';
		const key = `${provider}:${tier}`;
		let u = byKey.get(key);
		if (!u) {
			u = {
				tier,
				provider,
				runs: 0,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: null,
				avgDurationMs: null,
				_durSum: 0,
				_durN: 0
			};
			byKey.set(key, u);
		}
		// Count one run per spawn (the lifecycle start); completions carry the totals.
		if (r.type === 'spawn') u.runs++;
		if (typeof r.tokens_in === 'number') u.tokensIn += r.tokens_in;
		if (typeof r.tokens_out === 'number') u.tokensOut += r.tokens_out;
		if (typeof r.cost_usd === 'number') u.costUsd = (u.costUsd ?? 0) + r.cost_usd;
		if (typeof r.duration_ms === 'number') {
			u._durSum += r.duration_ms;
			u._durN++;
		}
	}

	return [...byKey.values()]
		.map(({ _durSum, _durN, ...u }) => ({
			...u,
			avgDurationMs: _durN > 0 ? Math.round(_durSum / _durN) : null
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
export interface ShellMetrics {
	/** Sessions with status='running' right now (live agent count). */
	runningAgents: number;
	/** Σ (tokens_in + tokens_out) across today's agent_event rows. */
	tokensToday: number;
	/** Σ cost_usd across today's PRICED rows; null when none were priced (never a fake $0). */
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
		 SELECT type, at, tokens_in, tokens_out, cost_usd FROM agent_event
		   WHERE at >= $since LIMIT 50000;`,
		{ since: startOfDay }
	);

	const runningAgents = running?.[0]?.c ?? 0;

	let tokensToday = 0;
	let costToday: number | null = null;
	for (const ev of todays ?? []) {
		if (typeof ev.tokens_in === 'number') tokensToday += ev.tokens_in;
		if (typeof ev.tokens_out === 'number') tokensToday += ev.tokens_out;
		if (typeof ev.cost_usd === 'number') costToday = (costToday ?? 0) + ev.cost_usd;
	}

	return { runningAgents, tokensToday, costToday };
}
