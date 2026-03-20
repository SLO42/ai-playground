/**
 * SQLite-backed task store using better-sqlite3.
 *
 * Drop-in replacement for the JSON-based task-store.ts with the same API shape
 * but backed by a per-project .playground/tasks.db SQLite database.
 */
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync, readFileSync } from 'fs';
import crypto from 'crypto';
import type { Task, TaskStatus, TaskPriority } from '$lib/types/tasks.js';
import { emit } from './event-bus.js';
import { recordEvent } from './heartbeat/agent-analytics.js';

// Re-export routing functions from the original task-store
export { routeTask, autoAssignTask } from './task-store.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Lightweight index entry returned by listTasks (matches TaskIndexEntry shape). */
export interface TaskIndexEntry {
	id: string;
	title: string;
	status: TaskStatus;
	priority: TaskPriority;
	assignee: string | null;
	tags: string[];
	feature: string | null;
	createdBy: string;
	updatedAt: string;
	completedAt: string | null;
	flagDiscussion: boolean;
	bucket: 'backlog' | 'completed' | 'archived';
}

interface TaskRow {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	flag_discussion: number;
	assignee: string | null;
	tags: string;
	feature: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	blocked_by: string | null;
	sprint_id: string | null;
	plan_task_id: string | null;
}

// ── DB handle cache ────────────────────────────────────────────────────

const dbCache = new Map<string, Database.Database>();

function dbPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'tasks.db');
}

function sanitizeId(id: string): void {
	if (/[/\\]|\.\./.test(id)) throw new Error(`Invalid task ID: ${id}`);
}

export function getDb(projectPath: string): Database.Database {
	const path = dbPath(projectPath);
	const cached = dbCache.get(path);
	if (cached) return cached;

	mkdirSync(resolve(projectPath, '.playground'), { recursive: true });

	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	db.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			priority TEXT NOT NULL DEFAULT 'medium',
			flag_discussion INTEGER NOT NULL DEFAULT 0,
			assignee TEXT,
			tags TEXT NOT NULL DEFAULT '[]',
			feature TEXT,
			created_by TEXT NOT NULL DEFAULT 'user',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			blocked_by TEXT,
			sprint_id TEXT,
			plan_task_id TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
		CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
		CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature);
		CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
	`);

	dbCache.set(path, db);
	return db;
}

/** Close a project's DB handle. */
export function closeDb(projectPath: string): void {
	const path = dbPath(projectPath);
	const db = dbCache.get(path);
	if (db) {
		db.close();
		dbCache.delete(path);
	}
}

// ── Row ↔ Task mapping ────────────────────────────────────────────────

function rowToTask(row: TaskRow): Task {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		status: row.status as TaskStatus,
		priority: row.priority as TaskPriority,
		flagDiscussion: !!row.flag_discussion,
		assignee: row.assignee,
		tags: safeParseJsonArray(row.tags),
		feature: row.feature,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		blockedBy: row.blocked_by ? safeParseJsonArray(row.blocked_by) : undefined
	};
}

function bucketForStatus(status: TaskStatus): TaskIndexEntry['bucket'] {
	if (status === 'completed') return 'completed';
	if (status === 'cancelled') return 'archived';
	return 'backlog';
}

function taskToIndexEntry(task: Task): TaskIndexEntry {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		priority: task.priority,
		assignee: task.assignee,
		tags: task.tags,
		feature: task.feature,
		createdBy: task.createdBy,
		updatedAt: task.updatedAt,
		completedAt: task.completedAt,
		flagDiscussion: task.flagDiscussion,
		bucket: bucketForStatus(task.status)
	};
}

function safeParseJsonArray(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// ── CRUD ───────────────────────────────────────────────────────────────

export function listTasks(projectPath: string): TaskIndexEntry[] {
	const db = getDb(projectPath);
	const rows = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
	return rows.map(row => taskToIndexEntry(rowToTask(row)));
}

export function getTask(projectPath: string, taskId: string): Task | null {
	sanitizeId(taskId);
	const db = getDb(projectPath);
	const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
	return row ? rowToTask(row) : null;
}

export function getAllTasks(projectPath: string): Task[] {
	const db = getDb(projectPath);
	const rows = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
	return rows.map(rowToTask);
}

export function createTask(projectPath: string, data: {
	title: string;
	description?: string;
	priority?: TaskPriority;
	assignee?: string | null;
	tags?: string[];
	feature?: string | null;
	createdBy?: string;
	blockedBy?: string[];
}): Task {
	const db = getDb(projectPath);
	const now = new Date().toISOString();
	const id = crypto.randomUUID().slice(0, 8);

	const task: Task = {
		id,
		title: data.title.trim(),
		description: data.description?.trim() ?? '',
		status: 'pending',
		priority: data.priority ?? 'medium',
		flagDiscussion: false,
		assignee: data.assignee ?? null,
		tags: data.tags ?? [],
		feature: data.feature ?? null,
		createdBy: data.createdBy ?? 'user',
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		blockedBy: data.blockedBy?.length ? data.blockedBy : undefined
	};

	db.prepare(`
		INSERT INTO tasks (id, title, description, status, priority, flag_discussion, assignee, tags, feature, created_by, created_at, updated_at, completed_at, blocked_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		task.id, task.title, task.description, task.status, task.priority,
		task.flagDiscussion ? 1 : 0, task.assignee, JSON.stringify(task.tags),
		task.feature, task.createdBy, task.createdAt, task.updatedAt,
		task.completedAt, task.blockedBy ? JSON.stringify(task.blockedBy) : null
	);

	emit({ channel: 'tasks', type: 'created', data: { id: task.id, title: task.title }, timestamp: now });

	if (task.blockedBy?.length) {
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'task_dependency_created', count: task.blockedBy.length }).catch(() => {});
	}

	return task;
}

export function updateTask(
	projectPath: string,
	taskId: string,
	updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'flagDiscussion' | 'assignee' | 'tags' | 'feature' | 'blockedBy'>>
): Task | null {
	sanitizeId(taskId);
	const db = getDb(projectPath);

	const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
	if (!existing) return null;

	const task = rowToTask(existing);
	const now = new Date().toISOString();

	if (updates.title !== undefined) task.title = String(updates.title).trim();
	if (updates.description !== undefined) task.description = String(updates.description).trim();
	if (updates.priority !== undefined) task.priority = updates.priority;
	if (updates.flagDiscussion !== undefined) task.flagDiscussion = updates.flagDiscussion;
	if (updates.assignee !== undefined) task.assignee = updates.assignee || null;
	if (updates.tags !== undefined) task.tags = updates.tags;
	if (updates.feature !== undefined) task.feature = updates.feature || null;
	if (updates.blockedBy !== undefined) task.blockedBy = updates.blockedBy?.length ? updates.blockedBy : undefined;
	if (updates.status !== undefined) {
		task.status = updates.status;
		if (updates.status === 'completed') task.completedAt = now;
		else if (task.completedAt) task.completedAt = null;
	}
	task.updatedAt = now;

	db.prepare(`
		UPDATE tasks SET
			title = ?, description = ?, status = ?, priority = ?,
			flag_discussion = ?, assignee = ?, tags = ?, feature = ?,
			updated_at = ?, completed_at = ?, blocked_by = ?
		WHERE id = ?
	`).run(
		task.title, task.description, task.status, task.priority,
		task.flagDiscussion ? 1 : 0, task.assignee, JSON.stringify(task.tags),
		task.feature, task.updatedAt, task.completedAt,
		task.blockedBy ? JSON.stringify(task.blockedBy) : null,
		task.id
	);

	emit({ channel: 'tasks', type: 'updated', data: { id: task.id, status: task.status }, timestamp: now });

	// Emit sprint-sync event when a linked task completes/cancels
	if (updates.status === 'completed' || updates.status === 'cancelled') {
		const sprintLink = syncTaskCompletionToPlan(projectPath, taskId);
		if (sprintLink) {
			emit({
				channel: 'tasks',
				type: 'sprint-sync',
				data: { taskId, sprintId: sprintLink.sprintId, planTaskId: sprintLink.planTaskId, newStatus: task.status },
				timestamp: now
			});
		}
	}

	// Track dependency resolution when a task is completed/cancelled
	if (updates.status === 'completed' || updates.status === 'cancelled') {
		const allRows = db.prepare('SELECT * FROM tasks').all() as TaskRow[];
		const unblockedCount = allRows.filter(row => {
			const blockers = row.blocked_by ? safeParseJsonArray(row.blocked_by) : [];
			return blockers.includes(taskId);
		}).length;
		if (unblockedCount > 0) {
			recordEvent({ taskId: task.id, taskTitle: task.title, type: 'task_dependency_resolved', count: unblockedCount }).catch(() => {});
		}
	}

	return task;
}

export function deleteTask(projectPath: string, taskId: string): boolean {
	sanitizeId(taskId);
	const db = getDb(projectPath);
	const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
	if (result.changes > 0) {
		emit({ channel: 'tasks', type: 'deleted', data: { id: taskId }, timestamp: new Date().toISOString() });
		return true;
	}
	return false;
}

// ── Dependency helpers ────────────────────────────────────────────────

export function getBlockedStatus(
	taskId: string,
	allTasks: Task[]
): { blocked: boolean; blockers: { id: string; title: string; status: TaskStatus }[] } {
	const task = allTasks.find(t => t.id === taskId);
	if (!task?.blockedBy?.length) return { blocked: false, blockers: [] };

	const blockers: { id: string; title: string; status: TaskStatus }[] = [];
	for (const depId of task.blockedBy) {
		const dep = allTasks.find(t => t.id === depId);
		if (!dep) continue;
		if (dep.status !== 'completed' && dep.status !== 'cancelled') {
			blockers.push({ id: dep.id, title: dep.title, status: dep.status });
		}
	}

	return { blocked: blockers.length > 0, blockers };
}

// ── Sprint linking ────────────────────────────────────────────────────

/** Link a task-store task to a sprint task from the project plan */
export function linkToSprint(projectPath: string, taskId: string, sprintId: string, planTaskId: string): boolean {
	sanitizeId(taskId);
	const db = getDb(projectPath);
	const result = db.prepare('UPDATE tasks SET sprint_id = ?, plan_task_id = ?, updated_at = ? WHERE id = ?')
		.run(sprintId, planTaskId, new Date().toISOString(), taskId);
	return result.changes > 0;
}

/** Get all tasks linked to a specific sprint */
export function getTasksBySprint(projectPath: string, sprintId: string): Task[] {
	const db = getDb(projectPath);
	const rows = db.prepare('SELECT * FROM tasks WHERE sprint_id = ? ORDER BY created_at').all(sprintId) as TaskRow[];
	return rows.map(rowToTask);
}

/** When a task completes, return its sprint linkage (if any) for upstream sync */
export function syncTaskCompletionToPlan(projectPath: string, taskId: string): { sprintId: string; planTaskId: string } | null {
	sanitizeId(taskId);
	const db = getDb(projectPath);
	const row = db.prepare('SELECT sprint_id, plan_task_id FROM tasks WHERE id = ?').get(taskId) as Pick<TaskRow, 'sprint_id' | 'plan_task_id'> | undefined;
	if (!row?.sprint_id || !row?.plan_task_id) return null;
	return { sprintId: row.sprint_id, planTaskId: row.plan_task_id };
}

// ── Migration from JSON ───────────────────────────────────────────────

/**
 * Migrate tasks from the JSON-based task store into SQLite.
 * Reads existing index.json + per-task JSON files and inserts into the DB.
 * Safe to call multiple times — skips tasks that already exist.
 */
export function migrateFromJson(projectPath: string): { migrated: boolean; count: number } {
	const db = getDb(projectPath);
	const tasksRoot = resolve(projectPath, '.playground/tasks');

	// Read the JSON index
	let indexData: { version: number; tasks: Array<{ id: string; bucket: string }> } | null = null;
	try {
		const raw = readFileSync(resolve(tasksRoot, 'index.json'), 'utf-8');
		indexData = JSON.parse(raw);
	} catch {
		// No index — try legacy flat file
		try {
			const raw = readFileSync(resolve(projectPath, '.playground/tasks.json'), 'utf-8');
			const legacyTasks = JSON.parse(raw) as Task[];
			if (!Array.isArray(legacyTasks) || legacyTasks.length === 0) {
				return { migrated: false, count: 0 };
			}
			return insertTasksBatch(db, legacyTasks);
		} catch {
			return { migrated: false, count: 0 };
		}
	}

	if (!indexData?.tasks?.length) return { migrated: false, count: 0 };

	// Read each task file from its bucket
	const tasks: Task[] = [];
	for (const entry of indexData.tasks) {
		const bucket = (entry as Record<string, string>).bucket ?? 'backlog';
		try {
			const raw = readFileSync(resolve(tasksRoot, bucket, `${entry.id}.json`), 'utf-8');
			tasks.push(JSON.parse(raw) as Task);
		} catch {
			// Task file missing — skip
		}
	}

	if (tasks.length === 0) return { migrated: false, count: 0 };

	return insertTasksBatch(db, tasks);
}

function insertTasksBatch(db: Database.Database, tasks: Task[]): { migrated: boolean; count: number } {
	const insert = db.prepare(`
		INSERT OR IGNORE INTO tasks (id, title, description, status, priority, flag_discussion, assignee, tags, feature, created_by, created_at, updated_at, completed_at, blocked_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	let count = 0;
	const batch = db.transaction(() => {
		for (const task of tasks) {
			const result = insert.run(
				task.id, task.title, task.description ?? '', task.status, task.priority ?? 'medium',
				task.flagDiscussion ? 1 : 0, task.assignee ?? null,
				JSON.stringify(task.tags ?? []), task.feature ?? null,
				task.createdBy ?? 'user', task.createdAt, task.updatedAt,
				task.completedAt ?? null,
				task.blockedBy?.length ? JSON.stringify(task.blockedBy) : null
			);
			if (result.changes > 0) count++;
		}
	});
	batch();

	return { migrated: count > 0, count };
}
