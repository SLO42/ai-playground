import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { declareTarget, listTargetRuns } from './registry';
import { runSyncTarget } from './driver';
import { buildAdapterCatalog, installedIds, isInstalled, ADAPTER_KINDS } from './catalog';
import { resetAdapterRegistry } from './index';
import { getSyncRegistry, resetSyncRegistry } from '../sync';
import type { SyncAdapter, SyncProbe, SyncResult, SyncRunOptions } from '../sync/adapter';

// TASK 12.4 VERIFY (D-038) — the UNIFIED adapter catalog (all three D-037 families) + the SYNC
// retrofit (GitHub sync resolved + driven as a registry adapter through the unified target_run
// ledger) + the CUSTOM-target scale story (a novel adapter id declares cleanly + reports honest
// "not installed"). Runs against a REAL throwaway SurrealDB. The GitHub round-trip uses a FAKE
// client (allowed in a test); the live `gh` round-trip is the documented deferred proof.

/**
 * A minimal in-memory fake SyncAdapter under a NOVEL id — proves the driver resolves a registered
 * sync adapter, drives it, and records the unified target_run row WITHOUT touching the real `gh`
 * boundary (the github adapter's live round-trip is covered hermetically in github.test.ts).
 */
class FakeSyncAdapter implements SyncAdapter {
	readonly id = 'fake-sync';
	readonly label = 'Fake sync';
	syncCalls = 0;
	async probe(): Promise<SyncProbe> {
		return { available: true, target: 'fake/repo' };
	}
	async sync(_db: Db, opts: SyncRunOptions): Promise<SyncResult> {
		this.syncCalls++;
		return {
			target: 'fake/repo',
			direction: opts.direction ?? 'both',
			dryRun: opts.dryRun ?? false,
			created: 1,
			updated: 0,
			pulled: 0,
			linked: 0,
			skipped: 0,
			items: [{ taskId: 'task:demo', action: 'created', externalId: '1' }],
			errors: []
		};
	}
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let projectDir: string;

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
	projectDir = await mkdtemp(join(tmpdir(), 'atelier-cat-'));
	await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'atelier-demo', version: '0.4.0' }), 'utf8');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	await rm(projectDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
	resetAdapterRegistry();
	resetSyncRegistry();
	await db.query('DELETE target_run; DELETE project_target; DELETE task_sync; DELETE task; DELETE project;').catch(() => {});
	const p = await createProject(db, { slug: 'demo', name: 'Demo', root_path: projectDir });
	projectId = p.id;
});

describe('unified adapter catalog (all three D-037 families)', () => {
	it('spans publish + deploy + sync, each entry honest + installed', async () => {
		const catalog = await buildAdapterCatalog({ env: {}, cwd: projectDir, db, projectId });
		const byKind = new Map<string, number>();
		for (const e of catalog) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
		// Every D-037 family appears.
		for (const k of ADAPTER_KINDS) expect(byKind.get(k) ?? 0).toBeGreaterThan(0);
		// The GitHub task↔issue sync (9.4) is now a first-class registry adapter (the retrofit).
		const github = catalog.find((e) => e.kind === 'sync' && e.id === 'github');
		expect(github).toBeDefined();
		expect(github!.installed).toBe(true);
		// Sync adapters declare no env secrets (gh-auth keychain, D-026).
		expect(github!.secrets).toEqual([]);
		// Every entry has an honest probe object (never throws).
		for (const e of catalog) expect(typeof e.probe.available).toBe('boolean');
	});

	it('installedIds + isInstalled report the registered ids per kind', () => {
		const ids = installedIds();
		expect(ids.publish.has('npm')).toBe(true);
		expect(ids.publish.has('thunderstore')).toBe(true);
		expect(ids.deploy.has('static-host')).toBe(true);
		expect(ids.sync.has('github')).toBe(true);
		expect(ids.sync.has('github-board')).toBe(true);
		expect(isInstalled('sync', 'github')).toBe(true);
		expect(isInstalled('sync', 'totally-custom')).toBe(false);
		expect(isInstalled('publish', 'my-cdn')).toBe(false);
	});
});

describe('custom-target scale story (D-037)', () => {
	it('declares a CUSTOM adapter id cleanly and reports it as NOT installed', async () => {
		const t = await declareTarget(db, {
			project: projectId,
			kind: 'deploy',
			adapterId: 'my-cdn',
			label: 'My CDN',
			config: { host: 'cdn.example.com', secret_ref: 'MY_CDN_TOKEN' }
		});
		expect(t.adapter_id).toBe('my-cdn');
		// The config carries only a secret NAME, never a value (D-026).
		expect(t.config.secret_ref).toBe('MY_CDN_TOKEN');
		// Honest: the core ships no adapter for this id.
		expect(isInstalled('deploy', 'my-cdn')).toBe(false);
	});
});

describe('sync retrofit — github sync driven through the registry + unified ledger (12.4a)', () => {
	it('resolves a registered sync adapter, drives it (dry-run) + records a unified target_run row', async () => {
		// Register a fake sync adapter under a novel id (the github adapter is already seeded as a
		// real registry adapter — proven hermetically in github.test.ts; here we exercise the DRIVER).
		const fake = new FakeSyncAdapter();
		getSyncRegistry().register(fake);
		await createTask(db, { project: projectId, title: 'first task', description: 'sync me' });
		await declareTarget(db, { project: projectId, kind: 'sync', adapterId: 'fake-sync', isDefault: true });

		const out = await runSyncTarget({ db, projectId, cwd: projectDir, dryRun: true });
		expect(out.target.adapter_id).toBe('fake-sync');
		expect(fake.syncCalls).toBe(1);
		expect(out.result.dryRun).toBe(true);
		expect(out.run.kind).toBe('sync');
		expect(out.run.dry_run).toBe(true);
		expect(out.run.ok).toBe(true);

		const runs = await listTargetRuns(db, projectId);
		expect(runs.some((r) => r.kind === 'sync' && r.adapter_id === 'fake-sync')).toBe(true);
	});

	it('fails CLOSED when the declared sync adapter id is UNKNOWN to the registry (D-037)', async () => {
		await declareTarget(db, { project: projectId, kind: 'sync', adapterId: 'totally-custom', isDefault: true });
		await expect(runSyncTarget({ db, projectId, cwd: projectDir, dryRun: true })).rejects.toThrow(
			/no sync adapter registered/
		);
	});

	it('fails CLOSED with an honest error when NO sync target is configured', async () => {
		await expect(runSyncTarget({ db, projectId, cwd: projectDir, dryRun: true })).rejects.toThrow(
			/no sync target configured/
		);
	});
});
