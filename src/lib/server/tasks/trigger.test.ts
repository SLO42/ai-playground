import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus, type BusEvent } from '../events/bus';
import { watchTable, type DbChange } from '../events/db-source';
import { createProject, deleteProject } from '../projects/repo';
import { createTask, setStatus, deleteTask } from './repo';

// TASK 1.3 VERIFY (DATA-MODEL §4.2; ARCHITECTURE §2.11): a task status TRANSITION
// emits EXACTLY ONE event on the events bus. This is the "live-query trigger seed":
// the SurrealDB live query on `task` (owned by events/watchTable — the ONLY
// sanctioned live query) republishes the status change onto the one bus exactly
// once. setStatus does NOT publish directly; the bus is the single source (§2.11).
// We assert the count is exactly 1 (no double-fire, no orchestrator self-publish).

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
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, {
		slug: 'trig',
		name: 'Trigger Host',
		root_path: 'F:/code/trig'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** Wait until `predicate()` is true or time out (live events are async). */
async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for live event');
		await new Promise((r) => setTimeout(r, 25));
	}
	// settle: give any *extra* (erroneous) events a chance to arrive so a
	// double-fire would be caught rather than missed by racing the assertion.
	await new Promise((r) => setTimeout(r, 200));
}

describe('task status transition → exactly one bus event (live-query trigger seed)', () => {
	it('a status change emits exactly ONE db_change event for that task', async () => {
		const bus = new EventBus();
		const updates: DbChange[] = [];
		// Only count UPDATE changes for OUR task id — ignore the CREATE and any
		// unrelated rows — so we measure the transition itself.
		const created = await createTask(db, {
			project: projectId,
			title: 'Trigger me',
			description: 'a status change should fan out exactly once'
		});

		bus.subscribe((e: BusEvent) => {
			const c = e.data as DbChange;
			if (e.type === 'db_change' && c.record === created.id && c.action === 'UPDATE') {
				updates.push(c);
			}
		});

		const handle = await watchTable(db, bus, 'task');
		try {
			const moved = await setStatus(db, created.id, 'ready');
			expect(moved?.status).toBe('ready');

			await waitFor(() => updates.length >= 1);

			// EXACTLY ONE — the trigger fires once for the one transition. No
			// double-fire (single live query) and no orchestrator self-publish.
			expect(updates).toHaveLength(1);
			expect(updates[0].action).toBe('UPDATE');
			expect((updates[0].result as { status?: string })?.status).toBe('ready');
		} finally {
			await handle.stop();
			await deleteTask(db, created.id);
		}
	});

	it('a REJECTED transition writes nothing → emits NO event', async () => {
		const bus = new EventBus();
		const updates: DbChange[] = [];
		const created = await createTask(db, {
			project: projectId,
			title: 'No-op on reject',
			description: 'illegal transition must not fan out'
		});

		bus.subscribe((e: BusEvent) => {
			const c = e.data as DbChange;
			if (e.type === 'db_change' && c.record === created.id && c.action === 'UPDATE') {
				updates.push(c);
			}
		});

		const handle = await watchTable(db, bus, 'task');
		try {
			// backlog→done is illegal → throws, rolls back, no row write.
			await expect(setStatus(db, created.id, 'done')).rejects.toThrow();
			// generous window — nothing should arrive on the bus for this row.
			await new Promise((r) => setTimeout(r, 500));
			expect(updates).toHaveLength(0);
		} finally {
			await handle.stop();
			await deleteTask(db, created.id);
		}
	});

	it('each step of a multi-step walk fires exactly once (one transition = one event)', async () => {
		const bus = new EventBus();
		const updates: DbChange[] = [];
		const created = await createTask(db, {
			project: projectId,
			title: 'Walk it',
			description: 'count one event per legal step'
		});

		bus.subscribe((e: BusEvent) => {
			const c = e.data as DbChange;
			if (e.type === 'db_change' && c.record === created.id && c.action === 'UPDATE') {
				updates.push(c);
			}
		});

		const handle = await watchTable(db, bus, 'task');
		try {
			await setStatus(db, created.id, 'ready');
			await setStatus(db, created.id, 'in_progress');
			await setStatus(db, created.id, 'done');
			await waitFor(() => updates.length >= 3);
			// Three legal transitions → exactly three events, in order.
			expect(updates).toHaveLength(3);
			expect(updates.map((c) => (c.result as { status?: string })?.status)).toEqual([
				'ready',
				'in_progress',
				'done'
			]);
		} finally {
			await handle.stop();
			await deleteTask(db, created.id);
		}
	});
});
