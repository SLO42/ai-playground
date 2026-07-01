// MAINTENANCE ACTIONS — the two registered self-maintenance loop bodies (LOOP-ENGINEERING;
// operator directive 2026-06-29/30). Dispatched by the MaintenanceLoopEngine (maintenance.ts).
//
// ISOLATION (the load-bearing decision): the §11 eval harness (memory/eval/harness.ts) is a
// measurement instrument, but it is NOT write-free — runEval/runRerankProbe SEED the fixture
// corpus (real store path) and fabricate labeled `retrieval_outcome` rows for the probe. Running
// it against the LIVE DB would pollute live memory AND poison the reranker's live training labels
// (F-008/D-030 — "no training data is invented"). So each eval runs in a THROWAWAY spawned
// SurrealDB (db/testserver — the harness's designed habitat: SHA-verified pinned binary F-006,
// OS-assigned loopback port, namespace dropped + process KILLED on teardown F-014), bounded by a
// hard wall-clock deadline, and only the RESULT (an eval_report row / a reranker_model row / a
// proposal notification) is written to the live DB.
//
// PROPOSE-ONLY (operator sovereignty, D-004): nothing here flips a default. RERANK_DEFAULT_ENABLED
// stays false; recall() ignores a persisted model until the operator enables reranking. The
// reranker action's "reranked ≥ baseline" verdict only writes a `notification` proposal (the same
// operator surface the gauntlet sentinel uses) — the flip is the operator's.
//
// HONESTY (F-008): below the training thresholds the reranker action is an explicit no-op with the
// real counts in its summary ("labels still accruing: N/20"); every summary carries measured
// numbers, never asserted ones; the eval-corpus bound (fixture labels, in-sample LexicalEmbedder)
// is stated in the persisted report's own notes and echoed in the proposal.

import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb } from '../db/testserver';
import {
	MemoryService,
	loadTrainingExamples,
	trainAndPersist,
	RERANK_MIN_EXAMPLES,
	RERANK_MIN_PER_CLASS
} from '../memory/index';
import { LexicalEmbedder } from '../memory/eval/embedder';
import {
	runEval,
	seedCorpus,
	runRerankProbe,
	type EvalReport,
	type RerankProbe
} from '../memory/eval/harness';
import { recordNotification } from '../services/incidents';
import {
	MAINT_EVAL_REGRESSION,
	MAINT_RERANKER_EVAL,
	type MaintenanceAction,
	type MaintenanceRegistry
} from './maintenance';

/** Hard wall-clock bound on one throwaway eval run (F-014 — bounded, never spin). */
export const EVAL_DEADLINE_MS = 180_000;

/** Race a promise against a hard deadline (unref'd — never keeps the process alive). */
async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded the ${ms}ms deadline`)), ms);
		if (typeof timer.unref === 'function') timer.unref();
	});
	try {
		return await Promise.race([p, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Run `fn` against a fresh, fully-migrated THROWAWAY SurrealDB with a LexicalEmbedder-backed
 * MemoryService (deterministic, credential-free — no Ollama), deadline-bounded, and ALWAYS torn
 * down (namespace dropped, spawned server process killed, data dir removed — F-014) even on
 * fault/timeout. Live memory is untouched by construction: the harness's seeds land here and die here.
 */
export async function withThrowawayEvalDb<T>(
	fn: (mem: MemoryService) => Promise<T>,
	opts: { timeoutMs?: number } = {}
): Promise<T> {
	const tdb = await startTestDb();
	let db: Db | null = null;
	try {
		db = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await runMigrations(db, schemaMigrations);
		const mem = new MemoryService({ db, embedder: new LexicalEmbedder() });
		return await withDeadline(fn(mem), opts.timeoutMs ?? EVAL_DEADLINE_MS, 'maintenance eval');
	} finally {
		await db?.close().catch(() => {});
		await tdb.teardown().catch(() => {});
	}
}

// ── maint:eval-regression — the §11 recall-quality regression measurement ─────────────────────────

export interface EvalRegressionDeps {
	/** Seam for tests: produce the EvalReport (default = the real throwaway runEval). */
	runReport?: () => Promise<EvalReport>;
}

/**
 * Run the full MEMORY-SPEC §11 eval (runEval) in the throwaway DB and persist the resulting
 * EvalReport to the live `eval_report` table (m0080) — the durable regression trail. MEASUREMENT
 * ONLY (D-030): the report mutates no default and prunes nothing; the summary carries the real
 * headline metrics so the run log reads honestly at a glance.
 */
export function evalRegressionAction(deps: EvalRegressionDeps = {}): MaintenanceAction {
	return async ({ db }) => {
		const run = deps.runReport ?? (() => withThrowawayEvalDb((mem) => runEval(mem)));
		const report = await run();
		// Plain-JSON the report defensively (FLEXIBLE object column; the report is already POJO-shaped).
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE eval_report CONTENT { loop: $loop, embedder: $embedder, report: $report } RETURN AFTER;`,
			{
				loop: MAINT_EVAL_REGRESSION,
				embedder: report.corpus.embedder,
				report: JSON.parse(JSON.stringify(report)) as Record<string, unknown>
			}
		);
		const baseline = report.weightSweep[0]?.macro;
		const summary =
			`§11 eval recorded — baseline nDCG@5 ${baseline?.ndcgAt5 ?? '—'}, P@5 ${baseline?.precisionAt5 ?? '—'}, ` +
			`MRR ${baseline?.mrr ?? '—'}; rerank probe noRegression=${report.rerankProbe.noRegression} ` +
			`(eval corpus, ${report.corpus.embedder} — not a live production metric)`;
		return {
			ok: true,
			summary,
			detail: { reportId: String(rows[0]?.id ?? '') }
		};
	};
}

// ── maint:reranker-eval — threshold-gated train + baseline-vs-reranked eval + proposal ────────────

export interface RerankerEvalDeps {
	/** Seam for tests: produce the RerankProbe (default = the real throwaway seed+probe). */
	runProbe?: () => Promise<RerankProbe>;
}

/**
 * On cadence: count the LIVE feature-bearing labeled `retrieval_outcome` rows (the reranker's real
 * training input). Below the trainer's own thresholds → an HONEST NO-OP ("labels still accruing").
 * At thresholds → run the baseline-vs-reranked eval probe (throwaway DB), train from the LIVE
 * labels via the production `trainAndPersist` path (persisting the active model + the measured
 * eval delta — behavior-neutral while RERANK_DEFAULT_ENABLED is false), and, iff the reranked
 * order did NOT regress the baseline, write a PROPOSAL notification. PROPOSE-ONLY: the default is
 * never flipped here — enabling the reranker stays the operator's decision (D-004).
 */
export function rerankerEvalAction(deps: RerankerEvalDeps = {}): MaintenanceAction {
	return async ({ db }) => {
		const examples = await loadTrainingExamples(db);
		let pos = 0;
		for (const e of examples) if (e.label >= 0.5) pos++;
		const neg = examples.length - pos;

		if (examples.length < RERANK_MIN_EXAMPLES || pos < RERANK_MIN_PER_CLASS || neg < RERANK_MIN_PER_CLASS) {
			return {
				ok: true,
				summary:
					`no-op — labels still accruing: ${examples.length}/${RERANK_MIN_EXAMPLES} feature-bearing ` +
					`(pos ${pos}, neg ${neg}; need ≥${RERANK_MIN_PER_CLASS} each)`,
				detail: { nExamples: examples.length, pos, neg, trained: false }
			};
		}

		// Baseline-vs-reranked on the controlled eval corpus (throwaway DB — the probe seeds rows).
		const probe = await (
			deps.runProbe ??
			(() =>
				withThrowawayEvalDb(async (mem) => {
					const seeded = await seedCorpus(mem);
					return runRerankProbe(mem, seeded);
				}))
		)();

		// Train from the LIVE labels (the designed offline entry point) + record the measured delta.
		const trained = await trainAndPersist(db, { evalDelta: probe.delta.ndcgAt5 });
		if (!trained.persisted) {
			// Shouldn't happen past the threshold check, but the trainer is the authority — stay honest.
			return {
				ok: true,
				summary: `training declined (${trained.reason ?? 'cold start'}) — nothing persisted`,
				detail: { nExamples: trained.nExamples, trained: false }
			};
		}

		const deltaLine = `nDCG@5 ${fmtDelta(probe.delta.ndcgAt5)}, MRR ${fmtDelta(probe.delta.mrr)}, P@5 ${fmtDelta(probe.delta.precisionAt5)}`;
		if (probe.noRegression) {
			await recordNotification(
				db,
				`Reranker eval: trained on ${trained.nExamples} live labeled outcomes; eval-corpus reranked ≥ baseline (${deltaLine}). ` +
					`PROPOSAL — consider enabling the learned reranker (RERANK_DEFAULT_ENABLED, memory/rerank.ts). ` +
					`Enabling is an operator decision; nothing was flipped (eval-corpus evidence, not a live production gain).`
			);
			return {
				ok: true,
				summary:
					`trained on ${trained.nExamples} live labels; reranked ≥ baseline on the eval corpus (${deltaLine}) — ` +
					`proposal notification written (propose-only; default untouched)`,
				detail: { nExamples: trained.nExamples, trained: true, proposed: true, delta: probe.delta }
			};
		}
		return {
			ok: true,
			summary:
				`trained on ${trained.nExamples} live labels; reranked REGRESSED the baseline on the eval corpus (${deltaLine}) — ` +
				`no proposal (model persisted with its measured delta; default untouched)`,
			detail: { nExamples: trained.nExamples, trained: true, proposed: false, delta: probe.delta }
		};
	};
}

function fmtDelta(n: number): string {
	return `${n >= 0 ? '+' : ''}${n}`;
}

/** The shipped static registry — identifier → action (in-code only; hooks.server.ts wires it). */
export function defaultMaintenanceRegistry(): MaintenanceRegistry {
	return new Map<string, MaintenanceAction>([
		[MAINT_EVAL_REGRESSION, evalRegressionAction()],
		[MAINT_RERANKER_EVAL, rerankerEvalAction()]
	]);
}
