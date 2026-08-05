// TASK-BOARD-SPEC §4.2 (P2) ACTION VERIFY — the /projects/[id] `createTask` + `retagTask` form
// actions against a REAL throwaway SurrealDB (a stubDb would not parse the SELECT/UPDATE — F-020).
//
// This is the layer that makes tags REACHABLE. The column and the prompt line are useless if the
// operator has no way to set them, so what is pinned here is the operator's whole loop:
//
//   • create a task WITH tags → the row really carries them, normalized;
//   • create with NO tags → an honest absence, not `[]`;
//   • retag an EXISTING task (the tasks that predate m0087 are the majority) → new tags stored;
//   • retag with an empty box → tags CLEARED, the rest of the row untouched;
//   • an over-long / over-count tag → 400 with the NAMED InvalidTagsError message, no write;
//   • a bad task id → 400; an unknown task id → 404 (each error named, none swallowed);
//   • TB-4/TB-5: neither action touches `status` or `description`.
//
// The actions read tryGetDb() (the runtime singleton), so the real action code runs unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { getTask, listTasksByProject, setStatus, MAX_TASK_TAG_LENGTH } from '$lib/server/tasks/repo';
import { actions } from './+page.server';

let tdb: TestDb;
let db: Db;
let projectSlug = '';
let projectId = '';

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
		`CREATE type::thing('project', $id) CONTENT { slug: $slug, name: $slug, root_path: '/tmp/tags' } RETURN id;`,
		{ id: `tag_proj_${Date.now()}`, slug: `tag-proj` }
	);
	projectId = String(rows[0].id);
	projectSlug = projectId.slice('project:'.length);
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

type ActionResult = { status: number; data: Record<string, unknown> };

async function call(
	name: 'createTask' | 'retagTask',
	fields: Record<string, string>
): Promise<ActionResult> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions[name]({
		request,
		params: { id: projectSlug }
	} as unknown as Parameters<(typeof actions)[typeof name]>[0])) as Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: res.status as number, data: res.data as Record<string, unknown> };
	}
	return { status: 200, data: res };
}

const taskOf = (r: ActionResult) => (r.data.task ?? {}) as Record<string, unknown>;

/** The most recently created task on this project (the board is newest-first). */
async function newestTask() {
	const list = await listTasksByProject(db, projectId);
	return list[0];
}

describe('createTask — the operator can author tags at creation', () => {
	it('stores the tags, normalized, on a real row', async () => {
		const res = await call('createTask', {
			title: 'Tagged from the form',
			priority: 'high',
			tags: ' DB , Migration ,db, '
		});
		expect(res.status).toBe(200);
		expect(taskOf(res).ok).toBe(true);

		const row = await getTask(db, String(taskOf(res).taskId));
		// Trimmed, lower-cased, de-duplicated, blank fragment between the trailing commas dropped.
		expect(row?.tags).toEqual(['db', 'migration']);
		expect(row?.priority).toBe('high');
		// D-008: the description still defaults to the title; tags did not disturb it.
		expect(row?.description).toBe('Tagged from the form');
	});

	it('an empty tag box is an honest absence — not an empty array', async () => {
		const res = await call('createTask', { title: 'Untagged from the form', tags: '' });
		expect(res.status).toBe(200);
		const row = await getTask(db, String(taskOf(res).taskId));
		expect(row?.tags).toBeUndefined();
	});

	it('a MISSING tags field behaves exactly like an empty one (the nil shadow path)', async () => {
		const res = await call('createTask', { title: 'No tags field at all' });
		expect(res.status).toBe(200);
		expect((await getTask(db, String(taskOf(res).taskId)))?.tags).toBeUndefined();
	});

	it('an over-long tag is a 400 with the NAMED message, and NO row is written', async () => {
		const before = (await listTasksByProject(db, projectId)).length;
		const res = await call('createTask', {
			title: 'Never created',
			tags: 'a'.repeat(MAX_TASK_TAG_LENGTH + 1)
		});
		expect(res.status).toBe(400); // the operator's input, not a server fault
		expect(String(taskOf(res).error)).toMatch(new RegExp(`exceeds ${MAX_TASK_TAG_LENGTH}`));
		expect((await listTasksByProject(db, projectId)).length).toBe(before);
	});

	it('too many tags is a 400 naming the bound', async () => {
		const res = await call('createTask', {
			title: 'Too many',
			tags: 'a,b,c,d,e,f,g,h,i'
		});
		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/at most 8 tags/);
	});

	it('a missing title is still refused before anything else is considered', async () => {
		const res = await call('createTask', { title: '   ', tags: 'db' });
		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/title is required/i);
	});
});

describe('retagTask — every task can be tagged, including ones created before m0087', () => {
	it('sets tags on an EXISTING untagged task and touches nothing else', async () => {
		const created = await call('createTask', { title: 'Pre-existing task' });
		const id = String(taskOf(created).taskId);
		expect((await getTask(db, id))?.tags).toBeUndefined();

		const res = await call('retagTask', { taskId: id, tags: 'Infra, careful' });
		expect(res.status).toBe(200);
		expect(taskOf(res).action).toBe('retag');
		expect(taskOf(res).tagCount).toBe(2);

		const row = await getTask(db, id);
		expect(row?.tags).toEqual(['infra', 'careful']);
		// TB-4/TB-5 — the retag path writes ONE column: no status move, no description rewrite.
		expect(row?.status).toBe('backlog');
		expect(row?.description).toBe('Pre-existing task');
		expect(row?.title).toBe('Pre-existing task');
	});

	it('an empty box CLEARS the tags, honestly reported as a count of 0', async () => {
		const created = await call('createTask', { title: 'To be cleared', tags: 'a,b' });
		const id = String(taskOf(created).taskId);

		const res = await call('retagTask', { taskId: id, tags: '   ' });
		expect(res.status).toBe(200);
		expect(taskOf(res).tagCount).toBe(0);
		expect((await getTask(db, id))?.tags).toBeUndefined();
	});

	it('the reported count is read off the STORED row, not echoed from the input', async () => {
		const created = await call('createTask', { title: 'Duplicate tags' });
		const id = String(taskOf(created).taskId);
		// Five submitted, two distinct after normalization — the operator is told the truth.
		const res = await call('retagTask', { taskId: id, tags: 'db, DB, db , Infra, infra' });
		expect(taskOf(res).tagCount).toBe(2);
	});

	it('a malformed task id is a 400 (the D-016 boundary), not a 500', async () => {
		const res = await call('retagTask', { taskId: 'not a record id', tags: 'db' });
		expect(res.status).toBe(400);
		expect(String(taskOf(res).error)).toMatch(/invalid task id/);
	});

	it('an unknown task id is a 404 — an honest "not found", never a silent success', async () => {
		const res = await call('retagTask', { taskId: 'task:definitely_not_here', tags: 'db' });
		expect(res.status).toBe(404);
		expect(String(taskOf(res).error)).toMatch(/not found/);
	});

	it('an invalid tag is a 400 and leaves the stored tags exactly as they were', async () => {
		const created = await call('createTask', { title: 'Keeps its tags', tags: 'original' });
		const id = String(taskOf(created).taskId);

		const res = await call('retagTask', { taskId: id, tags: 'b'.repeat(MAX_TASK_TAG_LENGTH + 1) });
		expect(res.status).toBe(400);
		expect((await getTask(db, id))?.tags).toEqual(['original']);
	});

	it('tags survive a status move — they are metadata, not lifecycle state', async () => {
		const created = await call('createTask', { title: 'Moves with its tags', tags: 'db' });
		const id = String(taskOf(created).taskId);
		await setStatus(db, id, 'ready');
		const row = await getTask(db, id);
		expect(row?.status).toBe('ready');
		expect(row?.tags).toEqual(['db']);
	});
});

describe('the board loader ships tags to the page', () => {
	it('every task summary carries a tags array — [] for the untagged ones', async () => {
		await call('createTask', { title: 'Loader tagged', tags: 'loader' });
		await call('createTask', { title: 'Loader untagged' });
		const rows = await listTasksByProject(db, projectId);

		const tagged = rows.find((t) => t.title === 'Loader tagged');
		const untagged = rows.find((t) => t.title === 'Loader untagged');
		expect(tagged?.tags).toEqual(['loader']);
		// The loader's mapping is `t.tags ?? []` — proven here on the repo value it maps from,
		// so an absent column reaches the page as [] and the card renders NO chip row (F-008).
		expect(untagged?.tags).toBeUndefined();
		expect(untagged?.tags ?? []).toEqual([]);
	});

	it('a newest-task read confirms the create action actually persisted (not a cached echo)', async () => {
		const res = await call('createTask', { title: 'Freshest', tags: 'fresh' });
		const newest = await newestTask();
		expect(newest?.id).toBe(String(taskOf(res).taskId));
		expect(newest?.tags).toEqual(['fresh']);
	});
});
