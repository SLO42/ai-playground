// Gap D ACTION VERIFY — the /projects/[id] `pmFitVerdict` form action against a REAL throwaway
// SurrealDB. The project PM records a fit-verdict {approve|deny, reason} on an open cert_hire hire
// brief BEFORE the operator's B4 decision. FIRST-CLASS input, NOT a hard gate: the action only
// records the PM judgment row (recordPmFitVerdict); it NEVER flips a cert or staffs (B4 stays with
// applyHireDecision). The red-team here is the action's boundary + error mapping:
//
//   • a DENY/APPROVE with a reason → 200, the row is recorded (latest-wins);
//   • a DENY with an EMPTY reason → 400 (the operator must see WHY);
//   • a bad outcome / missing brief id → 400 (boundary);
//   • a malformed brief id → 400; a non-cert_hire / already-decided brief → 409 (named HireGateError).
//
// The action reads tryGetDb() (the runtime singleton) — we init it with the test DB so the real
// action code runs unchanged. Runs are built directly (createInterviewRun → finalizeInterviewRun);
// no LLM gauntlet — the action's dispatch + validation + error mapping is the unit under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import {
	createRole,
	createRoleVersion,
	createInterviewRun,
	finalizeInterviewRun,
	raiseHireBrief,
	getPmFitVerdictForBrief
} from '$lib/server/workforce';
import { createDecisionBrief, getBrief, markBriefDecided } from '$lib/server/projects/briefs';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;
let n = 0;
// A real project so pmProjectId(params.id) resolves; the action does not require a hired PM (the
// project's operator records on the PM's behalf). The brief is project-less (it certifies a role).
let projectSlug = '';

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
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/x' } RETURN id;`,
		{ id: `fit_proj_${Date.now()}`, slug: `fit-proj` }
	);
	projectSlug = String(rows[0].id).slice('project:'.length);
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

async function fitVerdict(fields: Record<string, string>): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions.pmFitVerdict({
		request,
		params: { id: projectSlug }
	} as unknown as Parameters<typeof actions.pmFitVerdict>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

const dataOf = (r: { data: unknown }) => (r.data as { fit?: Record<string, unknown> })?.fit ?? {};

/** Seed a fresh role → version → terminal PASSING run, raise its cert_hire brief, return the brief id. */
async function freshHireBrief(): Promise<string> {
	const slug = `fit-action-${++n}-${Date.now()}`;
	const role = await createRole(db, { slug, name: `Fit Action ${n}`, purpose: 'fit-action-test', provenance: 'test' });
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `methodology for ${slug}`,
		default_tier: 'sonnet'
	});
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier: 'sonnet',
		provider: 'claude',
		model_id: 'claude-test',
		fixture_set_sha: `sha-${n}`,
		planted_total: 2,
		pass_criteria: { pass_recall: 1, max_false_positives: 0 }
	});
	await finalizeInterviewRun(db, run.id, {
		status: 'passed',
		planted_total: 2,
		planted_found: 2,
		false_positives: 0,
		results: [{ fixture: slug, kind: 'planted_defect', found: ['p1', 'p2'], missed: [] }]
	});
	const brief = await raiseHireBrief(db, run.id);
	return brief.id;
}

describe('/projects/[id] pmFitVerdict action — gap D PM fit-verdict (FIRST-CLASS, not a hard gate)', () => {
	it('records a DENY with a reason → 200; the latest fit-verdict carries the reason (surfaces to the operator)', async () => {
		const briefId = await freshHireBrief();
		const res = await fitVerdict({ brief: briefId, outcome: 'deny', reason: 'project needs BepInEx specifics' });
		expect(res.status).toBe(200);
		expect(dataOf(res).ok).toBe(true);
		expect(dataOf(res).outcome).toBe('deny');
		const v = await getPmFitVerdictForBrief(db, briefId);
		expect(v?.outcome).toBe('deny');
		expect(v?.reason).toMatch(/BepInEx/);
		// NEVER decided the brief — B4 stays with the operator.
		expect((await getBrief(db, briefId))?.status).toBe('open');
	}, 60_000);

	it('records an APPROVE; latest-wins over a prior deny', async () => {
		const briefId = await freshHireBrief();
		await fitVerdict({ brief: briefId, outcome: 'deny', reason: 'first call' });
		const res = await fitVerdict({ brief: briefId, outcome: 'approve', reason: 'reconsidered — fits' });
		expect(res.status).toBe(200);
		expect((await getPmFitVerdictForBrief(db, briefId))?.outcome).toBe('approve');
	}, 60_000);

	it('a DENY with an EMPTY reason is refused 400 (the operator must see WHY)', async () => {
		const briefId = await freshHireBrief();
		const res = await fitVerdict({ brief: briefId, outcome: 'deny', reason: '   ' });
		expect(res.status).toBe(400);
		expect(String(dataOf(res).error)).toMatch(/reason/i);
		expect(await getPmFitVerdictForBrief(db, briefId)).toBeNull();
	}, 60_000);

	it('a bad outcome is refused 400 (boundary)', async () => {
		const briefId = await freshHireBrief();
		const res = await fitVerdict({ brief: briefId, outcome: 'maybe', reason: 'x' });
		expect(res.status).toBe(400);
		expect(String(dataOf(res).error)).toMatch(/approve \| deny/i);
	}, 60_000);

	it('a malformed brief id is refused 400; a missing brief id is refused 400', async () => {
		const bad = await fitVerdict({ brief: 'not a record id', outcome: 'approve', reason: 'x' });
		expect(bad.status).toBe(400);
		const missing = await fitVerdict({ brief: '', outcome: 'approve', reason: 'x' });
		expect(missing.status).toBe(400);
	}, 60_000);

	it('a non-cert_hire brief (a task brief) is refused 409 — a fit-verdict only judges a hire gate', async () => {
		const taskBrief = await createDecisionBrief(db, {
			artifact: `task:fit_action_neg_${++n}`,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote?',
			issue: 'A task gate, not a hire gate.',
			effort: { apply: '—', wrongness: '—' },
			evidence: [`task:fit_action_neg_${n}`, 'tasks'],
			falsifier: 'the proposal may be premature',
			options: [
				{ id: 'approve', label: 'Promote', pro: 'p', con: 'c', recommended: 'go' },
				{ id: 'reject', label: 'Reject', pro: 'p', con: 'c' }
			]
		});
		const res = await fitVerdict({ brief: taskBrief.id, outcome: 'approve', reason: 'fine' });
		expect(res.status).toBe(409);
		expect(String(dataOf(res).error)).toMatch(/cert_hire/);
	}, 60_000);

	it('an ALREADY-DECIDED brief is refused 409 (too late — the operator already disposed)', async () => {
		const briefId = await freshHireBrief();
		await markBriefDecided(db, briefId, 'approved');
		const res = await fitVerdict({ brief: briefId, outcome: 'deny', reason: 'too late' });
		expect(res.status).toBe(409);
		expect(String(dataOf(res).error)).toMatch(/already/);
	}, 60_000);
});
