// TASK W-D7c CER1 VERIFY — integration proof for the day-0 ceremony DRIVER (authoring half,
// WORKFORCE-SPEC §8 steps ①+②) against a REAL throwaway SurrealDB.
//
// Proves the DRIVER wiring is HONEST end-to-end:
//   • ceremonyAuthoringState — day-0 empty (not seeded) → seeded shape → keyed/unkeyed states
//     (shadow paths: not-seeded nil pool, fixture with no key, fixture with a key);
//   • the SEED action is idempotent (re-run absorbs prior work, never duplicates — F-015);
//   • the confirmKey action wires the engine's operator guards as named feedback, NOT 500s:
//       - missing operatorConfirmed → 400 with the gate message (fail-closed, §8);
//       - teethless planted key      → 400 (override path also exercised);
//       - malformed plant            → 400 naming the plant;
//       - happy path                 → key created, surfaced keyed:true on re-load.
//
// The actions read tryGetDb() (the runtime singleton) — we init it with the test DB so the
// real action code runs unchanged. If the SurrealDB binary can't start, the suite skips
// honestly (never a faked artifact).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '$lib/server/db/client';
import { initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { ceremonyAuthoringState } from '$lib/server/workforce';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	// The provisioning/migration connection (root) — run the schema.
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	await db.close();
	// Init the runtime singleton the actions' tryGetDb() reads. Same DB, fresh handle.
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

/** Build a POST Request with form fields for an action call. */
function formRequest(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/agents/ceremony', { method: 'POST', body: fd });
}

// SvelteKit action handlers receive a RequestEvent; the two actions here only touch
// `request`, so a minimal stub suffices for the integration assertions.
function event(request: Request): Parameters<(typeof actions)['seed']>[0] {
	return { request } as Parameters<(typeof actions)['seed']>[0];
}

describe('day-0 ceremony DRIVER — authoring half (CER1)', () => {
	it('SHADOW: before seeding, authoring state is honestly empty (not seeded)', async () => {
		const state = await ceremonyAuthoringState(db);
		expect(state.seeded).toBe(false);
		expect(state.roles).toEqual([]);
		expect(state.keysOutstanding).toBe(0);
	});

	it('SEED action seeds the five launch roles + draft cores + proposed fixtures', async () => {
		const res = await actions.seed(event(formRequest({})));
		expect(res).toMatchObject({ ceremony: { ok: true, seeded: true } });
		const data = (res as { ceremony: Record<string, unknown> }).ceremony;
		expect(data.rolesTotal).toBe(5);
		expect(data.rolesCreated).toBe(5);

		const state = await ceremonyAuthoringState(db);
		expect(state.seeded).toBe(true);
		expect(state.roles.length).toBe(5);
		// Every role has a draft prompt core (step ①) + ≥1 candidate fixture (scorer_control
		// excluded), all UNKEYED at day 0 (honest: keysOutstanding > 0).
		for (const r of state.roles) {
			expect(r.promptCore).not.toBeNull();
			expect(r.promptCore?.lifecycle).toBe('draft');
			expect(r.fixtures.length).toBeGreaterThan(0);
			expect(r.fixtures.every((f) => f.kind !== 'scorer_control')).toBe(true);
			expect(r.fixtures.every((f) => f.keyed === false)).toBe(true);
		}
		expect(state.keysOutstanding).toBe(
			state.roles.reduce((n, r) => n + r.fixtures.length, 0)
		);
		// The A8 bait affordance is surfaced (isBait) so the UI can guide the operator.
		expect(state.roles.some((r) => r.fixtures.some((f) => f.isBait))).toBe(true);
	});

	it('SEED is idempotent — re-running absorbs prior work, creates nothing new (F-015)', async () => {
		const before = await ceremonyAuthoringState(db);
		const res = await actions.seed(event(formRequest({})));
		const data = (res as { ceremony: Record<string, unknown> }).ceremony;
		expect(data.rolesTotal).toBe(5);
		expect(data.rolesCreated).toBe(0); // all already present
		const after = await ceremonyAuthoringState(db);
		expect(after.roles.length).toBe(before.roles.length);
		expect(after.keysOutstanding).toBe(before.keysOutstanding);
	});

	it('GATE: confirmKey without operatorConfirmed fails closed with the named gate message', async () => {
		const state = await ceremonyAuthoringState(db);
		const fixture = state.roles[0].fixtures.find((f) => f.requiresPlants)!;
		const res = await actions.confirmKey(
			event(formRequest({ fixture: fixture.fixture, plants: '[]' }))
		);
		// fail(400, …) returns a { status, data } shape from @sveltejs/kit.
		expect((res as { status: number }).status).toBe(400);
		const err = (res as { data: { ceremony: { error: string } } }).data.ceremony.error;
		expect(err).toMatch(/confirm/i);
	});

	it('TEETH: a planted fixture with empty plants is rejected (teethless), override succeeds', async () => {
		const state = await ceremonyAuthoringState(db);
		const planted = state.roles
			.flatMap((r) => r.fixtures)
			.find((f) => f.kind === 'planted_defect' && !f.keyed)!;

		// Empty plants → teethless reject (named guard, not a 500).
		const reject = await actions.confirmKey(
			event(formRequest({ fixture: planted.fixture, plants: '[]', operatorConfirmed: 'on' }))
		);
		expect((reject as { status: number }).status).toBe(400);
		expect((reject as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/teethless|plant/i
		);

		// The override path: allowEmptyPlants + justification → confirmed on record.
		const ok = await actions.confirmKey(
			event(
				formRequest({
					fixture: planted.fixture,
					plants: '[]',
					operatorConfirmed: 'on',
					allowEmptyPlants: 'on',
					emptyPlantsJustification: 'control: no machine-checkable teeth, operator on record'
				})
			)
		);
		expect(ok).toMatchObject({ ceremony: { ok: true, created: true } });
	});

	it('MALFORMED: a plant that is not machine-checkable is rejected naming the plant', async () => {
		const state = await ceremonyAuthoringState(db);
		const target = state.roles
			.flatMap((r) => r.fixtures)
			.find((f) => f.kind === 'planted_defect' && !f.keyed)!;
		const res = await actions.confirmKey(
			event(
				formRequest({
					fixture: target.fixture,
					// Missing required scorer fields — parsePlant rejects at the confirm boundary.
					plants: JSON.stringify([{ nonsense: true }]),
					operatorConfirmed: 'on'
				})
			)
		);
		expect((res as { status: number }).status).toBe(400);
		expect((res as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/plant\[0\]|machine-checkable/i
		);
	});

	it('HAPPY: a well-formed plant confirms a key; re-load surfaces keyed:true with the diff', async () => {
		const state = await ceremonyAuthoringState(db);
		const target = state.roles
			.flatMap((r) => r.fixtures)
			.find((f) => f.kind === 'planted_defect' && !f.keyed)!;
		const plant = {
			id: 'committed-secret',
			class: 'committed-secret',
			severity: 'high',
			detection: { mode: 'presence', evidence_pattern: 'sk-live' }
		};
		const res = await actions.confirmKey(
			event(
				formRequest({
					fixture: target.fixture,
					plants: JSON.stringify([plant]),
					fp_tolerance: '0',
					fp_justification: 'zero FP tolerance for a committed-secret plant',
					operatorConfirmed: 'on'
				})
			)
		);
		expect(res).toMatchObject({ ceremony: { ok: true, created: true } });

		const after = await ceremonyAuthoringState(db);
		const reloaded = after.roles
			.flatMap((r) => r.fixtures)
			.find((f) => f.fixture === target.fixture)!;
		expect(reloaded.keyed).toBe(true);
		expect(reloaded.keyDiff).not.toBeNull();
		expect(reloaded.keyDiff?.plants.length).toBe(1);
		expect(reloaded.keyDiff?.fp_tolerance).toBe(0);
	});
});
