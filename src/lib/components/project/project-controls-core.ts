// CC-CONTROLS — pure presentation logic for the project command-center CONTROLS (ProjectControls.svelte).
//
// All logic that turns LIVE rows + the last action result into the controls' visual model lives here as
// pure functions so it is unit-testable without rendering Svelte (the project-status-core pattern).
// NOTHING here fabricates a count or a state (F-008): the restartable-session list comes from the real
// session rows, the ready-task count from the real task rows, and every result-banner state is a faithful
// read of the action result the server returned (an honest empty/error, never a fake success). Plain .ts
// — NO runes (F-009).

/** A minimal task shape — only `status` is read (works with the loader's TaskSummary). */
export interface TaskLike {
	status: string;
}

/** A minimal session shape — works with the loader's FleetSession (id/status/taskId/note + label fields). */
import { sessionDisplayName } from '$lib/shared/naming';

export interface SessionLike {
	id: string;
	status: string;
	taskId?: string | null;
	note?: string | null;
	kind?: string | null;
	roleName?: string | null;
	roleSlug?: string | null;
}

/**
 * Count THIS project's READY tasks — the CONTINUE candidate set the operator sees BEFORE clicking. A
 * nil/empty list ⇒ 0 (the honest "nothing ready" state — the button is then shown disabled with a reason,
 * never a fake count). Counts ONLY `status === 'ready'` (the orchestrator's spawn-ready status); a task
 * in any other status is not a CONTINUE candidate.
 */
export function readyTaskCount(tasks: readonly TaskLike[] | null | undefined): number {
	let n = 0;
	for (const t of tasks ?? []) if (t?.status === 'ready') n += 1;
	return n;
}

/** The session statuses RESTART may re-run — MUST mirror project-controls.ts RESTARTABLE_SESSION_STATUSES
 *  (a failed/stuck session, never a clean done or a healthy running one). Kept here too so the UI can
 *  decide which sessions get a RESTART affordance without importing the server module. */
export const RESTARTABLE_SESSION_STATUSES: readonly string[] = ['failed', 'stale', 'unknown'] as const;

/** One restartable session row the controls render: the id to submit, its task, the honest failure note,
 *  and a short human label of WHAT it was (so the operator knows which run they are re-running). */
export interface RestartableRow {
	sessionId: string;
	taskId: string;
	/** The honest terminal note (WHY it failed), or null — never a fabricated reason (F-008). */
	note: string | null;
	/** A short "what kind of work" label (e.g. "dev task", "pm — lifecycle"), derived from kind/role. */
	label: string;
}

/**
 * Derive the list of RESTARTABLE sessions for the controls. SHADOW PATHS: a nil/empty list ⇒ [] (the
 * honest "nothing to restart" state). A session is restartable IFF (a) its status is in
 * RESTARTABLE_SESSION_STATUSES AND (b) it carries a task id (a chat/discussion turn with no task cannot be
 * "re-run as a task" — it is filtered out here so the UI never offers an impossible restart). The list is
 * capped at `max` so a storm of failed sessions cannot blow the surface up (the rest are reachable via the
 * activity panel). The label is a faithful read of kind/role — a neutral fallback when unknown, never
 * fabricated.
 */
export function restartableSessions(
	sessions: readonly SessionLike[] | null | undefined,
	max = 8
): RestartableRow[] {
	const out: RestartableRow[] = [];
	for (const s of sessions ?? []) {
		if (!s) continue;
		if (!RESTARTABLE_SESSION_STATUSES.includes(s.status)) continue;
		const taskId = s.taskId != null ? String(s.taskId) : '';
		if (!taskId) continue; // no task → not restartable as a task run (honest filter)
		out.push({
			sessionId: String(s.id),
			taskId,
			note: s.note ?? null,
			label: sessionLabel(s)
		});
		if (out.length >= max) break;
	}
	return out;
}

/**
 * A short, honest "what kind of work" label from role/kind. Neutral fallback when unknown —
 * never a fabricated label (F-008).
 *
 * NAMING (standing operator rule, 2026-07-26): delegates to the ONE shared composer so a restart
 * row reads the same as the same session in the memory scene and on the fleet cards. Behaviour is
 * preserved (`role` still beats `kind`, and `includeKind` keeps the coarse kind alongside it);
 * what changes is that the two are joined with the shared ` · ` separator instead of an ad-hoc
 * ` — `, and the dead-end `'agent run'` becomes the explicit `'unnamed session'` placeholder —
 * the honest "we have no purposeful field for this row", which `describeSession(...).isPlaceholder`
 * lets a renderer style as unknown rather than as a name.
 */
export function sessionLabel(s: SessionLike): string {
	return sessionDisplayName(
		{ roleName: s.roleName, roleSlug: s.roleSlug, kind: s.kind },
		{ includeKind: true }
	);
}

/** The honest result-banner state for a CONTINUE/RESTART action: idle (no result yet) / busy (in flight) /
 *  ok (it ran) / noop (nothing needed — e.g. nothing ready, or already in-flight) / error (named reason).
 *  Never a fake success: a result that enqueued/spawned nothing AND found nothing to do is `noop`, not `ok`. */
export type ControlState = 'idle' | 'busy' | 'ok' | 'noop' | 'error';

/** The CONTINUE result shape the server returns (mirrors project-controls.ContinueResult, loosened for the
 *  client's untyped form payload). */
export interface ContinueFeedback {
	error?: unknown;
	readyCount?: unknown;
	enqueued?: unknown;
	alreadyQueued?: unknown;
	claimed?: unknown;
	spawned?: unknown;
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Map a CONTINUE action result + the in-flight flag to the honest banner state. SHADOW PATHS: busy wins
 * (we are mid-request); a result with `error` ⇒ error; no result ⇒ idle. A result that found NO ready
 * tasks AND enqueued/spawned nothing is `noop` (an honest "nothing to do", never dressed as a success);
 * a result that enqueued OR spawned OR found ready work to drive is `ok`.
 */
export function continueState(fb: ContinueFeedback | null | undefined, busy: boolean): ControlState {
	if (busy) return 'busy';
	if (!fb) return 'idle';
	if (fb.error != null && fb.error !== '') return 'error';
	const ready = num(fb.readyCount);
	const enqueued = num(fb.enqueued);
	const claimed = num(fb.claimed);
	const spawned = num(fb.spawned);
	if (ready === 0 && enqueued === 0 && claimed === 0 && spawned === 0) return 'noop';
	return 'ok';
}

/** A one-line honest summary of a CONTINUE result for the banner (real counts only). */
export function continueSummary(fb: ContinueFeedback | null | undefined): string {
	if (!fb) return '';
	if (fb.error != null && fb.error !== '') return String(fb.error);
	const ready = num(fb.readyCount);
	const enqueued = num(fb.enqueued);
	const already = num(fb.alreadyQueued);
	const spawned = num(fb.spawned);
	if (ready === 0 && enqueued === 0 && spawned === 0) {
		return 'Nothing ready to continue — no tasks are in the ready state for this project.';
	}
	const parts: string[] = [];
	parts.push(`${ready} ready task${ready === 1 ? '' : 's'}`);
	if (enqueued > 0) parts.push(`${enqueued} enqueued`);
	if (already > 0) parts.push(`${already} already queued`);
	parts.push(`${spawned} session${spawned === 1 ? '' : 's'} started`);
	return parts.join(' · ') + '.';
}

/** The RESTART result shape the server returns (mirrors project-controls.RestartResult, loosened). */
export interface RestartFeedback {
	error?: unknown;
	taskId?: unknown;
	enqueued?: unknown;
	claimed?: unknown;
	spawned?: unknown;
}

/**
 * Map a RESTART action result + the in-flight flag to the honest banner state. busy wins; `error` ⇒
 * error; no result ⇒ idle. A re-run that was a dedup no-op (enqueued:false) AND started nothing is
 * `noop` (the benign already-in-flight double-click guard — an honest state, NOT a failure); a re-run
 * that enqueued or started a session is `ok`.
 */
export function restartState(fb: RestartFeedback | null | undefined, busy: boolean): ControlState {
	if (busy) return 'busy';
	if (!fb) return 'idle';
	if (fb.error != null && fb.error !== '') return 'error';
	const enqueued = fb.enqueued === true;
	const spawned = num(fb.spawned);
	if (!enqueued && spawned === 0) return 'noop';
	return 'ok';
}

/** A one-line honest summary of a RESTART result for the banner. */
export function restartSummary(fb: RestartFeedback | null | undefined): string {
	if (!fb) return '';
	if (fb.error != null && fb.error !== '') return String(fb.error);
	const enqueued = fb.enqueued === true;
	const spawned = num(fb.spawned);
	if (!enqueued && spawned === 0) {
		return 'Already re-running — that task is in flight; nothing was spawned (double-run guarded).';
	}
	if (spawned > 0) return `Re-run started — ${spawned} session${spawned === 1 ? '' : 's'} spawned.`;
	return 'Re-run enqueued — it will start as soon as a slot frees up.';
}
