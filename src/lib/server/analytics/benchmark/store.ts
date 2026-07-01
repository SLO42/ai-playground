// MODEL-BENCHMARK-SPEC step 3 (class B — Judged) — verdict persistence + the comparison loader.
//
// saveSessionVerdict writes the per-dimension verdicts for one session. Re-judging is
// DELETE-then-CREATE per session (idempotent replace; no mutable dedup_key → sidesteps the
// F-048 status-transition collision class). rationale is screened once more here before it
// lands (D-026 — defence in depth; the judge output is model-authored text).
//
// buildJudgedComparison reads the verdict rows back grouped by the SESSION-UNDER-TEST provider
// (the local-vs-cloud axis), averaging SCORED verdicts per dimension and counting the honest
// insufficient ones separately (F-008 — an insufficient verdict is never folded into the mean).
// judged_at is coerced to an ISO string in the row normalizer (F-013 — never return a raw SDK
// datetime to a `load`). Honest empty [] when no session has been judged.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../../db/client';
import { assertRecordId } from '../../db/validate';
import { screen } from '../../memory/screen';
import {
	BENCHMARK_DIMENSIONS,
	type BenchmarkDimension,
	type SessionVerdict,
	type VerdictStatus
} from './judge';

/** Who ran the judge (a cloud model — recorded for provenance, distinct from the session model). */
export interface JudgeIdentity {
	provider: string;
	modelId: string;
}

/**
 * Persist one session's verdicts: delete any prior verdicts for the session, then write one
 * row per dimension. Idempotent replace (re-judge overwrites). Fail-safe on the delete of a
 * never-judged session (no rows → no-op).
 */
export async function saveSessionVerdict(
	db: Db,
	verdict: SessionVerdict,
	judge: JudgeIdentity
): Promise<void> {
	const sid = new StringRecordId(assertRecordId(verdict.sessionId));
	await db.query('DELETE benchmark_verdict WHERE session = $sid;', { sid });
	for (const d of verdict.dimensions) {
		const content: Record<string, unknown> = {
			session: sid,
			provider: verdict.provider,
			model_id: verdict.modelId,
			dimension: d.dimension,
			status: d.status,
			score: d.status === 'scored' ? d.score : null,
			rationale: screen(d.rationale ?? '').text,
			judge_provider: judge.provider,
			judge_model: judge.modelId,
			...(d.evidence ? { evidence: d.evidence } : {})
		};
		await db.query('CREATE benchmark_verdict CONTENT $content;', { content });
	}
}

/** Average score for one dimension across a provider's SCORED verdicts (null when none scored). */
export interface DimensionRollup {
	dimension: BenchmarkDimension;
	/** Mean of SCORED verdicts, 0..1; null when no session was scorable on this dimension. */
	avgScore: number | null;
	/** How many judged sessions produced a real score here. */
	scored: number;
	/** How many were honestly insufficient (F-008 — NOT folded into avgScore). */
	insufficient: number;
}

/** One provider's judged-quality rollup (the local-vs-cloud comparison row). */
export interface ProviderVerdicts {
	provider: string;
	/** Distinct sessions judged for this provider in the window. */
	sessionsJudged: number;
	dimensions: DimensionRollup[];
	/** Most recent judged_at (ISO) across this provider's verdicts; null when none. */
	lastJudgedAt: string | null;
}

export interface JudgedComparisonOptions {
	/** Trailing window in days over judged_at (default 30). */
	windowDays?: number;
	/** Hard cap on verdict rows scanned. */
	maxRows?: number;
}

/** A verdict row as read back (pre-normalization). */
export interface RawVerdictRow {
	session?: unknown;
	provider?: string | null;
	dimension?: string | null;
	status?: string | null;
	score?: number | null;
	judged_at?: unknown;
}

/** Coerce an SDK datetime (JS Date or Surreal DateTime) to an ISO string; null when absent (F-013). */
export function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	if (typeof (v as { toISOString?: unknown }).toISOString === 'function') {
		try {
			return (v as { toISOString: () => string }).toISOString();
		} catch {
			return null;
		}
	}
	if (typeof v === 'string') return v;
	return null;
}

/**
 * Fold raw verdict rows into per-provider rollups. Pure — the DB read passes its rows here.
 * SCORED verdicts feed the mean; insufficient ones are counted but never averaged (F-008).
 */
export function foldJudged(rows: RawVerdictRow[]): ProviderVerdicts[] {
	interface Acc {
		provider: string;
		sessions: Set<string>;
		last: string | null;
		dims: Map<string, { sum: number; scored: number; insufficient: number }>;
	}
	const byProvider = new Map<string, Acc>();

	for (const r of rows ?? []) {
		const provider = (r.provider as string) || 'unknown';
		const dimension = (r.dimension as string) || '';
		if (!BENCHMARK_DIMENSIONS.includes(dimension as BenchmarkDimension)) continue;
		let acc = byProvider.get(provider);
		if (!acc) {
			acc = { provider, sessions: new Set<string>(), last: null, dims: new Map() };
			byProvider.set(provider, acc);
		}
		if (r.session != null) acc.sessions.add(String(r.session));
		const iso = isoOrNull(r.judged_at);
		if (iso && (!acc.last || iso > acc.last)) acc.last = iso;
		let dim = acc.dims.get(dimension);
		if (!dim) {
			dim = { sum: 0, scored: 0, insufficient: 0 };
			acc.dims.set(dimension, dim);
		}
		const status = (r.status as VerdictStatus) || 'scored';
		if (status === 'scored' && typeof r.score === 'number') {
			dim.sum += r.score;
			dim.scored++;
		} else {
			dim.insufficient++;
		}
	}

	return [...byProvider.values()]
		.map((acc) => ({
			provider: acc.provider,
			sessionsJudged: acc.sessions.size,
			lastJudgedAt: acc.last,
			dimensions: BENCHMARK_DIMENSIONS.map((d): DimensionRollup => {
				const dim = acc.dims.get(d);
				const scored = dim?.scored ?? 0;
				return {
					dimension: d,
					avgScore: scored > 0 ? round2((dim as { sum: number }).sum / scored) : null,
					scored,
					insufficient: dim?.insufficient ?? 0
				};
			})
		}))
		.sort((a, b) => b.sessionsJudged - a.sessionsJudged || a.provider.localeCompare(b.provider));
}

/**
 * The /reports judged-quality comparison: verdicts grouped by session-under-test provider.
 * Honest empty [] when no session has been judged in the window.
 */
export async function buildJudgedComparison(
	db: Db,
	opts: JudgedComparisonOptions = {}
): Promise<ProviderVerdicts[]> {
	const windowDays = opts.windowDays ?? 30;
	const maxRows = opts.maxRows ?? 20_000;
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
	const [rows] = await db.query<[RawVerdictRow[]]>(
		`SELECT session, provider, dimension, status, score, judged_at
		   FROM benchmark_verdict WHERE judged_at >= $since ORDER BY judged_at ASC LIMIT $lim;`,
		{ since, lim: maxRows }
	);
	return foldJudged(rows ?? []);
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
