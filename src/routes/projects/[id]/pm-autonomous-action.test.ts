// PMA ACTION VERIFY — the /projects/[id] `pmAutonomous` + `pmAutoPublish` form actions against a REAL
// throwaway SurrealDB. These are the SAFETY toggles behind the Overview "Run autonomously to release"
// control: arm/disarm the unsupervised loop, and the operator's pre-authorize-auto-publish consent
// (default OFF). The red-team here is the actions' boundary + integrity invariants:
//
//   • ARM is readiness-GATED (LP-3 — the SAME arm gate as /loops): a not-green Design Checklist blocks
//     409 with the missing items; a green checklist or an explicit operator override arms (200);
//   • DISARM (the kill switch) is NEVER gated and flips pm.autonomous=false (200);
//   • pre-authorize true/false flips pm.auto_publish_preauthorized and returns it (200);
//   • the two flags are INDEPENDENT — arming never auto-publishes, opting in never disarms;
//   • a project with NO hired PM → 409 for BOTH (never auto-hires — integrity LOCKED);
//   • an invalid project id → 400 (boundary, never an interpolated query).
//
// The actions read tryGetDb() (the runtime singleton) — we init it with the test DB so the real action
// code runs unchanged. F-008: every assertion reads back the live persisted pm row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createPm, getPm } from '$lib/server/projects/pm-repo';
import { setLoopChecklistItem, upsertLoopManifest } from '$lib/server/loops/manifest';
import { pmAutonomousLoopIdentifier } from '$lib/server/loops/arm-gate';
import { READINESS_CHECKLIST } from '$lib/components/loops/readiness-core';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;

/** A fresh project (returns its slug) — pmProjectId(params.id) resolves against the bare slug. */
async function freshProjectSlug(tag: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `${tag}_${Date.now()}`, slug: `${tag}` }
	);
	return String(rows[0].id).slice('project:'.length);
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
	// Re-init as the runtime singleton so the action's tryGetDb() returns this DB.
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

type ActionRes = { status: number; data: unknown };

async function call(
	action: 'pmAutonomous' | 'pmAutoPublish',
	slug: string,
	fields: Record<string, string>
): Promise<ActionRes> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions[action]({
		request,
		params: { id: slug }
	} as unknown as Parameters<(typeof actions)[typeof action]>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

const pmOf = (r: ActionRes) => (r.data as { pm?: Record<string, unknown> })?.pm ?? {};

/** Green the pm-autonomous loop's Design Checklist so an ungated arm is reachable (mirrors /loops). */
async function greenChecklist(projectId: string): Promise<void> {
	const identifier = pmAutonomousLoopIdentifier(projectId);
	await upsertLoopManifest(db, { identifier, kind: 'pm-autonomous', label: 'test loop', projectId });
	for (const item of READINESS_CHECKLIST) await setLoopChecklistItem(db, identifier, item.id, true);
}

describe('/projects/[id] pmAutonomous action — arm/disarm the unsupervised loop (readiness-gated arm)', () => {
	it('arm is BLOCKED 409 when the readiness checklist is not green — nothing armed, missing surfaced', async () => {
		const slug = await freshProjectSlug('pma_arm_blocked');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		const res = await call('pmAutonomous', slug, { armed: 'true' });
		expect(res.status).toBe(409);
		expect((pmOf(res).missing as string[]).length).toBe(READINESS_CHECKLIST.length);
		expect((await getPm(db, `project:${slug}`))?.autonomous).toBe(false);
	});

	it('arms a hired PM once the checklist is green (200); the live row reads autonomous=true', async () => {
		const slug = await freshProjectSlug('pma_arm_act');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		await greenChecklist(`project:${slug}`);
		const res = await call('pmAutonomous', slug, { armed: 'true' });
		expect(res.status).toBe(200);
		expect(pmOf(res).action).toBe('autonomous');
		expect(pmOf(res).autonomous).toBe(true);
		expect((await getPm(db, `project:${slug}`))?.autonomous).toBe(true);
	});

	it('arm with override=true arms a not-ready loop (operator is sovereign; recorded)', async () => {
		const slug = await freshProjectSlug('pma_arm_override');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		const res = await call('pmAutonomous', slug, {
			armed: 'true',
			override: 'true',
			overrideReason: 'operator go'
		});
		expect(res.status).toBe(200);
		expect(pmOf(res).autonomous).toBe(true);
		expect(pmOf(res).overridden).toBe(true);
		expect((await getPm(db, `project:${slug}`))?.autonomous).toBe(true);
	});

	it('disarms (armed=false) → autonomous=false — the kill switch is NEVER gated', async () => {
		const slug = await freshProjectSlug('pma_disarm_act');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		await call('pmAutonomous', slug, { armed: 'true', override: 'true' });
		const res = await call('pmAutonomous', slug, { armed: 'false' });
		expect(res.status).toBe(200);
		expect(pmOf(res).autonomous).toBe(false);
	});

	it('no PM hired → 409 (never auto-hires — integrity LOCKED)', async () => {
		const slug = await freshProjectSlug('pma_arm_nopm');
		const res = await call('pmAutonomous', slug, { armed: 'true' });
		expect(res.status).toBe(409);
		expect(await getPm(db, `project:${slug}`)).toBeNull();
	});

	it('invalid project id → 400 (boundary)', async () => {
		const res = await call('pmAutonomous', 'has spaces/bad', { armed: 'true' });
		expect(res.status).toBe(400);
	});
});

describe('/projects/[id] pmAutoPublish action — pre-authorize-auto-publish opt-in (default OFF)', () => {
	it('opts in (200); the live row reads auto_publish_preauthorized=true; arm flag untouched', async () => {
		const slug = await freshProjectSlug('pma_pub_in');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		// Arm via the operator override (the readiness gate would otherwise block a fresh loop).
		await call('pmAutonomous', slug, { armed: 'true', override: 'true' });
		const res = await call('pmAutoPublish', slug, { preauthorized: 'true' });
		expect(res.status).toBe(200);
		expect(pmOf(res).action).toBe('autoPublish');
		expect(pmOf(res).autoPublishPreauthorized).toBe(true);
		const row = await getPm(db, `project:${slug}`);
		expect(row?.auto_publish_preauthorized).toBe(true);
		// Opting in to auto-publish must NOT disarm the loop (independent flags).
		expect(row?.autonomous).toBe(true);
	});

	it('opts back out (preauthorized=false) → false (publish returns to operator-gated)', async () => {
		const slug = await freshProjectSlug('pma_pub_out');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		await call('pmAutoPublish', slug, { preauthorized: 'true' });
		const res = await call('pmAutoPublish', slug, { preauthorized: 'false' });
		expect(res.status).toBe(200);
		expect(pmOf(res).autoPublishPreauthorized).toBe(false);
		expect((await getPm(db, `project:${slug}`))?.auto_publish_preauthorized).toBe(false);
	});

	it('a malformed/missing flag defaults to OFF (never silently opts in)', async () => {
		const slug = await freshProjectSlug('pma_pub_default');
		await createPm(db, { project: `project:${slug}`, name: 'Vesper' });
		const res = await call('pmAutoPublish', slug, {}); // no preauthorized field
		expect(res.status).toBe(200);
		expect(pmOf(res).autoPublishPreauthorized).toBe(false);
	});

	it('no PM hired → 409 (never auto-hires)', async () => {
		const slug = await freshProjectSlug('pma_pub_nopm');
		const res = await call('pmAutoPublish', slug, { preauthorized: 'true' });
		expect(res.status).toBe(409);
		expect(await getPm(db, `project:${slug}`)).toBeNull();
	});
});
