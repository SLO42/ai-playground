// CCF-2 (CC-CONFIG-SPEC §3) — the /claude-code LOADER surfaces harvest-scope health. The capture
// itself is proven at the reconcile level (cc-config/sync.test.ts, both healthy + forced-error);
// this proves the LOADER's own contract: the connected path threads `reconcileScopes().harvestHealth`
// into the load output as a TYPED value (visible in `data`, not swallowed), and the DB-down shadow
// path degrades to `harvestHealth: null` (honest unknown — never a fabricated healthy state, F-008).
// The handler reads tryGetDb() (the runtime singleton); we init it with the throwaway test DB so the
// real loader code runs unchanged (mirrors loops/page.server.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import type { HarvestScopeHealth } from '$lib/server/cc-config';
import { load } from './+page.server';

let tdb: TestDb;
let db: Db;

// Pin the harness-owned harvest scope to a hermetic temp dir so the loader's reconcile never writes
// into the worktree's real `.harness/` tree. Env is read at call time; restored in afterAll.
let harvestRoot: string;
const prevHarvestEnv = process.env.HARVEST_SCOPE_ROOT;

/** The subset of the load output this test asserts on (the loader has no exported Data type). */
interface LoadShape {
	connected: boolean;
	harvestHealth: HarvestScopeHealth | null;
}

/** Invoke the real loader with a no-op `depends` + a bare `/claude-code` URL (no `?session=`). */
async function runLoad(): Promise<LoadShape> {
	const depends = () => {};
	const url = new URL('http://localhost/claude-code');
	return (await load({ depends, url } as unknown as Parameters<typeof load>[0])) as unknown as LoadShape;
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
	await db.close();

	harvestRoot = mkdtempSync(join(tmpdir(), 'cc-harvest-route-'));
	process.env.HARVEST_SCOPE_ROOT = harvestRoot;

	// The runtime singleton the loader's tryGetDb() reads — same DB, fresh handle.
	db = await initDb({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
}, 90_000);

afterAll(async () => {
	await closeDb().catch(() => {});
	await tdb?.teardown();
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
	if (prevHarvestEnv === undefined) delete process.env.HARVEST_SCOPE_ROOT;
	else process.env.HARVEST_SCOPE_ROOT = prevHarvestEnv;
});

describe('/claude-code loader — harvest-scope health (CCF-2)', () => {
	it('connected path surfaces a HEALTHY harvest-scope health in the load output (populated on success too)', async () => {
		const data = await runLoad();
		expect(data.connected).toBe(true);
		// The reconcile ensured the harvest scope → a typed healthy value is VISIBLE in `data`
		// (F-020 sweep: the reason is not dropped — the field is present on the happy path).
		expect(data.harvestHealth).not.toBeNull();
		expect(data.harvestHealth?.status).toBe('healthy');
		if (data.harvestHealth?.status === 'healthy') {
			expect(data.harvestHealth.scopeId).toMatch(/^cc_scope:/);
		}
	});

	it('DB-down shadow path ⇒ harvestHealth is null (honest unknown, never a fabricated healthy state)', async () => {
		await closeDb();
		const data = await runLoad();
		expect(data.connected).toBe(false);
		expect(data.harvestHealth).toBeNull();
	});
});
