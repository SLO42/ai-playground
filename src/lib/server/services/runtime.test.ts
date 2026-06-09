// TASK 10.5 — integration proof for the /services control surface (UI-SPEC §45/§210).
//
// Against a REAL migrated SurrealDB (startTestDb — F-008, no fakes), this suite proves:
//
//   1. The MANAGER's operator action (`operate`) records a real audit incident + notification
//      on BOTH success and failure (the durable trail the page renders, §208), and flips the
//      `service` row status — using a small fake ServiceAdapter so the action is deterministic
//      and does NOT depend on a real Ollama/SurrealDB process being killable in CI.
//   2. The RUNTIME read model (`readServices`) returns the FULL managed set merged with honest
//      controllability + a coerced datetime — INCLUDING the F-013 regression: a `service` row
//      with a SET datetime read back THROUGH the runtime read path is a plain ISO string (not a
//      non-POJO SurrealDB DateTime that would break SvelteKit's load serializer).
//   3. The RUNTIME control gate (`operateService`) refuses an unknown service, an unknown
//      action, and a non-controllable service (surrealdb/engine/dashboard) — no dead/dangerous
//      control reaches the manager (D-038 #5/#6).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { ServicesManager, type ServiceAdapter, type ServiceName } from './manager';
import { listIncidents, listUnreadNotifications } from './incidents';
import { readServices, operateService, ServiceControlError, getServicesManager, __resetServicesRuntime } from './runtime';

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

beforeEach(() => {
	__resetServicesRuntime();
});

/** A deterministic in-memory adapter (no real OS process) for the audit-trail assertions. */
class FakeAdapter implements ServiceAdapter {
	readonly name: ServiceName;
	private up = false;
	private _pid: number | null = null;
	constructor(name: ServiceName, public failOn?: 'start' | 'stop') {
		this.name = name;
	}
	async start(): Promise<void> {
		if (this.failOn === 'start') throw new Error('boom: start failed');
		this.up = true;
		this._pid = 4242;
	}
	async stop(): Promise<void> {
		if (this.failOn === 'stop') throw new Error('boom: stop failed');
		this.up = false;
		this._pid = null;
	}
	async health(): Promise<boolean> {
		return this.up;
	}
	pid(): number | null {
		return this._pid;
	}
}

describe('§10.5 ServicesManager.operate — operator audit trail', () => {
	it('a successful restart records an info incident + a notification and flips status running', async () => {
		const mgr = new ServicesManager(db);
		mgr.register(new FakeAdapter('ollama'));
		await mgr.start('ollama');

		const before = (await listIncidents(db)).length;
		const res = await mgr.operate('ollama', 'restart');

		expect(res.ok).toBe(true);
		expect(res.action).toBe('restart');
		expect(res.incident.severity).toBe('info');
		expect(res.incident.title).toContain('ollama');

		const incidents = await listIncidents(db);
		expect(incidents.length).toBeGreaterThan(before);
		expect(incidents.some((i) => i.title.includes('Operator restart') && i.severity === 'info')).toBe(true);

		const notes = await listUnreadNotifications(db);
		expect(notes.some((n) => n.message.includes('restarted by operator'))).toBe(true);

		const row = (await mgr.listServices()).find((s) => s.name === 'ollama');
		expect(row?.status).toBe('running');
		expect(row?.pid).toBe(4242);
	});

	it('a FAILED action records an error incident (honest) and surfaces the message', async () => {
		const mgr = new ServicesManager(db);
		mgr.register(new FakeAdapter('ollama', 'start'));

		const res = await mgr.operate('ollama', 'start');
		expect(res.ok).toBe(false);
		expect(res.error).toContain('start failed');
		expect(res.incident.severity).toBe('error');
		expect(res.incident.title).toContain('failed');

		const incidents = await listIncidents(db);
		expect(incidents.some((i) => i.title.includes('failed') && i.severity === 'error')).toBe(true);
	});
});

describe('§10.5 runtime.readServices — full set, honest controllability, F-013 datetime coercion', () => {
	it('returns the full managed set with honest controllability flags', async () => {
		const { services } = await readServices(db);
		const names = services.map((s) => s.name).sort();
		expect(names).toEqual(['dashboard', 'engine', 'ollama', 'surrealdb']);

		const ollama = services.find((s) => s.name === 'ollama')!;
		expect(ollama.controllable).toBe(true);

		for (const n of ['surrealdb', 'engine', 'dashboard'] as const) {
			const s = services.find((x) => x.name === n)!;
			expect(s.controllable).toBe(false);
			expect(s.note, `${n} must explain WHY it is not controllable`).toBeTruthy();
		}
	});

	it('F-013 — a SET datetime read back through the runtime load path is a plain ISO string', async () => {
		// Write a real service row with a datetime (the manager does this via UPSERT CONTENT).
		const mgr = getServicesManager(db);
		mgr.register(new FakeAdapter('ollama'));
		await mgr.start('ollama'); // writes service:ollama with checked_at = time::now()

		const { services } = await readServices(db);
		const ollama = services.find((s) => s.name === 'ollama')!;

		// The exact F-013 trap: the datetime must be a primitive string, JSON-serializable
		// (SvelteKit's load serializer rejects a non-POJO SurrealDB DateTime).
		expect(typeof ollama.checked_at).toBe('string');
		expect(ollama.checked_at.length).toBeGreaterThan(0);
		expect(() => JSON.parse(JSON.stringify(ollama))).not.toThrow();
		// And it round-trips as a valid date (real value, not a fabricated placeholder).
		expect(Number.isNaN(new Date(ollama.checked_at).getTime())).toBe(false);
	});
});

describe('§10.5 runtime.operateService — control gate (no dead/dangerous controls)', () => {
	it('refuses an unknown service', async () => {
		await expect(operateService(db, 'nope', 'start')).rejects.toBeInstanceOf(ServiceControlError);
	});

	it('refuses an unknown action', async () => {
		await expect(operateService(db, 'ollama', 'nuke')).rejects.toBeInstanceOf(ServiceControlError);
	});

	it('refuses a non-controllable service (surrealdb — the dashboard reads from it)', async () => {
		await expect(operateService(db, 'surrealdb', 'restart')).rejects.toBeInstanceOf(ServiceControlError);
		await expect(operateService(db, 'engine', 'stop')).rejects.toBeInstanceOf(ServiceControlError);
		await expect(operateService(db, 'dashboard', 'start')).rejects.toBeInstanceOf(ServiceControlError);
	});
});
