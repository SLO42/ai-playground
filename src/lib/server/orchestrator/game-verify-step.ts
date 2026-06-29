// GAME-VERIFY orchestrator step (spec: docs/GAME-VERIFY-SPEC.md §"Orchestrator integration").
//
// The seam that runs the {@link runGameVerify} runner AFTER the build/test gate (the post-task
// loop) for projects that DECLARE a `game_verify` harness, then PERSISTS the verdict and FEEDS a
// non-pass back into the build loop as the next iteration's fix signal — the human-in-the-loop,
// automated. This is INFRASTRUCTURE (a runner + a gate + persistence + feedback), not a mod and
// not game-specific code; ROUNDS is only the reference config.
//
// NON-NEGOTIABLE RAILS:
//   • GATE (opt-in, F-008): a project with no parseable `game_verify` block ⇒ the runner is NEVER
//     invoked (ran:false). The agent never invents a launch_command/process/paths.
//   • SERIALIZE (spec): at most ONE game-verify at a time PER GAME — guarded by a per-game async
//     lock keyed by the (normalized) process_name. The lock mirrors merge-back's withMergeLock:
//     a waiter runs after the prior chain SETTLES (never inheriting its result), and the entry is
//     deleted once its chain drains so the map can't grow unbounded (F-014 leak class).
//   • NON-PASS IS NOT A HARD FAIL (F-008): an errors/timeout/crashed/not_ready verdict does NOT
//     flip the task to failed — it is persisted (an `agent_event`) AND fed back as a `follow_up`
//     work_item carrying the SCREENED stack traces / log tail (the fix signal for the next pass).
//   • NEVER CRASH THE DRAIN (F-014/F-048): the runner itself never throws; the persistence/feedback
//     writes are wrapped so a DB fault here is caught + recorded as an honest `error` event and the
//     step returns — a game-verify fault can never propagate to kill the orchestrator drain.
//   • D-026: the verdict's logTail / stackTraces are ALREADY screened by the runner; the diagnostic
//     `note` is screened here before it enters a persisted detail (defence in depth).

import type { Db } from '../db/client';
import { parseGameVerifyConfig } from '../projects/repo';
import {
	runGameVerify,
	type GameVerifyConfig,
	type GameVerifyContext,
	type GameVerifyDeps,
	type GameVerifyVerdict
} from './game-verify';
import { writeAgentEvent } from '../analytics/events';
import { enqueue } from './workqueue';
import { screenForDisplay } from '../memory/observability';

/**
 * The injectable game-verify runner (the test seam — tests pass a fake so NO real game launches,
 * F-010/F-014). Defaults to {@link runGameVerify}. Signature-compatible with it.
 */
export type GameVerifyRunner = (
	cfg: GameVerifyConfig,
	ctx: GameVerifyContext,
	opts?: GameVerifyDeps
) => Promise<GameVerifyVerdict>;

export interface GameVerifyStepInput {
	/** Project record id — links the persisted verdict event + the feedback work_item. */
	projectId: string;
	/** The mod task just built — parent of the feedback follow-up. */
	taskId: string;
	/** The session that did the work — the verdict event links to it. */
	sessionId: string;
	/** The working dir the build ran in (worktree.path ?? project.root_path) — deploy globs resolve here. */
	cwd: string;
	/** The RAW `project.game_verify` value (validated by parseGameVerifyConfig — absent/invalid ⇒ gated off). */
	rawConfig: unknown;
	/** Already-built artifact paths (preferred deploy sources); absent ⇒ the runner does a bounded cwd walk. */
	builtArtifacts?: string[];
}

export interface GameVerifyStepDeps {
	/** Injected runner (test seam). Defaults to {@link runGameVerify}. */
	runner?: GameVerifyRunner;
	/** Injected runner OS-seams, forwarded to the runner (tests drive deploy/launch/poll/kill deterministically). */
	runnerDeps?: GameVerifyDeps;
}

export interface GameVerifyStepResult {
	/** false ⇒ gated off (no parseable game_verify config) — the runner was NOT invoked. */
	ran: boolean;
	/** The runner's verdict (present iff ran). */
	verdict?: GameVerifyVerdict;
	/** The feedback `follow_up` work_item id, when a non-pass verdict enqueued one. */
	feedbackWorkId?: string;
	/** The persisted verdict `agent_event` id (present on a clean persist). */
	agentEventId?: string;
}

// ── Per-game serialization lock (mirrors sessions/merge-back.ts withMergeLock) ─────────────
//
// One in-flight game-verify chain PER game (keyed by the normalized process_name). A second
// verify for the SAME game awaits the first's settle (success OR failure) before launching, so two
// real game processes can NEVER be launched concurrently (the spec's serialization rail). The entry
// is deleted once its chain drains so the map cannot grow unbounded (F-014 leak class).
const gameLocks = new Map<string, Promise<unknown>>();

function normalizeGameKey(processName: string): string {
	return processName.trim().toLowerCase();
}

/**
 * Run `fn` with the per-game lock held — serialized against any other game-verify for the SAME
 * game. The lock NEVER rejects the chain (a prior failure must not poison the next verify): each
 * waiter runs on the prior's SETTLED tail (`.then(() => fn(), () => fn())`), then cleans the map
 * entry when it is the current tail.
 */
async function withGameLock<T>(processName: string, fn: () => Promise<T>): Promise<T> {
	const key = normalizeGameKey(processName);
	const prior = gameLocks.get(key) ?? Promise.resolve();
	const run = prior.then(
		() => fn(),
		() => fn()
	);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	gameLocks.set(key, tail);
	try {
		return await run;
	} finally {
		if (gameLocks.get(key) === tail) gameLocks.delete(key);
	}
}

/** Test/diagnostics: number of game keys with an in-flight verify chain (0 when idle). */
export function gameVerifyInFlightCount(): number {
	return gameLocks.size;
}

// ── The step ───────────────────────────────────────────────────────────────────────────────

/**
 * Run the GAME-VERIFY step for a just-built mod task. GATE → SERIALIZE → RUN → PERSIST → FEED-BACK.
 *
 * Returns `{ ran:false }` immediately (the runner UNTOUCHED) when the project declares no parseable
 * `game_verify` block — so a non-game project is byte-identical to the pre-capability behavior.
 *
 * On a parseable config it runs the (serialized-per-game) runner, persists the verdict as a
 * `completion` agent_event (reason 'game-verify', the full honest verdict in `detail`), and — on any
 * NON-pass outcome — enqueues a `follow_up` work_item carrying the SCREENED stack traces / log tail
 * so the next code-write iteration gets the fix signal. The task is NEVER failed by a non-pass
 * verdict (human-in-the-loop, automated). NEVER throws: a persistence/DB fault is caught and recorded
 * as an honest `error` event, so this can never crash the orchestrator drain (F-014/F-048).
 */
export async function runGameVerifyStep(
	db: Db,
	input: GameVerifyStepInput,
	deps: GameVerifyStepDeps = {}
): Promise<GameVerifyStepResult> {
	// ── GATE (opt-in): absent/invalid config ⇒ the capability is OFF; the runner is NOT invoked. ──
	const cfg = parseGameVerifyConfig(input.rawConfig);
	if (!cfg) return { ran: false };

	const runner = deps.runner ?? runGameVerify;

	let verdict: GameVerifyVerdict;
	try {
		// SERIALIZE per game — never two concurrent launches of the same game (spec).
		verdict = await withGameLock(cfg.process_name, () =>
			runner(cfg, { cwd: input.cwd, builtArtifacts: input.builtArtifacts }, deps.runnerDeps)
		);
	} catch (err) {
		// Defence in depth: runGameVerify never throws (it returns an honest verdict on any fault),
		// but an INJECTED runner might. A thrown runner is an honest 'not_ready', never a crash.
		await recordFault(db, input, `game-verify runner threw: ${(err as Error).message}`);
		return { ran: true };
	}

	// ── PERSIST the verdict where session/task outcomes live (an agent_event — like post-task). ──
	// The logTail / stackTraces are ALREADY screened by the runner (D-026); the diagnostic `note`
	// is screened here for defence in depth. A non-pass is recorded honestly (the outcome is in the
	// detail) — it is NOT a hard failure, so the event type stays `completion`, never `error`.
	const screenedNote = verdict.note ? screenForDisplay(verdict.note).text : undefined;
	try {
		const agentEventId = await writeAgentEvent(db, {
			type: 'completion',
			session: input.sessionId,
			project: input.projectId,
			detail: {
				reason: 'game-verify',
				ok: verdict.outcome === 'pass',
				summary: `game-verify: ${verdict.outcome}`,
				outcome: verdict.outcome,
				ready: verdict.ready,
				loaded: verdict.loaded,
				error_count: verdict.errorCount,
				by_pattern: verdict.byPattern,
				stack_traces: verdict.stackTraces,
				log_tail: verdict.logTail,
				note: screenedNote,
				deployed: verdict.deployed,
				taskId: input.taskId
			}
		});

		// ── FEED BACK (non-pass only): enqueue a follow_up with the SCREENED fix signal. ──
		// A pass needs no follow-up. errors/timeout/crashed/not_ready ⇒ the next iteration's input.
		let feedbackWorkId: string | undefined;
		if (verdict.outcome !== 'pass') {
			const { id, enqueued } = await enqueue(db, {
				workType: 'follow_up',
				payload: {
					parentTaskId: input.taskId,
					projectId: input.projectId,
					reason: `game-verify: ${verdict.outcome}`,
					game_verify_outcome: verdict.outcome,
					error_count: verdict.errorCount,
					// Screened by the runner already; bounded by the runner's MAX_STACK_BLOCKS / LOG_TAIL.
					stack_traces: verdict.stackTraces,
					log_tail: verdict.logTail
				},
				projectId: input.projectId,
				// One open game-verify follow-up per task (not one per verify run) — dedup on the task.
				dedupScope: `${input.taskId}|game-verify`
			});
			if (enqueued) feedbackWorkId = id;
		}

		return { ran: true, verdict, feedbackWorkId, agentEventId };
	} catch (err) {
		// A DB fault writing the verdict/feedback must NEVER crash the drain (F-014/F-048). Record an
		// honest error event (best-effort) and return — the verdict still ran; only its persistence failed.
		await recordFault(db, input, `game-verify persist failed (${verdict.outcome}): ${(err as Error).message}`);
		return { ran: true, verdict };
	}
}

/** Record an honest `error` agent_event for a game-verify fault. Best-effort — never throws. */
async function recordFault(db: Db, input: GameVerifyStepInput, message: string): Promise<void> {
	try {
		await writeAgentEvent(db, {
			type: 'error',
			session: input.sessionId,
			project: input.projectId,
			detail: {
				by: 'orchestrator',
				reason: 'game-verify-fault',
				error: screenForDisplay(message).text,
				taskId: input.taskId
			}
		});
	} catch {
		/* best-effort — a fault recording the fault must not crash the drain (F-014) */
	}
}
