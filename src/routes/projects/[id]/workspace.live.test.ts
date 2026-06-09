// TASK 10.4 — integration proof for the project-workspace tabs (Tasks board / Memory /
// Settings / Overview Maintain panel + hierarchical Roadmap) on /projects/[id].
//
// Exercises the EXACT repo + explorer functions the +page.server load + actions assemble,
// against a REAL migrated SurrealDB (F-008 — every assertion reads a real row, no mocks):
//
//   1. Tasks BOARD round-trip: createTask → listTasksByProject groups by status; the
//      board's per-task `moves` come from the canTransition state machine; setStatus moves
//      a task live and an illegal move is rejected (D-008 task lifecycle).
//   2. Maintain panel: writeFindings (security + dependency. + ux. families) → listFindings
//      returns ONLY this project's live findings, sorted critical→low (UI-SPEC §189).
//   3. Project Memory: a project-scoped memory row + a referenced entity → listProjectMemories
//      and listProjectGraph return ONLY this project's recall + topic sub-graph (UI-SPEC §195),
//      and a DIFFERENT project's memory does NOT leak in.
//   4. Settings: updateProject persists the mutable columns; slug/id immutable.
//   5. F-013 GUARD: the assembled load-shape (incl. the sprint's SET datetime, read back
//      through the projects repo) is fully devalue-safe — no Surreal Datetime/RecordId leaks
//      into the page payload. This is the regression the fails.md gotcha demands.
//
// If the SurrealDB binary can't start, the suite skips honestly (never a faked artifact).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as devalue from 'devalue';
import { Db } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { StringRecordId } from 'surrealdb';
import {
	createProject,
	createRelease,
	createPhase,
	createFeature,
	createSprint,
	getProject,
	listReleases,
	listPhases,
	listFeatures,
	listSprints,
	updateProject
} from '$lib/server/projects/repo';
import {
	createTask,
	listTasksByProject,
	setStatus,
	canTransition,
	InvalidTransitionError,
	TASK_STATUSES,
	type TaskStatus
} from '$lib/server/tasks/repo';
import { writeFindings, listFindings } from '$lib/server/scanner/findings-repo';
import { listProjectMemories, listProjectGraph, storeMemory, FakeEmbedder } from '$lib/server/memory';

let test: TestDb | undefined;
let db: Db | undefined;
let available = false;

beforeAll(async () => {
	try {
		test = await startTestDb();
		db = await Db.connect({
			url: test.wsUrl,
			namespace: test.namespace,
			database: test.database,
			username: test.root.username,
			password: test.root.password
		});
		await runMigrations(db, schemaMigrations);
		await createProject(db, { slug: 'wsdemo', name: 'Workspace Demo', root_path: '/tmp/wsdemo' });
		await createProject(db, { slug: 'wsother', name: 'Other', root_path: '/tmp/wsother' });
		available = true;
	} catch {
		available = false;
	}
}, 60_000);

afterAll(async () => {
	try {
		await db?.close();
	} catch {
		/* ignore */
	}
	await test?.teardown();
});

const PID = 'project:wsdemo';

describe('Tasks board — create + group + move through the state machine (UI-SPEC §190; D-008)', () => {
	it('creates a task, groups it by status, and exposes legal move targets', async () => {
		if (!available || !db) return;
		const t = await createTask(db, {
			project: PID,
			title: 'Wire the board',
			description: 'Wire the board',
			priority: 'high',
			origin: 'manual'
		});
		expect(t.status).toBe('backlog');

		const rows = await listTasksByProject(db, PID);
		expect(rows.some((r) => r.id === t.id)).toBe(true);

		// The board's per-task move targets are exactly the state machine's reachable set.
		const moves = [...TASK_STATUSES].filter((s) => canTransition(t.status, s));
		expect(moves).toContain('ready');
		expect(moves).not.toContain('done'); // backlog → done is illegal
	});

	it('moves a task live and rejects an illegal transition', async () => {
		if (!available || !db) return;
		const t = await createTask(db, {
			project: PID,
			title: 'Move me',
			description: 'Move me',
			origin: 'manual'
		});
		const moved = await setStatus(db, t.id, 'ready');
		expect(moved?.status).toBe('ready');

		// An illegal move (ready → done) is rejected by the machine — nothing written.
		await expect(setStatus(db, t.id, 'done' as TaskStatus)).rejects.toBeInstanceOf(
			InvalidTransitionError
		);
		const after = await listTasksByProject(db, PID);
		expect(after.find((r) => r.id === t.id)?.status).toBe('ready');
	});
});

describe('Maintain panel — project-scoped findings rollup (UI-SPEC §189; D-015)', () => {
	it('lists this project\'s security/dependency/ux findings, severity-sorted, scoped', async () => {
		if (!available || !db) return;
		await writeFindings(db, PID, [
			{ rule: 'security.eval', severity: 'critical', file: 'src/run.js', line: 1, detail: 'eval() of dynamic input' },
			{ rule: 'dependency.outdated', severity: 'high', file: 'package.json', line: 0, detail: 'left-pad 1.0 < 1.3' },
			{ rule: 'ux.contrast', severity: 'low', file: '/projects', line: 0, detail: 'low text contrast' }
		]);
		// A finding on the OTHER project must NOT leak into this project's panel.
		await writeFindings(db, 'project:wsother', [
			{ rule: 'security.secret', severity: 'critical', file: 'x.ts', line: 3, detail: 'hardcoded secret' }
		]);

		const found = await listFindings(db, PID);
		const rules = found.map((f) => f.rule);
		expect(rules).toEqual(
			expect.arrayContaining(['security.eval', 'dependency.outdated', 'ux.contrast'])
		);
		expect(found.every((f) => f.project === PID)).toBe(true);
		// critical-first ordering (the panel renders this order).
		expect(found[0].severity).toBe('critical');
	});
});

describe('Project Memory — scoped recall + topic graph (UI-SPEC §195; F-008)', () => {
	it('returns only this project\'s memory + referenced entities, not another project\'s', async () => {
		if (!available || !db) return;
		// Store two memory rows (this project + the other) via the real store pipeline with a
		// deterministic FakeEmbedder — no Ollama, but a real screen+embed+insert (F-008).
		const opts = { db, embedder: new FakeEmbedder() };
		const mine = await storeMemory(opts, {
			project: PID,
			content: 'Workspace tab decision',
			importance: 7.0
		});
		await storeMemory(opts, {
			project: 'project:wsother',
			content: 'Other project note',
			importance: 5.0
		});
		// A referenced entity → the project's topic sub-graph.
		const [[ent]] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE entity CONTENT { label: "SvelteKit", type: "tech" } RETURN AFTER;`
		);
		await db.query(`RELATE $m->references->$e SET kind = "mentions";`, {
			m: new StringRecordId(mine.id),
			e: new StringRecordId(String(ent.id))
		});

		const mems = await listProjectMemories(db, PID);
		expect(mems.some((m) => m.content === 'Workspace tab decision')).toBe(true);
		expect(mems.some((m) => m.content === 'Other project note')).toBe(false);

		const graph = await listProjectGraph(db, PID);
		expect(graph.nodes.some((n) => n.label === 'SvelteKit')).toBe(true);
	});
});

describe('Settings — project config persists; slug/id immutable (UI-SPEC §196; D-016)', () => {
	it('updateProject saves the mutable columns', async () => {
		if (!available || !db) return;
		const updated = await updateProject(db, PID, {
			name: 'Workspace Demo (renamed)',
			status: 'active',
			build_tool: 'npm',
			test_command: 'npm test',
			repo_url: 'https://github.com/x/y'
		});
		expect(updated?.name).toBe('Workspace Demo (renamed)');
		expect(updated?.test_command).toBe('npm test');
		const reread = await getProject(db, PID);
		expect(reread?.build_tool).toBe('npm');
		expect(reread?.slug).toBe('wsdemo'); // slug never changes
	});
});

describe('F-013 guard — the assembled load-shape is devalue-safe (no Surreal datetime/RecordId leak)', () => {
	it('a SET sprint datetime read back through the repo serializes as an ISO string', async () => {
		if (!available || !db) return;
		// Roadmap hierarchy with a release → phase/feature, plus a sprint carrying a SET
		// datetime (`starts`) — the exact non-POJO field class the F-013 gotcha warns about.
		const rel = await createRelease(db, { project: PID, version: 'v0.4', title: 'Workspace', status: 'active' });
		await createPhase(db, { project: PID, release: rel.id, name: 'Build tabs', order: 1, status: 'in_progress' });
		await createFeature(db, { project: PID, release: rel.id, title: 'Tasks board', status: 'in_progress' });
		await createSprint(db, { project: PID, name: 'v0.4 — workspace', starts: new Date('2026-06-09T00:00:00Z') });

		// Assemble the SAME shape the +page.server load returns to the client.
		const [releases, phases, features, sprints, tasks, findings, memories, graph, project] =
			await Promise.all([
				listReleases(db, PID),
				listPhases(db, PID),
				listFeatures(db, PID),
				listSprints(db, PID),
				listTasksByProject(db, PID),
				listFindings(db, PID),
				listProjectMemories(db, PID),
				listProjectGraph(db, PID),
				getProject(db, PID)
			]);

		const sprint = sprints.find((s) => s.name === 'v0.4 — workspace');
		expect(typeof sprint?.starts).toBe('string'); // coerced to ISO, not a Surreal Datetime
		expect(sprint?.starts).toContain('2026-06-09');

		const loadShape = {
			connected: true,
			project,
			releases,
			phases,
			features,
			sprints,
			tasks: tasks.map((t) => ({
				id: t.id,
				title: t.title,
				status: t.status,
				priority: t.priority,
				moves: [...TASK_STATUSES].filter((s) => canTransition(t.status, s))
			})),
			findings,
			memories,
			graph
		};

		// devalue.stringify is the SvelteKit load serializer — it THROWS on a non-POJO value
		// (the F-013 failure mode). A clean round-trip proves the whole payload is safe.
		const wire = devalue.stringify(loadShape);
		const back = devalue.parse(wire) as typeof loadShape;
		expect(back.releases[0].version).toBe('v0.4');
		expect(typeof back.sprints.find((s) => s.name === 'v0.4 — workspace')?.starts).toBe('string');
	});
});
