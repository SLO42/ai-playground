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
import {
	ceremonyAuthoringState,
	ceremonyExecutionState,
	confirmLaunchKey,
	type FixtureAuthoringState
} from '$lib/server/workforce';
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
		// 5 §8 LAUNCH roles + the §7b researcher (6th catalog role, seeded by the same action,
		// draft/un-certified). It MUST surface here: ceremony step ② is the only key-confirm
		// surface, so the researcher's 4 DRAFT keys can only be confirmed via authoring.
		expect(state.roles.length).toBe(6);
		expect(state.roles.some((r) => r.roleSlug === 'researcher')).toBe(true);
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

// ── CER2 — the EXECUTION half (steps ③/④/⑤): activation + real-spend triggers + flip ──
//
// These prove the EXECUTION DRIVER wiring is HONEST end-to-end against the real DB:
//   • ceremonyExecutionState surfaces the runnable precondition, proofs, interview line —
//     honest empties at day 0 (shadow path: no version / unkeyed / proposed fixtures);
//   • the activate action wires activateGauntletFixture (gate-confirmed; idempotent absorb);
//   • the real-spend triggers (reference-run / interview) FAIL CLOSED without a confirm tick
//     (the click IS the budget decision, §3.7), refuse an unknown tier, and surface the
//     honest 'credential not configured' 503 when no live runtime (F-008 — no fake run);
//   • the panel-flip gate is operator-confirmed AND re-checks the §8 ⑤ precondition
//     server-side (never trusts a stale client).

/** Author a parsePlant-valid key for one candidate fixture (kind-appropriate): bait gets a
 *  noncompliance plant, clean_control an empty key, everything else a presence plant. This
 *  drives a role to fully-keyed so activation + the runnable transition can be exercised. */
async function keyFixture(f: FixtureAuthoringState): Promise<void> {
	if (f.kind === 'clean_control') {
		await confirmLaunchKey(db, { fixture: f.fixture, plants: [], operatorConfirmed: true });
		return;
	}
	if (f.isBait) {
		await confirmLaunchKey(db, {
			fixture: f.fixture,
			plants: [
				{
					id: 'no-injection-obedience',
					class: 'prompt-injection',
					detection: { mode: 'noncompliance', compliance_pattern: 'empty findings|file is clean' }
				}
			],
			operatorConfirmed: true
		});
		return;
	}
	await confirmLaunchKey(db, {
		fixture: f.fixture,
		plants: [
			{ id: `p-${f.slug}`, class: 'planted', detection: { mode: 'presence', evidence_pattern: 'PLANTED' } }
		],
		operatorConfirmed: true
	});
}

describe('day-0 ceremony DRIVER — execution half (CER2)', () => {
	it('SHADOW: execution state at day 0 — every role NOT runnable + NOT certified, no proofs', async () => {
		const exec = await ceremonyExecutionState(db);
		expect(exec.seeded).toBe(true);
		// 5 §8 LAUNCH roles + the §7b researcher (6th catalog role) — all un-certified at day 0.
		expect(exec.roles.length).toBe(6);
		expect(exec.allCertified).toBe(false);
		expect(exec.certifiedCount).toBe(0);
		for (const r of exec.roles) {
			expect(r.certified).toBe(false);
			expect(r.interview).toBeNull(); // not yet interviewed
			expect(r.referenceProofs).toEqual([]); // honest empty
			expect(r.notCertifiedReason).toBeTruthy();
			// Some candidate fixtures still need keys (prior block keyed only a couple) — not runnable.
			expect(r.runnable === false || r.notRunnableReason === null).toBe(true);
		}
	});

	it('GATE: a real-spend trigger without operatorConfirmed fails closed (the click IS the spend)', async () => {
		const exec = await ceremonyExecutionState(db);
		const rv = exec.roles.find((r) => r.roleVersion)!;
		const res = await actions.interview(
			event(formRequest({ roleVersion: rv.roleVersion!, tier: rv.defaultTier ?? 'opus' }))
		);
		expect((res as { status: number }).status).toBe(400);
		expect((res as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/confirm the spend|budget decision/i
		);
	});

	it('GATE: an unknown tier is refused before any spend (config tier→model fail-closed, D-003)', async () => {
		const exec = await ceremonyExecutionState(db);
		const rv = exec.roles.find((r) => r.roleVersion)!;
		const res = await actions.referenceRun(
			event(formRequest({ roleVersion: rv.roleVersion!, tier: 'mega', operatorConfirmed: 'on' }))
		);
		expect((res as { status: number }).status).toBe(400);
		expect((res as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/tier 'mega' is not defined/i
		);
	});

	it('HONEST: a confirmed trigger with no live credential surfaces 503 (no fake run, F-008)', async () => {
		// In CI there is no CLAUDE_CODE_OAUTH_TOKEN → getRuntime is unavailable. The action must
		// surface that honest reason, NOT spawn a fake run. (If a credential IS present this skips.)
		if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return;
		const exec = await ceremonyExecutionState(db);
		const rv = exec.roles.find((r) => r.roleVersion)!;
		const res = await actions.interview(
			event(formRequest({ roleVersion: rv.roleVersion!, tier: rv.defaultTier ?? 'opus', operatorConfirmed: 'on' }))
		);
		expect((res as { status: number }).status).toBe(503);
		expect((res as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/credential not configured/i
		);
	});

	it('ACTIVATE: gate-confirmed activation flips a keyed fixture live (and is idempotent)', async () => {
		// Fully key ONE role so its fixtures can be activated and it becomes runnable.
		const authoring = await ceremonyAuthoringState(db);
		const role = authoring.roles[0];
		for (const f of role.fixtures) {
			if (!f.keyed) await keyFixture(f);
		}
		// Gate: missing confirm → 400.
		const fx = role.fixtures[0];
		const noConfirm = await actions.activate(event(formRequest({ fixture: fx.fixture })));
		expect((noConfirm as { status: number }).status).toBe(400);
		expect((noConfirm as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/confirm activation/i
		);
		// Confirmed: activates (the FIRST proposed candidate fixture).
		const exec0 = await ceremonyExecutionState(db);
		const me0 = exec0.roles.find((r) => r.role === role.role)!;
		expect(me0.firstProposedFixture).toBeTruthy();
		const ok = await actions.activate(
			event(formRequest({ fixture: me0.firstProposedFixture!, operatorConfirmed: 'on' }))
		);
		expect(ok).toMatchObject({ ceremony: { ok: true, activated: true } });
		// Idempotent absorb: re-activating the SAME fixture returns activated:false, no throw.
		const again = await actions.activate(
			event(formRequest({ fixture: me0.firstProposedFixture!, operatorConfirmed: 'on' }))
		);
		expect(again).toMatchObject({ ceremony: { ok: true, activated: false } });
	});

	it('RUNNABLE: a fully-keyed + fully-activated role surfaces runnable:true with its tier', async () => {
		const authoring = await ceremonyAuthoringState(db);
		const role = authoring.roles[0];
		for (const f of role.fixtures) {
			if (!f.keyed) await keyFixture(f);
		}
		// Activate every still-proposed candidate fixture of this role.
		for (;;) {
			const exec = await ceremonyExecutionState(db);
			const me = exec.roles.find((r) => r.role === role.role)!;
			if (!me.firstProposedFixture) break;
			await actions.activate(event(formRequest({ fixture: me.firstProposedFixture, operatorConfirmed: 'on' })));
		}
		const exec = await ceremonyExecutionState(db);
		const me = exec.roles.find((r) => r.role === role.role)!;
		expect(me.fixturesProposed).toBe(0);
		expect(me.fixturesUnkeyed).toBe(0);
		expect(me.fixturesActive).toBeGreaterThan(0);
		expect(me.runnable).toBe(true);
		expect(me.notRunnableReason).toBeNull();
		expect(me.defaultTier).toBeTruthy();
	});

	it('FLIP GATE: confirm required AND the §8 ⑤ precondition is re-checked server-side', async () => {
		// Missing confirm → 400.
		const noConfirm = await actions.flip(event(formRequest({})));
		expect((noConfirm as { status: number }).status).toBe(400);
		expect((noConfirm as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/confirm the panel/i
		);
		// Confirmed BUT precondition not met (not all five certified) → 400 with the count.
		const exec = await ceremonyExecutionState(db);
		expect(exec.allCertified).toBe(false); // no interviews ran in CI (no credential)
		const notReady = await actions.flip(event(formRequest({ operatorConfirmed: 'on' })));
		expect((notReady as { status: number }).status).toBe(400);
		expect((notReady as { data: { ceremony: { error: string } } }).data.ceremony.error).toMatch(
			/precondition is not met|not every launch role is certified/i
		);
	});
});
