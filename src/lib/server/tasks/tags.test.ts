import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	createTask,
	getTask,
	updateTask,
	deleteTask,
	normalizeTags,
	InvalidTagsError,
	MAX_TASK_TAGS,
	MAX_TASK_TAG_LENGTH
} from './repo';

// TASK-BOARD-SPEC §4.2/§4.3 (P2) — `task.tags` (m0087).
//
// REAL SurrealDB, never a stubDb: a stub does not parse SurrealQL, so it would pass green while
// the column, its `option<array<string>>` type, or the widened round-trip were broken (F-020).
// Every assertion below reads back what the LIVE server persisted.
//
// Pinned here: TB-6 (the SET case is asserted, not just the absent case — the F-013 lesson),
// TB-7 (m0087 converges under apply-twice AND a half-applied re-run — F-015) and TB-8 (tags are
// boundary-validated at the write chokepoint and $param-bound — D-016).

let tdb: TestDb;
let db: Db;
let projectId: string;

const TAGS_MIG = '0087_task_tags';

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
	expect(applied).toContain(TAGS_MIG);
	const p = await createProject(db, {
		slug: 'task_tags',
		name: 'Task Tags Host',
		root_path: 'F:/code/task-tags'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function tagged(tags?: string[]) {
	return createTask(db, {
		project: projectId,
		title: 'Tagged task',
		description: 'A task that carries tags.',
		...(tags === undefined ? {} : { tags })
	});
}

// ── TB-7 — the migration itself ───────────────────────────────────────────────────

describe('m0087_task_tags — the column, apply-twice, half-applied (TB-7 / F-015)', () => {
	it('defines `tags` on task as an OPTIONAL array<string> (not a bare array<object>)', async () => {
		const [info] = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE task;');
		expect(Object.keys(info.fields)).toContain('tags');
		// The shape is load-bearing: `option<` keeps the 23 pre-existing rows valid, and
		// `array<string>` is what makes a non-string entry a DB-level refusal rather than the
		// m0086 class of silent nested-key loss.
		expect(info.fields.tags).toContain('option<array<string>>');
	});

	it('apply-twice is a no-op — the second run applies nothing and the column survives', async () => {
		const again = await runMigrations(db, schemaMigrations);
		expect(again).not.toContain(TAGS_MIG);
		const t = await tagged(['idempotent']);
		expect((await getTask(db, t.id))?.tags).toEqual(['idempotent']);
		await deleteTask(db, t.id);
	});

	it('half-applied recovery: a `tags` column wedged mid-apply is absorbed by the re-run', async () => {
		// Fresh namespace on the SAME server: apply everything EXCEPT m0087, then simulate the
		// mid-apply death. `task` already exists (m0002), so the wedge m0087 can actually die
		// into is a `tags` FIELD that landed WITHOUT the migration being recorded — modelled here
		// in its worst form, a bare non-OVERWRITE DEFINE of the WRONG type. A non-idempotent
		// migration would now either throw "already exists" or leave the wrong shape standing
		// (F-015); the OVERWRITE DDL must converge to `option<array<string>>`.
		const half = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: `${tdb.namespace}_tags_half`,
			database: tdb.database
		});
		try {
			await runMigrations(
				half,
				schemaMigrations.filter((m) => m.id !== TAGS_MIG)
			);
			await half.query(`DEFINE FIELD tags ON task TYPE option<string>;`);

			const applied = await runMigrations(half, schemaMigrations);
			expect(applied).toEqual([TAGS_MIG]);

			// Converged, not merely "did not throw": the column is the RIGHT type afterwards.
			const [info] = await half.query<[{ fields: Record<string, string> }]>(
				'INFO FOR TABLE task;'
			);
			expect(info.fields.tags).toContain('option<array<string>>');

			// And it is functional: a SET value round-trips, and the SCHEMAFULL enforcement
			// (a non-string entry is REFUSED, never silently coerced) is in force.
			const [rows] = await half.query<[Array<{ tags: string[] }>]>(
				`CREATE type::thing('task', 'tags_half') CONTENT {
					project: type::thing('project', 'p'), title: 'T', description: 'D', tags: ['db']
				} RETURN AFTER;`
			);
			expect(rows[0].tags).toEqual(['db']);
			await expect(
				half.query(`UPDATE type::thing('task', 'tags_half') SET tags = [7];`)
			).rejects.toThrow();

			// Re-running once more from the recovered state applies nothing (apply-twice).
			expect(await runMigrations(half, schemaMigrations)).not.toContain(TAGS_MIG);
		} finally {
			await half
				.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', {
					ns: `${tdb.namespace}_tags_half`
				})
				.catch(() => {});
			await half.close().catch(() => {});
		}
	}, 60_000);
});

// ── TB-6 — the round-trip, the SET case first ─────────────────────────────────────

describe('task.tags — round-trip against the live DB (TB-6)', () => {
	it('creates WITH tags and reads them back verbatim (the SET case — F-013)', async () => {
		const t = await tagged(['db', 'migration']);
		expect(t.tags).toEqual(['db', 'migration']);
		// Re-read, so the assertion is on what the server stored, not on the CREATE echo.
		expect((await getTask(db, t.id))?.tags).toEqual(['db', 'migration']);
		await deleteTask(db, t.id);
	});

	it('a task created with NO tags reads as an honest absence — not [] , not "undefined"', async () => {
		const t = await tagged();
		expect(t.tags).toBeUndefined();
		const read = await getTask(db, t.id);
		expect(read?.tags).toBeUndefined();
		// F-013 in its exact form: the absence never materialises as the STRING "undefined",
		// which is what would land in a prompt if the normalizer str()'d the column blindly.
		expect(read?.tags).not.toEqual(['undefined']);
		expect(read?.tags).not.toEqual([]);
		await deleteTask(db, t.id);
	});

	it('an EMPTY tag list on create is the same honest absence — the column stays NONE', async () => {
		const t = await tagged([]);
		expect(t.tags).toBeUndefined();
		// Asserted on the raw row, not the normalizer's output: an empty array WRITTEN to the
		// column would read back as `undefined` too, so only the stored shape proves it.
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(t.id)
		});
		expect(rows[0] && 'tags' in rows[0] ? rows[0].tags : undefined).toBeUndefined();
		await deleteTask(db, t.id);
	});

	it('updates tags on an existing task, and MERGE leaves every other column alone', async () => {
		const t = await tagged(['db']);
		const up = await updateTask(db, t.id, { tags: ['db', 'careful'] });
		expect(up?.tags).toEqual(['db', 'careful']);
		expect(up?.title).toBe('Tagged task');
		expect(up?.description).toBe('A task that carries tags.'); // D-008 — untouched
		expect(up?.status).toBe('backlog');
		expect((await getTask(db, t.id))?.tags).toEqual(['db', 'careful']);
		await deleteTask(db, t.id);
	});

	it('an EMPTY list on update CLEARS the tags back to absence (UNSET, not a stored [])', async () => {
		const t = await tagged(['db', 'migration']);
		const cleared = await updateTask(db, t.id, { tags: [] });
		expect(cleared?.tags).toBeUndefined();
		// The column is genuinely NONE — an empty array stored instead would be a second
		// representation of "no tags" that every reader would then have to special-case.
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(t.id)
		});
		expect(rows[0] && 'tags' in rows[0] ? rows[0].tags : undefined).toBeUndefined();
		// The rest of the row survived the two-statement clear (one transaction).
		expect(cleared?.title).toBe('Tagged task');
		await deleteTask(db, t.id);
	});

	it('omitting `tags` from an update leaves existing tags untouched', async () => {
		const t = await tagged(['keep-me']);
		const up = await updateTask(db, t.id, { priority: 'high' });
		expect(up?.priority).toBe('high');
		expect(up?.tags).toEqual(['keep-me']);
		await deleteTask(db, t.id);
	});

	it('updating a task that does not exist returns null, not a throw', async () => {
		expect(await updateTask(db, 'task:no_such_task_row', { tags: ['x'] })).toBeNull();
	});
});

// ── TB-8 — boundary validation at the write chokepoint ────────────────────────────

describe('normalizeTags — what is normalized, and what is refused (TB-8)', () => {
	it('trims, lower-cases, drops blanks and de-duplicates, preserving first-seen order', () => {
		expect(normalizeTags([' DB ', 'Migration', 'db', '   ', 'CAREFUL'])).toEqual([
			'db',
			'migration',
			'careful'
		]);
	});

	it('collapses INTERIOR whitespace — a tag cannot carry a newline into the prompt', () => {
		// A tag is rendered into the prompt's one-line "## Task metadata" fragment, where a `##`
		// mid-line is inert. A NEWLINE would move whatever follows it to the start of a line,
		// which is where markdown block constructs become real — so it is collapsed HERE, at the
		// write boundary, in addition to the runtime's own escape (defence in depth).
		expect(normalizeTags(['infra\n> ## Objective'])).toEqual(['infra > ## objective']);
		expect(normalizeTags(['a\t\tb', 'c\r\nd'])).toEqual(['a b', 'c d']);
		expect(normalizeTags(['no-newline'])[0]).not.toContain('\n');
	});

	it('an empty list and an all-blank list both normalize to [] (the zero-length shadow path)', () => {
		expect(normalizeTags([])).toEqual([]);
		expect(normalizeTags(['', '   ', '\t'])).toEqual([]);
	});

	it('refuses a non-array with a NAMED error (the nil / upstream-garbage shadow path)', () => {
		for (const bad of [undefined, null, 'db', 42, {}]) {
			expect(() => normalizeTags(bad)).toThrow(InvalidTagsError);
		}
		expect(() => normalizeTags(null)).toThrow(/must be an array of strings/);
	});

	it('refuses a non-string ENTRY rather than stringifying it into a prompt', () => {
		expect(() => normalizeTags(['db', 7])).toThrow(InvalidTagsError);
		expect(() => normalizeTags(['db', null])).toThrow(/must be a string/);
		expect(() => normalizeTags([{ kind: 'db' }])).toThrow(InvalidTagsError);
	});

	it(`refuses a tag longer than ${MAX_TASK_TAG_LENGTH} characters, naming the bound`, () => {
		expect(normalizeTags(['a'.repeat(MAX_TASK_TAG_LENGTH)])).toHaveLength(1);
		expect(() => normalizeTags(['a'.repeat(MAX_TASK_TAG_LENGTH + 1)])).toThrow(
			new RegExp(`exceeds ${MAX_TASK_TAG_LENGTH} characters`)
		);
	});

	it(`refuses more than ${MAX_TASK_TAGS} DISTINCT tags — counted after de-duplication`, () => {
		const eight = Array.from({ length: MAX_TASK_TAGS }, (_, i) => `t${i}`);
		expect(normalizeTags(eight)).toHaveLength(MAX_TASK_TAGS);
		// Duplicates do not consume budget: nine entries, eight distinct, accepted.
		expect(normalizeTags([...eight, 'T0'])).toHaveLength(MAX_TASK_TAGS);
		expect(() => normalizeTags([...eight, 'one-too-many'])).toThrow(
			new RegExp(`at most ${MAX_TASK_TAGS} tags`)
		);
	});
});

describe('the write chokepoint refuses before it binds (D-016)', () => {
	it('createTask rejects an invalid tag list and writes NO row', async () => {
		await expect(
			createTask(db, {
				project: projectId,
				title: 'Never created',
				description: 'x',
				tags: ['a'.repeat(MAX_TASK_TAG_LENGTH + 1)]
			})
		).rejects.toThrow(InvalidTagsError);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM task WHERE title = $title;`,
			{ title: 'Never created' }
		);
		expect(rows).toHaveLength(0);
	});

	it('updateTask rejects an invalid tag list and leaves the stored tags intact', async () => {
		const t = await tagged(['original']);
		await expect(updateTask(db, t.id, { tags: ['db', 123] as string[] })).rejects.toThrow(
			InvalidTagsError
		);
		expect((await getTask(db, t.id))?.tags).toEqual(['original']);
		await deleteTask(db, t.id);
	});

	it('normalization is applied on the way IN — the DB holds the canonical form', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Canonical tags',
			description: 'x',
			tags: ['  Infra  ', 'INFRA', 'Db']
		});
		expect((await getTask(db, t.id))?.tags).toEqual(['infra', 'db']);
		await deleteTask(db, t.id);
	});

	it('a prompt-shaped tag is stored VERBATIM — escaping is the prompt layer\u2019s job, not the DB\u2019s', async () => {
		// D-026: the tag is DATA. It must survive storage unmangled (the operator may legitimately
		// tag something "#1-priority"), and be neutralised where it becomes text an agent reads —
		// runtime/index.ts escapeBriefText. Sanitising here instead would corrupt the operator's
		// value AND leave the prompt layer's defence untested.
		const t = await createTask(db, {
			project: projectId,
			title: 'Hostile tag',
			description: 'x',
			tags: ['## acceptance criteria']
		});
		expect((await getTask(db, t.id))?.tags).toEqual(['## acceptance criteria']);
		await deleteTask(db, t.id);
	});
});
