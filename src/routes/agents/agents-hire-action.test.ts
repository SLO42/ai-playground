// HR-5 ACTION VERIFY — the /agents `applyHire` form action (the OPERATOR HIRE GATE on the
// /agents hire queue, HR-RECRUITER-SPEC §7.5 / B4) against a REAL throwaway SurrealDB. This is
// the SECOND reachable B4 surface (the first is the global RightTray via /api/briefs); both call
// the same applyHireDecision engine. The action is load-bearing, so the red-team is explicit:
//
//   • B4 GATE — an APPROVE without the operatorConfirmed tick fail-closes (400 from the action's
//     own guard; the cert NEVER flips, the brief stays open). With the tick → 200 + 'approved'.
//   • FAIL-CLOSED on a forged / wrong-artifact-kind / missing brief id → a NAMED HireGateError
//     mapped to 409, NO cert flip, no leak.
//   • REJECT leaves the cert untouched (no flip) and needs no confirm.
//   • Every shadow path is named (nil id, bad action, disconnected db).
//
// The action reads tryGetDb() (the runtime singleton) — we init it with the test DB so the real
// action code runs unchanged. Runs are built directly (createInterviewRun → finalizeInterviewRun)
// — no LLM gauntlet; we exercise the action's dispatch + B4 gate + error mapping only.

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
	getRoleVersion,
	raiseHireBrief
} from '$lib/server/workforce';
import { createDecisionBrief, getBrief } from '$lib/server/projects/briefs';
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

/** Build a FormData body the action reads (the shape the +page.svelte form posts). */
function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

/** Invoke the real applyHire action; normalize the SvelteKit success/fail return. */
async function applyHire(fields: Record<string, string>): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions.applyHire({ request } as Parameters<typeof actions.applyHire>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	// fail() returns { status, data }; a success return is the bare data object.
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

/** Seed a fresh role → version → terminal PASSING run, raise its cert_hire brief, return ids. */
async function freshHireBrief(): Promise<{ briefId: string; versionId: string; runId: string }> {
	const slug = `hire-action-${++n}-${Date.now()}`;
	const role = await createRole(db, { slug, name: `Action Hire ${n}`, purpose: 'action-test', provenance: 'test' });
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
	return { briefId: brief.id, versionId: version.id, runId: run.id };
}

const dataOf = (r: { data: unknown }) => (r.data as { hire?: Record<string, unknown> })?.hire ?? {};

describe('/agents applyHire action — the operator hire gate (HR-5, B4)', () => {
	it('B4 GATE: APPROVE without the operatorConfirmed tick is refused 400 — the cert never flips, brief stays open', async () => {
		const { briefId, versionId } = await freshHireBrief();
		const res = await applyHire({ brief: briefId, action: 'approve' }); // no operatorConfirmed
		expect(res.status).toBe(400);
		expect(String(dataOf(res).error)).toMatch(/confirm the hire/i);
		// No effect leaked: the brief is still open. (The run's own finalizer already drove the
		// version to 'passed'; the GATE refusal is what we assert — the brief was not decided.)
		expect((await getBrief(db, briefId))?.status).toBe('open');
		// The version lifecycle is whatever the run set it to, NOT changed by this refused approve.
		expect((await getRoleVersion(db, versionId))?.lifecycle).toBe('passed');
	}, 60_000);

	it('B4 GATE FIX: APPROVE WITH operatorConfirmed=on succeeds → brief approved, recommendation hire', async () => {
		const { briefId } = await freshHireBrief();
		const res = await applyHire({ brief: briefId, action: 'approve', operatorConfirmed: 'on' });
		expect(res.status).toBe(200);
		expect(dataOf(res).ok).toBe(true);
		expect(dataOf(res).status).toBe('approved');
		expect(dataOf(res).recommendation).toBe('hire');
		expect((await getBrief(db, briefId))?.status).toBe('approved');
	}, 60_000);

	it('REJECT needs no confirm, flips nothing → brief rejected, the version stays as-is', async () => {
		const { briefId, versionId } = await freshHireBrief();
		const before = (await getRoleVersion(db, versionId))?.lifecycle;
		const res = await applyHire({ brief: briefId, action: 'reject' });
		expect(res.status).toBe(200);
		expect(dataOf(res).ok).toBe(true);
		expect(dataOf(res).status).toBe('rejected');
		expect(dataOf(res).certFlipped).toBe(false);
		expect((await getBrief(db, briefId))?.status).toBe('rejected');
		expect((await getRoleVersion(db, versionId))?.lifecycle).toBe(before); // untouched
	}, 60_000);

	it('RED-TEAM: a forged / non-existent brief id fails CLOSED with a NAMED HireGateError → 409 (no leak)', async () => {
		const res = await applyHire({ brief: 'decision_brief:does_not_exist', action: 'approve', operatorConfirmed: 'on' });
		expect(res.status).toBe(409);
		expect(String(dataOf(res).error)).toMatch(/not found/i);
	}, 60_000);

	it('RED-TEAM: a WRONG-artifact-kind brief id (a task brief, not cert_hire) is refused 409 — applyHireDecision only applies a hire gate', async () => {
		// A non-cert_hire decision_brief (artifact_kind 'task'): the action must NOT treat it as a hire
		// gate. applyHireDecision fail-closes with HireGateError naming the kind → mapped to 409. The
		// brief only STORES the artifact link (createDecisionBrief validates the id FORMAT, not row
		// existence) and the kind guard fires before the artifact is ever dereferenced — so a valid
		// task id suffices, no task row needed (the guard is the unit under test).
		const taskId = `task:t_${++n}_${Date.now()}`;
		const taskBrief = await createDecisionBrief(db, {
			artifact: taskId,
			artifact_kind: 'task',
			classification: 'proposal_gate',
			ask: 'Promote this proposed task?',
			issue: 'a non-hire brief used to probe the hire gate',
			effort: { apply: 'one click', wrongness: 'a bad task ships' },
			evidence: [taskId, 'probe evidence'],
			falsifier: 'the task may be premature',
			options: [
				{ id: 'approve', label: 'Approve', pro: 'ship it', con: 'maybe premature', recommended: 'looks ready' },
				{ id: 'reject', label: 'Reject', pro: 'hold', con: 'delays work' }
			]
		});
		const res = await applyHire({ brief: taskBrief.id, action: 'approve', operatorConfirmed: 'on' });
		expect(res.status).toBe(409);
		expect(String(dataOf(res).error)).toMatch(/cert_hire/i);
		// The task brief is UNTOUCHED — the hire gate refused it, did not decide it.
		expect((await getBrief(db, taskBrief.id))?.status).toBe('open');
	}, 60_000);

	it('shadow: a missing brief id → 400 named; a bad action → 400 named', async () => {
		const miss = await applyHire({ action: 'approve', operatorConfirmed: 'on' });
		expect(miss.status).toBe(400);
		expect(String(dataOf(miss).error)).toMatch(/missing brief id/i);

		const { briefId } = await freshHireBrief();
		const bad = await applyHire({ brief: briefId, action: 'defer' });
		expect(bad.status).toBe(400);
		expect(String(dataOf(bad).error)).toMatch(/approve \| reject/i);
		// A bad action never decides the brief.
		expect((await getBrief(db, briefId))?.status).toBe('open');
	}, 60_000);
});
