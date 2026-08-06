// server/tasks/scope — the ONE project-scope check for an operator-supplied task id.
//
// WHY THIS MODULE EXISTS (the defect it retires):
// A record id posted from a form needs TWO independent guards before it reaches a write, and they
// live in different places on purpose:
//
//   1. TABLE identity — an invariant of the repo function itself. `setStatus` in the task repo can
//      only ever mean a `task`, so `assertRecordIdOfTable(id, 'task')` belongs INSIDE the repo
//      (tasks/repo.ts), where no present or future caller has to remember it. That half is done.
//
//   2. PROJECT scope — NOT knowable in the repo. Only the route knows which project the URL is
//      scoped to, so the repo cannot make this check and the caller must. That half kept being
//      hand-copied inline, and a hand-copied guard is a guard that goes missing: it was written out
//      at four call sites on /projects/[id] and absent from two more (`pmRevise`, `pmWithdraw`),
//      which let one project's PM surface withdraw — and revise, creating a successor row — a
//      `proposed` task belonging to ANOTHER project, answering HTTP 200 `{ ok: true }`.
//
// So the project check gets ONE home. This is the function that was `resolveBoardTask`, local to
// /projects/[id]/tasks; it was already exactly right, it just could not be reached from the routes
// that needed it. Lifting it is the fix — a fifth inline copy would have been the bug again.
//
// The two guards compose but do not substitute for each other. Note especially what the table guard
// alone does NOT buy you: it pins WHICH table, never WHICH row, so a well-formed id of the right
// table in the wrong project sails straight through it.

import type { Db } from '../db/client';
import { assertRecordIdOfTable } from '../db/validate';
import { getTask, type TaskRow } from './repo';

/**
 * Resolve a posted task id to a row ONLY IF it is table-scoped (D-016) AND on THIS project.
 *
 * Returns `null` for all three refusals — malformed id, right shape but wrong table, and a real
 * task of another project — so the caller renders one honest not-found and never confirms which
 * of the three it was (a foreign row is neither written to nor acknowledged to exist).
 *
 * Callers that want to distinguish a malformed/wrong-table id (a client bug → 400) from a
 * legitimately absent one (→ 404) keep their own `assertRecordIdOfTable` ahead of this call; this
 * function re-checks it regardless, so a caller that forgets is still safe.
 *
 * NO TOCTOU: `task.project` is absent from `UpdateTaskInput` (D-008) and `setStatus` writes only
 * `status` + `updated_at`, so the row cannot move to another project between this read and the
 * write it guards.
 */
export async function resolveProjectTask(
	db: Db,
	projectId: string,
	rawId: string
): Promise<TaskRow | null> {
	let taskId: string;
	try {
		taskId = assertRecordIdOfTable(rawId, 'task');
	} catch {
		return null;
	}
	const row = await getTask(db, taskId);
	if (!row || row.project !== projectId) return null;
	return row;
}
