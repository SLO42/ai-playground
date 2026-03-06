import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
	createTask,
	getTask,
	getAllTasks,
	listTasks,
	updateTask,
	deleteTask,
	migrateIfNeeded
} from '../lib/server/task-store.js';
import type { Task } from '../lib/types/tasks.js';

/**
 * Integration tests for /api/projects/[id]/tasks endpoints.
 *
 * These tests exercise the same task-store operations the API handlers call,
 * verifying correct data flow, filtering, error handling, and CRUD lifecycle.
 */

describe('/api/projects/[id]/tasks — GET', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('returns empty array when no tasks exist', async () => {
		await migrateIfNeeded(projectPath);
		const tasks = await listTasks(projectPath);
		expect(tasks).toEqual([]);
	});

	it('returns index entries for fast listing (default mode)', async () => {
		await migrateIfNeeded(projectPath);
		await createTask(projectPath, { title: 'Task A', priority: 'high' });
		await createTask(projectPath, { title: 'Task B', priority: 'low' });

		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(2);
		// Index entries should have id, title, status, priority but NOT description
		expect(entries[0]).toHaveProperty('id');
		expect(entries[0]).toHaveProperty('title');
		expect(entries[0]).toHaveProperty('status');
		expect(entries[0]).not.toHaveProperty('description');
	});

	it('returns full task objects when ?full=true equivalent', async () => {
		await migrateIfNeeded(projectPath);
		await createTask(projectPath, {
			title: 'Full task',
			description: 'Detailed description here'
		});

		const tasks = await getAllTasks(projectPath);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].description).toBe('Detailed description here');
		expect(tasks[0]).toHaveProperty('createdAt');
		expect(tasks[0]).toHaveProperty('updatedAt');
	});

	it('filters tasks by single status', async () => {
		await migrateIfNeeded(projectPath);
		const t1 = await createTask(projectPath, { title: 'Pending task' });
		const t2 = await createTask(projectPath, { title: 'Done task' });
		await updateTask(projectPath, t2.id, { status: 'completed' });

		const all = await getAllTasks(projectPath);
		const pending = all.filter((t) => t.status === 'pending');
		const completed = all.filter((t) => t.status === 'completed');

		expect(pending).toHaveLength(1);
		expect(pending[0].title).toBe('Pending task');
		expect(completed).toHaveLength(1);
		expect(completed[0].title).toBe('Done task');
	});

	it('filters tasks by multiple statuses (comma-separated)', async () => {
		await migrateIfNeeded(projectPath);
		const t1 = await createTask(projectPath, { title: 'Pending' });
		const t2 = await createTask(projectPath, { title: 'In Progress' });
		const t3 = await createTask(projectPath, { title: 'Completed' });
		const t4 = await createTask(projectPath, { title: 'Cancelled' });

		await updateTask(projectPath, t2.id, { status: 'in_progress' });
		await updateTask(projectPath, t3.id, { status: 'completed' });
		await updateTask(projectPath, t4.id, { status: 'cancelled' });

		const all = await getAllTasks(projectPath);
		// Simulate ?status=pending,in_progress
		const statuses = ['pending', 'in_progress'] as const;
		const filtered = all.filter((t) => (statuses as readonly string[]).includes(t.status));

		expect(filtered).toHaveLength(2);
		expect(filtered.map((t) => t.title).sort()).toEqual(['In Progress', 'Pending']);
	});

	it('returns tasks with correct field types', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, {
			title: 'Typed task',
			priority: 'critical',
			assignee: 'claw',
			tags: ['bug', 'urgent']
		});

		const fetched = await getTask(projectPath, task.id);
		expect(fetched).not.toBeNull();
		expect(typeof fetched!.id).toBe('string');
		expect(typeof fetched!.title).toBe('string');
		expect(typeof fetched!.description).toBe('string');
		expect(typeof fetched!.createdAt).toBe('string');
		expect(typeof fetched!.updatedAt).toBe('string');
		expect(fetched!.completedAt).toBeNull();
		expect(fetched!.assignee).toBe('claw');
		expect(fetched!.tags).toEqual(['bug', 'urgent']);
		expect(fetched!.priority).toBe('critical');
		expect(fetched!.flagDiscussion).toBe(false);
	});
});

describe('/api/projects/[id]/tasks — POST', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-post-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('creates a task with all fields', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, {
			title: 'New feature',
			description: 'Build the thing',
			priority: 'high',
			assignee: 'user',
			tags: ['feature'],
			createdBy: 'api'
		});

		expect(task.id).toBeTruthy();
		expect(task.title).toBe('New feature');
		expect(task.description).toBe('Build the thing');
		expect(task.priority).toBe('high');
		expect(task.assignee).toBe('user');
		expect(task.tags).toEqual(['feature']);
		expect(task.createdBy).toBe('api');
		expect(task.status).toBe('pending');
	});

	it('creates a task with minimal fields (title only)', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Minimal task' });

		expect(task.title).toBe('Minimal task');
		expect(task.description).toBe('');
		expect(task.priority).toBe('medium');
		expect(task.assignee).toBeNull();
		expect(task.tags).toEqual([]);
		expect(task.createdBy).toBe('user');
	});

	it('trims whitespace from title', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: '  Spaces around  ' });
		expect(task.title).toBe('Spaces around');
	});

	it('assigns unique IDs to each task', async () => {
		await migrateIfNeeded(projectPath);
		const ids = new Set<string>();
		for (let i = 0; i < 10; i++) {
			const task = await createTask(projectPath, { title: `Task ${i}` });
			ids.add(task.id);
		}
		expect(ids.size).toBe(10);
	});

	it('persists task and is retrievable', async () => {
		await migrateIfNeeded(projectPath);
		const created = await createTask(projectPath, {
			title: 'Persistent',
			description: 'Should survive a re-read'
		});

		const fetched = await getTask(projectPath, created.id);
		expect(fetched).not.toBeNull();
		expect(fetched!.id).toBe(created.id);
		expect(fetched!.title).toBe('Persistent');
		expect(fetched!.description).toBe('Should survive a re-read');
	});
});

describe('/api/projects/[id]/tasks/[taskId] — GET', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-get-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('returns a single task by ID', async () => {
		await migrateIfNeeded(projectPath);
		const created = await createTask(projectPath, { title: 'Specific task' });

		const task = await getTask(projectPath, created.id);
		expect(task).not.toBeNull();
		expect(task!.id).toBe(created.id);
		expect(task!.title).toBe('Specific task');
	});

	it('returns null for non-existent task ID', async () => {
		await migrateIfNeeded(projectPath);
		const task = await getTask(projectPath, 'does-not-exist');
		expect(task).toBeNull();
	});

	it('returns updated task after modifications', async () => {
		await migrateIfNeeded(projectPath);
		const created = await createTask(projectPath, {
			title: 'Original',
			priority: 'low'
		});
		await updateTask(projectPath, created.id, {
			title: 'Updated',
			priority: 'critical'
		});

		const task = await getTask(projectPath, created.id);
		expect(task!.title).toBe('Updated');
		expect(task!.priority).toBe('critical');
	});
});

describe('/api/projects/[id]/tasks/[taskId] — PUT', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-put-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('updates task title', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Old title' });
		const updated = await updateTask(projectPath, task.id, { title: 'New title' });
		expect(updated!.title).toBe('New title');
	});

	it('updates task status to in_progress', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Start me' });
		const updated = await updateTask(projectPath, task.id, { status: 'in_progress' });
		expect(updated!.status).toBe('in_progress');
	});

	it('sets completedAt when status becomes completed', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Complete me' });
		const updated = await updateTask(projectPath, task.id, { status: 'completed' });
		expect(updated!.status).toBe('completed');
		expect(updated!.completedAt).toBeTruthy();
		expect(new Date(updated!.completedAt!).getTime()).toBeGreaterThan(0);
	});

	it('clears completedAt when reopening a completed task', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Reopen' });
		await updateTask(projectPath, task.id, { status: 'completed' });
		const reopened = await updateTask(projectPath, task.id, { status: 'pending' });
		expect(reopened!.status).toBe('pending');
		expect(reopened!.completedAt).toBeNull();
	});

	it('updates priority', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Reprioritize' });
		const updated = await updateTask(projectPath, task.id, { priority: 'critical' });
		expect(updated!.priority).toBe('critical');
	});

	it('updates tags', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Tag me', tags: ['old'] });
		const updated = await updateTask(projectPath, task.id, { tags: ['new', 'updated'] });
		expect(updated!.tags).toEqual(['new', 'updated']);
	});

	it('updates assignee', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Assign' });
		const updated = await updateTask(projectPath, task.id, { assignee: 'claw' });
		expect(updated!.assignee).toBe('claw');
	});

	it('sets flagDiscussion', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Discuss' });
		const updated = await updateTask(projectPath, task.id, { flagDiscussion: true });
		expect(updated!.flagDiscussion).toBe(true);
	});

	it('updates updatedAt timestamp', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Timestamp' });
		const originalUpdatedAt = task.updatedAt;

		// Small delay to ensure different timestamp
		await new Promise((r) => setTimeout(r, 10));
		const updated = await updateTask(projectPath, task.id, { title: 'Timestamp v2' });
		expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
	});

	it('returns null when updating non-existent task', async () => {
		await migrateIfNeeded(projectPath);
		const result = await updateTask(projectPath, 'ghost-id', { title: 'Nope' });
		expect(result).toBeNull();
	});

	it('moves task file between buckets on status change', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Bucket mover' });

		// pending → backlog
		let entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('backlog');

		// completed → completed bucket
		await updateTask(projectPath, task.id, { status: 'completed' });
		entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('completed');

		// cancelled → archived bucket
		await updateTask(projectPath, task.id, { status: 'cancelled' });
		entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('archived');

		// back to pending → backlog
		await updateTask(projectPath, task.id, { status: 'pending' });
		entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('backlog');
	});
});

describe('/api/projects/[id]/tasks/[taskId] — DELETE', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-del-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('deletes an existing task', async () => {
		await migrateIfNeeded(projectPath);
		const task = await createTask(projectPath, { title: 'Delete me' });

		const deleted = await deleteTask(projectPath, task.id);
		expect(deleted).toBe(true);

		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(0);

		const fetched = await getTask(projectPath, task.id);
		expect(fetched).toBeNull();
	});

	it('returns false when deleting non-existent task', async () => {
		await migrateIfNeeded(projectPath);
		const deleted = await deleteTask(projectPath, 'no-such-task');
		expect(deleted).toBe(false);
	});

	it('does not affect other tasks when deleting one', async () => {
		await migrateIfNeeded(projectPath);
		const t1 = await createTask(projectPath, { title: 'Keep A' });
		const t2 = await createTask(projectPath, { title: 'Delete B' });
		const t3 = await createTask(projectPath, { title: 'Keep C' });

		await deleteTask(projectPath, t2.id);

		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.title).sort()).toEqual(['Keep A', 'Keep C']);
	});
});

describe('/api/projects/[id]/tasks — migration', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-migrate-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('creates empty index if no legacy data exists', async () => {
		const result = await migrateIfNeeded(projectPath);
		expect(result.migrated).toBe(false);
		expect(result.count).toBe(0);

		const entries = await listTasks(projectPath);
		expect(entries).toEqual([]);
	});

	it('migrates legacy flat tasks.json to per-file structure', async () => {
		// Write legacy format
		const legacyTasks: Task[] = [
			{
				id: 'legacy-1',
				title: 'Legacy Task',
				description: 'From old format',
				status: 'pending',
				priority: 'medium',
				flagDiscussion: false,
				assignee: null,
				tags: [],
				feature: null,
				createdBy: 'user',
				createdAt: '2026-01-01T00:00:00Z',
				updatedAt: '2026-01-01T00:00:00Z',
				completedAt: null
			}
		];
		await mkdir(join(projectPath, '.playground'), { recursive: true });
		await writeFile(
			join(projectPath, '.playground/tasks.json'),
			JSON.stringify(legacyTasks),
			'utf-8'
		);

		const result = await migrateIfNeeded(projectPath);
		expect(result.migrated).toBe(true);
		expect(result.count).toBe(1);

		const task = await getTask(projectPath, 'legacy-1');
		expect(task).not.toBeNull();
		expect(task!.title).toBe('Legacy Task');
	});

	it('skips migration if already on v2', async () => {
		await migrateIfNeeded(projectPath); // First call creates v2 index
		const result = await migrateIfNeeded(projectPath); // Second call is a no-op
		expect(result.migrated).toBe(false);
	});
});

describe('/api/projects/[id]/tasks — concurrent operations', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-tasks-concurrent-'));
		await migrateIfNeeded(projectPath);
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('handles multiple sequential creates correctly', async () => {
		for (let i = 0; i < 20; i++) {
			await createTask(projectPath, { title: `Task ${i}` });
		}
		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(20);
	});

	it('handles create-then-immediate-read consistently', async () => {
		const created = await createTask(projectPath, {
			title: 'Immediate read',
			description: 'Should be available right away'
		});

		const read = await getTask(projectPath, created.id);
		expect(read).not.toBeNull();
		expect(read!.id).toBe(created.id);
		expect(read!.title).toBe('Immediate read');
	});

	it('handles create-update-delete in rapid succession', async () => {
		const task = await createTask(projectPath, { title: 'Rapid lifecycle' });
		await updateTask(projectPath, task.id, { status: 'in_progress' });
		await updateTask(projectPath, task.id, { status: 'completed' });
		await deleteTask(projectPath, task.id);

		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(0);
		expect(await getTask(projectPath, task.id)).toBeNull();
	});
});
