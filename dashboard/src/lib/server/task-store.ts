import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'fs/promises';
import { resolve, join } from 'path';
import type { Task } from '$lib/types/tasks.js';
import crypto from 'crypto';
import { withLock } from './async-mutex.js';
import { recordEvent } from './heartbeat/agent-analytics.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface TaskIndex {
	version: 2;
	tasks: TaskIndexEntry[];
	lastUpdated: string;
}

export interface TaskIndexEntry {
	id: string;
	title: string;
	status: Task['status'];
	priority: Task['priority'];
	assignee: string | null;
	tags: string[];
	feature: string | null;
	createdBy: string;
	updatedAt: string;
	completedAt: string | null;
	flagDiscussion: boolean;
	/** Which subfolder the detail file lives in */
	bucket: 'backlog' | 'completed' | 'archived';
}

// ── Helpers ────────────────────────────────────────────────────────────

function tasksRoot(projectPath: string): string {
	return resolve(projectPath, '.playground/tasks');
}

function indexPath(projectPath: string): string {
	return join(tasksRoot(projectPath), 'index.json');
}

function sanitizeId(id: string): string {
	if (/[/\\]|\.\./.test(id)) throw new Error(`Invalid task ID: ${id}`);
	return id;
}

function taskFilePath(projectPath: string, bucket: string, id: string): string {
	return join(tasksRoot(projectPath), bucket, `${sanitizeId(id)}.json`);
}

function bucketForStatus(status: Task['status']): TaskIndexEntry['bucket'] {
	if (status === 'completed') return 'completed';
	if (status === 'cancelled') return 'archived';
	return 'backlog';
}

function toIndexEntry(task: Task): TaskIndexEntry {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		priority: task.priority,
		assignee: task.assignee,
		tags: task.tags,
		feature: task.feature ?? null,
		createdBy: task.createdBy,
		updatedAt: task.updatedAt,
		completedAt: task.completedAt,
		flagDiscussion: task.flagDiscussion,
		bucket: bucketForStatus(task.status)
	};
}

async function ensureDirs(projectPath: string): Promise<void> {
	const root = tasksRoot(projectPath);
	await Promise.all([
		mkdir(join(root, 'backlog'), { recursive: true }),
		mkdir(join(root, 'completed'), { recursive: true }),
		mkdir(join(root, 'archived'), { recursive: true })
	]);
}

async function readJson<T>(p: string): Promise<T | null> {
	try {
		const raw = await readFile(p, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

// ── Index Operations ──────────────────────────────────────────────────

export async function readIndex(projectPath: string): Promise<TaskIndex> {
	const idx = await readJson<TaskIndex>(indexPath(projectPath));
	if (idx?.version === 2) return idx;
	return { version: 2, tasks: [], lastUpdated: new Date().toISOString() };
}

async function writeIndex(projectPath: string, index: TaskIndex): Promise<void> {
	index.lastUpdated = new Date().toISOString();
	await ensureDirs(projectPath);
	await writeFile(indexPath(projectPath), JSON.stringify(index, null, '\t'), 'utf-8');
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function listTasks(projectPath: string): Promise<TaskIndexEntry[]> {
	const index = await readIndex(projectPath);
	return index.tasks;
}

export async function getTask(projectPath: string, taskId: string): Promise<Task | null> {
	sanitizeId(taskId);
	const index = await readIndex(projectPath);
	const entry = index.tasks.find((t) => t.id === taskId);
	if (!entry) return null;
	return readJson<Task>(taskFilePath(projectPath, entry.bucket, entry.id));
}

export async function getAllTasks(projectPath: string): Promise<Task[]> {
	const index = await readIndex(projectPath);
	const tasks = await Promise.all(
		index.tasks.map((entry) =>
			readJson<Task>(taskFilePath(projectPath, entry.bucket, entry.id))
		)
	);
	return tasks.filter((t): t is Task => t !== null);
}

export async function createTask(projectPath: string, data: {
	title: string;
	description?: string;
	priority?: Task['priority'];
	assignee?: string | null;
	tags?: string[];
	feature?: string | null;
	createdBy?: string;
	blockedBy?: string[];
}): Promise<Task> {
	return withLock(indexPath(projectPath), async () => {
		const now = new Date().toISOString();
		const task: Task = {
			id: crypto.randomUUID().slice(0, 8),
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

		await ensureDirs(projectPath);
		const bucket = bucketForStatus(task.status);
		await writeFile(taskFilePath(projectPath, bucket, task.id), JSON.stringify(task, null, '\t'), 'utf-8');

		const index = await readIndex(projectPath);
		index.tasks.push(toIndexEntry(task));
		await writeIndex(projectPath, index);

		if (task.blockedBy?.length) {
			recordEvent({ taskId: task.id, taskTitle: task.title, type: 'task_dependency_created', count: task.blockedBy.length }).catch(() => {});
		}

		return task;
	});
}

export async function updateTask(projectPath: string, taskId: string, updates: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'flagDiscussion' | 'assignee' | 'tags' | 'feature' | 'blockedBy'>>): Promise<Task | null> {
	sanitizeId(taskId);
	return withLock(indexPath(projectPath), async () => {
		const index = await readIndex(projectPath);
		const entryIdx = index.tasks.findIndex((t) => t.id === taskId);
		if (entryIdx === -1) return null;

		const entry = index.tasks[entryIdx];
		const task = await readJson<Task>(taskFilePath(projectPath, entry.bucket, taskId));
		if (!task) return null;

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

		const newBucket = bucketForStatus(task.status);
		const oldBucket = entry.bucket;

		// Write to new location
		await ensureDirs(projectPath);
		await writeFile(taskFilePath(projectPath, newBucket, task.id), JSON.stringify(task, null, '\t'), 'utf-8');

		// Remove from old location if bucket changed
		if (newBucket !== oldBucket) {
			await unlink(taskFilePath(projectPath, oldBucket, task.id)).catch(() => {});
		}

		// Update index
		index.tasks[entryIdx] = toIndexEntry(task);
		await writeIndex(projectPath, index);

		// Track dependency resolution when a task is completed/cancelled
		if (updates.status === 'completed' || updates.status === 'cancelled') {
			const allTasks = await Promise.all(
				index.tasks.map((e) => readJson<Task>(taskFilePath(projectPath, e.bucket, e.id)))
			);
			const unblockedCount = allTasks.filter(
				(t): t is Task => t !== null && !!t.blockedBy?.includes(taskId)
			).length;
			if (unblockedCount > 0) {
				recordEvent({ taskId: task.id, taskTitle: task.title, type: 'task_dependency_resolved', count: unblockedCount }).catch(() => {});
			}
		}

		return task;
	});
}

export async function deleteTask(projectPath: string, taskId: string): Promise<boolean> {
	sanitizeId(taskId);
	return withLock(indexPath(projectPath), async () => {
		const index = await readIndex(projectPath);
		const entryIdx = index.tasks.findIndex((t) => t.id === taskId);
		if (entryIdx === -1) return false;

		const entry = index.tasks[entryIdx];
		await unlink(taskFilePath(projectPath, entry.bucket, taskId)).catch(() => {});
		index.tasks.splice(entryIdx, 1);
		await writeIndex(projectPath, index);

		return true;
	});
}

// ── Dependency helpers ────────────────────────────────────────────────

/**
 * Check whether a task is blocked by incomplete dependencies.
 * Returns `blocked: true` with the list of blocking task IDs/titles
 * if any task in `blockedBy` is not yet `completed` or `cancelled`.
 */
export function getBlockedStatus(taskId: string, allTasks: Task[]): { blocked: boolean; blockers: { id: string; title: string; status: Task['status'] }[] } {
	const task = allTasks.find(t => t.id === taskId);
	if (!task?.blockedBy?.length) return { blocked: false, blockers: [] };

	const blockers: { id: string; title: string; status: Task['status'] }[] = [];
	for (const depId of task.blockedBy) {
		const dep = allTasks.find(t => t.id === depId);
		if (!dep) continue; // dependency was deleted — not blocking
		if (dep.status !== 'completed' && dep.status !== 'cancelled') {
			blockers.push({ id: dep.id, title: dep.title, status: dep.status });
		}
	}

	return { blocked: blockers.length > 0, blockers };
}

// ── Migration ─────────────────────────────────────────────────────────

/**
 * Migrate from legacy flat tasks.json to per-file structure.
 * Safe to call multiple times — skips if already migrated.
 */
export async function migrateIfNeeded(projectPath: string): Promise<{ migrated: boolean; count: number }> {
	const legacyFile = resolve(projectPath, '.playground/tasks.json');
	const idx = await readJson<TaskIndex>(indexPath(projectPath));

	// Already on v2
	if (idx?.version === 2) return { migrated: false, count: idx.tasks.length };

	// Read legacy
	const legacy = await readJson<Task[]>(legacyFile);
	if (!legacy || legacy.length === 0) {
		// No legacy data — just create empty index
		await ensureDirs(projectPath);
		await writeIndex(projectPath, { version: 2, tasks: [], lastUpdated: new Date().toISOString() });
		return { migrated: false, count: 0 };
	}

	// Migrate each task
	await ensureDirs(projectPath);
	const entries: TaskIndexEntry[] = [];

	for (const task of legacy) {
		const bucket = bucketForStatus(task.status);
		await writeFile(taskFilePath(projectPath, bucket, task.id), JSON.stringify(task, null, '\t'), 'utf-8');
		entries.push(toIndexEntry(task));
	}

	await writeIndex(projectPath, { version: 2, tasks: entries, lastUpdated: new Date().toISOString() });

	// Rename legacy file so it's not re-read but not lost
	await rename(legacyFile, legacyFile + '.migrated').catch(() => {});

	return { migrated: true, count: legacy.length };
}

// ── Handoff Routing ───────────────────────────────────────────────────

type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'claw';

interface RoutingResult {
	tier: ModelTier;
	agentId: string;
	reason: string;
	complexity: number;
}

const COMPLEXITY_SIGNALS: Record<string, number> = {
	// Tags that raise complexity
	'architecture': 25, 'security': 25, 'security-critical': 30,
	'design': 20, 'refactor': 15, 'performance': 15,
	'testing': 10, 'code-review': 10, 'review': 10,
	'routing': 5, 'formatting': -10, 'linting': -10,
	'status': -15, 'lookup': -15, 'simple': -20,
};

const TITLE_SIGNALS: [RegExp, number][] = [
	[/architect|design|system.design/i, 25],
	[/security|audit|vulnerab/i, 25],
	[/refactor|restructure|reorganize/i, 15],
	[/implement|build|create.*feature/i, 15],
	[/review|code.review/i, 10],
	[/test|spec|coverage/i, 10],
	[/fix.*bug|hotfix|patch/i, 5],
	[/format|lint|style/i, -15],
	[/status|check|list|lookup/i, -15],
	[/rename|typo|label/i, -10],
];

/** Estimate task complexity (0–100) from available signals. */
function estimateComplexity(task: Pick<Task, 'title' | 'description' | 'priority' | 'tags'>): number {
	let score = 30; // baseline

	// Priority contributes
	if (task.priority === 'critical') score += 25;
	else if (task.priority === 'high') score += 15;
	else if (task.priority === 'low') score -= 10;

	// Tag signals
	for (const tag of task.tags) {
		const key = tag.toLowerCase();
		if (key in COMPLEXITY_SIGNALS) score += COMPLEXITY_SIGNALS[key];
	}

	// Title signals
	for (const [pattern, weight] of TITLE_SIGNALS) {
		if (pattern.test(task.title)) { score += weight; break; }
	}

	// Description length is a weak proxy for scope
	const descLen = task.description?.length ?? 0;
	if (descLen > 500) score += 10;
	else if (descLen > 200) score += 5;

	return Math.max(0, Math.min(100, score));
}

/** Default agent assignments per tier (first available). */
const TIER_AGENTS: Record<ModelTier, string[]> = {
	opus:   ['opus-coder-1', 'opus-coder-2', 'opus-researcher', 'opus-planner'],
	sonnet: ['sonnet-coder', 'sonnet-tester'],
	haiku:  ['haiku-helper-1', 'haiku-helper-2'],
	claw:   ['claw-orchestrator-1', 'claw-orchestrator-2'],
};

/** Specialized agent overrides by tag. */
const TAG_AGENT_OVERRIDES: Record<string, string> = {
	'security': 'opus-security',
	'security-critical': 'opus-security',
	'architecture': 'opus-architect',
	'design': 'opus-architect',
	'code-review': 'opus-reviewer',
	'review': 'opus-reviewer',
	'testing': 'opus-tester',
};

/**
 * Route a task to the appropriate model tier and agent based on
 * escalation/delegation rules from config/agent-pool.yaml.
 *
 * Thresholds:
 *   complexity > 60% → opus  (architecture, security, novel problems)
 *   complexity > 30% → sonnet (moderate code, review, refactoring)
 *   complexity ≤ 30% → haiku (formatting, linting, lookups)
 *
 * Orchestration tasks (routing, tool calls, delegation) → claw (local, free).
 */
export function routeTask(task: Pick<Task, 'title' | 'description' | 'priority' | 'tags'>): RoutingResult {
	const complexity = estimateComplexity(task);
	const lowerTags = task.tags.map(t => t.toLowerCase());

	// Orchestration tasks always go to claw (free local model)
	const isOrchestration = lowerTags.some(t =>
		['routing', 'orchestration', 'delegation', 'tool-calls'].includes(t)
	) || /orchestrat|delegat|route.*task/i.test(task.title);

	if (isOrchestration && complexity <= 50) {
		return {
			tier: 'claw',
			agentId: TIER_AGENTS.claw[0],
			reason: 'Orchestration task routed to local model (free)',
			complexity
		};
	}

	// Check for specialized agent overrides (always opus-tier)
	for (const tag of lowerTags) {
		if (tag in TAG_AGENT_OVERRIDES) {
			return {
				tier: 'opus',
				agentId: TAG_AGENT_OVERRIDES[tag],
				reason: `Specialist agent for "${tag}"`,
				complexity
			};
		}
	}

	// Tier selection based on complexity thresholds
	let tier: ModelTier;
	let reason: string;

	if (complexity > 60) {
		tier = 'opus';
		reason = 'High complexity — escalated to opus';
	} else if (complexity > 30) {
		tier = 'sonnet';
		reason = 'Moderate complexity — routed to sonnet';
	} else {
		tier = 'haiku';
		reason = 'Low complexity — delegated to haiku';
	}

	return {
		tier,
		agentId: TIER_AGENTS[tier][0],
		reason,
		complexity
	};
}

/**
 * Auto-assign a task to the best agent if no assignee is set.
 * Returns the updated task (or original if already assigned).
 */
export async function autoAssignTask(projectPath: string, taskId: string): Promise<Task | null> {
	const task = await getTask(projectPath, taskId);
	if (!task || task.assignee) return task;

	const route = routeTask(task);
	return updateTask(projectPath, taskId, { assignee: route.agentId });
}

// ── Bulk helpers for reports/sync ─────────────────────────────────────

/** Write a full task (used by github-sync import) */
export async function putTask(projectPath: string, task: Task): Promise<void> {
	return withLock(indexPath(projectPath), async () => {
		const bucket = bucketForStatus(task.status);
		await ensureDirs(projectPath);
		await writeFile(taskFilePath(projectPath, bucket, task.id), JSON.stringify(task, null, '\t'), 'utf-8');

		const index = await readIndex(projectPath);
		const existingIdx = index.tasks.findIndex((t) => t.id === task.id);
		if (existingIdx >= 0) {
			// Move old file if bucket changed
			const oldBucket = index.tasks[existingIdx].bucket;
			if (oldBucket !== bucket) {
				await unlink(taskFilePath(projectPath, oldBucket, task.id)).catch(() => {});
			}
			index.tasks[existingIdx] = toIndexEntry(task);
		} else {
			index.tasks.push(toIndexEntry(task));
		}
		await writeIndex(projectPath, index);
	});
}

/** Replace all tasks (used by github-sync full write) */
export async function replaceAllTasks(projectPath: string, tasks: Task[]): Promise<void> {
	return withLock(indexPath(projectPath), async () => {
		await ensureDirs(projectPath);
		const entries: TaskIndexEntry[] = [];

		for (const task of tasks) {
			const bucket = bucketForStatus(task.status);
			await writeFile(taskFilePath(projectPath, bucket, task.id), JSON.stringify(task, null, '\t'), 'utf-8');
			entries.push(toIndexEntry(task));
		}

		await writeIndex(projectPath, { version: 2, tasks: entries, lastUpdated: new Date().toISOString() });
	});
}
