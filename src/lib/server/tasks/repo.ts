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
import { assertRecordId, assertRecordIdOfTable } from '../db/validate';
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
	// ── TASK-BOARD-SPEC §4.2 (m0087) — operator-authored tags. Absent (NONE) when the
	//    operator never set any: an honest absence, never `[]` claiming "considered, chose
	//    none". Normalized at the write chokepoint (see normalizeTags), so a row that came
	//    back from the DB is already trimmed/lowercased/deduped/bounded. ─────────────────
	tags?: string[];
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
	/** TASK-BOARD-SPEC §4.2 — operator-authored tags; normalized + bounded by
	 *  {@link normalizeTags}. Omitted when absent so the column stays NONE (§6.1). */
	tags?: string[];
}

/** Mutable task columns. `description` is intentionally absent (D-008 — immutable). */
export interface UpdateTaskInput {
	title?: string;
	priority?: TaskPriority;
	/** TASK-BOARD-SPEC §4.2 — tags ARE mutable metadata (unlike `description`, D-008): the whole
	 *  point of a tag is that the operator refines it as they learn how a task should be handled.
	 *  Passing `[]` CLEARS the column back to an honest absence; omitting the key leaves it. */
	tags?: string[];
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

// ── Tags (TASK-BOARD-SPEC §4.2 / TB-8) ────────────────────────────────────────
//
// Tags exist to REMIND THE EXECUTING MODEL how to handle a task (the operator's 2026-07-26
// ask), so they are prompt payload, not decoration: `launch.ts` selects them and
// `buildTaskBrief` renders them into the prompt's `## Task metadata` line. That is exactly why
// the bounds below are enforced at the WRITE chokepoint rather than left to the UI — a tag list
// that grows unbounded is a prompt-budget leak, and one that varies only by case or whitespace
// ("Infra", "infra ") reads to a model as two different reminders.

/** Most tags one task may carry — bounded because every tag lands in the model's prompt. */
export const MAX_TASK_TAGS = 8;
/** Longest single tag — a tag is a label, not a sentence (sentences belong in `purpose`). */
export const MAX_TASK_TAG_LENGTH = 32;

/**
 * Thrown when a tag list cannot be normalized into the bounded shape above.
 *
 * NAMED, not a generic Error (and never a silent truncation): the operator typed something the
 * system will not store, and the honest outcome is a message saying which value and which bound —
 * the form action surfaces `.message` verbatim.
 */
export class InvalidTagsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidTagsError';
	}
}

/**
 * Normalize an operator-supplied tag list into the stored shape, or throw {@link InvalidTagsError}.
 *
 * NORMALIZED (silently, because the operator's intent is unambiguous): each tag is trimmed and
 * lowercased, INTERIOR whitespace runs collapse to a single space, blank/whitespace-only entries
 * are dropped, and duplicates collapse to the first occurrence (order preserved — the operator's
 * ordering is meaningful in a prompt line).
 *
 * The whitespace collapse is not cosmetic. A tag is rendered INTO the prompt's one-line
 * `## Task metadata` fragment, where a `##` mid-line is inert — but a NEWLINE inside a tag would
 * put whatever follows it at the start of a line, which is exactly where markdown block
 * constructs become real. Collapsing here removes that class at the write boundary; the prompt
 * layer's `escapeBriefText` still covers it independently (defence in depth — a legacy row, or a
 * writer that predates this function, never passed through here).
 *
 * REJECTED (loudly, because dropping the value would lose the operator's intent): a non-array,
 * a non-string entry, a tag over {@link MAX_TASK_TAG_LENGTH} chars, or more than
 * {@link MAX_TASK_TAGS} distinct tags. Truncating instead would store something the operator did
 * not write and put it in a prompt an autonomous agent acts on (F-008).
 *
 * Shadow paths: `[]` and an all-blank list both yield `[]`, which callers treat as "no tags" —
 * an honest absence on create, and an explicit CLEAR on update.
 */
export function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new InvalidTagsError(`task tags must be an array of strings, got ${typeof value}`);
	}
	const out: string[] = [];
	for (const raw of value) {
		if (typeof raw !== 'string') {
			throw new InvalidTagsError(`task tag must be a string, got ${typeof raw}`);
		}
		const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ');
		if (!tag) continue; // a blank entry is nothing to say, not an error
		if (tag.length > MAX_TASK_TAG_LENGTH) {
			throw new InvalidTagsError(
				`task tag "${tag.slice(0, MAX_TASK_TAG_LENGTH)}…" exceeds ${MAX_TASK_TAG_LENGTH} characters`
			);
		}
		if (!out.includes(tag)) {
			out.push(tag);
			// The count bound is an INVARIANT held DURING the scan, not a post-condition on the
			// finished result. Checked after the loop it bounded nothing: the O(n²) `includes`
			// dedup ran over the whole unbounded input first, so a 60 000-entry list burned
			// ~2.5s of the event loop — the same loop that hosts the orchestrator drain and the
			// SSE stream — before rejecting (CLAUDE.md §3, "no blocking hangs"). Bailing HERE
			// caps `out` at MAX_TASK_TAGS + 1, which makes each `includes` O(1)-ish and the
			// whole refusal linear in the input rather than quadratic.
			//
			// "at least" is deliberate and not hedging: we stop counting at the bail, so a total
			// would be a number we never measured (F-008 — an honest bound, not a plausible one).
			if (out.length > MAX_TASK_TAGS) {
				throw new InvalidTagsError(
					`a task may carry at most ${MAX_TASK_TAGS} tags, got at least ${out.length}`
				);
			}
		}
	}
	return out;
}

/**
 * Read-side coercion for the `tags` column (the normalizer's counterpart).
 *
 * A row written before m0087, or by a path that bypassed {@link normalizeTags}, must never reach a
 * caller as `String(undefined)` or as a fabricated `[]` (F-013/F-008). Anything that is not a
 * non-empty array of non-blank strings reads as an honest ABSENCE — the same convention `parent`
 * and the proposal links already follow in this module.
 */
function normTagsRead(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tags = value.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
	return tags.length ? tags : undefined;
}

function normTask(
	row: TaskRow & {
		id: unknown;
		project: unknown;
		parent?: unknown;
		proposed_by?: unknown;
		revision_of?: unknown;
		superseded_by?: unknown;
		tags?: unknown;
	}
): TaskRow {
	return {
		...row,
		id: str(row.id),
		// TASK-BOARD-SPEC §4.2 — tags read back as a plain string array; absent/blank/garbage
		// reads as an honest absence, never `[]` and never the literal "undefined" (F-013).
		tags: normTagsRead(row.tags),
		project: str(row.project),
		parent: row.parent != null ? str(row.parent) : undefined,
		// TASK 16.4 — proposal links → plain strings; absent stays absent (honest).
		proposed_by: row.proposed_by != null ? str(row.proposed_by) : undefined,
		revision_of: row.revision_of != null ? str(row.revision_of) : undefined,
		superseded_by: row.superseded_by != null ? str(row.superseded_by) : undefined,
		// F-013: created_at/updated_at are SAFE to str() because they carry non-NONE DEFAULTs
		// in the schema — they are always present. For any new OPTIONAL datetime field on task,
		// MUST use the isoOrUndef pattern from projects/repo.ts (imports there, not here).
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
	// TB-8 — tags are validated at THIS chokepoint (D-016), before any value is bound. A list
	// that normalizes to empty is OMITTED, so the column stays NONE (§6.1): a task created
	// without tags is honestly untagged, not tagged with nothing.
	const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
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
		proposal_fingerprint: input.proposal_fingerprint,
		tags: tags?.length ? tags : undefined
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
 *
 * The id is TABLE-SCOPED (`assertRecordIdOfTable`, not the shape-only `assertRecordId`): this
 * function ends in a bare `UPDATE $rid MERGE`, which writes to whatever table the id names. The
 * generic guard accepts any well-formed `table:id`, so a caller that forwarded an unvalidated
 * operator-supplied id would silently MERGE onto `project`/`memory` (both carry a `tags` column)
 * and get a row back as if it had succeeded. A function called `updateTask` may only ever write a
 * `task`, and that is enforced HERE so no future caller has to remember it.
 */
export async function updateTask(
	db: Db,
	id: string,
	patch: UpdateTaskInput
): Promise<TaskRow | null> {
	if (patch.priority !== undefined && !TASK_PRIORITIES.includes(patch.priority)) {
		throw new Error(`invalid task priority: ${String(patch.priority)}`);
	}
	// TB-8 — same write chokepoint as createTask; throws InvalidTagsError before anything binds.
	const tags = patch.tags === undefined ? undefined : normalizeTags(patch.tags);
	const rid = new StringRecordId(assertRecordIdOfTable(id, 'task'));
	const content = omitUndefined({ ...patch, tags, updated_at: new Date() });
	// CLEARING tags needs UNSET, not MERGE. MERGE with `[]` would STORE an empty array — a second
	// representation of "no tags" that then has to be special-cased on every read. `option<T>`
	// also rejects an explicit NULL (§6.1), and NONE cannot be bound as a $param from JS, so the
	// clear is expressed as its own statement. Both statements run in ONE transaction so a task
	// can never be observed with its old tags removed but its title/priority patch not applied
	// (the interrupt contract). The MERGE is last, so its rows are the last statement result.
	const clearTags = tags !== undefined && tags.length === 0;
	if (clearTags) delete (content as { tags?: unknown }).tags;
	const surql = clearTags
		? `BEGIN TRANSACTION;
			UPDATE $rid UNSET tags;
			UPDATE $rid MERGE $content RETURN AFTER;
			COMMIT TRANSACTION;`
		: `UPDATE $rid MERGE $content RETURN AFTER;`;
	const results = await db.query<unknown[]>(surql, { rid, content });
	const rows = (results[results.length - 1] ?? []) as (TaskRow & {
		id: unknown;
		project: unknown;
	})[];
	return rows.length ? normTask(rows[0]) : null;
}

/**
 * Delete a task. TABLE-SCOPED for the same reason as {@link updateTask}/{@link setStatus}, and
 * most urgently of the three: the statement is a bare `DELETE $rid`, so under the shape-only
 * guard any well-formed `table:id` would delete that row — from ANY table, with no enum or state
 * machine standing in the way. No caller reaches this with an operator-supplied id today; the
 * guard is here so none ever can.
 */
export async function deleteTask(db: Db, id: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordIdOfTable(id, 'task'));
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

	// TABLE-SCOPED (`assertRecordIdOfTable`, not the shape-only `assertRecordId`) for exactly the
	// reason `updateTask` is: this function ends in a bare `UPDATE $rid SET status`, which writes
	// to whatever table the id names. The state machine below does NOT make up the difference —
	// `canTransition` only asks whether the row's CURRENT status string is a key of
	// ALLOWED_TRANSITIONS with `to` in its list, so EVERY table whose status enum overlaps the
	// task enum was reachable through a well-formed foreign id: `phase` and `feature` sit in
	// 'in_progress' and their own ASSERT admits 'done'; a 'proposed' `review_proposal` admits
	// 'withdrawn'. Those writes committed and returned a row, so the caller was told the move
	// succeeded. (`project` happened to be safe — its enum is disjoint — which is why the hole
	// read as covered.) A `setStatus` in the task repo may only ever move a `task`, and that is
	// enforced HERE so no caller, present or future, has to remember it.
	//
	// The guard runs BEFORE the pre-read, so a foreign id is refused without reading the row at
	// all — no foreign row is normalized as a task, and the identity-'done' branch below (which
	// writes, via closeOpenPanelVerdictsForArtifact) can never fire against a non-task artifact.
	const taskId = assertRecordIdOfTable(id, 'task');

	// Pre-read the current status to produce a precise, typed error BEFORE issuing
	// the guarded transaction (the transaction is the authoritative guard; this is
	// the friendly-error fast path).
	const current = await getTask(db, taskId);
	if (!current) throw new Error(`task not found: ${taskId}`);
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

	const rid = new StringRecordId(taskId);
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

/**
 * SPAWN/ROUTE-FAILURE TERMINAL — drive a task wedged `in_progress`/`review` by a FAILED
 * `task_run` spawn (the route resolve threw, or launchSession failed) to the honest terminal
 * `failed`, instead of stranding it `in_progress` until the next boot reaper (the BL-R2 gap
 * named by the BL-R1 red-team). `task_run` work_items carry NO `session`, so BL-R1's
 * `releaseSessionWork` cannot reach this task — the orchestrator drain calls this directly
 * after the work_item is marked failed.
 *
 * Unlike {@link resetStuckTaskToReady}, `in_progress→failed` and `review→failed` ARE legal
 * moves in ALLOWED_TRANSITIONS — so this is NOT a state-machine bypass; the guarded UPDATE is
 * used (instead of {@link setStatus}) purely for IDEMPOTENCE: it mirrors post-task's own
 * terminal-failed write (post-task.ts:306 `IF $cur IN ["in_progress","review"]`) so the two
 * failure paths land the same way, and a re-run / concurrent post-task move never throws.
 *
 * We PREFER `failed` over `ready` deliberately: there is NO bounded task-level retry mechanism
 * for `task_run` (the work_item `attempts` field counts only lost-claim-race retries inside
 * claimNext — workqueue.ts:221 — not spawn re-drives), so resetting to `ready` would re-drain
 * the same task into the same spawn failure forever. `failed` is the honest terminal; rework
 * spawns a NEW follow-up task (origin "follow_up", §4.2) preserving the audit trail.
 *
 * GUARD (`WHERE status IN ["in_progress","review"]`): a task that already advanced (done/failed
 * — e.g. post-task already wrote the terminal on the spawn-returned-failed path), was never
 * started, or was parked is left UNTOUCHED. Idempotent (interrupt contract): once `failed`, a
 * re-run matches nothing and moves zero rows. Touches `updated_at` so the live query / PM
 * observes the terminal. Returns whether a row moved.
 */
export async function resetStuckTaskToFailed(db: Db, taskId: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(taskId));
	// RETURN BEFORE yields the rows that matched the guarded WHERE (the count of tasks failed).
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE $rid SET status = "failed", updated_at = time::now()
		   WHERE status IN ["in_progress", "review"] RETURN BEFORE;`,
		{ rid }
	);
	return rows.length > 0;
}

/**
 * BL-R3 (success-side twin) — drive a task stranded `in_progress`/`review` to the terminal `done`.
 *
 * The SYMMETRIC counterpart of {@link resetStuckTaskToFailed}. A SUCCESSFUL `task_run` whose
 * orchestrator ran WITHOUT the post-task loop (the degenerate constructor default — production
 * ALWAYS enables it) has NO terminal writer: post-task is the only path that writes a task's `done`,
 * and the failed-writer only fires on a NON-ok terminal. So an ok spawn with post-task disabled would
 * otherwise leave the task pinned `in_progress` forever with no live worker — the invisible half-state
 * F-048 class (a success-side mirror of BL-R2's failed-side strand). The orchestrator calls this on
 * that exact path so the honest terminal (the session succeeded) is recorded.
 *
 * `in_progress→done` and `review→done` ARE legal in ALLOWED_TRANSITIONS — so this is NOT a
 * state-machine bypass; the guarded UPDATE is used (instead of {@link setStatus}) purely for
 * IDEMPOTENCE: it mirrors post-task's own terminal write (`IF $cur IN ["in_progress","review"]`) so
 * a re-run / a task that already advanced (post-task raced it, an operator move) matches nothing and
 * moves zero rows — never a throw. Touches `updated_at` so the live query / PM observes the terminal.
 * Returns whether a row moved.
 */
export async function resetStuckTaskToDone(db: Db, taskId: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(taskId));
	// RETURN BEFORE yields the rows that matched the guarded WHERE (the count of tasks advanced).
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE $rid SET status = "done", updated_at = time::now()
		   WHERE status IN ["in_progress", "review"] RETURN BEFORE;`,
		{ rid }
	);
	return rows.length > 0;
}

/**
 * BL-R4 — OPERATOR-MANUAL RE-RUN ONLY. Reopen a task the operator DELIBERATELY chooses to re-run from
 * the terminal `failed` back to `ready`, so the orchestrator drain can re-drive it. A narrow,
 * record-targeted UPDATE that DELIBERATELY bypasses {@link setStatus}'s state machine — modeled on
 * {@link resetStuckTaskToReady}, but guarded to the `failed` pre-state instead of in_progress/review.
 *
 * ALLOWED_TRANSITIONS makes `failed` TERMINAL on purpose: a finished task does not silently reopen, and
 * there is no legal multi-hop path back to `ready` from `failed` (this is exactly the move the normal
 * machine refuses). So the re-run uses this guarded UPDATE, mirroring the RH-1 recovery pattern.
 *
 * CRITICAL — OPERATOR CONTROL-PLANE AUTHORITY ONLY (D-025/D-035a). This function MUST be reached ONLY
 * from an operator-gated control-plane action (project-controls.restartSessionTask under
 * `operatorAuthority`). It MUST NOT be called from the auto-drain / boot reaper / gcStale / any
 * unattended path. RH-1 INVARIANT (DO NOT REGRESS): the AUTO recovery path deliberately lands failed
 * work on `failed`, NEVER `ready` — because there is NO bounded task-level retry, so `ready` would
 * re-drain into the SAME failure forever (a spin). The reaper uses {@link resetStuckTaskToReady} (guarded
 * to in_progress/review — it never touches `failed`) and {@link resetStuckTaskToFailed} (which LANDS
 * `failed`); neither reopens a failed task. The OPERATOR making the re-run decision IS the bounded-retry
 * mechanism the auto path lacks — that human authority is the whole reason a failed→ready reopen is safe
 * here and unsafe automatically.
 *
 * GUARD (`WHERE status = "failed"`): a task in ANY other status is left UNTOUCHED — we never reopen a
 * done/in_progress/review/ready/backlog/blocked/proposed/withdrawn task (that would be fabricated rework
 * or a double-run). Idempotent (interrupt contract): once `ready`, a re-run matches nothing and moves
 * zero rows — no throw. Touches `updated_at` so the live query / PM observes the reopen. Returns whether
 * a row moved.
 */
export async function reopenFailedTaskToReady(db: Db, taskId: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(taskId));
	// RETURN BEFORE yields the rows that matched the guarded WHERE (the count of failed tasks reopened).
	const [rows] = await db.query<[unknown[]]>(
		`UPDATE $rid SET status = "ready", updated_at = time::now()
		   WHERE status = "failed" RETURN BEFORE;`,
		{ rid }
	);
	return rows.length > 0;
}
