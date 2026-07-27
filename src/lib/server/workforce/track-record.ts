// TASK 16.3 — W-D7a: §2.5 roleTrackRecord — the computed service-level rollup
// SKELETON (rollup.ts discipline: bounded SELECTs, fold in JS, cost from PRICED
// rows only, every metric `number | null` + a source-row count; null → '—',
// never a dressed-up zero — F-008).
//
// v2.1 sources (and ONLY these — the v2-wave harness verdict JSON is NOT a
// source, D-001):
//   • interview_run                — recall / FP / cost per (version, model)
//   • panel_verdict                — verdict counts, approve/pushback split,
//                                    outcome closure, confidence×outcome (the
//                                    real A1 calibration from day 0)
//   • agent_event ⋈ session.role_version — field cost/tokens/duration/errors
//
// §2.5 B2 boundary: refutation rates, fix-loop caused, cost per certified
// feature, suppression counts need v2.2b's review_verdict table — they are
// declared LITERALLY null here (typed `null`, not number|null) and the UI renders
// '— (needs B2)'. No placeholder math, no projection.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { getRoleVersion, WorkforceInputError } from './repo';
import { isScoredStatus } from '$lib/shared/interview-status';

/** One (model_id) cell of the interview plane — all figures from real runs. */
export interface InterviewPlaneCell {
	model_id: string;
	/** UX tier label of the latest run at this model. */
	tier: string;
	/** Source-row count: ALL runs at this model (any status). */
	runs: number;
	passed: number;
	failed: number;
	error: number;
	adjudicating: number;
	running: number;
	/** planted_found / planted_total of the LATEST SCORED run — `isScoredStatus`, i.e.
	 * {passed, failed}. null when no scored run exists or its planted_total is 0 (never a
	 * fake 0%). An 'error' run is NOT scored: the runner writes `planted_found: 0` on the
	 * spawn_failure / scorer_error finalizes (workforce/gauntlet.ts), so counting it here
	 * published `recall 0%` as this model's latest measurement (F-008). */
	recall: number | null;
	/** false_positives of the latest SCORED run; null when none. `false_positives` is
	 * written by the PASS BAR only, so on any non-{passed,failed} run it is an
	 * uninitialised schema DEFAULT 0, never a measurement. */
	falsePositives: number | null;
	/** Σ cost_usd across PRICED runs only; null when none were priced (F-008). */
	costUsd: number | null;
	/** True when every PASSING run at this model is stale (§3.7 flag). */
	stale: boolean;
	lastRunAt: string | null;
}

export interface PanelPlane {
	/** Source-row count (verdicts naming this version as validator). */
	total: number;
	approve: number;
	pushback: number;
	outcomes: {
		upheld: number;
		overridden_by_operator: number;
		revised: number;
		withdrawn: number;
		/** Verdicts whose outcome has not been mechanically closed yet (§2.2). */
		open: number;
	};
	/** Real A1 calibration cells: counts per (confidence × closed outcome) from
	 * rows that carry BOTH. Empty when no verdict is both confident and closed. */
	calibration: Array<{ confidence: string; outcome: string; count: number }>;
}

export interface FieldPlane {
	/** Sessions linked to this version (session.role_version). */
	sessions: number;
	/** agent_event rows across those sessions (source-row count). */
	events: number;
	/** Σ cost_usd from PRICED rows only; null when none priced. */
	costUsd: number | null;
	/** Σ tokens; null when NO row carried the figure (never a fabricated 0). */
	tokensIn: number | null;
	tokensOut: number | null;
	/** Mean duration over rows that reported one; null when none did. */
	avgDurationMs: number | null;
	/** Count of type='error' events (a real count — 0 is honest here). */
	errors: number;
}

export interface RoleTrackRecord {
	roleVersion: string;
	/** Interview plane, one cell per model_id. [] = 'no interviews yet'. */
	interviews: InterviewPlaneCell[];
	panel: PanelPlane;
	field: FieldPlane;
	// ── pre-B2 (§2.5): literally null until v2.2b lands review_verdict —
	//    the surface renders '— (needs B2)'. Typed `null`, not number|null,
	//    so no code can "compute" them early.
	refutationRate: null;
	fixLoopRate: null;
	costPerCertifiedFeature: null;
	suppressionCount: null;
}

export interface RawRun {
	model_id: string;
	tier: string;
	status: string;
	stale: boolean;
	planted_total: number;
	planted_found: number;
	false_positives: number;
	cost_usd?: number | null;
	started_at: unknown;
	ended_at?: unknown;
}

interface RawVerdict {
	verdict: string;
	confidence?: string | null;
	outcome?: string | null;
}

interface RawFieldEvent {
	type?: string;
	tokens_in?: number | null;
	tokens_out?: number | null;
	cost_usd?: number | null;
	duration_ms?: number | null;
}

/**
 * Fold the runs at one role_version into per-model cells.
 *
 * TERMINALITY IS NOT DECLARED HERE. This module used to carry its own
 * `const TERMINAL = new Set(['passed','failed','error'])` — a SECOND definition of "has this run
 * produced a score", and one that disagreed with the canonical `$lib/shared/interview-status`:
 * it admitted `'error'`. An errored run produced NO score (the runner finalizes spawn_failure /
 * scorer_error with `planted_found: 0` — workforce/gauntlet.ts), so the `recall` / `falsePositives`
 * cells published `0%` and `0 FP` as this model's latest MEASUREMENT for every broken run — the
 * F-008 fabrication this whole rule exists to stop, and it was rendering live on `/agents`
 * ("recall (latest)").
 *
 * The duplicate set is precisely how the defect class survived five point fixes, so it is gone:
 * every terminality question in this file routes through `isScoredStatus`.
 *
 * Note what is NOT gated, deliberately: the `passed` / `failed` / `error` / `adjudicating` /
 * `running` COUNTS. Counting how many runs reached a status is a fact about the runs; it states
 * no score. Only `recall` and `falsePositives` claim a measurement, so only they are gated.
 *
 * Exported for `track-record.test.ts` — the terminality property is asserted directly on this
 * fold rather than through a live query, so a regression fails by name in milliseconds.
 */
export function foldInterviews(runs: RawRun[]): InterviewPlaneCell[] {
	const byModel = new Map<string, RawRun[]>();
	for (const r of runs) {
		const list = byModel.get(r.model_id) ?? [];
		list.push(r);
		byModel.set(r.model_id, list);
	}
	const cells: InterviewPlaneCell[] = [];
	for (const [model_id, list] of byModel) {
		// Newest first (started_at was projected + ordered by the query — F-022).
		const latest = list[0];
		// The newest run that TERMINALLY produced a score — the only run allowed to state
		// recall/FP for this cell. Newest-first order comes from the caller's ORDER BY.
		const latestScored = list.find((r) => isScoredStatus(r.status)) ?? null;
		let costUsd: number | null = null;
		for (const r of list) {
			if (typeof r.cost_usd === 'number') costUsd = (costUsd ?? 0) + r.cost_usd;
		}
		const passing = list.filter((r) => r.status === 'passed');
		cells.push({
			model_id,
			tier: latest.tier,
			runs: list.length,
			passed: passing.length,
			failed: list.filter((r) => r.status === 'failed').length,
			error: list.filter((r) => r.status === 'error').length,
			adjudicating: list.filter((r) => r.status === 'adjudicating').length,
			running: list.filter((r) => r.status === 'running').length,
			recall:
				latestScored && latestScored.planted_total > 0
					? latestScored.planted_found / latestScored.planted_total
					: null,
			falsePositives: latestScored ? latestScored.false_positives : null,
			costUsd,
			stale: passing.length > 0 && passing.every((r) => r.stale),
			lastRunAt: latest.started_at != null ? String(latest.started_at) : null
		});
	}
	return cells.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

function foldPanel(verdicts: RawVerdict[]): PanelPlane {
	const plane: PanelPlane = {
		total: verdicts.length,
		approve: 0,
		pushback: 0,
		outcomes: { upheld: 0, overridden_by_operator: 0, revised: 0, withdrawn: 0, open: 0 },
		calibration: []
	};
	const cal = new Map<string, { confidence: string; outcome: string; count: number }>();
	for (const v of verdicts) {
		if (v.verdict === 'approve') plane.approve++;
		else if (v.verdict === 'pushback') plane.pushback++;
		const o = v.outcome;
		if (o && o in plane.outcomes) {
			plane.outcomes[o as keyof Omit<PanelPlane['outcomes'], 'open'>]++;
		} else {
			plane.outcomes.open++;
		}
		if (v.confidence && o) {
			const key = `${v.confidence}|${o}`;
			const cell = cal.get(key) ?? { confidence: v.confidence, outcome: o, count: 0 };
			cell.count++;
			cal.set(key, cell);
		}
	}
	plane.calibration = [...cal.values()].sort(
		(a, b) => a.confidence.localeCompare(b.confidence) || a.outcome.localeCompare(b.outcome)
	);
	return plane;
}

function foldField(sessions: number, events: RawFieldEvent[]): FieldPlane {
	let costUsd: number | null = null;
	let tokensIn: number | null = null;
	let tokensOut: number | null = null;
	let durSum = 0;
	let durN = 0;
	let errors = 0;
	for (const ev of events) {
		if (typeof ev.cost_usd === 'number') costUsd = (costUsd ?? 0) + ev.cost_usd;
		if (typeof ev.tokens_in === 'number') tokensIn = (tokensIn ?? 0) + ev.tokens_in;
		if (typeof ev.tokens_out === 'number') tokensOut = (tokensOut ?? 0) + ev.tokens_out;
		if (typeof ev.duration_ms === 'number') {
			durSum += ev.duration_ms;
			durN++;
		}
		if (ev.type === 'error') errors++;
	}
	return {
		sessions,
		events: events.length,
		costUsd,
		tokensIn,
		tokensOut,
		avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
		errors
	};
}

/**
 * §2.5 — the null-honest track record for one role version. Throws
 * WorkforceInputError when the version does not exist (a card for a missing
 * version is a caller bug, not an empty state).
 */
export async function roleTrackRecord(db: Db, roleVersionId: string): Promise<RoleTrackRecord> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);
	const vid = new StringRecordId(assertRecordId(version.id));

	// Bounded SELECTs; F-022: ORDER BY fields appear in the projections.
	const [runs] = await db.query<[RawRun[]]>(
		`SELECT model_id, tier, status, stale, planted_total, planted_found,
		        false_positives, cost_usd, started_at
		   FROM interview_run WHERE role_version = $vid
		  ORDER BY started_at DESC LIMIT 1000;`,
		{ vid }
	);
	const [verdicts] = await db.query<[RawVerdict[]]>(
		`SELECT verdict, confidence, outcome FROM panel_verdict
		  WHERE role_version = $vid LIMIT 5000;`,
		{ vid }
	);
	const [sessionRows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM session WHERE role_version = $vid LIMIT 1000;`,
		{ vid }
	);
	const sessionIds = (sessionRows ?? []).map((s) => s.id);
	let events: RawFieldEvent[] = [];
	if (sessionIds.length > 0) {
		const [evRows] = await db.query<[RawFieldEvent[]]>(
			`SELECT type, tokens_in, tokens_out, cost_usd, duration_ms
			   FROM agent_event WHERE session IN $sids LIMIT 50000;`,
			{ sids: sessionIds }
		);
		events = evRows ?? [];
	}

	return {
		roleVersion: version.id,
		interviews: foldInterviews(runs ?? []),
		panel: foldPanel(verdicts ?? []),
		field: foldField(sessionIds.length, events),
		refutationRate: null,
		fixLoopRate: null,
		costPerCertifiedFeature: null,
		suppressionCount: null
	};
}
