import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus, type BusEvent } from './bus';
import { SseClient } from './sse';
import { watchTable, type DbChange } from './db-source';

// TASK 0.d VERIFY (ARCHITECTURE §2.11): a DB change emits EXACTLY ONE SSE event to
// a subscriber — assert NO double-fire. This proves the bus is the single source:
// db owns the one live query → republishes to `events` → the SSE client off the bus
// sees the change once, not twice.

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await db.query(`
		DEFINE TABLE thing SCHEMAFULL;
		DEFINE FIELD label ON thing TYPE string;
	`);
}, 60_000);

afterAll(async () => {
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
	await new Promise((r) => setTimeout(r, 150));
}

describe('db-source — one DB change → exactly one SSE event (no double-fire)', () => {
	it('a CREATE republishes to the bus and reaches a per-client SSE subscriber once', async () => {
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(db, bus, 'thing');
		try {
			await db.query('CREATE thing SET label = $l;', { l: 'alpha' });
			await waitFor(() => seen.length >= 1);

			// EXACTLY ONE event — the double-fire assertion.
			expect(seen).toHaveLength(1);
			const e = seen[0];
			expect(e.type).toBe('db_change');
			expect(e.topic).toBe('thing');
			const change = e.data as DbChange;
			expect(change.action).toBe('CREATE');
			expect(change.record).toMatch(/^thing:/);
			expect((change.result as { label?: string })?.label).toBe('alpha');
		} finally {
			await handle.stop();
		}
	});

	it('exactly one live query owns the change — an SSE client off the bus sees it once', async () => {
		const bus = new EventBus();
		const client = SseClient.from(bus, { filter: (e) => e.topic === 'thing' });

		const handle = await watchTable(db, bus, 'thing');
		try {
			await db.query('CREATE thing SET label = $l;', { l: 'beta' });
			await waitFor(() => client.queued >= 1);
			// No second copy from any other live query — strictly one queued frame.
			expect(client.queued).toBe(1);
		} finally {
			await handle.stop();
			client.close();
		}
	});

	it('UPDATE and DELETE each republish once with the right action', async () => {
		const bus = new EventBus();
		const seen: DbChange[] = [];
		bus.subscribe((e) => seen.push(e.data as DbChange));

		const handle = await watchTable(db, bus, 'thing');
		try {
			const created = await db.query<[{ id: unknown }[]]>('CREATE thing SET label = $l;', {
				l: 'gamma'
			});
			const id = created[0][0].id;
			await db.query('UPDATE $id SET label = $l;', { id, l: 'gamma2' });
			await db.query('DELETE $id;', { id });

			await waitFor(() => seen.filter((c) => c.action === 'DELETE').length >= 1);

			const actions = seen.map((c) => c.action);
			// Exactly one of each — no duplicates from a second live query.
			expect(actions.filter((a) => a === 'CREATE')).toHaveLength(1);
			expect(actions.filter((a) => a === 'UPDATE')).toHaveLength(1);
			expect(actions.filter((a) => a === 'DELETE')).toHaveLength(1);
		} finally {
			await handle.stop();
		}
	});

	it('after stop(), further DB changes do NOT reach the bus', async () => {
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(db, bus, 'thing');
		await handle.stop();

		await db.query('CREATE thing SET label = $l;', { l: 'after-stop' });
		// Give a generous window; nothing should arrive.
		await new Promise((r) => setTimeout(r, 400));
		expect(seen).toHaveLength(0);
	});
});
