// LOOPS ROUTE VERIFY — the /loops loader against a REAL throwaway SurrealDB. getLoops itself is
// exhaustively covered in loops/read.test.ts; this proves the LOADER's own contract: the connected
// path returns the aggregated loops + a project-id→name map for the grouped UI, and the two shadow
// paths (no DB / a dead handle) degrade to honest connected:false + empty (D-019, F-008), never a
// fabricated loop. The handler reads tryGetDb() (the runtime singleton) — we init it with the test DB
// so the real loader code runs unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject } from '$lib/server/projects/repo';
import { createPm, setPmAutonomous, updatePmSchedule } from '$lib/server/projects/pm-repo';
import { writeAgentEvent } from '$lib/server/analytics/events';
import { load } from './+page.server';
import type { LoopsData } from './+page.server';

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
	await db.close();
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
});

/** Invoke the real loader with a no-op `depends` (the only event arg the loader reads). */
async function runLoad(): Promise<LoopsData> {
	const depends = () => {};
	return (await load({ depends } as unknown as Parameters<typeof load>[0])) as LoopsData;
}

describe('/loops loader — connected path', () => {
	it('returns the aggregated loops + a project-id→name map', async () => {
		const project = await createProject(db, {
			slug: 'loops_route_a',
			name: 'Loops Route A',
			root_path: 'F:/code/loops-route-a'
		});
		const pm = await createPm(db, {
			project: project.id,
			name: 'Routy',
			persona: 'PM'
		});
		await setPmAutonomous(db, project.id, true);
		await updatePmSchedule(db, project.id, { cadence: '*/10 * * * *', cadenceOffset: null });
		await writeAgentEvent(db, {
			type: 'completion',
			project: project.id,
			detail: { summary: 'drove a ready task to done' }
		});

		const data = await runLoad();
		expect(data.connected).toBe(true);
		// The two GLOBAL orchestrator loops are always present, plus the per-project PM loops.
		const ids = data.loops.map((l) => l.id);
		expect(ids).toContain('orch:drain');
		expect(ids).toContain('orch:gc');
		expect(ids).toContain('mem-review');
		expect(ids).toContain(`pm-auto:${project.id}`);
		expect(ids).toContain(`pm-cadence:${pm.id}`);
		// The name map titles the per-project group with the REAL project name (no fabrication).
		expect(data.projectNames[project.id]).toBe('Loops Route A');
	});
});

describe('/loops loader — shadow paths (honest degrade, D-019/F-008)', () => {
	it('a dead/closed DB handle ⇒ connected:false + empty, never a fabricated loop', async () => {
		await closeDb();
		const data = await runLoad();
		expect(data).toEqual({
			connected: false,
			loops: [],
			manifest: [],
			manifestMap: {},
			declaredOnly: [],
			projectNames: {}
		});
	});
});
