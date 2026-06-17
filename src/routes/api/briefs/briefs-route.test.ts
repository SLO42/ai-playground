// HR-5 ROUTE VERIFY — the /api/briefs POST handler's cert_hire dispatch (the OPERATOR HIRE-GATE,
// HR-RECRUITER-SPEC §7.5/B4) against a REAL throwaway SurrealDB. Regression for the two route
// defects the D-038 review caught:
//
//   GAP-1 (HIGH) — a cert_hire APPROVE must carry operatorConfirmed; without it the server
//     fail-closes (HireGateError → 409) and the cert never flips. The RightTray now sends
//     operatorConfirmed:true for cert_hire approves, and omits Defer (which 400s here). This proves
//     the route contract the tray must satisfy: confirmed approve → 200 + brief 'approved';
//     unconfirmed approve → 409; defer → 400.
//   GAP-2 (MEDIUM) — an approve with a STALE/disposed staffingProposal makes confirmStaffing throw
//     StaffingGateError; the handler now maps that to a clean 409, never a masked 500.
//
// The handler reads tryGetDb() (the runtime singleton) — we init it with the test DB so the real
// route code runs unchanged. The run is built directly (createInterviewRun → finalizeInterviewRun
// 'passed') — no LLM gauntlet needed; we only exercise the route's dispatch + error mapping.

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
	raiseHireBrief
} from '$lib/server/workforce';
import { getBrief } from '$lib/server/projects/briefs';
import { POST } from './+server';

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
	// The runtime singleton the route's tryGetDb() reads — same DB, fresh handle.
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

/** A POST Request to /api/briefs with a JSON body (the shape RightTray.decide posts). */
function req(body: unknown): Request {
	return new Request('http://localhost/api/briefs', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/** Invoke the real POST handler; return {status,json} on success or {status} on a thrown HttpError. */
async function call(body: unknown): Promise<{ status: number; json?: unknown }> {
	try {
		const res = await POST({ request: req(body) } as Parameters<typeof POST>[0]);
		return { status: res.status, json: await res.json() };
	} catch (err) {
		// SvelteKit error() throws an HttpError carrying { status, body }.
		return { status: (err as { status: number }).status };
	}
}

/** Seed a fresh role → version → terminal PASSING run, raise its cert_hire brief, return ids. */
async function freshHireBrief(): Promise<{ briefId: string; roleId: string }> {
	const slug = `hire-route-${++n}-${Date.now()}`;
	const role = await createRole(db, {
		slug,
		name: `Route Hire ${n}`,
		purpose: 'route-test candidate',
		provenance: 'test'
	});
	const version = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `methodology for ${slug}`,
		default_tier: 'opus'
	});
	const run = await createInterviewRun(db, {
		role_version: version.id,
		tier: 'opus',
		provider: 'anthropic',
		model_id: 'claude-test',
		fixture_set_sha: `sha-${n}`,
		planted_total: 2,
		pass_criteria: { pass_recall: 1, max_false_positives: 0 }
	});
	// A PASSING terminal run (the finalizer flips the in-campaign version interviewing→passed).
	await finalizeInterviewRun(db, run.id, {
		status: 'passed',
		planted_total: 2,
		planted_found: 2,
		false_positives: 0,
		results: [{ fixture: slug, kind: 'planted_defect', found: ['p1', 'p2'], missed: [] }]
	});
	const brief = await raiseHireBrief(db, run.id);
	return { briefId: brief.id, roleId: role.id };
}

describe('/api/briefs POST — cert_hire dispatch (HR-5, B4)', () => {
	it('GAP-1: an APPROVE WITHOUT operatorConfirmed is refused 409 (the cert never flips) — the old tray bug', async () => {
		const { briefId } = await freshHireBrief();
		const res = await call({ id: briefId, action: 'approve' });
		expect(res.status).toBe(409);
		// The brief stays open — no effect leaked.
		expect((await getBrief(db, briefId))?.status).toBe('open');
	}, 60_000);

	it('GAP-1: DEFER on a hire-gate brief is 400 (approve/reject only) — justifies hiding the Defer control', async () => {
		const { briefId } = await freshHireBrief();
		const res = await call({ id: briefId, action: 'defer' });
		expect(res.status).toBe(400);
		expect((await getBrief(db, briefId))?.status).toBe('open');
	}, 60_000);

	it('GAP-1 FIX: APPROVE WITH operatorConfirmed:true succeeds 200 + marks the brief approved (the tray now sends this)', async () => {
		const { briefId } = await freshHireBrief();
		const res = await call({ id: briefId, action: 'approve', operatorConfirmed: true });
		expect(res.status).toBe(200);
		expect((res.json as { ok: boolean }).ok).toBe(true);
		expect((res.json as { briefStatus: string }).briefStatus).toBe('approved');
		expect((await getBrief(db, briefId))?.status).toBe('approved');
	}, 60_000);

	it('GAP-2: an APPROVE with a STALE/unknown staffingProposal is a clean 409, NOT a masked 500', async () => {
		// confirmStaffing throws WorkforceInputError for a not-found proposal (and StaffingGateError
		// for a disposed one — see recruiter-hire.test.ts). Neither was caught before this fix, so an
		// operator passing a stale proposal on approve got a raw 500. The handler now maps both to 409.
		const { briefId } = await freshHireBrief();
		const res = await call({
			id: briefId,
			action: 'approve',
			operatorConfirmed: true,
			staffingProposal: 'review_proposal:does_not_exist'
		});
		expect(res.status).toBe(409);
	}, 60_000);
});
