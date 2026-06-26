// TASK 1.3 — task CRUD + status machine (ARCHITECTURE §2/§3; DATA-MODEL §4.2;
// depends on: db, events).
//
// DB-backed CRUD for the `task` table plus the status STATE MACHINE that guards
// every status transition. A `task` status change is the PRIMARY orchestrator
// trigger (DATA-MODEL §4.2): the SurrealDB live query on `task` — owned by the
// events module's watchTable (ARCHITECTURE §2.11) — republishes the row change
// onto the one `events` bus. This module does NOT open its own live query; the
// trigger.test.ts proves a transition emits EXACTLY ONE bus event via that path.
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated.
// The ONLY interpolated tokens are record ids, validated at the chokepoint in
// db/validate.ts FIRST (wrapped as StringRecordId so the SDK serializes a true
// record link). Optional fields are OMITTED, never set to an explicit NULL
// (option<T> rejects NULL — MEMORY-SPEC §6.1); MERGE preserves untouched columns.
//
// D-008: the stored task `description` is NEVER mutated in place — there is no
// updateDescription path. Context for a run is passed as separate fields by the
// orchestrator, never folded back into the persisted task (DECISIONS §D-008).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { closeOpenPanelVerdictsForArtifact } from '../workforce/repo';

// ── Enums (DATA-MODEL §4.2 ASSERTs — kept in lock-step with the schema) ─────────

/** Allowed `task.status` values (schema ASSERT, §4.2 + TASK 16.4 / PM-SPEC §4:
 *  `proposed` is the BORN-ONLY state of PM-created tasks — nothing transitions INTO
 *  it; `withdrawn` is the terminal exit of the propose/revise/withdraw loop). */
export const TASK_STATUSES = [
	'proposed',
	'backlog',
	'ready',
	'in_progress',
	'review',
	'blocked',
	'done',
	'failed',
	'withdrawn'
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Allowed `task.priority` values (schema ASSERT, §4.2). */
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Allowed `task.origin` values (schema ASSERT, §4.2 + 'pm' for TASK 16.4 / D-039). */
export const TASK_ORIGINS = ['manual', 'scanner', 'follow_up', 'review', 'release', 'pm'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

// ── Status state machine ────────────────────────────────────────────────────
//
// The enum lives in the schema ASSERT; the *legal transitions between* enum
// values live HERE (a DB enum can't express "ready→in_progress ok, done→ready
// not"). `done` and `failed` are terminal — a finished task does not silently
// reopen; rework spawns a NEW follow-up task (origin "follow_up", §4.2) so the
// audit trail and the immutable description (D-008) are preserved.

/** For each status, the set of statuses it may transition TO. */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	// TASK 16.4 (PM-SPEC §4): a proposal leaves `proposed` ONLY via panel approval /
	// operator decision (→ ready) or the PM revise/withdraw loop (→ withdrawn).
	// Nothing transitions INTO `proposed` — PM-created tasks are BORN there.
	proposed: ['ready', 'withdrawn'],
	backlog: ['ready', 'blocked', 'failed'],
	ready: ['in_progress', 'blocked', 'backlog', 'failed'],
	in_progress: ['review', 'blocked', 'done', 'failed'],
	review: ['done', 'in_progress', 'blocked', 'failed'],
	blocked: ['ready', 'in_progress', 'backlog', 'failed'],
	done: [], // terminal
	failed: [], // terminal
	withdrawn: [] // terminal (PM withdrew / revision superseded the proposal)
};

/** True if `from → to` is a legal status transition (identity is a no-op, not a move). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The statuses a task in `from` may legally move to (excludes `from` itself). */
export function nextStatuses(from: TaskStatus): readonly TaskStatus[] {
	return ALLOWED_TRANSITIONS[from] ?? [];
}

/** Thrown when a status transition is rejected by the state machine. */
export class InvalidTransitionError extends Error {
	constructor(
		readonly from: TaskStatus,
		readonly to: TaskStatus
	) {
		super(`illegal task status transition: ${from} → ${to}`);
		this.name = 'InvalidTransitionError';
	}
}

function isTaskStatus(v: unknown): v is TaskStatus {
	return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

// ── Row + input shapes ─────────────────────────────────────────────────────────

/** Trigger provenance carried on a PM-proposed task (PM-SPEC §4.1 — which trigger/
 *  evidence produced it; the same honest shape pm_review.provenance carries). */
export interface TaskProvenance {
	kind: string;
	evidence: string[];
	authority?: string;
	detail?: Record<string, unknown>;
}

/** A persisted `task` row (SDK RecordId/Date coerced to plain strings). */
export interface TaskRow {
	id: string;
	project: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: TaskPriority;
	origin: TaskOrigin;
	/** Follow-ups link to their parent task; absent (NONE) for top-level tasks. */
	parent?: string;
	// ── TASK 16.4 — Act-with-Purpose artifact fields (PM-SPEC §4.1; absent on
	//    non-proposal tasks — an honest absence, never ''). ──────────────────────
	objective?: string;
	purpose?: string;
	acceptance_criteria?: string[];
	provenance?: TaskProvenance;
	proposed_by?: string;
	revision_of?: string;
	superseded_by?: string;
	proposal_fingerprint?: string;
	created_at: string;
	updated_at: string;
}

export interface CreateTaskInput {
	project: string;
	title: string;
	description: string;
	priority?: TaskPriority;
	origin?: TaskOrigin;
	/** Parent task id — set for follow-ups (origin "follow_up"). */
	parent?: string;
	/** Initial status; defaults to the schema DEFAULT ("backlog") when omitted. */
	status?: TaskStatus;
	// ── TASK 16.4 — proposal fields. ONLY the pm-proposals chokepoint sets these
	//    (it enforces the §4.1 contract); they pass through here unchanged. ───────
	objective?: string;
	purpose?: string;
	acceptance_criteria?: string[];
	provenance?: TaskProvenance;
	proposed_by?: string;
	revision_of?: string;
	proposal_fingerprint?: string;
}

/** Mutable task columns. `description` is intentionally absent (D-008 — immutable). */
export interface UpdateTaskInput {
	title?: string;
	priority?: TaskPriority;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function str(v: unknown): string {
	return String(v);
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function normTask(
	row: TaskRow & {
		id: unknown;
		project: unknown;
		parent?: unknown;
		proposed_by?: unknown;
		revision_of?: unknown;
		superseded_by?: unknown;
	}
): TaskRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		parent: row.parent != null ? str(row.parent) : undefined,
		// TASK 16.4 — proposal links → plain strings; absent stays absent (honest).
		proposed_by: row.proposed_by != null ? str(row.proposed_by) : undefined,
		revision_of: row.revision_of != null ? str(row.revision_of) : undefined,
		superseded_by: row.superseded_by != null ? str(row.superseded_by) : undefined,
		created_at: str(row.created_at),
		updated_at: str(row.updated_at)
	};
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Create a `task` row with a generated id. The `project` link and optional
 * `parent` link are validated (D-016) and bound as record links; all values bind
 * via $param. Absent optionals are omitted, not nulled (§6.1). The schema fills
 * status="backlog", priority="normal", origin="manual" when not supplied.
 */
export async function createTask(db: Db, input: CreateTaskInput): Promise<TaskRow> {
	if (input.status !== undefined && !isTaskStatus(input.status)) {
		throw new Error(`invalid task status: ${String(input.status)}`);
	}
	const content = omitUndefined({
		project: link(input.project),
		title: input.title,
		description: input.description,
		priority: input.priority,
		origin: input.origin,
		parent: input.parent ? link(input.parent) : undefined,
		status: input.status,
		// TASK 16.4 — Act-with-Purpose fields (set only via the pm-proposals chokepoint;
		// absent fields are OMITTED so option<T> stays NONE, §6.1).
		objective: input.objective,
		purpose: input.purpose,
		acceptance_criteria: input.acceptance_criteria,
		provenance: input.provenance,
		proposed_by: input.proposed_by ? link(input.proposed_by) : undefined,
		revision_of: input.revision_of ? link(input.revision_of) : undefined,
		proposal_fingerprint: input.proposal_fingerprint
	});
	const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
		`CREATE task CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normTask(rows[0]);
}

export async function getTask(db: Db, id: string): Promise<TaskRow | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM $rid;`,
		{ rid }
	);
	return rows.length ? normTask(rows[0]) : null;
}

/** All tasks, newest first. */
export async function listTasks(db: Db): Promise<TaskRow[]> {
	const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM task ORDER BY created_at DESC;`
	);
	return rows.map(normTask);
}

/** Tasks for one project, optionally filtered by status — uses §4.2 indexes. */
export async function listTasksByProject(
	db: Db,
	projectId: string,
	status?: TaskStatus
): Promise<TaskRow[]> {
	const project = link(projectId);
	if (status !== undefined) {
		if (!isTaskStatus(status)) throw new Error(`invalid task status: ${String(status)}`);
		const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
			`SELECT * FROM task WHERE project = $project AND status = $status ORDER BY created_at DESC;`,
			{ project, status }
		);
		return rows.map(normTask);
	}
	const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
		`SELECT * FROM task WHERE project = $project ORDER BY created_at DESC;`,
		{ project }
	);
	return rows.map(normTask);
}

/**
 * Update mutable task columns (title/priority). `description` is NOT updatable by
 * design (D-008 — never mutate the stored description in place) and `status` moves
 * ONLY through {@link setStatus} so every transition passes the state machine.
 * Touches `updated_at`. MERGE preserves untouched columns.
 */
export async function updateTask(
	db: Db,
	id: string,
	patch: UpdateTaskInput
): Promise<TaskRow | null> {
	if (patch.priority !== undefined && !TASK_PRIORITIES.includes(patch.priority)) {
		throw new Error(`invalid task priority: ${String(patch.priority)}`);
	}
	const rid = new StringRecordId(assertRecordId(id));
	const content = omitUndefined({ ...patch, updated_at: new Date() });
	const [rows] = await db.query<[(TaskRow & { id: unknown; project: unknown })[]]>(
		`UPDATE $rid MERGE $content RETURN AFTER;`,
		{ rid, content }
	);
	return rows.length ? normTask(rows[0]) : null;
}

export async function deleteTask(db: Db, id: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[unknown[]]>(`DELETE $rid RETURN BEFORE;`, { rid });
	return rows.length > 0;
}

// ── Status machine write ────────────────────────────────────────────────────

/**
 * Transition a task to `to`, enforcing the {@link canTransition} state machine.
 *
 * Read-then-write is done in ONE transaction so the guard and the write can't be
 * split by a concurrent transition (D-008 — kill the v1 TOCTOU class). The
 * `THROW` inside the transaction makes an illegal transition (or missing task)
 * roll back with no write — so no `db_change` fires for a rejected move, which is
 * exactly what the trigger test asserts (one transition ⇒ one event).
 *
 * On success the single UPDATE is what the live query observes; the events module
 * republishes it onto the bus EXACTLY ONCE (ARCHITECTURE §2.11) — this function
 * never publishes directly.
 *
 * @throws InvalidTransitionError if `to` is not reachable from the current status.
 * @throws Error if the task does not exist.
 * @returns the updated row, or `null` only if the row vanished between writes.
 */
export async function setStatus(db: Db, id: string, to: TaskStatus): Promise<TaskRow | null> {
	if (!isTaskStatus(to)) throw new Error(`invalid task status: ${String(to)}`);

	// Pre-read the current status to produce a precise, typed error BEFORE issuing
	// the guarded transaction (the transaction is the authoritative guard; this is
	// the friendly-error fast path).
	const current = await getTask(db, id);
	if (!current) throw new Error(`task not found: ${id}`);
	if (current.status === to) {
		// Identity is a no-op, never a transition — do not touch the row, so no
		// spurious db_change fires. Return the row unchanged.
		//
		// 16.4 fix (interrupt contract): EXCEPT that the §2.2 upheld-on-done closure
		// below runs AFTER the committed transition — a crash in that window leaves
		// open panel verdicts on a done task, and this early-return previously made
		// the closure unreachable forever (no caller path ever re-reached it). Re-run
		// the closure on the identity-done path so a re-issued setStatus(id,'done')
		// converges: already-closed rows absorb (closePanelVerdictOutcome no-ops on
		// the same outcome), tasks that never met a panel close zero rows.
		if (to === 'done') {
			await closeOpenPanelVerdictsForArtifact(db, current.id, 'upheld');
		}
		return current;
	}
	if (!canTransition(current.status, to)) {
		throw new InvalidTransitionError(current.status, to);
	}

	const rid = new StringRecordId(assertRecordId(id));
	// Atomic guard-and-write (D-008 — kill the v1 TOCTOU class): the LEGALITY of the
	// transition is decided in JS above (canTransition); the transaction enforces the
	// RACE guard — the row's status must still equal the `from` we read, else a
	// concurrent transition moved it and we THROW (rolling back, no write). Because a
	// rejected transition writes nothing, no `db_change` fires for it.
	// SurrealDB 2.x flow control uses block form: `IF $cond { ... };` + `THROW <expr>`.
	// The trailing `RETURN` is the statement result we read back.
	const surql = `
		BEGIN TRANSACTION;
		LET $cur = (SELECT VALUE status FROM ONLY $rid);
		IF $cur = NONE { THROW "task not found"; };
		IF $cur != $from { THROW "concurrent task status transition"; };
		UPDATE $rid SET status = $to, updated_at = time::now();
		RETURN (SELECT * FROM ONLY $rid);
		COMMIT TRANSACTION;
	`;
	const result = await db.query<unknown[]>(surql, {
		rid,
		to,
		from: current.status
	});
	const row = result[result.length - 1] as
		| (TaskRow & { id: unknown; project: unknown })
		| null;

	// TASK 16.4 — §2.2 mechanical outcome closure (WORKFORCE-SPEC, harness-only,
	// D-035): a task reaching its terminal DONE state — unmodified, since the §4.1
	// artifact fields are immutable after creation (D-008) — closes every still-open
	// panel verdict on it as 'upheld'. setStatus is the single transition chokepoint,
	// so this cannot be bypassed; tasks that never met a panel close zero rows.
	if (row && to === 'done') {
		await closeOpenPanelVerdictsForArtifact(db, str(row.id), 'upheld');
	}
	return row ? normTask(row) : null;
}

/**
 * CRASH-RECOVERY ONLY — reset a task wedged `in_progress`/`review` by a DEAD session back to
 * `ready` so the orchestrator drain re-drives it (the F-048 follow-on; called by reaper.ts).
 *
 * This DELIBERATELY bypasses {@link setStatus}'s state machine — and is the documented EXCEPTION
 * to the "status moves ONLY through setStatus" invariant above. ALLOWED_TRANSITIONS forbids
 * `in_progress→ready` and `review→ready` ON PURPOSE: in normal flow you never "un-start" work
 * (that would discard a real in-flight run). But a session reaped at boot leaves its task stranded
 * mid-flight with NO live worker — recovery to ready is exactly the move the normal machine refuses,
 * and there is no legal multi-hop path back to ready from in_progress/review either. So recovery
 * uses a NARROW, record-targeted UPDATE guarded to ONLY the two orphaned-by-crash pre-states.
 *
 * GUARD (`WHERE status IN ["in_progress","review"]`): a task that already advanced (done/failed),
 * was never started (proposed/backlog/ready), or was parked (blocked/withdrawn) is left UNTOUCHED —
 * we never clobber a task that moved on or that the operator/PM deliberately parked. Idempotent
 * (interrupt contract): once the task is `ready` a re-run matches nothing and moves zero rows.
 * Touches `updated_at` so the live query / PM observes the recovery. Returns whether a row moved.
 */
export async function resetStuckTaskToReady(db: Db, taskId: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(taskId));
	// RETURN BEFORE yields the rows that matched the guarded WHERE (the count of tasks reset).
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE $rid SET status = "ready", updated_at = time::now()
		   WHERE status IN ["in_progress", "review"] RETURN BEFORE;`,
		{ rid }
	);
	return rows.length > 0;
}
