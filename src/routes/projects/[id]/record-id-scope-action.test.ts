// D-016 RECORD-ID SCOPE on the /projects/[id] form actions — against a REAL throwaway SurrealDB.
// A stubDb would not parse the SELECT/UPDATE/DELETE these actions issue (F-020), and the whole
// point of this file is that the DATABASE is what decides whether a foreign write lands.
//
// The defect this pins is the one `retagTask` closed and the rest of the file did not: a record id
// guarded by the SHAPE-only `assertRecordId` is accepted whenever it merely LOOKS like `table:id`,
// so a WELL-FORMED id naming another table — or another project's row — reached the write.
//
// The tests that matter here all feed a well-formed id. A malformed id was ALWAYS rejected (the
// shape check caught it), which is exactly why this hole kept reading as covered: no test ever
// drove a well-formed FOREIGN id through these actions. Each `describe` below states what the
// action did BEFORE the fix, so the regression is legible without the git history.
//
// Covered here: `moveTask` (the reported HIGH finding), plus the same class found in the sweep on
// this same file — `pmCompleteSprint` and the manual `launch` spawn.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createTask, getTask, setStatus, deleteTask } from '$lib/server/tasks/repo';
import { completeSprint } from '$lib/server/projects/pm-repo';
import { StringRecordId } from 'surrealdb';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;
/** The project the URL is scoped to — every action below runs as `params.id = thisSlug`. */
let thisProjectId = '';
let thisSlug = '';
/** A SECOND project, to prove one board cannot reach across into another's rows. */
let otherProjectId = '';

async function makeProject(seed: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/scope' } RETURN id;`,
		{ id: `${seed}_${Date.now()}`, slug: seed.replace(/_/g, '-') }
	);
	return String(rows[0].id);
}

/** Read a row back RAW — the assertion has to see what the database actually holds. */
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
	thisProjectId = await makeProject('scope_this');
	otherProjectId = await makeProject('scope_other');
	thisSlug = thisProjectId.slice('project:'.length);
	await db.close();
	// The actions read tryGetDb() (the runtime singleton), so the real action code runs unchanged.
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

type ActionResult = { status: number; data: Record<string, unknown> };
type ActionName = 'moveTask' | 'pmCompleteSprint' | 'launch';

async function call(name: ActionName, fields: Record<string, string>): Promise<ActionResult> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions[name]({
		request,
		params: { id: thisSlug }
	} as unknown as Parameters<(typeof actions)[ActionName]>[0])) as Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: res.status as number, data: res.data as Record<string, unknown> };
	}
	return { status: 200, data: res };
}

const taskOf = (r: ActionResult) => (r.data.task ?? {}) as Record<string, unknown>;
const pmOf = (r: ActionResult) => (r.data.pm ?? {}) as Record<string, unknown>;
const launchOf = (r: ActionResult) => (r.data.launch ?? {}) as Record<string, unknown>;

// ── moveTask — the reported HIGH finding ─────────────────────────────────────────────────────
//
// BEFORE: `moveTask` guarded `taskId` with the shape-only `assertRecordId` and handed it to
// `setStatus`, which did the same. The state machine did NOT cover the gap: `canTransition` only
// asks whether the row's CURRENT status string is a key of ALLOWED_TRANSITIONS with `to` in its
// list, so every table whose status enum OVERLAPS the task enum was writable through this form.
// `project` happens to be disjoint (active/paused/archived), which is why the hole read as closed —
// but `phase` and `feature` sit in 'in_progress' and their own ASSERT admits 'done', and a
// 'proposed' `review_proposal` admits 'withdrawn'. Those UPDATEs committed and returned a row, so
// the action answered `{ ok: true, action: 'move' }` for a row that is not a task.
describe('moveTask refuses ids that are not a task of THIS project', () => {
	it('a `phase` row in in_progress is NOT marked done — the state machine was never a table guard', async () => {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE phase CONTENT { project: $p, name: 'Scope phase', status: 'in_progress' } RETURN id;`,
			{ p: new StringRecordId(thisProjectId) }
		);
		const phaseId = String(rows[0].id);
		// in_progress → done is a LEGAL task transition, and 'done' is legal for a phase too, so
		// nothing but the table guard stands between this post and the write.
		const res = await call('moveTask', { taskId: phaseId, to: 'done' });

		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/invalid task id/);
		expect((await rawRow(phaseId))?.status).toBe('in_progress'); // untouched
	});

	it('a `feature` row in in_progress is NOT marked done either', async () => {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE feature CONTENT { project: $p, title: 'Scope feature', status: 'in_progress' } RETURN id;`,
			{ p: new StringRecordId(thisProjectId) }
		);
		const featureId = String(rows[0].id);
		const res = await call('moveTask', { taskId: featureId, to: 'done' });

		expect(res.status).toBe(400);
		expect((await rawRow(featureId))?.status).toBe('in_progress');
	});

	it("a REAL task of ANOTHER project is a 404 — one board cannot move another's task", async () => {
		const foreign = await createTask(db, {
			project: otherProjectId,
			title: 'Belongs to the other project',
			description: 'Belongs to the other project'
		});
		const res = await call('moveTask', { taskId: foreign.id, to: 'ready' });

		expect(res.status).toBe(404);
		expect(String(taskOf(res).error)).toMatch(/not found/);
		// The refusal is a REFUSAL — the foreign task did not move.
		expect((await getTask(db, foreign.id))?.status).toBe('backlog');
		await deleteTask(db, foreign.id);
	});

	it('a malformed id is still a 400 (the guard that already worked keeps working)', async () => {
		const res = await call('moveTask', { taskId: 'not a record id', to: 'ready' });
		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/invalid task id/);
	});

	it('an unknown but well-formed task id is a 404, not a 500', async () => {
		const res = await call('moveTask', { taskId: 'task:definitely_not_here', to: 'ready' });
		expect(res.status).toBe(404);
	});

	it("the legitimate move still works — the guard refuses foreigners, not the operator", async () => {
		const mine = await createTask(db, {
			project: thisProjectId,
			title: 'Mine to move',
			description: 'Mine to move'
		});
		const res = await call('moveTask', { taskId: mine.id, to: 'ready' });

		expect(res.status).toBe(200);
		expect(taskOf(res).ok).toBe(true);
		expect((await getTask(db, mine.id))?.status).toBe('ready');
		await deleteTask(db, mine.id);
	});

	it('an ILLEGAL transition on a real task is still the state machine\'s named 400', async () => {
		const mine = await createTask(db, {
			project: thisProjectId,
			title: 'Cannot leap',
			description: 'Cannot leap'
		});
		// backlog → done is not in ALLOWED_TRANSITIONS.
		const res = await call('moveTask', { taskId: mine.id, to: 'done' });
		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/illegal task status transition/);
		await deleteTask(db, mine.id);
	});
});

// The repo chokepoints are not merely the action's helpers — they are the layer that has to hold
// for EVERY caller, including ones written after this fix. Asserted directly.
describe('the task repo refuses a non-task id on its own', () => {
	it('setStatus names expected-vs-actual instead of moving a foreign row', async () => {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE phase CONTENT { project: $p, name: 'Repo phase', status: 'in_progress' } RETURN id;`,
			{ p: new StringRecordId(thisProjectId) }
		);
		const phaseId = String(rows[0].id);
		await expect(setStatus(db, phaseId, 'done')).rejects.toThrow(
			/is in table 'phase'.*'task' record id is required/s
		);
		expect((await rawRow(phaseId))?.status).toBe('in_progress');
	});

	it('deleteTask will not delete a row from another table', async () => {
		// The bare `DELETE $rid` is the worst of the three writes: no enum and no state machine
		// stands in its way, so only the table guard decides whether the row survives.
		await expect(deleteTask(db, thisProjectId)).rejects.toThrow(
			/is in table 'project'.*'task' record id is required/s
		);
		expect(await rawRow(thisProjectId)).toBeDefined();
	});
});

// ── pmCompleteSprint — same class, found in the sweep ────────────────────────────────────────
//
// BEFORE: `completeSprint` is a bare `UPDATE $rid MERGE { status: "completed", … }` behind a
// shape-only guard, and the action never checked whose sprint it was.
describe('pmCompleteSprint refuses ids that are not a sprint of THIS project', () => {
	async function makeSprint(projectId: string): Promise<string> {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE sprint CONTENT { project: $p, name: 'Scope sprint' } RETURN id;`,
			{ p: new StringRecordId(projectId) }
		);
		return String(rows[0].id);
	}

	it("another project's sprint is a 404 and stays active", async () => {
		const foreign = await makeSprint(otherProjectId);
		const res = await call('pmCompleteSprint', { sprintId: foreign });

		expect(res.status).toBe(404);
		expect(String(pmOf(res).error)).toMatch(/not found/);
		expect((await rawRow(foreign))?.status).toBe('active');
	});

	it('a well-formed id in another TABLE is a 400, and that row is not merged into', async () => {
		const res = await call('pmCompleteSprint', { sprintId: thisProjectId });
		expect(res.status).toBe(400);
		expect(String(pmOf(res).error)).toMatch(/invalid sprint id/);
		// The project's own status enum has no 'completed', so the merge would have failed loudly —
		// but `completed_at` is the field that proves nothing was written at all.
		const row = await rawRow(thisProjectId);
		expect(row?.completed_at).toBeUndefined();
		expect(row?.status).toBe('active');
	});

	it('this project\'s own sprint still completes', async () => {
		const mine = await makeSprint(thisProjectId);
		const res = await call('pmCompleteSprint', { sprintId: mine });
		expect(res.status).toBe(200);
		expect(pmOf(res).ok).toBe(true);
		expect((await rawRow(mine))?.status).toBe('completed');
	});

	it('the repo chokepoint refuses a non-sprint id for every future caller', async () => {
		await expect(completeSprint(db, thisProjectId)).rejects.toThrow(
			/is in table 'project'.*'sprint' record id is required/s
		);
	});
});

// ── launch — the same shape-only id, but this one SPENDS ─────────────────────────────────────
//
// BEFORE: `launchSession` resolves the prompt with `SELECT … FROM ONLY $tid` and only asserts the
// row EXISTS — it never checks the table or the project. A well-formed foreign id therefore
// spawned a real Claude Code session against THIS project's worktree, seeded with another
// project's (or another table's) text as its instructions. The refusal has to happen in the action,
// BEFORE any spend, which is what these assert: the 400/404 arrives without the runtime ever being
// consulted (an unavailable credential would otherwise answer 503 first — see the `to be refused
// before the runtime is reached` expectation).
describe('launch refuses to spend on a task that is not this project\'s', () => {
	it('a well-formed id in another table is a 400 at the boundary', async () => {
		const res = await call('launch', { taskId: thisProjectId });
		expect(res.status).toBe(400);
		expect(String(launchOf(res).error)).toMatch(/invalid task id/);
	});

	it("another project's task is a 404 — refused before the runtime is reached", async () => {
		const foreign = await createTask(db, {
			project: otherProjectId,
			title: 'Foreign work',
			description: 'Foreign work'
		});
		const res = await call('launch', { taskId: foreign.id });
		// 404, NOT the 503 an unavailable runtime would return — proof the scope check runs first
		// and no spawn was attempted.
		expect(res.status).toBe(404);
		expect(String(launchOf(res).error)).toMatch(/not found/);
		await deleteTask(db, foreign.id);
	});
});
