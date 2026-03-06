import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
	createTask,
	getTask,
	listTasks,
	updateTask,
	readIndex
} from './task-store.js';

describe('Task start and completion flow (e2e)', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'task-e2e-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('creates a task in pending status', async () => {
		const task = await createTask(projectPath, {
			title: 'Implement login page',
			description: 'Build the login UI with email/password fields',
			priority: 'high',
			tags: ['frontend', 'auth']
		});

		expect(task.id).toBeTruthy();
		expect(task.status).toBe('pending');
		expect(task.title).toBe('Implement login page');
		expect(task.priority).toBe('high');
		expect(task.completedAt).toBeNull();

		// Verify it appears in the index
		const entries = await listTasks(projectPath);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(task.id);
		expect(entries[0].status).toBe('pending');
		expect(entries[0].bucket).toBe('backlog');
	});

	it('starts a pending task and transitions to in_progress', async () => {
		const task = await createTask(projectPath, { title: 'Setup CI pipeline' });

		const started = await updateTask(projectPath, task.id, { status: 'in_progress' });

		expect(started).not.toBeNull();
		expect(started!.status).toBe('in_progress');
		expect(started!.completedAt).toBeNull();
		// Should still be in backlog bucket
		const entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('backlog');
	});

	it('completes an in_progress task with completedAt timestamp', async () => {
		const task = await createTask(projectPath, { title: 'Write tests' });
		await updateTask(projectPath, task.id, { status: 'in_progress' });

		const completed = await updateTask(projectPath, task.id, { status: 'completed' });

		expect(completed).not.toBeNull();
		expect(completed!.status).toBe('completed');
		expect(completed!.completedAt).toBeTruthy();
		// Should move to completed bucket
		const entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('completed');
	});

	it('full lifecycle: pending → in_progress → completed', async () => {
		// 1. Create
		const task = await createTask(projectPath, {
			title: 'Deploy to staging',
			priority: 'critical',
			assignee: 'claw',
			tags: ['devops']
		});
		expect(task.status).toBe('pending');

		// 2. Start
		const started = await updateTask(projectPath, task.id, { status: 'in_progress' });
		expect(started!.status).toBe('in_progress');

		// 3. Poll status (simulates UI polling)
		const polled = await getTask(projectPath, task.id);
		expect(polled).not.toBeNull();
		expect(polled!.status).toBe('in_progress');
		expect(polled!.assignee).toBe('claw');

		// 4. Complete
		const completed = await updateTask(projectPath, task.id, { status: 'completed' });
		expect(completed!.status).toBe('completed');
		expect(completed!.completedAt).toBeTruthy();

		// 5. Verify final state
		const final = await getTask(projectPath, task.id);
		expect(final!.status).toBe('completed');
		expect(final!.completedAt).toBeTruthy();

		// 6. Verify index is consistent
		const index = await readIndex(projectPath);
		const entry = index.tasks.find((t) => t.id === task.id);
		expect(entry).toBeTruthy();
		expect(entry!.status).toBe('completed');
		expect(entry!.bucket).toBe('completed');
		expect(entry!.completedAt).toBeTruthy();
	});

	it('cancelling a task moves it to archived bucket', async () => {
		const task = await createTask(projectPath, { title: 'Optional feature' });
		await updateTask(projectPath, task.id, { status: 'in_progress' });

		const cancelled = await updateTask(projectPath, task.id, { status: 'cancelled' });

		expect(cancelled!.status).toBe('cancelled');
		const entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('archived');
	});

	it('re-opening a completed task clears completedAt', async () => {
		const task = await createTask(projectPath, { title: 'Reopen me' });
		await updateTask(projectPath, task.id, { status: 'completed' });

		const reopened = await updateTask(projectPath, task.id, { status: 'in_progress' });

		expect(reopened!.status).toBe('in_progress');
		expect(reopened!.completedAt).toBeNull();
		const entries = await listTasks(projectPath);
		expect(entries[0].bucket).toBe('backlog');
	});

	it('handles multiple tasks with independent lifecycles', async () => {
		const t1 = await createTask(projectPath, { title: 'Task A' });
		const t2 = await createTask(projectPath, { title: 'Task B' });
		const t3 = await createTask(projectPath, { title: 'Task C' });

		// Start A and C, leave B pending
		await updateTask(projectPath, t1.id, { status: 'in_progress' });
		await updateTask(projectPath, t3.id, { status: 'in_progress' });

		// Complete A, cancel C
		await updateTask(projectPath, t1.id, { status: 'completed' });
		await updateTask(projectPath, t3.id, { status: 'cancelled' });

		const entries = await listTasks(projectPath);
		const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

		expect(byId[t1.id].status).toBe('completed');
		expect(byId[t1.id].bucket).toBe('completed');
		expect(byId[t2.id].status).toBe('pending');
		expect(byId[t2.id].bucket).toBe('backlog');
		expect(byId[t3.id].status).toBe('cancelled');
		expect(byId[t3.id].bucket).toBe('archived');
	});

	it('returns null when updating a non-existent task', async () => {
		const result = await updateTask(projectPath, 'no-such-id', { status: 'completed' });
		expect(result).toBeNull();
	});
});
