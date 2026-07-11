// COST-GOVERNANCE-SPEC CG-4 — the recent-window per-source spend ESTIMATOR.
//
// A gated confirm that triggers real spend (the ceremony reference-run / bootstrap interview, the
// autonomous-loop arm) renders an HONEST estimate line so the operator sees the likely cost BEFORE
// authorising: the recent-window AVERAGE tokens (+ $ when the model was priced) a run of that source
// has cost, computed ONLY from measured `agent_event` completion history.
//
// F-008 HONESTY (the invariants this module holds):
//   • MEASURED-ONLY: every figure is an average over real completion rows; nothing is invented.
//   • LABELLED ESTIMATE: the display copy always says "estimated" and carries the sample size.
//   • NO HISTORY ⇒ '—': a source with zero in-window completions returns null → the UI shows an
//     em-dash with "no history yet" (never a fabricated 0-dressed-as-real).
//   • UNPRICED ⇒ TOKENS ONLY: when NO sampled row carried a cost (an unpriced model), avgUsd is null
//     and the line shows tokens without a $ — never a fabricated $0. A genuine local $0 row IS priced
//     (cost_usd 0 at the events.ts chokepoint) and contributes an honest $0.00.
//
// GROUNDING (opus scout, file:line — no guessing, D-039):
//   • cost_usd is computed at the events.ts completion-write chokepoint from config/pricing.yaml
//     (CG-1, events.ts:210 resolveCostUsd) — so averaging cost_usd over PRICED rows already IS
//     "tokens × CG-1 pricing"; this module does not re-price.
//   • CEREMONY spend converges on the gauntlet candidate session; the gauntlet writes ONE completion
//     agent_event per candidate session (gauntlet.ts:682) and `interview_run.session`
//     (schema m?, interview_run.session link) is the DEFINITIVE clean label — a completion whose
//     session an interview_run references is ceremony/gauntlet spend. That is precisely the spec's
//     "avg tokens per interview_run-ish session".
//   • LOOP (pm re-tick) spend is PROJECT-scoped: events.ts writes `project` on every launched
//     session's completion (launch.ts), so a project's autonomous-loop-driven sessions ARE the
//     project's completion rows. There is no cleaner PER-TICK label — every launchSession row is
//     kind='task' (launch.ts:543) and the PM-proposal agent id collides with the opus-tier drain slot
//     (boot.ts agentForTier) — so project scope is the honest, grounded unit the operator cares about
//     when arming: "expected spend per session the armed loop drives". Labelled as such.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** The recent window the estimator averages over (30 days) — long enough to hold a sparse
 *  ceremony / loop history, short enough to stay honestly "recent". */
export const ESTIMATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A measured per-run spend estimate for one source (null when there is no in-window history). */
export interface RunSpendEstimate {
	/** Mean (tokens_in + tokens_out) over the sampled completion rows — the honest token expectation. */
	avgTokens: number;
	/** Mean cost_usd over the PRICED sampled rows (CG-1 pricing already applied at write), or null
	 *  when NO sampled row carried a price (unpriced model ⇒ tokens only, no $ — F-008). */
	avgUsd: number | null;
	/** How many completion rows the token average is over (the honest sample size). */
	sampleSize: number;
	/** How many of those rows were priced (the $ average's sample size; 0 ⇒ avgUsd null). */
	pricedSampleSize: number;
}

/** The presentation POJO the server load hands the UI — a rendered line + honest sub-note. */
export interface RunEstimateDisplay {
	/** The headline estimate line: '~N tokens (~$X) per run', or '—' when there is no history. */
	label: string;
	/** A sub-note that is ALWAYS honest: 'estimated from N recent run(s)' / 'no history yet' /
	 *  'tokens only — model unpriced'. */
	note: string;
	/** True only when computed from measured history (the UI shows the value; else the em-dash). */
	hasHistory: boolean;
}

/** The raw aggregate shape one GROUP ALL query returns (any leg may be NONE → coalesced below). */
interface EstimateAggRow {
	n: number | null;
	tok: number | null;
	usd: number | null;
	priced: number | null;
}

/**
 * The SELECT projection shared by every source query. ONE GROUP ALL aggregate over completion rows:
 *   • n      — total sampled completions (the token average's denominator).
 *   • tok    — Σ(tokens_in ?? 0 + tokens_out ?? 0) — a NONE token leg coalesces to 0 so a partial
 *              completion never nulls the whole sum (mirrors spend-budget.ts tokensSpentSince).
 *   • usd    — Σ(cost_usd ?? 0) over the group (unpriced rows contribute 0; genuine local $0 too).
 *   • priced — COUNT of rows whose cost_usd is SET (the $ average's denominator; 0 ⇒ avgUsd null).
 * A `math::sum(IF …)` counts priced rows because SurrealDB has no conditional COUNT aggregate.
 */
const ESTIMATE_PROJECTION = `count() AS n,
	        math::sum((tokens_in ?? 0) + (tokens_out ?? 0)) AS tok,
	        math::sum(cost_usd ?? 0) AS usd,
	        math::sum(IF cost_usd != NONE { 1 } ELSE { 0 }) AS priced`;

/** Fold one aggregate row into an estimate. Zero sampled rows ⇒ null (honest '—', no fabricated 0). */
function toEstimate(row: EstimateAggRow | undefined): RunSpendEstimate | null {
	const n = typeof row?.n === 'number' ? row.n : 0;
	if (n <= 0) return null; // no measured history — the caller renders '—'
	const tok = typeof row?.tok === 'number' ? row.tok : 0;
	const priced = typeof row?.priced === 'number' ? row.priced : 0;
	const usd = typeof row?.usd === 'number' ? row.usd : 0;
	return {
		avgTokens: Math.round(tok / n),
		// $ only when at least one sampled row was priced — else null (tokens-only, never fake $0).
		avgUsd: priced > 0 ? usd / priced : null,
		sampleSize: n,
		pricedSampleSize: priced
	};
}

/**
 * CEREMONY (reference-run / bootstrap interview) recent per-run spend. Averages completion rows whose
 * `session` is referenced by an `interview_run` — the gauntlet candidate session, the definitive clean
 * ceremony label. Window-bounded on the durable `at` timestamp (restart-proof). Returns null when the
 * window holds no ceremony completions (F-008 honest '—').
 */
export async function estimateCeremonyRun(
	db: Db,
	windowMs: number = ESTIMATE_WINDOW_MS
): Promise<RunSpendEstimate | null> {
	const since = new Date(Date.now() - windowMs).toISOString();
	const [rows] = await db.query<[EstimateAggRow[]]>(
		`SELECT ${ESTIMATE_PROJECTION}
		   FROM agent_event
		  WHERE type = 'completion'
		    AND at >= <datetime>$since
		    AND session != NONE
		    AND session IN (SELECT VALUE session FROM interview_run WHERE session != NONE)
		  GROUP ALL;`,
		{ since }
	);
	return toEstimate(Array.isArray(rows) ? rows[0] : undefined);
}

/**
 * LOOP (autonomous PM re-tick) recent per-session spend for ONE project. Averages the project's
 * completion rows in the window (events.ts denormalises `project` onto every launched session's
 * completion, so this needs no session→project join). The project id passes the D-016 chokepoint
 * (assertRecordId) and binds as a record link (`$project`), never string-interpolated. Returns null
 * when the project has no in-window completions (F-008 honest '—').
 */
export async function estimateLoopRun(
	db: Db,
	projectId: string,
	windowMs: number = ESTIMATE_WINDOW_MS
): Promise<RunSpendEstimate | null> {
	const since = new Date(Date.now() - windowMs).toISOString();
	const [rows] = await db.query<[EstimateAggRow[]]>(
		`SELECT ${ESTIMATE_PROJECTION}
		   FROM agent_event
		  WHERE type = 'completion'
		    AND at >= <datetime>$since
		    AND project = $project
		  GROUP ALL;`,
		{ since, project: new StringRecordId(assertRecordId(projectId)) }
	);
	return toEstimate(Array.isArray(rows) ? rows[0] : undefined);
}

/** Compact thousands-grouped token count (no locale surprises — always grouped by comma). */
function formatTokens(n: number): string {
	return n.toLocaleString('en-US');
}

/** Honest USD formatting: 2 dp normally, 4 dp for sub-$0.10 figures so a real cost never rounds to
 *  $0.00, and a genuine $0 (local) reads '$0.00'. */
function formatUsd(v: number): string {
	if (v === 0) return '$0.00';
	return v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/**
 * Fold an estimate into the display POJO the UI renders (server-side so no server-only module reaches
 * the client — the spec's "server load supplies the estimate; UI renders it"). `unit` names the run
 * ('run' for ceremony, 'driven session' for the loop) so the copy is honest per surface.
 * Shadow paths: null estimate ⇒ '—' + 'no history yet'; priced ⇒ tokens (+$); unpriced ⇒ tokens +
 * 'tokens only — model unpriced'.
 */
export function toEstimateDisplay(
	est: RunSpendEstimate | null,
	unit: 'run' | 'driven session' = 'run'
): RunEstimateDisplay {
	if (!est) {
		return { label: '—', note: 'no history yet', hasHistory: false };
	}
	const money = est.avgUsd !== null ? ` (~${formatUsd(est.avgUsd)})` : '';
	const label = `~${formatTokens(est.avgTokens)} tokens${money} per ${unit}`;
	const runs = `${est.sampleSize} recent ${est.sampleSize === 1 ? 'run' : 'runs'}`;
	const note = est.avgUsd !== null ? `estimated from ${runs}` : `estimated from ${runs} · tokens only — model unpriced`;
	return { label, note, hasHistory: true };
}
