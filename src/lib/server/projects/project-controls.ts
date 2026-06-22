// CC-CONTROLS — the operator command-center CONTROL seam for /projects/[id] (OPERATOR PAIN).
//
// The operator could SEE a project's status (CC-STATUS) and WATCH it think (ProjectActivity) but had
// no way to ACT from the project page: a stalled project with pre-existing READY tasks sat undeveloped
// (the event-mode orchestrator only reacts to a task ENTERING ready — it never re-drains tasks already
// sitting ready after a dev-server boot), and a failed/stuck session offered no re-run. This module is
// the honest, guarded ACT seam behind two new server actions:
//
//   • continueReadyTasks  — "get a stalled project moving": ask the LIVE orchestrator to enqueue THIS
//     project's already-READY tasks and drain them. This is the real enqueue/drain seam
//     (orchestrator.enqueueTask + orchestrator.drain), NOT a status-bounce through backlog (D-008 keeps
//     the description immutable; bouncing status would fabricate transitions). It re-uses the SAME
//     work_item claim queue + daily cap + interactive semaphore the boot orchestrator uses, so it can
//     NEVER bypass the spawn cap or run away (drain stops the instant permits OR the cap OR work run out).
//
//   • restartSessionTask  — re-run the task behind a FAILED/stuck session (the operator's exact pain:
//     6 dev sessions failed instantly with cc_session_id=null, no note). Re-enqueues that ONE task's
//     task_run via the SAME seam.
//
// THE DOUBLE-SPAWN GUARD IS STRUCTURAL, not an in-memory lock: the work_item `dedup_key` UNIQUE index
// (schema m0019: work_type|session|dedup_scope|status, active window = pending|processing) makes a
// re-enqueue of a task that is ALREADY pending/processing a UNIQUE-collision no-op (workqueue.enqueue
// returns enqueued:false). So a double-click — or two concurrent CONTINUE/RESTART requests, or a CONTINUE
// racing the boot orchestrator's own trigger — collapses to a single in-flight task_run. This guard is
// cross-request AND cross-process (it lives in the DB), strictly stronger than a per-process lock. The
// orchestrator's own claimNext is single-winner (S0), so even if two work_items somehow coexisted only
// one would be claimed+spawned at a time under the semaphore.
//
// CROSS-PROJECT SAFETY: continueReadyTasks lists ready tasks for THIS projectId ONLY
// (listTasksByProject(db, projectId, 'ready')) and enqueues each with its real (taskId, projectId) — it
// can never touch another project's tasks. restartSessionTask verifies the session belongs to THIS
// project before re-enqueuing (a cross-project session id is refused with a named error).
//
// AUTHORITY: neither action hires, publishes, or promotes anything — they only ask the orchestrator to
// run work that is ALREADY ready (the operator/PM put it there). No D-037/D-039 gate is touched.
//
// Honest states (F-008): every count is a real read; an absent orchestrator (degraded/no-credential
// boot) is a NAMED honest reason, never a fake "started". An interrupt mid-drain is safe — the queue is
// durable and a later trigger/continue re-drains (interrupt contract).

import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { listTasksByProject } from '../tasks/repo';

/** EVERY ERROR HAS A NAME — the orchestrator handle was absent (degraded/no-credential boot). The
 *  caller maps this to an honest 503 reason; nothing was enqueued or spawned. */
export class OrchestratorUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OrchestratorUnavailableError';
	}
}

/** EVERY ERROR HAS A NAME — the named session does not belong to THIS project (cross-project refusal)
 *  or carries no task to re-run. The caller maps this to a 409; nothing was enqueued. */
export class SessionControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SessionControlError';
	}
}

/**
 * The MINIMAL orchestrator surface these controls drive — exactly the two PUBLIC methods the live
 * Orchestrator already exposes (orchestrator.ts: enqueueTask + drain). Typing the dependency this
 * narrowly (a) keeps the seam test-injectable without a full Orchestrator, and (b) makes it explicit
 * that these controls can ONLY enqueue + drain — they cannot reach claimNext/spawn directly or bypass
 * the cap. The orchestrator is the single owner of the cap + semaphore; we just feed its queue.
 */
export interface OrchestratorControl {
	/** Enqueue a task_run work_item for one task (idempotent via the dedup_key — returns whether a NEW
	 *  row was created; a task already pending/processing returns false). */
	enqueueTask(taskId: string, projectId: string): Promise<boolean>;
	/** Drain the claim queue under the SAME daily cap + interactive semaphore (never a busy loop). */
	drain(): Promise<{ claimed: number; spawned: number }>;
}

/** What a CONTINUE pass did — all honest real counts (F-008). */
export interface ContinueResult {
	/** How many READY tasks this project had at the moment of the action (the candidate set). */
	readyCount: number;
	/** How many task_run work_items were NEWLY enqueued (a task already in-flight is skipped → not
	 *  counted here; that is the dedup guard working, not a failure). */
	enqueued: number;
	/** How many candidates were already in-flight (pending/processing) — the dedup guard absorbed them. */
	alreadyQueued: number;
	/** The drain outcome: items CLAIMED + spawns STARTED this pass (bounded by the cap + semaphore). */
	claimed: number;
	spawned: number;
}

/** What a RESTART pass did — honest real outcome (F-008). */
export interface RestartResult {
	/** The task id that was re-enqueued (the task behind the failed/stuck session). */
	taskId: string;
	/** True when a NEW task_run was enqueued; false when the task was ALREADY in-flight (dedup no-op —
	 *  a benign double-click guard, NOT a failure). */
	enqueued: boolean;
	/** The drain outcome (bounded by the cap + semaphore). */
	claimed: number;
	spawned: number;
}

/**
 * CONTINUE — get a stalled project moving by re-enqueuing its already-READY tasks into the live
 * orchestrator's claim queue, then draining. THE honest fix for the operator's pain: ready tasks that
 * predate the boot are not re-driven by the event-mode orchestrator (it only reacts to a task ENTERING
 * ready), so they sit forever; this asks the orchestrator to drain them explicitly.
 *
 * Scope: lists ready tasks for THIS projectId ONLY (cannot touch other projects). Idempotent: a task
 * already pending/processing collapses via the dedup_key (counted as alreadyQueued, not enqueued). Spend
 * is bounded by the orchestrator's OWN daily cap + interactive semaphore inside drain() — this seam adds
 * NO new spawn path and can never bypass the cap. SHADOW PATHS: no ready tasks ⇒ readyCount 0, nothing
 * enqueued, an honest drain of whatever was already queued (which may be 0). A nil orchestrator throws
 * OrchestratorUnavailableError (named honest reason). The projectId is validated at the boundary (D-016).
 */
export async function continueReadyTasks(
	orchestrator: OrchestratorControl | null,
	db: Db,
	projectId: string
): Promise<ContinueResult> {
	const pid = assertRecordId(projectId);
	if (!orchestrator) {
		throw new OrchestratorUnavailableError(
			'No live orchestrator — the engine is not running (no Claude Code credential or a degraded boot). Ready tasks will drive on the next credentialed boot.'
		);
	}

	// THIS project's ready tasks only — the cross-project leakage guard is the WHERE project = $project
	// in listTasksByProject (never a global list). [] when none (honest empty).
	const ready = await listTasksByProject(db, pid, 'ready');

	let enqueued = 0;
	let alreadyQueued = 0;
	for (const t of ready) {
		// enqueueTask is idempotent: a task already pending/processing returns false (dedup_key no-op).
		// This is the double-spawn guard — a concurrent CONTINUE / the boot trigger / a double-click all
		// collapse to a single in-flight task_run.
		const isNew = await orchestrator.enqueueTask(t.id, pid);
		if (isNew) enqueued += 1;
		else alreadyQueued += 1;
	}

	// Drain under the orchestrator's OWN cap + semaphore. Safe even when nothing new was enqueued (it
	// drains whatever is claimable, bounded). A drain mid-flight is interrupt-safe (durable queue).
	const drained = await orchestrator.drain();

	return {
		readyCount: ready.length,
		enqueued,
		alreadyQueued,
		claimed: drained.claimed,
		spawned: drained.spawned
	};
}

/** The minimal session shape restart reads — id/status/project/task. Works with the loader FleetSession
 *  (it carries these) AND a raw row read, so the caller can pass either. */
export interface RestartableSession {
	id: string;
	status: string;
	/** The owning project record id (string) — checked against THIS project (cross-project guard). */
	project?: string | null;
	/** The task this session ran (the unit to re-enqueue), or null when the session had no task. */
	taskId?: string | null;
}

/** The session statuses a RESTART is allowed to re-run: a terminal FAILED session, or a session left
 *  'running' with no live process (a stuck/orphaned session — the boot reaper normally flips these to
 *  failed, but a live-but-wedged one is still restartable). We do NOT restart a cleanly 'done' session
 *  (its work finished) — re-running it would be fabricated rework; the operator spawns a follow-up
 *  instead. A genuinely live, healthy 'running' session is refused too (you cannot restart work that is
 *  actively in flight — that is exactly the double-spawn we prevent). */
export const RESTARTABLE_SESSION_STATUSES: readonly string[] = ['failed', 'stale', 'unknown'] as const;

/**
 * RESTART — re-run the task behind a FAILED/stuck session by re-enqueuing its task_run through the SAME
 * orchestrator seam. Guarded against double-spawn by the work_item dedup_key (a second click while the
 * re-run is pending/processing is a no-op, enqueued:false). Guarded against cross-project leakage: the
 * session must belong to THIS projectId (a foreign session id is refused with a named SessionControlError).
 *
 * The session is identified by the caller (it already has the FleetSession rows); we re-validate its
 * project + status + task here at the boundary (NO-GUESSING — never trust the client's claim). A session
 * with no task (a chat/discussion turn) cannot be "re-run as a task" → named error. A session that is
 * cleanly done or actively running is refused (RESTARTABLE_SESSION_STATUSES) so RESTART never duplicates
 * live work nor fabricates rework. Spend is bounded by the orchestrator's cap + semaphore in drain().
 */
export async function restartSessionTask(
	orchestrator: OrchestratorControl | null,
	projectId: string,
	session: RestartableSession
): Promise<RestartResult> {
	const pid = assertRecordId(projectId);
	if (!orchestrator) {
		throw new OrchestratorUnavailableError(
			'No live orchestrator — the engine is not running (no Claude Code credential or a degraded boot). Re-run will drive on the next credentialed boot.'
		);
	}

	// CROSS-PROJECT GUARD: the session must belong to THIS project. A foreign/absent project is refused
	// (never re-enqueue another project's work from this page).
	const sessionProject = session.project != null ? String(session.project) : '';
	if (!sessionProject || assertRecordId(sessionProject) !== pid) {
		throw new SessionControlError('session does not belong to this project');
	}

	// STATUS GUARD: only a failed/stuck session is restartable. A done session finished its work
	// (re-running is fabricated rework — spawn a follow-up instead); a healthy running session is live
	// work (re-running would be the double-spawn we exist to prevent).
	if (!RESTARTABLE_SESSION_STATUSES.includes(session.status)) {
		throw new SessionControlError(
			`session status "${session.status}" is not restartable (only failed/stuck sessions can be re-run)`
		);
	}

	// The unit to re-run is the session's task. A session with no task (chat/discussion) has nothing to
	// re-run as a task — a named honest refusal, never a fabricated task.
	const taskId = session.taskId != null ? String(session.taskId) : '';
	if (!taskId) {
		throw new SessionControlError('session has no task to re-run (it was not a task run)');
	}
	// Validate the task id at the boundary (D-016) before it flows into enqueueTask.
	const tid = assertRecordId(taskId);

	// Re-enqueue the SAME task. Idempotent via the dedup_key: a re-run already pending/processing is a
	// no-op (enqueued:false) — the double-click / concurrent-restart guard.
	const isNew = await orchestrator.enqueueTask(tid, pid);
	const drained = await orchestrator.drain();

	return { taskId: tid, enqueued: isNew, claimed: drained.claimed, spawned: drained.spawned };
}
