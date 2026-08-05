/**
 * /projects/[id]/tasks — the FULL-PAGE task board + per-task detail (TASK-BOARD-SPEC §5, P3).
 *
 * OPERATOR ASK (2026-07-26): *"basically want to turn the tasks section into an asana board that we
 * can view, with a full page view and each task having meta data and tags to help remind our models
 * exactly why and how to handle each task."* The project page's inline kanban ships a deliberately
 * slim `TaskSummary` (title / priority / createdAt / tags / moves) — every §4.1 field the row
 * carries (objective, purpose, acceptance_criteria, provenance, the proposal links, the
 * fingerprint) is STORED, panel-validated, and never rendered anywhere. This loader ships them.
 *
 * ── One query, one live surface (§5.2) ────────────────────────────────────────────────────
 * `listTasksByProject` already returns fully-normalized `TaskRow`s, so this route introduces NO new
 * query shape and therefore no new F-020 surface. The DETAIL view reads the SAME loaded rows —
 * `?task=<id>` opens a panel, it does not hit a second loader — which is why a task that is not on
 * this project's board resolves to an honest not-found instead of a cross-project read.
 *
 * ── The wire shape (F-013 / devalue) ──────────────────────────────────────────────────────
 * `normTask` already `str()`s the id, the project link and both datetimes, but `provenance.detail`
 * is a free-form `Record<string, unknown>` that came straight out of the SDK — it can hold a
 * RecordId or a Date, either of which is a devalue 500 the moment a `load` returns it. So the whole
 * row is projected onto {@link BoardTask} by `board-row.ts`: datetimes ISO-coerced, `detail`
 * FLATTENED to printable `{key, value}` string pairs, absent fields OMITTED (never `''`, never the
 * literal `"undefined"`).
 *
 * ── Writes (TB-4 / TB-5) ──────────────────────────────────────────────────────────────────
 * Three actions, each a thin call onto an EXISTING repo function: `moveTask` → `setStatus` (the
 * only status writer, so every move passes the state machine — the board adds no promote button and
 * no second promoter), `retagTask` → `updateTask({tags})`, `setPriority` → `updateTask({priority})`.
 * `description` is absent from `UpdateTaskInput` (D-008) so no surface here can mutate the run seed,
 * and the §4.1 fields on a `proposed` task are PM-owned — they change only through
 * `revisePmProposal` on the project page's PM surface, never here (F-055).
 *
 * ── Sprints (the other half of the operator's question — answered, not built over) ────────
 * A `sprint` row carries `project, name, starts?, ends?, status?, completed_at?` (schema.ts:72-76,
 * :739-741) and NOTHING else: `task` has no sprint link, so a sprint cannot contain a task, a goal,
 * or a ticket. The only inbound FK anywhere is `decision.sprint` (:727). The board therefore does
 * not group by sprint — it states the fact instead (`sprintReality` below) and offers tags as the
 * grouping that actually exists. Retiring the sprint UI is P4 and operator-gated (spec §6.2).
 */

import { error, fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { assertRecordId, assertRecordIdOfTable } from '$lib/server/db/validate';
import { getProject, listSprints } from '$lib/server/projects/repo';
import { getPm } from '$lib/server/projects/pm-repo';
import {
	listTasksByProject,
	getTask,
	setStatus,
	updateTask,
	TASK_STATUSES,
	TASK_PRIORITIES,
	type TaskRow,
	type TaskStatus,
	type TaskPriority
} from '$lib/server/tasks/repo';
// The row → wire projection lives in its own module: SvelteKit REFUSES any non-reserved export from
// a `+page.server.ts` (build-time `validate`), so `toBoardTask` cannot be declared here.
import { toBoardTask } from './board-row';
import type { BoardTask } from './task-board-view';
import type { Actions, PageServerLoad } from './$types';

/** What the board page receives. */
export interface TaskBoardData {
	connected: boolean;
	projectId: string;
	/** The project's slug (the route param) — the back-link and the page title use it. */
	slug: string;
	projectName: string | null;
	tasks: BoardTask[];
	/** The canonical column order (the status vocabulary), shipped so the page holds no copy. */
	taskStatuses: readonly TaskStatus[];
	taskPriorities: readonly TaskPriority[];
	/**
	 * The honest sprint fact for THIS project: how many sprint rows exist, and how many of them are
	 * time-boxed. Real counts off real rows (F-008) — the page uses them to answer the operator's
	 * "how are sprints configured?" with measurements rather than an assertion.
	 */
	sprintReality: { total: number; timeBoxed: number; withTasks: 0 };
	/** Named load failure, surfaced verbatim — never a silent empty board (F-008). */
	error?: string;
}

/** Validate `project:<slug>` at the D-016 boundary; null on a malformed param. */
function boardProjectId(idParam: string): string | null {
	try {
		return assertRecordId(`project:${idParam}`);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ params, depends }): Promise<TaskBoardData> => {
	// The SAME invalidation key the project page's inline board uses, so the ONE `task` SSE watcher
	// (watched-tables.ts) re-drives this loader too — no new push channel (§5.3 / D-005).
	depends('app:tasks');

	const slug = params.id;
	const projectId = boardProjectId(slug);
	if (!projectId) throw error(404, 'invalid project id');

	const base = {
		projectId,
		slug,
		projectName: null,
		tasks: [] as BoardTask[],
		taskStatuses: TASK_STATUSES,
		taskPriorities: TASK_PRIORITIES,
		sprintReality: { total: 0, timeBoxed: 0, withTasks: 0 as const }
	};

	const db = tryGetDb();
	// DB down is a NAMED state, not an empty board: `connected:false` renders "start SurrealDB",
	// which is a different fact from "this project has no tasks" (F-008).
	if (!db) return { connected: false, ...base };

	try {
		const project = await getProject(db, projectId);
		if (!project) throw error(404, 'project not found');

		const rows = await listTasksByProject(db, projectId);

		// ── The proposer's NAME (standing operator rule 2026-07-26: a label must convey PURPOSE) ──
		// `task.proposed_by` stores `pm.id` — an opaque auto-id the naming composer will not dress up as
		// a name. The purposeful name is one FK away on the project's own `pm` row (UNIQUE project), so
		// this is a JOIN, not a fabrication: ONE read for the whole board, resolved here and shipped on
		// the wire. A project with no PM, or a PM with a blank name, resolves to NOTHING and the panel
		// says "unnamed" — which is then a TRUE statement rather than a degraded fallback.
		const names = new Map<string, string>();
		try {
			const pm = await getPm(db, projectId);
			const pmName = pm?.name?.trim();
			if (pm && pmName) names.set(pm.id, pmName);
		} catch (err) {
			// Same discipline as the sprint read below: a PM-row failure must not take the BOARD down, and
			// it is LOGGED rather than swallowed. The only consequence is that `proposed by` falls back to
			// the bare id — degraded, but never a WRONG name.
			console.warn(
				`[task-board] pm read failed for ${projectId} (best-effort; 'proposed by' falls back to the raw id): ${(err as Error).message}`
			);
		}

		// Sprint reality (see the header note): counted, never assumed. `withTasks` is the literal 0
		// because `task` carries no sprint link at all — there is no query that could return another
		// number, and stating it as a measured field keeps the page from having to assert it in prose.
		let sprints: { starts?: string; ends?: string }[] = [];
		try {
			sprints = await listSprints(db, projectId);
		} catch (err) {
			// A sprint read failure must not take the BOARD down — tasks are the subject of this page.
			// The counts stay 0, which the page renders as "none recorded" rather than a false claim.
			//
			// It is LOGGED, not swallowed: a silent best-effort catch is exactly what let the F-020
			// sweep's two live bugs sit green for months. The happy path has its own real-SurrealDB
			// assertion (`sprint reality is MEASURED`, board-loader.live.test.ts), so a developer error
			// in this read shows up as a failing test AND as a named line here — never as a quiet 0.
			console.warn(
				`[task-board] sprint read failed for ${projectId} (best-effort; the board's sprint counts read 0): ${(err as Error).message}`
			);
			sprints = [];
		}

		return {
			connected: true,
			...base,
			projectName: project.name ?? null,
			tasks: rows.map((r) => toBoardTask(r, names)),
			sprintReality: {
				total: sprints.length,
				timeBoxed: sprints.filter((s) => !!s.starts || !!s.ends).length,
				withTasks: 0
			}
		};
	} catch (err) {
		// A thrown kit error (404) is a real answer — re-throw it rather than dressing it as a
		// disconnected board.
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return { connected: false, ...base, error: (err as Error).message };
	}
};

/** Validate a posted task id: table-scoped (D-016) AND on THIS project's board. */
async function resolveBoardTask(
	db: NonNullable<ReturnType<typeof tryGetDb>>,
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
	// A task on ANOTHER project is a plain not-found: this board neither writes to it nor confirms
	// it exists. `task.project` is absent from UpdateTaskInput, so it cannot move out from under
	// this check between the read and the write.
	if (!row || row.project !== projectId) return null;
	return row;
}

export const actions: Actions = {
	/**
	 * Move a task to a new status — through `setStatus`, so the state machine decides (TB-4).
	 *
	 * This is the ONLY status-write path on this route, and it adds no promotion capability the
	 * inline board did not already have: `proposed → ready` remains reachable because
	 * `canTransition` allows it and that move IS the operator's own D-039 approval act. No automated
	 * promoter is introduced — `decidePanel` remains the only one (F-055).
	 */
	moveTask: async ({ params, request }) => {
		const projectId = boardProjectId(params.id);
		if (!projectId) return fail(400, { board: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { board: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const rawId = String(form.get('taskId') ?? '').trim();
		const to = String(form.get('to') ?? '').trim();
		if (!(TASK_STATUSES as readonly string[]).includes(to)) {
			return fail(400, { board: { error: `Unknown status "${to}".` } });
		}
		const row = await resolveBoardTask(db, projectId, rawId);
		if (!row) return fail(404, { board: { error: 'task not found on this board' } });

		try {
			const moved = await setStatus(db, row.id, to as TaskStatus);
			if (!moved) return fail(404, { board: { error: 'task not found' } });
			return { board: { ok: true as const, action: 'move' as const, taskId: row.id, to } };
		} catch (err) {
			// InvalidTransitionError is the operator asking for a move the machine forbids — a 400
			// with the machine's own named message, not a 500.
			const status = (err as Error).name === 'InvalidTransitionError' ? 400 : 500;
			return fail(status, { board: { error: (err as Error).message } });
		}
	},

	/**
	 * Set (or clear) a task's tags — the same one-column `updateTask` write the inline board uses.
	 *
	 * Parsing is UI-shaped only (split on commas, drop blanks); trimming, lower-casing, dedup and
	 * the ≤8 × ≤32 bounds all live in `normalizeTags` at the repo write chokepoint (TB-8), so this
	 * surface and the project page's cannot drift apart and an over-long tag surfaces the SAME named
	 * `InvalidTagsError` message on both.
	 */
	retagTask: async ({ params, request }) => {
		const projectId = boardProjectId(params.id);
		if (!projectId) return fail(400, { board: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { board: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const rawId = String(form.get('taskId') ?? '').trim();
		const tags = String(form.get('tags') ?? '')
			.split(',')
			.map((t) => t.trim())
			.filter((t) => t.length > 0);

		const row = await resolveBoardTask(db, projectId, rawId);
		if (!row) return fail(404, { board: { error: 'task not found on this board' } });

		try {
			const saved = await updateTask(db, row.id, { tags });
			if (!saved) return fail(404, { board: { error: 'task not found' } });
			return {
				board: {
					ok: true as const,
					action: 'retag' as const,
					taskId: row.id,
					// Read back off the row the DB actually stored — never an echo of what was typed
					// (duplicates and blanks collapse server-side).
					tagCount: (saved.tags ?? []).length
				}
			};
		} catch (err) {
			const status = (err as Error).name === 'InvalidTagsError' ? 400 : 500;
			return fail(status, { board: { error: (err as Error).message } });
		}
	},

	/**
	 * Change a task's priority (§5.5) — `updateTask({priority})`, validated against the stored enum
	 * before anything binds. Priority is genuinely mutable metadata: it is the field the operator
	 * re-judges most often as a backlog ages, and unlike `description` it is not a run seed.
	 */
	setPriority: async ({ params, request }) => {
		const projectId = boardProjectId(params.id);
		if (!projectId) return fail(400, { board: { error: 'invalid project id' } });
		const db = tryGetDb();
		if (!db) return fail(503, { board: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const rawId = String(form.get('taskId') ?? '').trim();
		const priority = String(form.get('priority') ?? '').trim();
		if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
			return fail(400, { board: { error: `Unknown priority "${priority}".` } });
		}
		const row = await resolveBoardTask(db, projectId, rawId);
		if (!row) return fail(404, { board: { error: 'task not found on this board' } });

		try {
			const saved = await updateTask(db, row.id, { priority: priority as TaskPriority });
			if (!saved) return fail(404, { board: { error: 'task not found' } });
			return {
				board: {
					ok: true as const,
					action: 'priority' as const,
					taskId: row.id,
					priority: saved.priority
				}
			};
		} catch (err) {
			return fail(500, { board: { error: (err as Error).message } });
		}
	}
};
