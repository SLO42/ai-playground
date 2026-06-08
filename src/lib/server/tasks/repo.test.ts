import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	createTask,
	getTask,
	listTasks,
	listTasksByProject,
	updateTask,
	deleteTask,
	setStatus,
	canTransition,
	nextStatuses,
	InvalidTransitionError,
	TASK_STATUSES
} from './repo';

// TASK 1.3 VERIFY (DATA-MODEL §4.2): task CRUD round-trips + the status STATE
// MACHINE accepts legal transitions and rejects illegal ones, against the
// throwaway test DB. Every assertion reads back what the live DB persisted —
// no fake runtime data (F-008). Record ids flow through the D-016 chokepoint.

let tdb: TestDb;
let db: Db;
let projectId: string;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
	const p = await createProject(db, {
		slug: 'tasks',
		name: 'Tasks Host',
		root_path: 'F:/code/tasks'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('task — CRUD round-trip (§4.2)', () => {
	it('create→read→update→delete with schema defaults', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Wire the bus',
			description: 'Republish task changes onto the events bus.'
		});
		expect(t.id).toMatch(/^task:/);
		expect(t.project).toBe(projectId);
		expect(t.title).toBe('Wire the bus');
		expect(t.status).toBe('backlog'); // DEFAULT
		expect(t.priority).toBe('normal'); // DEFAULT
		expect(t.origin).toBe('manual'); // DEFAULT
		expect(t.parent).toBeUndefined(); // option<> omitted, not NULL (§6.1)
		expect(t.created_at).toBeTruthy();

		const read = await getTask(db, t.id);
		expect(read?.title).toBe('Wire the bus');
		expect(read?.description).toBe('Republish task changes onto the events bus.');

		const up = await updateTask(db, t.id, { title: 'Wire the event bus', priority: 'high' });
		expect(up?.title).toBe('Wire the event bus');
		expect(up?.priority).toBe('high');
		// MERGE preserves untouched columns + the immutable description (D-008).
		expect(up?.description).toBe('Republish task changes onto the events bus.');
		expect(up?.status).toBe('backlog');

		const list = await listTasks(db);
		expect(list.some((x) => x.id === t.id)).toBe(true);

		expect(await deleteTask(db, t.id)).toBe(true);
		expect(await getTask(db, t.id)).toBeNull();
	});

	it('honors origin/parent for follow-ups (origin "follow_up")', async () => {
		const parent = await createTask(db, {
			project: projectId,
			title: 'Parent task',
			description: 'The original.'
		});
		const followUp = await createTask(db, {
			project: projectId,
			title: 'Add tests',
			description: 'Follow-up to add tests.',
			origin: 'follow_up',
			parent: parent.id,
			priority: 'low'
		});
		expect(followUp.origin).toBe('follow_up');
		expect(followUp.parent).toBe(parent.id);
		expect(followUp.priority).toBe('low');
		await deleteTask(db, followUp.id);
		await deleteTask(db, parent.id);
	});

	it('lists tasks by project, filtered by status (§4.2 indexes)', async () => {
		const a = await createTask(db, {
			project: projectId,
			title: 'A',
			description: 'a',
			status: 'ready'
		});
		const b = await createTask(db, {
			project: projectId,
			title: 'B',
			description: 'b' // defaults to backlog
		});
		const ready = await listTasksByProject(db, projectId, 'ready');
		expect(ready.some((x) => x.id === a.id)).toBe(true);
		expect(ready.some((x) => x.id === b.id)).toBe(false);

		const all = await listTasksByProject(db, projectId);
		expect(all.some((x) => x.id === a.id)).toBe(true);
		expect(all.some((x) => x.id === b.id)).toBe(true);

		await deleteTask(db, a.id);
		await deleteTask(db, b.id);
	});
});

describe('status state machine', () => {
	it('exposes the canonical enum (locked to the schema ASSERT)', () => {
		expect([...TASK_STATUSES]).toEqual([
			'backlog',
			'ready',
			'in_progress',
			'review',
			'blocked',
			'done',
			'failed'
		]);
	});

	it('canTransition / nextStatuses encode the legal graph; terminals are sinks', () => {
		expect(canTransition('backlog', 'ready')).toBe(true);
		expect(canTransition('ready', 'in_progress')).toBe(true);
		expect(canTransition('in_progress', 'done')).toBe(true);
		// illegal jumps
		expect(canTransition('backlog', 'done')).toBe(false);
		expect(canTransition('backlog', 'in_progress')).toBe(false);
		// terminals do not reopen
		expect(nextStatuses('done')).toEqual([]);
		expect(nextStatuses('failed')).toEqual([]);
		expect(canTransition('done', 'ready')).toBe(false);
	});

	it('setStatus walks a legal path and persists each move', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'March it',
			description: 'walk the machine'
		});
		expect((await setStatus(db, t.id, 'ready'))?.status).toBe('ready');
		expect((await setStatus(db, t.id, 'in_progress'))?.status).toBe('in_progress');
		expect((await setStatus(db, t.id, 'review'))?.status).toBe('review');
		const done = await setStatus(db, t.id, 'done');
		expect(done?.status).toBe('done');
		// reading back confirms the live DB persisted the terminal status.
		expect((await getTask(db, t.id))?.status).toBe('done');
		await deleteTask(db, t.id);
	});

	it('rejects an illegal transition and leaves the row untouched (no write)', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'No teleport',
			description: 'cannot jump backlog→done'
		});
		await expect(setStatus(db, t.id, 'done')).rejects.toBeInstanceOf(InvalidTransitionError);
		// row unchanged — the rejected transition wrote nothing.
		expect((await getTask(db, t.id))?.status).toBe('backlog');
		await deleteTask(db, t.id);
	});

	it('rejects reopening a terminal task (done is a sink)', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Sealed',
			description: 'done stays done',
			status: 'ready'
		});
		await setStatus(db, t.id, 'in_progress');
		await setStatus(db, t.id, 'done');
		await expect(setStatus(db, t.id, 'ready')).rejects.toBeInstanceOf(InvalidTransitionError);
		await deleteTask(db, t.id);
	});

	it('setStatus to the SAME status is a no-op (returns the row, no error)', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Idempotent',
			description: 'same status'
		});
		const same = await setStatus(db, t.id, 'backlog');
		expect(same?.status).toBe('backlog');
		await deleteTask(db, t.id);
	});

	it('setStatus on a missing task throws', async () => {
		await expect(setStatus(db, 'task:nope', 'ready')).rejects.toThrow(/not found/);
	});
});

describe('guards & edge cases', () => {
	it('getTask on a missing id returns null', async () => {
		expect(await getTask(db, 'task:missing')).toBeNull();
	});
	it('deleteTask on a missing id returns false', async () => {
		expect(await deleteTask(db, 'task:missing')).toBe(false);
	});
	it('rejects a malformed record id at the D-016 boundary', async () => {
		await expect(getTask(db, 'task:Bad-Id; DROP')).rejects.toThrow();
	});
});
