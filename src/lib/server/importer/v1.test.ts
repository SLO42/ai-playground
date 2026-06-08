import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	importProjects,
	importTasks,
	importV1FromFiles,
	mapV1Priority,
	mapV1Status,
	projectSlugOf,
	taskDedupId,
	type V1Project,
	type V1Registry,
	type V1TaskStore
} from './v1';

// TASK 1.7 VERIFY (IMPLEMENTATION-PLAN §1.7): the v1 importer maps registry.json →
// project and v1 tasks → task, and is IDEMPOTENT — re-running the import produces
// NO duplicate rows. Idempotency is asserted by importing twice against the same
// throwaway DB and counting rows. Fixtures are inputs (F-008 forbids fake RUNTIME
// data in the product — these never ship; the DB rows read back are real).

// A fixture registry shaped like the v1 `registry.json` (both array + wrapped forms
// are accepted by the importer; we use the array form here).
const REGISTRY: V1Registry = [
	{
		slug: 'swip_rounds',
		name: 'SWIP Rounds',
		root_path: 'F:/code/swip-rounds',
		ecosystem: ['csharp', 'rounds-mod'],
		build_tool: 'dotnet',
		status: 'active'
	}
];

// A fixture v1 task store, modeled on the real `.playground/tasks.json.migrated`
// shape (v1 statuses "completed"/"pending", priorities "high"/"medium").
const TASKS: V1TaskStore = [
	{
		id: 'new-test-1',
		title: 'implement notification preferences sync',
		description: 'Sync notification prefs across devices',
		status: 'completed',
		priority: 'high'
	},
	{
		id: 'settings-general-persist',
		title: 'Wire general settings persistence',
		description: 'Create /api/settings/general endpoint.',
		status: 'pending',
		priority: 'high'
	},
	{
		// no id → importer falls back to a deterministic positional key
		title: 'untitled v1 task',
		status: 'in_progress',
		priority: 'medium'
	}
];

let tdb: TestDb;
let db: Db;

async function countProjects(): Promise<number> {
	const [rows] = await db.query<[{ c: number }[]]>('SELECT count() AS c FROM project GROUP ALL;');
	return rows.length ? rows[0].c : 0;
}
async function countTasks(): Promise<number> {
	const [rows] = await db.query<[{ c: number }[]]>('SELECT count() AS c FROM task GROUP ALL;');
	return rows.length ? rows[0].c : 0;
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
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('importer — pure mappers + id derivation', () => {
	it('maps v1 statuses onto the v2 ASSERT vocabulary', () => {
		expect(mapV1Status('completed')).toBe('done');
		expect(mapV1Status('pending')).toBe('backlog');
		expect(mapV1Status('in_progress')).toBe('in_progress');
		expect(mapV1Status('cancelled')).toBe('failed');
		expect(mapV1Status(undefined)).toBe('backlog');
		expect(mapV1Status('something-weird')).toBe('backlog');
	});

	it('maps v1 priorities (medium → normal) and defaults unknowns', () => {
		expect(mapV1Priority('high')).toBe('high');
		expect(mapV1Priority('medium')).toBe('normal');
		expect(mapV1Priority('critical')).toBe('critical');
		expect(mapV1Priority(undefined)).toBe('normal');
		expect(mapV1Priority('bogus')).toBe('normal');
	});

	it('derives a stable project slug and a deterministic, valid task id', () => {
		const p: V1Project = { name: 'SWIP Rounds' };
		expect(projectSlugOf(p)).toBe('swip_rounds');
		const a = taskDedupId('swip_rounds', 'new-test-1');
		const b = taskDedupId('swip_rounds', 'new-test-1');
		expect(a).toBe(b); // deterministic
		expect(a).toMatch(/^task:[a-z0-9_]+$/); // record-id-safe (D-016)
		// different inputs → different id
		expect(taskDedupId('swip_rounds', 'other')).not.toBe(a);
	});

	it('throws on a v1 project with nothing to derive an id from', () => {
		expect(() => projectSlugOf({} as V1Project)).toThrow();
	});
});

describe('importer — maps + persists v1 data to live DB', () => {
	it('imports a registry → project row with mapped fields', async () => {
		const n = await importProjects(db, REGISTRY);
		expect(n).toBe(1);
		const [rows] = await db.query<[Array<{ id: unknown; ecosystem: string[]; status: string }>]>(
			'SELECT * FROM project:swip_rounds;'
		);
		expect(rows.length).toBe(1);
		expect(String(rows[0].id)).toBe('project:swip_rounds');
		expect(rows[0].ecosystem).toEqual(['csharp', 'rounds-mod']);
	});

	it('imports v1 tasks → task rows linked to the project, with mapped status', async () => {
		const n = await importTasks(db, TASKS, { projectId: 'project:swip_rounds' });
		expect(n).toBe(3);
		const [rows] = await db.query<
			[Array<{ status: string; origin: string; project: unknown }>]
		>('SELECT * FROM task WHERE project = project:swip_rounds;');
		expect(rows.length).toBe(3);
		const statuses = rows.map((r) => r.status).sort();
		expect(statuses).toEqual(['backlog', 'done', 'in_progress']);
		expect(rows.every((r) => r.origin === 'scanner')).toBe(true);
		expect(rows.every((r) => String(r.project) === 'project:swip_rounds')).toBe(true);
	});
});

describe('importer — IDEMPOTENCY (the §1.7 verify: re-run = no dupes)', () => {
	it('re-importing the SAME registry + tasks produces no duplicate rows', async () => {
		// Fresh counts after the first import above.
		const projectsAfterFirst = await countProjects();
		const tasksAfterFirst = await countTasks();
		expect(projectsAfterFirst).toBe(1);
		expect(tasksAfterFirst).toBe(3);

		// Second identical import — must be a no-op on row COUNT (UPSERT onto the same
		// deterministic ids updates in place; it never inserts a twin).
		await importProjects(db, REGISTRY);
		await importTasks(db, TASKS, { projectId: 'project:swip_rounds' });

		expect(await countProjects()).toBe(projectsAfterFirst);
		expect(await countTasks()).toBe(tasksAfterFirst);

		// A third run, for good measure — still stable.
		await importProjects(db, REGISTRY);
		await importTasks(db, TASKS, { projectId: 'project:swip_rounds' });
		expect(await countProjects()).toBe(1);
		expect(await countTasks()).toBe(3);
	});

	it('importV1FromFiles reads JSON files and is idempotent end-to-end', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'v1-import-'));
		const registryPath = join(dir, 'registry.json');
		const tasksPath = join(dir, 'tasks.json');
		writeFileSync(registryPath, JSON.stringify(REGISTRY), 'utf8');
		writeFileSync(tasksPath, JSON.stringify(TASKS), 'utf8');
		try {
			const first = await importV1FromFiles(db, { registryPath, tasksPath });
			// sole project → tasks auto-attach to it
			expect(first).toEqual({ projects: 1, tasks: 3 });

			const before = { p: await countProjects(), t: await countTasks() };
			const second = await importV1FromFiles(db, { registryPath, tasksPath });
			expect(second).toEqual({ projects: 1, tasks: 3 });
			// counts unchanged across the re-run — idempotent
			expect(await countProjects()).toBe(before.p);
			expect(await countTasks()).toBe(before.t);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
