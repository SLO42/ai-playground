// D-016 RECORD-ID SCOPE on the /projects/[id]/targets `remove` action — REAL SurrealDB (F-020: a
// stubDb does not parse the DELETE this action issues, and the DELETE is the whole subject).
//
// This was the most severe instance of the shape-only-id class found in the sweep, because the
// statement behind it is a bare `DELETE $rid`: no enum, no state machine and no FK stands between
// a posted id and the row's removal. `remove` validated the posted `targetId` with the shape-only
// `assertRecordId` and passed it straight to `removeTarget`, so ANY well-formed `table:id` was
// deleted and `{ remove: { ok: true } }` returned.
//
// Note what did NOT protect it: every OTHER targetId path on this route (run/dryRun/confirm/verify)
// goes through `resolveTarget` in adapters/driver.ts, which checks `t.project !== projectId` and
// refuses. `remove` was the one call path that bypassed that resolve and called the repo directly —
// the F-055 shape exactly (a gate that exists, and a new path around it).
//
// The malformed-id case was always rejected; the test that matters feeds WELL-FORMED ids.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { declareTarget, getTarget, removeTarget } from '$lib/server/adapters/registry';
import { StringRecordId } from 'surrealdb';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;
let thisProjectId = '';
let thisSlug = '';
let otherProjectId = '';

async function makeProject(seed: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/tgt' } RETURN id;`,
		{ id: `${seed}_${Date.now()}`, slug: seed.replace(/_/g, '-') }
	);
	return String(rows[0].id);
}

async function rawRow(id: string): Promise<Record<string, unknown> | undefined> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
		rid: new StringRecordId(id)
	});
	return rows[0];
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
	thisProjectId = await makeProject('tgt_this');
	otherProjectId = await makeProject('tgt_other');
	thisSlug = thisProjectId.slice('project:'.length);
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

type ActionResult = { status: number; data: Record<string, unknown> };

async function callRemove(targetId: string): Promise<ActionResult> {
	const f = new FormData();
	f.set('targetId', targetId);
	const request = { formData: async () => f } as unknown as Request;
	const res = (await actions.remove!({
		request,
		params: { id: thisSlug }
	} as unknown as Parameters<NonNullable<(typeof actions)['remove']>>[0])) as Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: res.status as number, data: res.data as Record<string, unknown> };
	}
	return { status: 200, data: res };
}

const removeOf = (r: ActionResult) => (r.data.remove ?? {}) as Record<string, unknown>;

describe('targets remove refuses ids that are not a project_target of THIS project', () => {
	it('a well-formed id in ANOTHER TABLE is a 400 and that row still exists', async () => {
		// The project row itself — a real, existing, well-formed id. Under the shape-only guard
		// this DELETED the project.
		const res = await callRemove(otherProjectId);

		expect(res.status).toBe(400);
		expect(String(removeOf(res).error)).toMatch(/invalid target id/);
		expect(await rawRow(otherProjectId)).toBeDefined();
	});

	it("ANOTHER project's target is a 404 and is NOT deleted", async () => {
		const foreign = await declareTarget(db, {
			project: otherProjectId,
			kind: 'publish',
			adapterId: 'npm',
			label: 'the other project’s publish target'
		});

		const res = await callRemove(foreign.id);
		expect(res.status).toBe(404);
		expect(String(removeOf(res).error)).toMatch(/not found/);
		// The refusal is a refusal — the target survives, intact.
		expect(await getTarget(db, foreign.id)).not.toBeNull();
	});

	it('this project\'s own target is still removable — the guard refuses foreigners only', async () => {
		const mine = await declareTarget(db, {
			project: thisProjectId,
			kind: 'publish',
			adapterId: 'npm',
			label: 'mine'
		});

		const res = await callRemove(mine.id);
		expect(res.status).toBe(200);
		expect(removeOf(res).ok).toBe(true);
		expect(await getTarget(db, mine.id)).toBeNull();
	});

	it('a malformed id is still a 400 (the check that already worked keeps working)', async () => {
		const res = await callRemove('not a record id');
		expect(res.status).toBe(400);
		expect(String(removeOf(res).error)).toMatch(/invalid target id/);
	});

	it('the repo chokepoint refuses a non-target id for every future caller', async () => {
		// `removeTarget` must hold on its own: it is the function that owns the DELETE.
		await expect(removeTarget(db, thisProjectId)).rejects.toThrow(
			/is in table 'project'.*'project_target' record id is required/s
		);
		expect(await rawRow(thisProjectId)).toBeDefined();
	});
});
