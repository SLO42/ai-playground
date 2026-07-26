// COMPLETION-LEDGER Wave A — VERIFY the hire/certification event ledger against a REAL SurrealDB.
//
// The defect class this wave exists to fix is "a real decision happens in the engine and leaves NO
// durable trace". A test that only proves the code PATH ran would reproduce that defect at the test
// layer, so every test here asserts on ROWS READ BACK from the database — the actual role_event /
// scene_event content, including the WHY payload. A stubDb cannot do this: it does not parse
// SurrealQL, so it would pass green against a broken ASSERT or a mis-projected query (F-020).
//
// Coverage:
//   • one test per emitted moment, asserting the row EXISTS with its context payload;
//   • the m0083 ASSERT widening actually accepts every new op/kind (the m0022 silent-swallow class);
//   • the four shadow paths per flow — happy, nil, empty, upstream-error;
//   • best-effort isolation: a THROWING sink never changes the host outcome, and a scene_event
//     failure never costs the DURABLE role_event row (they are independent arms);
//   • D-026 screening of the free-text payload fields;
//   • the /agents read model (listRecentRoleEvents + HIRE_LIFECYCLE_OPS) returns real rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	emitCandidateConsidered,
	emitGauntletAdjudicated,
	emitGauntletScored,
	emitGauntletStarted,
	emitHireDecided,
	emitHireEvent,
	emitHireStaffed,
	emitRoleReversioned
} from './hire-events';
import {
	createRole,
	createRoleVersion,
	listRecentRoleEvents,
	HIRE_LIFECYCLE_OPS,
	type RoleEventOp
} from './repo';

let tdb: TestDb;
let db: Db;

const HIRE_EVENTS_MIG = '0083_workforce_hire_events';

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain(HIRE_EVENTS_MIG);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

let seq = 0;
async function freshRole() {
	const slug = `hire-ev-${++seq}`;
	return createRole(db, { slug, name: `Role ${slug}`, purpose: 'hire event ledger' });
}
async function freshVersion(roleId: string) {
	return createRoleVersion(db, { role: roleId, prompt_core: 'Find the planted bugs.', default_tier: 'sonnet' });
}

/** Read back the role_event rows for one role (the DURABLE audit half). */
async function roleEventsFor(roleId: string): Promise<Array<{ op: string; detail: Record<string, unknown> }>> {
	const [rows] = await db.query<[Array<{ op: string; detail?: Record<string, unknown> }>]>(
		`SELECT op, detail, at FROM role_event WHERE role = type::thing($rid) ORDER BY at ASC;`,
		{ rid: roleId }
	);
	return rows.map((r) => ({ op: r.op, detail: r.detail ?? {} }));
}

/** Read back the scene_event rows for one ref (the LIVE feed half). */
async function sceneEventsFor(ref: string): Promise<Array<{ kind: string; source: string; meta: Record<string, unknown> }>> {
	const [rows] = await db.query<[Array<{ kind: string; source: string; meta?: Record<string, unknown> }>]>(
		`SELECT kind, source, meta, at FROM scene_event WHERE ref = $ref ORDER BY at ASC;`,
		{ ref }
	);
	return rows.map((r) => ({ kind: r.kind, source: r.source, meta: r.meta ?? {} }));
}

// ── The m0083 vocabulary actually lands (the m0022 silent-swallow class) ───────────────

describe('m0083 — the widened ASSERTs accept every new op/kind', () => {
	it('writes a row for EVERY new role_event op and scene_event kind (nothing is silently rejected)', async () => {
		const role = await freshRole();
		const moments: Array<{ op: RoleEventOp; kind: Parameters<typeof emitHireEvent>[1]['sceneKind'] }> = [
			{ op: 'gauntlet_started', kind: 'gauntlet_started' },
			{ op: 'interviewed', kind: 'gauntlet_scored' },
			{ op: 'adjudicated', kind: 'gauntlet_adjudicated' },
			{ op: 'reversioned', kind: 'role_reversioned' },
			{ op: 'candidate_considered', kind: 'candidate_considered' },
			{ op: 'hired', kind: 'hired' },
			{ op: 'hire_rejected', kind: 'hire_rejected' }
		];
		for (const m of moments) {
			const res = await emitHireEvent(db, {
				op: m.op,
				sceneKind: m.kind,
				role: role.id,
				ref: `probe:${m.op}`,
				source: 'probe',
				detail: { probe: true }
			});
			// BOTH sinks must report success — a false here is the silent-swallow defect.
			expect(res, `op ${m.op} / kind ${m.kind}`).toEqual({ roleEvent: true, scene: true });
		}
		const ops = (await roleEventsFor(role.id)).map((r) => r.op);
		for (const m of moments) expect(ops).toContain(m.op);
	});
});

// ── The certification path ─────────────────────────────────────────────────────────────

describe('emitGauntletStarted — a campaign OPENING is durable + explains itself', () => {
	it('records the inputs the verdict will rest on, and classifies WHY the run exists', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletStarted(db, {
			role: role.id,
			roleSlug: role.slug,
			roleVersion: version.id,
			run: 'interview_run:started1',
			tier: 'sonnet',
			provider: 'claude',
			modelId: 'claude-test',
			fixtureSetSha: 'sha-abc',
			plantedTotal: 7,
			lifecycleBefore: 'draft'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'gauntlet_started');
		expect(ev).toBeDefined();
		// ANALYTICS BAR: not a flat marker — the full basis is reconstructable from the row.
		expect(ev!.detail).toMatchObject({
			role_slug: role.slug,
			tier: 'sonnet',
			provider: 'claude',
			model_id: 'claude-test',
			fixture_set_sha: 'sha-abc',
			planted_total: 7,
			lifecycle_before: 'draft',
			trigger: 'campaign',
			ref: 'interview_run:started1'
		});
		const scene = await sceneEventsFor('interview_run:started1');
		expect(scene).toHaveLength(1);
		expect(scene[0].kind).toBe('gauntlet_started');
		expect(scene[0].source).toBe('interview_run');
		expect(scene[0].meta).toMatchObject({ role_slug: role.slug, planted_total: 7 });
	});

	it('classifies a RETRY and an EVIDENCE run distinctly from a fresh campaign', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletStarted(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:retry1', tier: 'sonnet', provider: 'claude', modelId: 'm',
			fixtureSetSha: 's', lifecycleBefore: 'error', retryOf: 'interview_run:prior'
		});
		await emitGauntletStarted(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:evidence1', tier: 'sonnet', provider: 'claude', modelId: 'm',
			fixtureSetSha: 's', lifecycleBefore: 'passed'
		});
		const evs = await roleEventsFor(role.id);
		expect(evs.find((e) => e.detail.ref === 'interview_run:retry1')!.detail).toMatchObject({
			trigger: 'retry',
			retry_of: 'interview_run:prior'
		});
		expect(evs.find((e) => e.detail.ref === 'interview_run:evidence1')!.detail).toMatchObject({
			trigger: 'evidence'
		});
	});
});

describe('emitGauntletScored — the verdict carries its full basis', () => {
	it('records recall + numerator/denominator + FP + lifecycle movement', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletScored(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:scored1', status: 'passed',
			plantedTotal: 8, plantedFound: 6, falsePositives: 1, costUsd: 0.42,
			ambiguousCount: 0, lifecycleBefore: 'interviewing', lifecycleAfter: 'passed'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'interviewed');
		expect(ev!.detail).toMatchObject({
			status: 'passed',
			recall: 0.75,
			planted_found: 6,
			planted_total: 8,
			false_positives: 1,
			cost_usd: 0.42,
			lifecycle_before: 'interviewing',
			lifecycle_after: 'passed'
		});
	});

	it('EMPTY-INPUT shadow path: zero plants ⇒ recall is OMITTED, never a fabricated 1.0 (F-008)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletScored(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:norecall', status: 'error', errorReason: 'scorer_error',
			plantedTotal: 0, plantedFound: 0, ambiguousCount: 0,
			lifecycleBefore: 'interviewing', lifecycleAfter: 'error'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'interviewed');
		// null recall is DROPPED at the boundary (§6.1 absent, never a stored NONE) — the surface
		// renders '—'. The critical assertion is that it is NOT 1.0.
		expect(ev!.detail.recall).toBeUndefined();
		expect(ev!.detail).toMatchObject({ status: 'error', error_reason: 'scorer_error' });
	});

	it('records a WITHHELD demotion — an evidence run that failed but could not demote (§2.2)', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletScored(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:evfail', status: 'failed',
			plantedTotal: 4, plantedFound: 1, ambiguousCount: 0,
			lifecycleBefore: 'passed', lifecycleAfter: 'passed'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'interviewed');
		expect(ev!.detail).toMatchObject({ demotion_withheld: true, lifecycle_after: 'passed' });
	});
});

describe('emitGauntletAdjudicated — the operator judgment is its own fact', () => {
	it('records the per-resolution counts that ARE the reasoning', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletAdjudicated(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:adj1', itemCount: 5,
			confirmedHits: 2, falsePositives: 2, dismissed: 1,
			statusBefore: 'adjudicating', statusAfter: 'passed'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'adjudicated');
		expect(ev!.detail).toMatchObject({
			items: 5, confirmed_hits: 2, false_positives: 2, dismissed: 1,
			status_before: 'adjudicating', status_after: 'passed', decided_by: 'operator'
		});
	});
});

describe('emitRoleReversioned — the recovery lineage', () => {
	it('records which version was walked away from and what replaced it', async () => {
		const role = await freshRole();
		const v1 = await freshVersion(role.id);
		const v2 = await freshVersion(role.id);
		await emitRoleReversioned(db, {
			role: role.id, roleSlug: role.slug,
			fromVersion: v1.id, toVersion: v2.id,
			fromLifecycle: 'failed', reason: 'v1 failed terminally; v2 clones its content'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'reversioned');
		expect(ev!.detail).toMatchObject({
			from_version: v1.id, to_version: v2.id, from_lifecycle: 'failed'
		});
		expect(String(ev!.detail.reason)).toContain('clones its content');
		expect((await sceneEventsFor(v2.id))[0].kind).toBe('role_reversioned');
	});
});

// ── The hire path ──────────────────────────────────────────────────────────────────────

describe('emitCandidateConsidered — the evidence AND the alternative not chosen', () => {
	it('records the recommendation, what it rests on, and the falsifier', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitCandidateConsidered(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:cc1', brief: 'decision_brief:cc1',
			recommendation: 'hire', recall: 0.9, plantedFound: 9, plantedTotal: 10,
			falsePositives: 0, maxFalsePositives: 2,
			autoResolvedCount: 3, escalatedCount: 1, tier: 'sonnet',
			falsifier: 'the fixture pool under-covers async code paths'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'candidate_considered');
		expect(ev!.detail).toMatchObject({
			recommendation: 'hire', recall: 0.9, planted_found: 9, planted_total: 10,
			false_positives: 0, max_false_positives: 2,
			auto_resolved: 3, escalated: 1, tier: 'sonnet',
			// THE ALTERNATIVE NOT CHOSEN — the whole point of the analytics bar.
			falsifier: 'the fixture pool under-covers async code paths',
			// HR only ever proposes; the row must never read as though it hired anyone.
			gate: 'operator_pending'
		});
		expect((await sceneEventsFor('decision_brief:cc1'))[0].kind).toBe('candidate_considered');
	});
});

describe('emitHireDecided — THE hire, and whether it overrode the recommendation', () => {
	it('an APPROVE that follows the recommendation records overrode_recommendation:false', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitHireDecided(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			brief: 'decision_brief:h1', action: 'approve', recommendation: 'hire',
			certFlipped: true, lifecycleBefore: 'interviewing', lifecycleAfter: 'passed',
			operatorConfirmed: true
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'hired');
		expect(ev!.detail).toMatchObject({
			action: 'approve', recommendation: 'hire', overrode_recommendation: false,
			cert_flipped: true, lifecycle_before: 'interviewing', lifecycle_after: 'passed',
			operator_confirmed: true, staffed_in_same_act: false
		});
		expect((await sceneEventsFor('decision_brief:h1'))[0].kind).toBe('hired');
	});

	it('an APPROVE against a no_hire recommendation is flagged as an OVERRIDE', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitHireDecided(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			brief: 'decision_brief:h2', action: 'approve', recommendation: 'no_hire',
			certFlipped: true, lifecycleBefore: 'interviewing', lifecycleAfter: 'passed',
			operatorConfirmed: true, staffingProposal: 'review_proposal:p1'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'hired');
		expect(ev!.detail).toMatchObject({
			overrode_recommendation: true,
			staffing_proposal: 'review_proposal:p1',
			staffed_in_same_act: true
		});
	});

	it('a REJECT against a hire recommendation is ALSO flagged as an override, and emits hire_rejected', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitHireDecided(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			brief: 'decision_brief:h3', action: 'reject', recommendation: 'hire',
			certFlipped: false, lifecycleBefore: 'interviewing', lifecycleAfter: 'interviewing',
			operatorConfirmed: false
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'hire_rejected');
		expect(ev!.detail).toMatchObject({
			action: 'reject', recommendation: 'hire', overrode_recommendation: true, cert_flipped: false
		});
		expect((await sceneEventsFor('decision_brief:h3'))[0].kind).toBe('hire_rejected');
	});
});

describe('emitHireStaffed — the reserved scene kind finally fires', () => {
	it('emits hire_staffed on the scene feed WITHOUT a duplicate role_event (staffRole owns that)', async () => {
		const role = await freshRole();
		const [proj] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE project CONTENT { name: 'Hire Staffing', slug: 'hire-staffing-${++seq}', root_path: 'F:/tmp/hire-staffing' } RETURN AFTER;`
		);
		const projectId = String((proj[0] as { id: unknown }).id);
		await emitHireStaffed(db, {
			role: role.id, project: projectId, staffRow: 'project_staff:s1',
			source: 'operator', reStaff: false
		});
		const scene = await sceneEventsFor('project_staff:s1');
		expect(scene).toHaveLength(1);
		expect(scene[0].kind).toBe('hire_staffed');
		expect(scene[0].meta).toMatchObject({ role: role.id, source: 'operator', re_staff: false });
		// F-055 — one write per act: staffRole owns the durable `staffed` audit row, so this
		// scene-only helper must NOT add a second one. (The role's own `created` row from
		// createRole is unrelated and expected.)
		const durable = await roleEventsFor(role.id);
		expect(durable.filter((r) => r.op === 'staffed')).toHaveLength(0);
		expect(durable.map((r) => r.op)).toEqual(['created']);
	});
});

// ── Shadow paths + best-effort isolation ───────────────────────────────────────────────

describe('emitHireEvent — best-effort isolation (a telemetry fault never costs the host)', () => {
	it('UPSTREAM-ERROR shadow path: a THROWING db never throws out of the emitter', async () => {
		const throwing = {
			query: async () => {
				throw new Error('db down');
			}
		} as unknown as Db;
		// The whole point: this resolves rather than rejecting, so no hire/cert can ever fail
		// because its telemetry failed.
		await expect(
			emitHireEvent(throwing, {
				op: 'hired', sceneKind: 'hired', role: 'role:x',
				ref: 'decision_brief:x', source: 'decision_brief', detail: { a: 1 }
			})
		).resolves.toEqual({ roleEvent: false, scene: false });
	});

	it('a scene_event fault does NOT cost the DURABLE role_event row (independent arms)', async () => {
		const role = await freshRole();
		let calls = 0;
		// Fail ONLY the scene_event write; let the role_event write through to the real DB.
		const partial = {
			query: async (q: string, binds?: Record<string, unknown>) => {
				calls++;
				if (typeof q === 'string' && q.includes('CREATE scene_event')) throw new Error('scene sink down');
				return db.query(q, binds);
			}
		} as unknown as Db;
		const res = await emitHireEvent(partial, {
			op: 'hired', sceneKind: 'hired', role: role.id,
			ref: 'decision_brief:partial', source: 'decision_brief', detail: { kept: true }
		});
		expect(res).toEqual({ roleEvent: true, scene: false });
		expect(calls).toBeGreaterThan(0);
		// The audit of record SURVIVED the scene outage — that is the reason the arms are split.
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'hired');
		expect(ev).toBeDefined();
		expect(ev!.detail).toMatchObject({ kept: true });
		expect(await sceneEventsFor('decision_brief:partial')).toHaveLength(0);
	});

	it('NIL/EMPTY shadow path: absent + null detail values are OMITTED, never stored as "undefined"', async () => {
		const role = await freshRole();
		await emitHireEvent(db, {
			op: 'hired', sceneKind: 'hired', role: role.id,
			ref: 'decision_brief:nil', source: 'decision_brief',
			detail: { present: 'yes', gone: undefined, alsoGone: null }
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'hired');
		expect(ev!.detail.present).toBe('yes');
		expect('gone' in ev!.detail).toBe(false);
		expect('alsoGone' in ev!.detail).toBe(false);
		// F-013-adjacent: the killer regression is a literal 'undefined' string landing in a row.
		expect(Object.values(ev!.detail)).not.toContain('undefined');
	});

	it('D-026: a secret planted in a free-text payload field is SCREENED before it lands', async () => {
		const role = await freshRole();
		await emitCandidateConsidered(db, {
			role: role.id, roleSlug: role.slug, roleVersion: 'role_version:x',
			run: 'interview_run:sec', brief: 'decision_brief:sec',
			recommendation: 'hire', recall: 1, plantedFound: 1, plantedTotal: 1,
			falsePositives: 0, maxFalsePositives: 0, autoResolvedCount: 0, escalatedCount: 0,
			tier: 'sonnet',
			falsifier: 'the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and it leaks'
		});
		const ev = (await roleEventsFor(role.id)).find((r) => r.op === 'candidate_considered');
		const falsifier = String(ev!.detail.falsifier ?? '');
		// The raw secret must NOT be recoverable from either sink.
		expect(falsifier).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
		const scene = await sceneEventsFor('decision_brief:sec');
		expect(String(scene[0].meta.falsifier ?? '')).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
	});
});

// ── The /agents read model (the SURFACE half — a row nothing renders is only half a fix) ──

describe('listRecentRoleEvents + HIRE_LIFECYCLE_OPS — the /agents hiring feed query', () => {
	it('HAPPY PATH returns REAL rows filtered to the hire lifecycle, newest-first', async () => {
		const role = await freshRole();
		const version = await freshVersion(role.id);
		await emitGauntletStarted(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			run: 'interview_run:feed1', tier: 'sonnet', provider: 'claude', modelId: 'm',
			fixtureSetSha: 's', lifecycleBefore: 'draft'
		});
		await emitHireDecided(db, {
			role: role.id, roleSlug: role.slug, roleVersion: version.id,
			brief: 'decision_brief:feed1', action: 'approve', recommendation: 'hire',
			certFlipped: true, lifecycleBefore: 'interviewing', lifecycleAfter: 'passed',
			operatorConfirmed: true
		});
		const feed = await listRecentRoleEvents(db, 100, HIRE_LIFECYCLE_OPS);
		const mine = feed.filter((r) => r.role === role.id);
		// The happy path must actually RETURN ROWS — a best-effort loader that silently yields []
		// is exactly the F-020 defect this assertion exists to catch.
		expect(mine.length).toBeGreaterThanOrEqual(2);
		expect(mine.map((r) => r.op)).toEqual(expect.arrayContaining(['gauntlet_started', 'hired']));
		// The joined display identity + the F-013 ISO coercion.
		expect(mine[0].role_slug).toBe(role.slug);
		for (const row of mine) {
			expect(typeof row.at).toBe('string');
			expect(String(row.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it('EXCLUDES role-admin noise (a plain `created` row is not part of the hire story)', async () => {
		const role = await freshRole(); // createRole writes role_event{op:'created'}
		const feed = await listRecentRoleEvents(db, 200, HIRE_LIFECYCLE_OPS);
		expect(feed.filter((r) => r.role === role.id && r.op === 'created')).toHaveLength(0);
		// …but the UNFILTERED call still sees it (the command-center behaviour is unchanged).
		const all = await listRecentRoleEvents(db, 200);
		expect(all.some((r) => r.role === role.id && r.op === 'created')).toBe(true);
	});

	it('EMPTY-INPUT shadow path: an explicitly empty op filter selects NOTHING (never silently "all")', async () => {
		expect(await listRecentRoleEvents(db, 50, [])).toEqual([]);
	});

	it('the ORDER BY field is in the projection — a real-surreal parse (F-020)', async () => {
		// A stubDb would pass this even with `at` missing from the SELECT; only a real server
		// raises the "Missing order idiom" class of error. Reaching the assertion IS the test.
		const rows = await listRecentRoleEvents(db, 5, HIRE_LIFECYCLE_OPS);
		expect(Array.isArray(rows)).toBe(true);
	});
});
