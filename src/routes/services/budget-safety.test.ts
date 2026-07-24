// SD-1 — the /services budget-safety banner DATA path, against a REAL throwaway SurrealDB. The banner
// makes the runaway-spend hole VISIBLE: an ARMED autonomous loop (pm.autonomous=true) against an
// UNCAPPED (0) token ceiling. This test drives the actual +page.server.ts loader through the runtime
// DB singleton (initDb → tryGetDb, the same wiring the real request uses) and asserts the verdict flips
// on real rows — no stub. Shadow paths: disconnected DB (armed unknown ⇒ silent), armed+uncapped ⇒ loud,
// armed+capped ⇒ silent, disarmed+uncapped ⇒ silent.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject, deleteProject } from '$lib/server/projects/repo';
import { createPm, setPmAutonomous } from '$lib/server/projects/pm-repo';
import {
	__setBudgetForTest,
	__setPerProjectBudgetForTest
} from '$lib/server/analytics/spend-budget';
import { load, type ServicesPageData } from './+page.server';

let tdb: TestDb;
let db: Db;
let projectId: string;

/** Minimal load event — the loader only reads `depends` (live-invalidation key) + tryGetDb(). */
function loadEvent() {
	return { depends: () => {} } as unknown as Parameters<typeof load>[0];
}

/** Run the loader and narrow off the PageServerLoad `void | PageData` union (it always returns data). */
async function runLoad(): Promise<ServicesPageData> {
	return (await load(loadEvent())) as ServicesPageData;
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
	// Wire the runtime singleton so the real loader's tryGetDb() returns this test DB.
	db = await initDb({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const p = await createProject(db, {
		slug: 'svcbudget',
		name: 'Budget Host',
		root_path: 'F:/code/svcbudget'
	});
	projectId = p.id;
	await createPm(db, { project: projectId, name: 'PM' });
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await closeDb().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	// Start each case with the PM disarmed and deterministic (injected) caps.
	await setPmAutonomous(db, projectId, false);
});

describe('/services loader — SD-1 budget-safety banner data (real-surreal)', () => {
	it('LOUD: an ARMED loop + an UNCAPPED (0) daily ceiling ⇒ uncappedWhileArmed:true with a real armed count', async () => {
		__setBudgetForTest(0); // global uncapped
		__setPerProjectBudgetForTest(5_000_000); // per-project armed
		await setPmAutonomous(db, projectId, true);

		const data = await runLoad();
		expect(data.connected).toBe(true);
		expect(data.budgetSafety.armedLoops).toBeGreaterThanOrEqual(1);
		expect(data.budgetSafety.dailyUncapped).toBe(true);
		expect(data.budgetSafety.perProjectUncapped).toBe(false);
		expect(data.budgetSafety.uncappedWhileArmed).toBe(true);
	});

	it('SILENT: an ARMED loop but BOTH ceilings armed ⇒ uncappedWhileArmed:false (no hole)', async () => {
		__setBudgetForTest(15_000_000);
		__setPerProjectBudgetForTest(5_000_000);
		await setPmAutonomous(db, projectId, true);

		const data = await runLoad();
		expect(data.budgetSafety.armedLoops).toBeGreaterThanOrEqual(1);
		expect(data.budgetSafety.uncappedWhileArmed).toBe(false);
	});

	it('SILENT: NO loop armed even with BOTH ceilings uncapped ⇒ uncappedWhileArmed:false (armed count 0)', async () => {
		__setBudgetForTest(0);
		__setPerProjectBudgetForTest(0);
		// PM left disarmed by beforeEach.

		const data = await runLoad();
		expect(data.budgetSafety.armedLoops).toBe(0);
		expect(data.budgetSafety.dailyUncapped).toBe(true);
		expect(data.budgetSafety.perProjectUncapped).toBe(true);
		expect(data.budgetSafety.uncappedWhileArmed).toBe(false);
	});
});
