// LOOPS ACTION VERIFY — the /loops `pmSchedule` + `pmAutonomous` form actions against a REAL throwaway
// SurrealDB. The global Loops surface carries the target projectId IN THE FORM (unlike the per-project
// tab, which reads it from params), so the boundary here is: validate the form projectId (D-016), reuse
// the already-validated repo write paths (updatePmSchedule / setPmAutonomous) + the SAME parsers the
// trigger engine fires with (parseCron / parseDurationMs). The red-team is the action's boundary + error
// mapping:
//
//   • a valid cron (+offset) → 200, persisted (re-read via getPm) — no restart needed;
//   • a malformed cron → 400, nothing written;
//   • a bad / missing projectId → 400 (D-016);
//   • disarm (armed=false) → 200, pm.autonomous = false via setPmAutonomous;
//   • a well-formed id for a project with NO hired PM → 409 (never auto-hires).
//
// The action reads tryGetDb() (the runtime singleton) — we init it with the test DB so the real action
// code runs unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject } from '$lib/server/projects/repo';
import { createPm, getPm, setPmAutonomous } from '$lib/server/projects/pm-repo';
import { actions } from './+page.server';

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

function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

async function call(
	name: 'pmSchedule' | 'pmAutonomous',
	fields: Record<string, string>
): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions[name]({ request } as unknown as Parameters<typeof actions.pmSchedule>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

const pmOf = (r: { data: unknown }) => (r.data as { pm?: Record<string, unknown> })?.pm ?? {};

/** A fresh project WITH a hired PM (arming/scheduling never auto-hires). Returns the project record id. */
async function freshProjectWithPm(): Promise<string> {
	const slug = `loops_act_${++n}_${Date.now()}`;
	const project = await createProject(db, { slug, name: `Loops Act ${n}`, root_path: `F:/code/${slug}` });
	await createPm(db, { project: project.id, name: `PM ${n}`, persona: 'PM' });
	return project.id;
}

describe('/loops pmSchedule action — cadence editor (DB-MERGE, no restart)', () => {
	it('a valid cron + offset persists via updatePmSchedule → 200', async () => {
		const projectId = await freshProjectWithPm();
		const res = await call('pmSchedule', { projectId, cadence: '*/10 * * * *', cadenceOffset: '5m' });
		expect(res.status).toBe(200);
		expect(pmOf(res).ok).toBe(true);
		expect(pmOf(res).cadence).toBe('*/10 * * * *');
		const pm = await getPm(db, projectId);
		expect(pm?.cadence).toBe('*/10 * * * *');
		expect(pm?.cadence_offset).toBe('5m');
	}, 60_000);

	it('an empty cron CLEARS the schedule (the honest "no cadence")', async () => {
		const projectId = await freshProjectWithPm();
		await call('pmSchedule', { projectId, cadence: '0 9 * * 1-5', cadenceOffset: '' });
		const res = await call('pmSchedule', { projectId, cadence: '', cadenceOffset: '' });
		expect(res.status).toBe(200);
		const pm = await getPm(db, projectId);
		expect(pm?.cadence ?? null).toBeNull();
	}, 60_000);

	it('a malformed cron is refused 400 — nothing is written', async () => {
		const projectId = await freshProjectWithPm();
		const res = await call('pmSchedule', { projectId, cadence: 'not a cron', cadenceOffset: '' });
		expect(res.status).toBe(400);
		expect(String(pmOf(res).error)).toMatch(/cron/i);
		expect((await getPm(db, projectId))?.cadence ?? null).toBeNull();
	}, 60_000);

	it('a malformed offset is refused 400', async () => {
		const projectId = await freshProjectWithPm();
		const res = await call('pmSchedule', { projectId, cadence: '0 9 * * *', cadenceOffset: 'soon' });
		expect(res.status).toBe(400);
		expect(String(pmOf(res).error)).toMatch(/duration/i);
	}, 60_000);

	it('a missing / malformed projectId is refused 400 (D-016 boundary)', async () => {
		const missing = await call('pmSchedule', { projectId: '', cadence: '0 9 * * *', cadenceOffset: '' });
		expect(missing.status).toBe(400);
		expect(String(pmOf(missing).error)).toMatch(/project id/i);
		const bad = await call('pmSchedule', { projectId: 'not a record id', cadence: '0 9 * * *', cadenceOffset: '' });
		expect(bad.status).toBe(400);
	}, 60_000);

	it('a well-formed id for a project with NO hired PM → 409 (never auto-hires)', async () => {
		const slug = `loops_nopm_${++n}_${Date.now()}`;
		const project = await createProject(db, { slug, name: `No PM ${n}`, root_path: `F:/code/${slug}` });
		const res = await call('pmSchedule', { projectId: project.id, cadence: '0 9 * * *', cadenceOffset: '' });
		expect(res.status).toBe(409);
		expect(String(pmOf(res).error)).toMatch(/no pm/i);
	}, 60_000);
});

describe('/loops pmAutonomous action — pause/kill toggle (DB-MERGE, no restart)', () => {
	it('disarm (armed=false) sets pm.autonomous=false via setPmAutonomous → 200', async () => {
		const projectId = await freshProjectWithPm();
		await setPmAutonomous(db, projectId, true); // arm first (the loop card only exists while armed)
		const res = await call('pmAutonomous', { projectId, armed: 'false' });
		expect(res.status).toBe(200);
		expect(pmOf(res).ok).toBe(true);
		expect(pmOf(res).autonomous).toBe(false);
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	}, 60_000);

	it('arm (armed=true) sets pm.autonomous=true', async () => {
		const projectId = await freshProjectWithPm();
		const res = await call('pmAutonomous', { projectId, armed: 'true' });
		expect(res.status).toBe(200);
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
	}, 60_000);

	it('a bad projectId is refused 400 (D-016)', async () => {
		const res = await call('pmAutonomous', { projectId: 'not a record id', armed: 'false' });
		expect(res.status).toBe(400);
	}, 60_000);

	it('a well-formed id for a project with NO hired PM → 409 (arming never auto-hires)', async () => {
		const slug = `loops_arm_nopm_${++n}_${Date.now()}`;
		const project = await createProject(db, { slug, name: `Arm No PM ${n}`, root_path: `F:/code/${slug}` });
		const res = await call('pmAutonomous', { projectId: project.id, armed: 'true' });
		expect(res.status).toBe(409);
	}, 60_000);
});
