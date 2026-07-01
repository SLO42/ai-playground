// MODEL-BENCHMARK-SPEC step 3 (class B — Judged) — the benchmark judge public surface.
//
// runJudgeBatch is the ON-DEMAND, cost-BOUNDED entry the operator triggers (a /reports form
// action / a script) — NEVER the heartbeat. It judges at most `limit` recent sessions (hard
// cap DEFAULT_JUDGE_LIMIT_MAX), one cloud LLM call each, and stores the structured verdicts.
// The judge model is INJECTED (a cloud ClaudeProvider in prod, a deterministic stub in tests).

import type { Db } from '../../db/client';
import { listJudgeCandidates, gatherSessionCorpus, type CandidateOptions } from './gather';
import { scoreSession, type JudgeModel } from './judge';
import { saveSessionVerdict, type JudgeIdentity } from './store';

export {
	BENCHMARK_DIMENSIONS,
	deriveObjectiveSignals,
	scoreSession,
	parseJudgeJson,
	resolveJudgeModel,
	makeClaudeJudge,
	type BenchmarkDimension,
	type VerdictStatus,
	type ObjectiveSignals,
	type SessionCorpus,
	type DimensionVerdict,
	type SessionVerdict,
	type JudgeModel,
	type JudgeModelChoice,
	type ClaudeJudgeOptions
} from './judge';

export {
	listJudgeCandidates,
	gatherSessionCorpus,
	type JudgeCandidate,
	type CandidateOptions
} from './gather';

export {
	saveSessionVerdict,
	buildJudgedComparison,
	foldJudged,
	isoOrNull,
	type JudgeIdentity,
	type DimensionRollup,
	type ProviderVerdicts,
	type JudgedComparisonOptions,
	type RawVerdictRow
} from './store';

/** Default batch size when the operator doesn't specify one. */
export const DEFAULT_JUDGE_LIMIT = 5;
/** Hard upper bound on a single judge batch (cost guard — the on-demand trigger stays bounded). */
export const DEFAULT_JUDGE_LIMIT_MAX = 20;

/** Clamp a requested batch size into [1, DEFAULT_JUDGE_LIMIT_MAX]. */
export function boundJudgeLimit(requested: number | undefined): number {
	if (typeof requested !== 'number' || Number.isNaN(requested)) return DEFAULT_JUDGE_LIMIT;
	return Math.max(1, Math.min(Math.floor(requested), DEFAULT_JUDGE_LIMIT_MAX));
}

export interface RunJudgeBatchOptions extends CandidateOptions {
	/** The injected judge model (cloud in prod, stub in tests). */
	model: JudgeModel;
	/** The judge model's identity, recorded on every verdict for provenance. */
	judge: JudgeIdentity;
}

export interface JudgeBatchResult {
	/** Sessions judged (had a corpus + were scored/stored). */
	judged: number;
	/** Candidates skipped (no readable corpus). */
	skipped: number;
	/** The bounded batch size actually used. */
	limit: number;
	/** Total insufficient-data verdicts written across the batch (honest cold-corpus count). */
	insufficientVerdicts: number;
}

/**
 * Judge a bounded batch of recent sessions on-demand. Gathers each session's screened corpus,
 * scores it with the injected cloud judge, and stores the verdicts. Bounded by `limit` (hard
 * cap) so the trigger can never judge an unbounded set. A session with no readable corpus is
 * skipped honestly (not a fabricated verdict).
 */
export async function runJudgeBatch(
	db: Db,
	opts: RunJudgeBatchOptions
): Promise<JudgeBatchResult> {
	const limit = boundJudgeLimit(opts.limit);
	const candidates = await listJudgeCandidates(db, {
		limit,
		...(opts.windowDays != null ? { windowDays: opts.windowDays } : {}),
		...(opts.provider ? { provider: opts.provider } : {})
	});

	let judged = 0;
	let skipped = 0;
	let insufficientVerdicts = 0;
	for (const c of candidates) {
		const corpus = await gatherSessionCorpus(db, c.sessionId);
		if (!corpus) {
			skipped++;
			continue;
		}
		const verdict = await scoreSession(corpus, opts.model);
		insufficientVerdicts += verdict.dimensions.filter(
			(d) => d.status === 'insufficient_data'
		).length;
		await saveSessionVerdict(db, verdict, opts.judge);
		judged++;
	}

	return { judged, skipped, limit, insufficientVerdicts };
}
