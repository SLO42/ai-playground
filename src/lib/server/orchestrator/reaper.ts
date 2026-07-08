// TASK 13.2 — the boot-time reaper for runs wedged 'running' by a hard server death.
//
// launchSession (sessions/launch.ts) and runWorkflow (workflows/runner.ts) guarantee a
// terminal status write on every IN-PROCESS exit path (13.2's other half) — but a hard
// process death (crash, kill, power loss) writes nothing. The work_item queue has a
// stale-claim reaper (gcStale, TASK 2.15); `session` and `workflow_run` rows had NONE,
// so a restart left phantom 'running' rows forever and every dashboard counted agents
// that no longer exist. This boot-time sweep marks every 'running' row that PREDATES
// this process boot as 'failed' with the honest note 'reaped: server restarted mid-run'
// (F-008) + ended_at, and writes an `error` agent_event per reaped session (analytics
// is first-class — the how/why of the failed verdict is recorded, not just the flip).
//
// "Predates this boot" compares started_at to the PROCESS boot instant
// (Date.now() − process.uptime()), NOT the call instant — so a dev-HMR re-eval of
// hooks.server.ts can never reap a session this very process started and still runs.
// Rows this process creates are covered by the in-process terminal guarantee above.
//
// Boundary discipline (D-016): every value binds via $param; the only record ids that
// flow onward (into writeAgentEvent) pass its db/validate chokepoint.

import type { Db } from '../db/client';
import { writeAgentEvent } from '../analytics/events';
import { releaseSessionWork } from './workqueue';
import { resetStuckTaskToReady } from '../tasks/repo';
import { activeOrchestrator } from './orchestrator';

/** The honest note stamped on every reaped row (F-008 — never a silent flip). */
export const REAPED_NOTE = 'reaped: server restarted mid-run';

export interface ReapResult {
	/** `session` rows reaped (pre-boot 'running' → 'failed'). */
	sessions: number;
	/** `workflow_run` rows reaped (pre-boot 'running' → 'failed'). */
	workflowRuns: number;
	/**
	 * `work_item` fork twins (memory_review/review) freed pending across all reaped sessions — the
	 * F-048 follow-on: a reaped session's claimed `processing` items are released so the drain
	 * re-drives them instead of starving on the orphaned twin (releaseSessionWork).
	 */
	releasedWorkItems: number;
	/** Orphaned tasks (a reaped session's `task`, wedged in_progress/review) reset to `ready`. */
	resetTasks: number;
}

/** The instant THIS process booted — the cutoff a run must predate to be reaped. */
export function processBootTime(): Date {
	return new Date(Date.now() - process.uptime() * 1000);
}

/**
 * ORH-2 (ORCHESTRATOR-SPEC §5) — self-trigger a drain after a release freed work.
 *
 * `releaseSessionWork` resets a dead session's `processing` twins → pending, but nothing
 * DRAINS them: the drain loop is trigger-driven (bus event / permit release / operator /
 * boot), and a freed row emits none of those. Left alone, the freed work sat until the next
 * unrelated task event (the ~5min `startMaintenance` backstop only un-sticks stale rows by
 * age — it does NOT drain). So after a successful release with n>0 freed items we NUDGE the
 * live orchestrator to drain them right now.
 *
 * Fire-and-forget + FULLY swallowed (F-014, invariant §2.5): a recovery release must NEVER
 * fail — and its already-computed result must NEVER be lost — because the nudge threw. Both
 * a rejected drain promise (`.catch`) and a synchronous throw from `drain()`/
 * `activeOrchestrator()` (the outer `try`) are logged and absorbed, re-raising nothing.
 *
 * At BOOT the orchestrator does not yet exist (`reapStaleRuns` runs before
 * `startOrchestrator` subscribes), so `activeOrchestrator()` returns null and this is a
 * correct no-op — ORH-1's `bootDrain` covers the boot-time reaper case. This nudge covers
 * RUNTIME callers (a live-session-failure recovery path invoking the release while the
 * orchestrator is running).
 */
function nudgeDrainAfterRelease(released: number): void {
	if (released <= 0) return; // nothing freed → nothing to drain
	try {
		void activeOrchestrator()
			?.drain()
			.catch((err) => {
				console.warn(
					`[reaper] post-release drain nudge rejected (swallowed, F-014): ${(err as Error).message}`
				);
			});
	} catch (err) {
		console.warn(
			`[reaper] post-release drain nudge threw synchronously (swallowed, F-014): ${(err as Error).message}`
		);
	}
}

/**
 * Reap session + workflow_run rows wedged 'running' by a previous boot: any row whose
 * started_at predates `bootTime` (default: this process's boot instant) is marked
 * 'failed' with {@link REAPED_NOTE} + ended_at, and each reaped session gets an `error`
 * agent_event. Idempotent: a second sweep finds nothing 'running' and reaps zero.
 * Rows already terminal (done/failed/cancelled) and runs started AFTER boot are never
 * touched.
 */
export async function reapStaleRuns(db: Db, bootTime: Date = processBootTime()): Promise<ReapResult> {
	const boot = bootTime.toISOString();
	const res = await db.query<
		[Array<{ id: unknown; project?: unknown; task?: unknown }>, Array<{ id: unknown }>]
	>(
		`UPDATE session
		   SET status = 'failed', ended_at = time::now(), note = $note
		   WHERE status = 'running' AND started_at < <datetime>$boot
		   RETURN AFTER;
		 UPDATE workflow_run
		   SET status = 'failed', ended_at = time::now(), note = $note
		   WHERE status = 'running' AND started_at < <datetime>$boot
		   RETURN AFTER;`,
		{ note: REAPED_NOTE, boot }
	);
	const sessions = res[0] ?? [];
	const runs = res[1] ?? [];

	let releasedWorkItems = 0;
	let resetTasks = 0;

	// Per reaped session: (1) an `error` agent_event (analytics first-class), then (2) the F-048
	// follow-on recovery — FREE its orphaned `processing` fork twins (releaseSessionWork) and RESET
	// its stranded task back to ready (resetStuckTaskToReady), so boot recovery is COMPLETE (session
	// failed + its work freed + its task ready) and the drain re-drives the work instead of starving
	// on the orphaned twin (the symptom hand-recovered via DB last go-live). The session was flipped
	// 'failed' by the UPDATE above BEFORE this loop, so the releaseSessionWork caller-contract
	// (session already terminal) holds. F-014: every step is wrapped per-session and best-effort — a
	// fault on the recovery (or the analytics) path is logged and NEVER thrown out of the reaper, so a
	// single bad row can never crash the boot sweep or leave it half-done for the rest.
	for (const s of sessions) {
		const sessionId = String(s.id);
		try {
			await writeAgentEvent(db, {
				type: 'error',
				session: sessionId,
				project: s.project != null ? String(s.project) : undefined,
				detail: {
					error: REAPED_NOTE,
					by: 'reaper',
					reason: 'session was still running when the server restarted (boot-time sweep, 13.2)'
				}
			});
		} catch (err) {
			console.warn(`[reaper] agent_event write failed for ${sessionId}: ${(err as Error).message}`);
		}

		// (2a) release the session's claimed work_items (F-048 follow-on).
		try {
			const { released } = await releaseSessionWork(db, sessionId);
			releasedWorkItems += released;
		} catch (err) {
			console.warn(
				`[reaper] releaseSessionWork failed for ${sessionId} (gcStale will recover by age): ${(err as Error).message}`
			);
		}

		// (2b) reset the session's orphaned task (session.task link) back to ready, guarded to the
		// in_progress/review crash pre-states only. NONE task (a chat/workflow-step session) → skip.
		if (s.task != null) {
			try {
				if (await resetStuckTaskToReady(db, String(s.task))) resetTasks += 1;
			} catch (err) {
				console.warn(
					`[reaper] resetStuckTaskToReady failed for task ${String(s.task)} (session ${sessionId}): ${(err as Error).message}`
				);
			}
		}
	}

	// ORH-2: the reap freed `releasedWorkItems` claimed twins back to pending — self-trigger a
	// drain so the freed work is re-driven now instead of waiting on the next unrelated event.
	// No-op + never-throws when the orchestrator isn't live yet (boot) or the nudge faults.
	nudgeDrainAfterRelease(releasedWorkItems);

	return { sessions: sessions.length, workflowRuns: runs.length, releasedWorkItems, resetTasks };
}
