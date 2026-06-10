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

/** The honest note stamped on every reaped row (F-008 — never a silent flip). */
export const REAPED_NOTE = 'reaped: server restarted mid-run';

export interface ReapResult {
	/** `session` rows reaped (pre-boot 'running' → 'failed'). */
	sessions: number;
	/** `workflow_run` rows reaped (pre-boot 'running' → 'failed'). */
	workflowRuns: number;
}

/** The instant THIS process booted — the cutoff a run must predate to be reaped. */
export function processBootTime(): Date {
	return new Date(Date.now() - process.uptime() * 1000);
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
		[Array<{ id: unknown; project?: unknown }>, Array<{ id: unknown }>]
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

	// One `error` agent_event per reaped session (analytics first-class). Best-effort:
	// an event-write failure never undoes the reap itself.
	for (const s of sessions) {
		try {
			await writeAgentEvent(db, {
				type: 'error',
				session: String(s.id),
				project: s.project != null ? String(s.project) : undefined,
				detail: {
					error: REAPED_NOTE,
					by: 'reaper',
					reason: 'session was still running when the server restarted (boot-time sweep, 13.2)'
				}
			});
		} catch (err) {
			console.warn(
				`[reaper] agent_event write failed for ${String(s.id)}: ${(err as Error).message}`
			);
		}
	}

	return { sessions: sessions.length, workflowRuns: runs.length };
}
