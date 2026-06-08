import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { ServicesManager } from './manager';
import { SurrealServiceAdapter } from './surreal-adapter';
import { listIncidents, listUnreadNotifications } from './incidents';
import { isPidAlive, killPid } from './proc';

// TASK 3.5 VERIFY (integration) — kill the SurrealDB process and the services manager
// AUTO-RESTARTS it AND writes an `incident` row, using the REAL provisioned SurrealDB
// binary (F-008: real lifecycle, real DB rows; no fakes).
//
// Topology: the manager's bookkeeping DB is a throwaway harness DB (startTestDb). The
// SUPERVISED service is a SEPARATE managed SurrealServer pinned to a FIXED loopback
// port + data dir (so a restart reconnects on the same endpoint). We kill THAT
// supervised server's OS process (taskkill //F //PID — F-001/F-002), then tick() and
// assert: the dead pid is observed (Windows-safe tasklist), an incident is recorded,
// and the service comes back healthy on a new pid.

let tdb: TestDb;
let db: Db;
let manager: ServicesManager;
let adapter: SurrealServiceAdapter;
let supervisedDir: string;

// A free fixed loopback port for the supervised server (stable across restarts).
async function freePort(): Promise<number> {
	const { createServer } = await import('node:net');
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = addr && typeof addr === 'object' ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

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

	supervisedDir = mkdtempSync(join(tmpdir(), 'svc-surreal-'));
	const port = await freePort();
	adapter = new SurrealServiceAdapter({
		dataDir: supervisedDir,
		bind: `127.0.0.1:${port}`,
		username: 'root',
		password: 'root'
	});

	manager = new ServicesManager(db, { maxRestarts: 3 });
	manager.register(adapter);
	await manager.start('surrealdb');
}, 90_000);

afterAll(async () => {
	await manager?.stop('surrealdb').catch(() => {});
	await db?.close();
	await tdb?.teardown();
	if (supervisedDir) rmSync(supervisedDir, { recursive: true, force: true });
});

describe('§3.5 ServicesManager — SurrealDB crash + auto-restart', () => {
	it('starts the supervised SurrealDB and records it running', async () => {
		expect(adapter.pid()).toBeTypeOf('number');
		expect(await adapter.health()).toBe(true);
		const svcs = await manager.listServices();
		const row = svcs.find((s) => s.name === 'surrealdb');
		expect(row?.status).toBe('running');
		expect(row?.pid).toBe(adapter.pid());
	});

	it('a healthy tick does NOT write an incident', async () => {
		const before = (await listIncidents(db)).length;
		const [result] = await manager.tick();
		expect(result.wasDown).toBe(false);
		expect(result.restarted).toBe(false);
		expect(result.healthy).toBe(true);
		expect((await listIncidents(db)).length).toBe(before);
	});

	it('killing the SurrealDB process → auto-restart + an incident row', async () => {
		const deadPid = adapter.pid()!;
		expect(await isPidAlive(deadPid)).toBe(true);

		// Kill the REAL supervised SurrealDB process (Windows-safe taskkill //F //PID).
		await killPid(deadPid);
		// Give the OS a moment to reap the process so tasklist no longer reports it.
		for (let i = 0; i < 40; i++) {
			if (!(await isPidAlive(deadPid))) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(await isPidAlive(deadPid)).toBe(false);

		const incidentsBefore = (await listIncidents(db)).length;

		// Reconcile: manager observes the dead pid, logs an incident, auto-restarts.
		const [result] = await manager.tick();

		expect(result.name).toBe('surrealdb');
		expect(result.wasDown).toBe(true);
		expect(result.restarted).toBe(true);
		expect(result.healthy).toBe(true);
		expect(result.incident).not.toBeNull();
		expect(result.incident?.severity).toBe('error');
		expect(result.incident?.title).toContain('surrealdb');

		// An incident row was persisted to the DB (not just returned).
		const incidents = await listIncidents(db);
		expect(incidents.length).toBeGreaterThan(incidentsBefore);
		expect(incidents.some((i) => i.title.includes('surrealdb') && i.severity === 'error')).toBe(true);

		// A crash + recovery notification was surfaced.
		const notes = await listUnreadNotifications(db);
		expect(notes.some((n) => n.message.includes('crashed'))).toBe(true);
		expect(notes.some((n) => n.message.includes('recovered'))).toBe(true);

		// The service is back up on a NEW, live pid, and the service row reflects it.
		const newPid = adapter.pid()!;
		expect(newPid).not.toBe(deadPid);
		expect(await isPidAlive(newPid)).toBe(true);
		expect(await adapter.health()).toBe(true);

		const svcs = await manager.listServices();
		const row = svcs.find((s) => s.name === 'surrealdb');
		expect(row?.status).toBe('running');
		expect(row?.pid).toBe(newPid);
	}, 90_000);
});
