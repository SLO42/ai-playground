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
//      action, and a non-controllable service (surrealdb/dashboard) — no dead/dangerous
//      control reaches the manager (D-038 #5/#6).
//
// SVC-2: `engine` was dropped from SERVICE_NAMES (it named the IN-PROCESS orchestrator, not a
// distinct managed service). The full managed set is now [dashboard, ollama, surrealdb].

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { ServicesManager, SERVICE_NAMES, type ServiceAdapter, type ServiceName, type ServiceStatus } from './manager';
import { listIncidents, listUnreadNotifications } from './incidents';
import {
	readServices,
	summarizeServices,
	operateService,
	ServiceControlError,
	getServicesManager,
	__resetServicesRuntime,
	__setOllamaAdapterForTest
} from './runtime';

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
		expect(names).toEqual(['dashboard', 'ollama', 'surrealdb']); // SVC-2: engine dropped

		const ollama = services.find((s) => s.name === 'ollama')!;
		expect(ollama.controllable).toBe(true);

		for (const n of ['surrealdb', 'dashboard'] as const) {
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

/** A deterministic probe double for readServices (health + discoverPid). */
class FakeProbeAdapter implements ServiceAdapter {
	readonly name: ServiceName = 'ollama';
	constructor(
		private readonly healthy: boolean,
		private readonly pidVal: number | null = null
	) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async health(): Promise<boolean> {
		return this.healthy;
	}
	pid(): number | null {
		return this.pidVal;
	}
	async discoverPid(): Promise<number | null> {
		return this.pidVal;
	}
}

describe('§14.4a/b readServices — probe reconciliation corrects the STALE ROW, never renders a dead pid', () => {
	it('RED-GREEN: a row claiming running with a DEAD probe reads stopped, pid hidden, last-seen honest — and the row itself is corrected', async () => {
		// The exact audit fixture: ollama’s persisted self-report says running (with a pid)
		// but the process has been gone for a day — the probe is the ground truth.
		await db.query(
			`UPSERT service:ollama CONTENT { name: 'ollama', status: 'running', pid: 76804, checked_at: d'2026-06-09T18:18:30Z' };`
		);
		__setOllamaAdapterForTest(db, new FakeProbeAdapter(false));

		const { services } = await readServices(db);
		const o = services.find((s) => s.name === 'ollama')!;
		expect(o.status).toBe('stopped'); // pre-fix the home rollup read this row as "up"
		expect(o.pid).toBeUndefined(); // 14.4b — NEVER the dead pid presented as current
		expect(o.liveHealthy).toBe(false);
		// "last seen" = the last instant the row claimed it was alive (honest).
		expect(o.lastSeenAt).toContain('2026-06-09T18:18:30');

		// The STALE ROW ITSELF got corrected (14.4a — F-008): status, pid UNSET, last_seen seeded.
		const [rows] = await db.query<[Array<{ status: string; pid?: number; last_seen_at?: unknown }>]>(
			`SELECT status, pid, last_seen_at FROM service:ollama;`
		);
		expect(rows[0].status).toBe('stopped');
		expect(rows[0].pid).toBeUndefined();
		expect(String(rows[0].last_seen_at)).toContain('2026-06-09T18:18:30');

		// And the home-facing rollup over the SAME views counts it DOWN (the red-green core).
		expect(summarizeServices(services)).toEqual({ up: 0, total: 1 });
	});

	it('a HEALTHY probe on a stale stopped row flips it back running with the LIVE pid (both view and row)', async () => {
		await db.query(
			`UPSERT service:ollama MERGE { name: 'ollama', status: 'stopped', checked_at: time::now() }; UPDATE service:ollama UNSET pid;`
		);
		__setOllamaAdapterForTest(db, new FakeProbeAdapter(true, 4321));

		const { services } = await readServices(db);
		const o = services.find((s) => s.name === 'ollama')!;
		expect(o.status).toBe('running');
		expect(o.pid).toBe(4321);
		expect(o.lastSeenAt).toBeTruthy(); // seen RIGHT NOW

		const [rows] = await db.query<[Array<{ status: string; pid?: number; last_seen_at?: unknown }>]>(
			`SELECT status, pid, last_seen_at FROM service:ollama;`
		);
		expect(rows[0].status).toBe('running');
		expect(rows[0].pid).toBe(4321);
		expect(rows[0].last_seen_at).toBeTruthy();

		expect(summarizeServices(services).up).toBe(1);
	});

	it('summarizeServices excludes honest-unknown services from the ratio (F-008)', async () => {
		// dashboard/engine/surrealdb have no rows and no probe here → unknown → excluded.
		await db.query(`DELETE service;`);
		__setOllamaAdapterForTest(db, new FakeProbeAdapter(false));
		const { services } = await readServices(db);
		// probe-false is REAL knowledge even with no row: ollama reads stopped, not unknown.
		expect(services.find((s) => s.name === 'ollama')!.status).toBe('stopped');
		expect(services.find((s) => s.name === 'dashboard')!.status).toBe('unknown');
		expect(summarizeServices(services)).toEqual({ up: 0, total: 1 });
	});
});

describe('SVC-2 — the declared service set matches the managed set, and status is honest', () => {
	const KNOWN_STATUSES: ServiceStatus[] = ['running', 'stopped', 'crashed', 'unknown'];

	it('SERVICE_NAMES has NO phantom name — engine is gone, the set is exactly the three real services', () => {
		// The dropped IN-PROCESS orchestrator must not linger in the declared set (F-008).
		expect((SERVICE_NAMES as readonly string[]).includes('engine')).toBe(false);
		expect([...SERVICE_NAMES].sort()).toEqual(['dashboard', 'ollama', 'surrealdb']);
	});

	it('the RENDERED set equals the DECLARED set exactly — every declared name renders, no extra row is fabricated', async () => {
		await db.query(`DELETE service;`); // no persisted rows: still renders the full declared set honestly
		const { services } = await readServices(db);
		expect(services.map((s) => s.name).sort()).toEqual([...SERVICE_NAMES].sort());
	});

	it('every CONTROLLABLE/registered service is in the declared set — no silently-managed service missing from the surface', async () => {
		// The production runtime registers exactly the controllable adapters; every one of them
		// MUST appear in the reported SERVICE_NAMES (the inverse-phantom: managed-but-unreported).
		const registered = getServicesManager(db).registered();
		expect(registered.length).toBeGreaterThan(0);
		for (const name of registered) {
			expect((SERVICE_NAMES as readonly string[]).includes(name)).toBe(true);
		}
		// And a declared service that is NOT registered is honestly non-controllable WITH a note
		// (a phantom would claim a control it cannot back). readServices carries that honesty.
		const { services } = await readServices(db);
		for (const view of services) {
			if (!registered.includes(view.name)) {
				expect(view.controllable, `${view.name} is not registered → must be non-controllable`).toBe(false);
				expect(view.note, `${view.name} must explain WHY it is not managed here`).toBeTruthy();
			}
		}
	});

	it('every per-service status is an HONEST known state — a service with no backing reads unknown, never a fabricated up', async () => {
		await db.query(`DELETE service;`); // no persisted rows for any service
		// Deterministic DOWN probe for ollama (no dependence on a real Ollama on the test host).
		__setOllamaAdapterForTest(db, new FakeProbeAdapter(false));
		const { services } = await readServices(db);
		for (const view of services) {
			expect(KNOWN_STATUSES, `${view.name} status must be a known state`).toContain(view.status);
			// No real "up" signal anywhere → NEVER a fabricated 'running' (F-008). ollama's probe
			// says down (→ stopped, real knowledge); surrealdb/dashboard have no probe + no row (→ unknown).
			expect(view.status, `${view.name} must not fabricate 'running' with no live signal`).not.toBe('running');
		}
		expect(services.find((s) => s.name === 'ollama')!.status).toBe('stopped'); // probe-false = real knowledge
		expect(services.find((s) => s.name === 'surrealdb')!.status).toBe('unknown');
		expect(services.find((s) => s.name === 'dashboard')!.status).toBe('unknown');
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
		await expect(operateService(db, 'dashboard', 'start')).rejects.toBeInstanceOf(ServiceControlError);
	});

	it('refuses a dropped/unknown service name (SVC-2 — engine is no longer a managed service)', async () => {
		await expect(operateService(db, 'engine', 'stop')).rejects.toBeInstanceOf(ServiceControlError);
	});
});
