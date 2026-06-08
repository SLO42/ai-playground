// TASK 1.7 — v1 data importer (start) (IMPLEMENTATION-PLAN §1.7; DATA-MODEL §11
// migration map; depends on: db). Maps the v1 `registry.json` → `project` and the
// v1 task store → `task`. One-time, RE-RUNNABLE script: re-importing the same v1
// data produces NO duplicate rows.
//
// Idempotency (the §1.7 verify) is achieved via the dedup_key principle (D-008):
// every imported row lands on a DETERMINISTIC record id derived from the v1
// source's natural key, then written with `UPSERT … MERGE`. A second run targets
// the exact same ids → updates in place, never inserts a twin.
//   • project  → id `project:<slug>` (slug = the dedup key; mirrors scanner 1.1).
//   • task     → id `task:<digest>` where digest = sha256(`<projectSlug>|<v1Id>`)
//                truncated to a record-id-safe hex token. The v1 task id is unique
//                only within v1's flat store, so we namespace it by project slug to
//                avoid cross-project collisions when several v1 stores are imported.
//
// Boundary discipline (D-016): record ids are validated at the chokepoint in
// db/validate.ts BEFORE they can name a record; ALL values bind via $param — never
// interpolated. Optional fields are OMITTED, never NULL (option<T> rejects NULL —
// MEMORY-SPEC §6.1); MERGE preserves columns the importer does not own (e.g. a
// project's later-edited plan, a task's created_at default).
//
// This module is filesystem-aware only at its `importV1FromFiles` edge; the core
// `importProjects` / `importTasks` take already-parsed data so tests drive them
// with fixtures (no fake RUNTIME data reaches the DB — fixtures are inputs, F-008).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { slugify } from '../scanner/detect';
import {
	TASK_PRIORITIES,
	TASK_STATUSES,
	type TaskPriority,
	type TaskStatus
} from '../tasks/repo';

// ── v1 source shapes (a permissive read of the legacy JSON; everything optional) ─

/** A single v1 project as it appears in the legacy `registry.json`. */
export interface V1Project {
	/** v1's slug/id; when absent we derive one from `name` (or `root_path`). */
	slug?: string;
	id?: string;
	name?: string;
	/** v1 stored the on-disk path under a few different keys over its life. */
	root_path?: string;
	path?: string;
	rootPath?: string;
	ecosystem?: string[];
	build_tool?: string;
	buildTool?: string;
	test_command?: string;
	testCommand?: string;
	repo_url?: string;
	repoUrl?: string;
	status?: string;
}

/** v1's `registry.json` was either a bare array or `{ projects: [...] }`. */
export type V1Registry = V1Project[] | { projects?: V1Project[] };

/** A single v1 task from the legacy task store (`tasks.json`). */
export interface V1Task {
	id?: string;
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	createdAt?: string;
	updatedAt?: string;
}

/** v1's task store was either a bare array or `{ tasks: [...] }`. */
export type V1TaskStore = V1Task[] | { tasks?: V1Task[] };

export interface ImportCounts {
	projects: number;
	tasks: number;
}

// ── Enum mapping (v1 vocab → v2 schema ASSERT vocab, §4.2) ──────────────────────

/** Map a v1 task status onto a v2 `task.status`; unknown/absent → "backlog". */
export function mapV1Status(v1: string | undefined): TaskStatus {
	switch ((v1 ?? '').toLowerCase()) {
		case 'completed':
		case 'done':
			return 'done';
		case 'in_progress':
		case 'in-progress':
		case 'active':
			return 'in_progress';
		case 'review':
		case 'in_review':
			return 'review';
		case 'blocked':
			return 'blocked';
		case 'failed':
		case 'cancelled':
		case 'canceled':
			return 'failed';
		case 'ready':
			return 'ready';
		case 'pending':
		case 'backlog':
		case 'todo':
		default:
			return 'backlog';
	}
}

/** Map a v1 task priority onto a v2 `task.priority`; unknown/absent → "normal". */
export function mapV1Priority(v1: string | undefined): TaskPriority {
	const p = (v1 ?? '').toLowerCase();
	if (p === 'medium' || p === 'normal') return 'normal';
	if ((TASK_PRIORITIES as readonly string[]).includes(p)) return p as TaskPriority;
	return 'normal';
}

// ── Deterministic id derivation (the dedup keys) ────────────────────────────────

/** The stable project slug: v1 slug/id if usable, else slugified name, else path. */
export function projectSlugOf(p: V1Project): string {
	const raw = p.slug ?? p.id ?? p.name ?? p.root_path ?? p.path ?? p.rootPath;
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		throw new Error('v1 project has no slug, id, name, or path to derive an id from');
	}
	return slugify(String(raw));
}

/**
 * The deterministic `task:<digest>` id for a v1 task within a project. The digest
 * is sha256(`<projectSlug>|<v1TaskId>`) truncated to 32 hex chars — lowercase
 * hex is a valid record-id token (validate.ts RECORD_ID_RE) and the same inputs
 * always yield the same id, which is exactly what makes re-import a no-op.
 */
export function taskDedupId(projectSlug: string, v1TaskId: string): string {
	const digest = createHash('sha256')
		.update(`${projectSlug}|${v1TaskId}`)
		.digest('hex')
		.slice(0, 32);
	return `task:t_${digest}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

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

function asArray<T>(store: T[] | { [k: string]: T[] | undefined }, key: string): T[] {
	if (Array.isArray(store)) return store;
	const inner = (store as Record<string, unknown>)[key];
	return Array.isArray(inner) ? (inner as T[]) : [];
}

// ── Project import ──────────────────────────────────────────────────────────────

/**
 * Import v1 projects. Each lands on `project:<slug>` via UPSERT…MERGE — the slug
 * IS the dedup key, so re-running updates in place (idempotent). Returns the count
 * of projects written. `root_path` is required by the schema; when v1 lacks one we
 * fall back to the slug so the SCHEMAFULL field is satisfied without inventing a
 * fake path. Optional fields are omitted (NONE), never NULL (§6.1).
 */
export async function importProjects(db: Db, registry: V1Registry): Promise<number> {
	const projects = asArray<V1Project>(registry, 'projects');
	let n = 0;
	for (const p of projects) {
		const slug = projectSlugOf(p);
		const recordId = assertRecordId(`project:${slug}`);
		const content = omitUndefined({
			slug,
			name: p.name ?? slug,
			root_path: p.root_path ?? p.path ?? p.rootPath ?? slug,
			ecosystem: Array.isArray(p.ecosystem) ? p.ecosystem : [],
			build_tool: p.build_tool ?? p.buildTool,
			test_command: p.test_command ?? p.testCommand,
			repo_url: p.repo_url ?? p.repoUrl,
			status: p.status ?? 'active',
			updated_at: new Date()
		});
		// MERGE (not CONTENT): on a re-import this preserves created_at + any plan the
		// product edited after the first import, while refreshing what v1 owns. This is
		// the idempotent path — same id → update, never a duplicate row.
		await db.query(`UPSERT ${recordId} MERGE $content RETURN NONE;`, { content });
		n++;
	}
	return n;
}

// ── Task import ─────────────────────────────────────────────────────────────────

export interface ImportTasksOptions {
	/** The v2 `project:<slug>` id every imported task links to. */
	projectId: string;
	/** Slug used to namespace the per-task dedup id (defaults to the project slug). */
	projectSlug?: string;
}

/**
 * Import v1 tasks under a project. Each lands on its deterministic
 * `task:<digest>` id (see {@link taskDedupId}) via UPSERT…MERGE, so re-import is a
 * no-op rather than a duplicate insert. The `task` schema has no dedup_key field
 * (§4.2 uses a generated id for normal CRUD) — the importer supplies the dedup
 * *value* itself as the meaningful record id, which is the same D-008 principle.
 * `description` is required by the schema; v1 tasks without one get an empty string
 * (never NULL). Origin is "scanner" — these are machine-imported, not hand-entered.
 */
export async function importTasks(
	db: Db,
	tasks: V1TaskStore,
	opts: ImportTasksOptions
): Promise<number> {
	const projectId = assertRecordId(opts.projectId);
	const projectSlug = opts.projectSlug ?? projectId.split(':')[1] ?? projectId;
	// Bound as StringRecordId so the SDK serializes a true record link — a bare
	// string in MERGE would be rejected by the SCHEMAFULL record<project> field
	// (mirrors projects/repo.ts `link()`). Validated at the chokepoint above.
	const projectLink = new StringRecordId(projectId);
	const list = asArray<V1Task>(tasks, 'tasks');
	let n = 0;
	for (let i = 0; i < list.length; i++) {
		const t = list[i];
		// A v1 task with no id still needs a stable key: fall back to its index so two
		// runs over the same store derive the same id (positional, but deterministic).
		const v1Id = t.id != null && String(t.id).trim() !== '' ? String(t.id) : `idx_${i}`;
		const recordId = assertRecordId(taskDedupId(projectSlug, v1Id));
		const content = omitUndefined({
			project: projectLink,
			title: t.title ?? v1Id,
			description: t.description ?? '',
			status: mapV1Status(t.status),
			priority: mapV1Priority(t.priority),
			origin: 'scanner'
		});
		// MERGE onto the deterministic id: a re-import targets the same record → update
		// in place, never a duplicate. This is the idempotency the §1.7 verify checks.
		await db.query(`UPSERT ${recordId} MERGE $content RETURN NONE;`, { content });
		n++;
	}
	return n;
}

// ── File edge (the runnable script binds here) ──────────────────────────────────

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface ImportV1Options {
	/** Path to the v1 `registry.json` (projects). */
	registryPath?: string;
	/** Path to the v1 task store JSON. */
	tasksPath?: string;
	/**
	 * Which project the imported tasks link to. If omitted and the registry yields
	 * exactly one project, tasks attach to it; otherwise tasks are skipped (a flat
	 * v1 task store can't be split across multiple projects without a mapping).
	 */
	taskProjectId?: string;
}

/**
 * Read the v1 files from disk and import them in dependency order (projects first,
 * then tasks). Returns the row counts written. Re-running with the same files is a
 * no-op on row COUNT (every write is an UPSERT onto a deterministic id) — the §1.7
 * verify.
 */
export async function importV1FromFiles(db: Db, opts: ImportV1Options): Promise<ImportCounts> {
	let projects = 0;
	let tasks = 0;
	let soleProjectId: string | undefined;

	if (opts.registryPath) {
		const registry = readJson<V1Registry>(opts.registryPath);
		projects = await importProjects(db, registry);
		const list = asArray<V1Project>(registry, 'projects');
		if (list.length === 1) soleProjectId = `project:${projectSlugOf(list[0])}`;
	}

	const taskProjectId = opts.taskProjectId ?? soleProjectId;
	if (opts.tasksPath && taskProjectId) {
		const store = readJson<V1TaskStore>(opts.tasksPath);
		tasks = await importTasks(db, store, { projectId: taskProjectId });
	}

	return { projects, tasks };
}

export { TASK_STATUSES, str };
