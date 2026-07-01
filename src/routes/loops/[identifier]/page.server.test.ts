// LOOPS DETAIL ROUTE VERIFY — the /loops/[identifier] loader + its actions against a REAL throwaway
// SurrealDB. Proves: the loader finds a loop by its DECODED (URL-encoded) identifier and reads its deep
// run history; an unknown identifier is an honest 404 (never a fabricated loop, F-008); a dead handle
// degrades to connected:false; the phase control POSTs loopPhase (persisted) and the enabled toggle
// persists via loopEnabled. The handler reads tryGetDb() (the runtime singleton) — we init it with the
// test DB so the real route code runs unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject } from '$lib/server/projects/repo';
import { createPm, setPmAutonomous, updatePmSchedule } from '$lib/server/projects/pm-repo';
import { writeAgentEvent } from '$lib/server/analytics/events';
import { getLoopManifest } from '$lib/server/loops/manifest';
import { load, actions } from './+page.server';
import type { LoopDetailData } from './+page.server';

let tdb: TestDb;
let db: Db;
let n = 0;

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

/** Invoke the real loader with a given (possibly URL-encoded) identifier param + no-op depends. */
async function runLoad(identifier: string): Promise<LoopDetailData> {
	const depends = () => {};
	return (await load({
		params: { identifier },
		depends
	} as unknown as Parameters<typeof load>[0])) as LoopDetailData;
}

function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

async function call(
	name: 'loopPhase' | 'loopEnabled',
	fields: Record<string, string>
): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions[name]({ request } as unknown as Parameters<typeof actions.loopEnabled>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

async function freshAutonomousProject(): Promise<string> {
	const slug = `loop_detail_${++n}_${Date.now()}`;
	const project = await createProject(db, { slug, name: `Loop Detail ${n}`, root_path: `F:/code/${slug}` });
	await createPm(db, { project: project.id, name: `PM ${n}`, persona: 'PM' });
	await setPmAutonomous(db, project.id, true);
	await updatePmSchedule(db, project.id, { cadence: '*/10 * * * *', cadenceOffset: null });
	return project.id;
}

describe('/loops/[identifier] loader — connected path', () => {
	it('finds a loop by its URL-ENCODED identifier (decoded in the loader) + reads its run history', async () => {
		const projectId = await freshAutonomousProject();
		await writeAgentEvent(db, { type: 'completion', project: projectId, detail: { summary: 'drove a task' } });

		const identifier = `pm-auto:${projectId}`;
		// Pass the ENCODED segment (identifiers carry ':') to prove the loader decodes it.
		const data = await runLoad(encodeURIComponent(identifier));
		expect(data.connected).toBe(true);
		expect(data.identifier).toBe(identifier);
		expect(data.loop?.id).toBe(identifier);
		expect(data.projectName).toBe(`Loop Detail ${n}`);
		expect(data.runs.length).toBeGreaterThan(0);
	}, 60_000);

	it('serves a GLOBAL loop (orch:drain) by its plain identifier', async () => {
		const data = await runLoad('orch:drain');
		expect(data.connected).toBe(true);
		expect(data.loop?.id).toBe('orch:drain');
	}, 60_000);

	it('an unknown identifier is an honest 404 (never a fabricated loop, F-008)', async () => {
		await expect(runLoad('nope:nothing')).rejects.toMatchObject({ status: 404 });
	}, 60_000);
});

describe('/loops/[identifier] actions — phase + enabled (DB-MERGE, no restart)', () => {
	it('loopPhase declares + promotes a loop to L2 (persisted)', async () => {
		const projectId = await freshAutonomousProject();
		const identifier = `pm-auto:${projectId}`;
		const res = await call('loopPhase', {
			identifier,
			kind: 'pm-autonomous',
			label: 'drive',
			projectId,
			phase: 'L2'
		});
		expect(res.status).toBe(200);
		expect((await getLoopManifest(db, identifier))?.phase).toBe('L2');
	}, 60_000);

	it('loopEnabled toggles enabled=false (persisted, reversible)', async () => {
		const projectId = await freshAutonomousProject();
		const identifier = `pm-auto:${projectId}`;
		const off = await call('loopEnabled', {
			identifier,
			kind: 'pm-autonomous',
			label: 'drive',
			projectId,
			enabled: 'false'
		});
		expect(off.status).toBe(200);
		expect((await getLoopManifest(db, identifier))?.enabled).toBe(false);
		const on = await call('loopEnabled', {
			identifier,
			kind: 'pm-autonomous',
			label: 'drive',
			projectId,
			enabled: 'true'
		});
		expect(on.status).toBe(200);
		expect((await getLoopManifest(db, identifier))?.enabled).toBe(true);
	}, 60_000);

	it('loopEnabled with a bad projectId is refused 400 (D-016 boundary)', async () => {
		const res = await call('loopEnabled', {
			identifier: 'pm-auto:whatever',
			kind: 'pm-autonomous',
			label: 'x',
			projectId: 'not a record id',
			enabled: 'false'
		});
		expect(res.status).toBe(400);
	}, 60_000);
});

describe('/loops/[identifier] loader — shadow path (honest degrade, D-019/F-008)', () => {
	it('a dead/closed DB handle ⇒ connected:false, never a fabricated loop', async () => {
		await closeDb();
		const data = await runLoad('orch:drain');
		expect(data.connected).toBe(false);
		expect(data.loop).toBeNull();
		expect(data.manifest).toBeNull();
	});
});
