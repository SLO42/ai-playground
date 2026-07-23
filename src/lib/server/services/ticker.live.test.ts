// SVC-1 (SERVICES-SPEC §3) — ServicesTicker END-TO-END behavior against a REAL SurrealDB.
//
// ticker.test.ts proves the SCHEDULER contract in isolation with an INJECTED reconcile fn.
// THIS suite closes the required real-behavior gap: drive a genuinely-DOWN service through
// the REAL ServicesTicker → REAL ServicesManager reconcile → REAL DB, and assert:
//   • a down desired-up service is DETECTED and an auto-restart is ATTEMPTED on a tick,
//   • the tick emits the first-class `agent_event` (type 'supervision') recording WHICH
//     service, WHY it was considered down, and the restart OUTCOME (SVC-1 analytics),
//   • the durable incident/notification trail is written (F-008 — no silent failure),
//   • tickMs=0 DISABLES the scheduler entirely (arms no timer; the manual-only contract).
//
// The supervised service is a FAKE in-process adapter (no OS process needed — the real
// crash+restart of an OS process is already covered by manager.test.ts). pid()=null while
// "down" means reconcile short-circuits liveness to false WITHOUT a tasklist call, so the
// down→restart→recovered path is deterministic and host-independent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { ServicesManager, type ServiceAdapter, type ServiceName } from './manager';
import { listIncidents, listUnreadNotifications } from './incidents';
import { ServicesTicker } from './ticker';

/**
 * A FAKE, in-process service adapter. `up` models the OS process being alive: while false,
 * pid() returns null (so reconcile sees it down with NO tasklist call) and health() is false;
 * start() brings it "up" (pid + health true) and counts the (re)start calls.
 */
class FakeAdapter implements ServiceAdapter {
	readonly name: ServiceName;
	up = false;
	startCalls = 0;
	/** When true, start() throws — models an auto-restart that fails (restart-error path). */
	failStart = false;
	constructor(name: ServiceName = 'ollama') {
		this.name = name;
	}
	async start(): Promise<void> {
		this.startCalls += 1;
		if (this.failStart) throw new Error('fake adapter: spawn refused');
		this.up = true;
	}
	async stop(): Promise<void> {
		this.up = false;
	}
	async health(): Promise<boolean> {
		return this.up;
	}
	pid(): number | null {
		return this.up ? 424242 : null;
	}
}

/** Read the supervision run-log rows this manager wrote (SVC-1 first-class analytics). */
async function supervisionEvents(
	db: Db
): Promise<Array<{ type: string; detail: Record<string, unknown> }>> {
	// F-020: every ORDER BY field must be in the SELECT projection — `at` is included.
	const [rows] = await db.query<[Array<{ type: string; detail: Record<string, unknown>; at: unknown }>]>(
		`SELECT type, detail, at FROM agent_event WHERE type = $t ORDER BY at ASC;`,
		{ t: 'supervision' }
	);
	return rows ?? [];
}

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
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close();
	await tdb?.teardown();
});

describe('ServicesTicker × ServicesManager — real supervision tick (SVC-1)', () => {
	it('detects a down service and ATTEMPTS a restart on a tick, emitting a supervision analytics event', async () => {
		const manager = new ServicesManager(db, { maxRestarts: 3 });
		const fake = new FakeAdapter('ollama');
		manager.register(fake);
		// Bring it desired-up (records running); then simulate a crash (process gone).
		await manager.start('ollama');
		expect(fake.startCalls).toBe(1);
		fake.up = false; // crash: pid()→null, health()→false

		const before = await supervisionEvents(db);

		// Drive the REAL manager reconcile through the REAL ticker (the production caller).
		const ticker = new ServicesTicker({ db, tickMs: 1000, tick: () => manager.tick() });
		await ticker.tickOnce();

		// A restart was ATTEMPTED (a second start() call) and the service recovered.
		expect(fake.startCalls).toBe(2);
		expect(fake.up).toBe(true);
		expect(ticker.runCount).toBe(1);
		expect(ticker.faultCount).toBe(0);

		// The service row reflects the recovery.
		const row = (await manager.listServices()).find((s) => s.name === 'ollama');
		expect(row?.status).toBe('running');

		// The durable operational trail is honest (F-008): a crash incident + crash/recovered notes.
		expect((await listIncidents(db)).some((i) => i.title.includes('ollama') && i.severity === 'error')).toBe(true);
		const notes = await listUnreadNotifications(db);
		expect(notes.some((n) => n.message.includes('crashed'))).toBe(true);
		expect(notes.some((n) => n.message.includes('recovered'))).toBe(true);

		// SVC-1: exactly ONE first-class supervision analytics event for this down→restart,
		// recording which service, WHY it was down, and the restart OUTCOME.
		const after = await supervisionEvents(db);
		expect(after.length).toBe(before.length + 1);
		const ev = after[after.length - 1];
		expect(ev.type).toBe('supervision');
		expect(ev.detail.service).toBe('ollama');
		expect(ev.detail.outcome).toBe('recovered');
		expect(ev.detail.restarted).toBe(true);
		expect(ev.detail.healthy).toBe(true);
		expect(String(ev.detail.reason)).toContain('no live pid'); // pid()=null while down
		expect(String(ev.detail.summary)).toContain('ollama');
	});

	it('records a restart-error supervision event when the auto-restart itself fails', async () => {
		const manager = new ServicesManager(db, { maxRestarts: 3 });
		const fake = new FakeAdapter('ollama');
		manager.register(fake);
		await manager.start('ollama');
		fake.up = false; // crash
		fake.failStart = true; // the auto-restart will throw

		const before = await supervisionEvents(db);
		const ticker = new ServicesTicker({ db, tickMs: 1000, tick: () => manager.tick() });
		await ticker.tickOnce();
		expect(ticker.faultCount).toBe(0); // a restart-error is HANDLED, not a tick fault

		const after = await supervisionEvents(db);
		expect(after.length).toBe(before.length + 1);
		const ev = after[after.length - 1];
		expect(ev.detail.outcome).toBe('restart-error');
		expect(ev.detail.healthy).toBe(false);
		expect(String(ev.detail.error)).toContain('spawn refused');
	});

	it('tickMs=0 DISABLES the scheduler entirely — no timer armed, no reconcile ever runs', async () => {
		const manager = new ServicesManager(db, { maxRestarts: 3 });
		const fake = new FakeAdapter('ollama');
		manager.register(fake);
		await manager.start('ollama');
		fake.up = false; // crash — would be restarted IF the scheduler ran

		let ticks = 0;
		const ticker = new ServicesTicker({
			db,
			tickMs: 0,
			tick: () => {
				ticks += 1;
				return manager.tick();
			}
		});
		ticker.start();
		expect(ticker.periodicArmed).toBe(false); // OFF — the manual-only contract preserved
		// No timer means no reconcile: the crashed service is NOT auto-restarted.
		expect(ticks).toBe(0);
		expect(fake.startCalls).toBe(1); // only the initial manager.start(); no restart
		ticker.stop();
	});
});
