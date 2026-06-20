import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { buildSceneGraph } from './scene';

// MEMORY-SCENE-SPEC §7.2 VERIFY — the read-only scene AGGREGATOR derives the node/edge
// TRUTH LIVE from the existing tables (NO denormalized copy, F-008). Proven against a live
// throwaway SurrealDB:
//   • derives MEMORY (entity + memory) + USAGE/JOBS (session + work_item) nodes with the
//     right class/subclass/status, and the three edge kinds (references / session_target /
//     job_target) from seeded rows.
//   • honest empty on an empty / nil DB (F-008).
//   • READ-ONLY invariant — the module source contains no mutating verb.
//   • bounded — per-class window caps are honored.
//   • all four data-flow shadow paths (happy / nil / empty / upstream-error).
//   • D-026 — a quarantined memory row is never surfaced as a node.

let tdb: TestDb;
let db: Db;

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
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown().catch(() => {});
});

beforeEach(async () => {
	// Each test starts from an empty graph — clear the source tables we seed.
	await db.query(
		'DELETE references; DELETE entity; DELETE memory; DELETE session; DELETE work_item; DELETE work_item; DELETE project; DELETE task;'
	);
});

/** Seed a project, return its id. */
async function seedProject(slug = 'demo'): Promise<string> {
	const [p] = await db.query<[Array<{ id: unknown }>]>(
		'CREATE project SET slug=$slug, name=$slug, root_path="/x" RETURN AFTER;',
		{ slug }
	);
	return String(p[0].id);
}

// ── happy path ───────────────────────────────────────────────────────────────────────

describe('buildSceneGraph — derived node/edge truth', () => {
	it('derives MEMORY + JOB nodes with class/subclass/status from real rows', async () => {
		const project = await seedProject();
		await db.query('CREATE entity:auth SET label="Auth", type="concept", status="active";');
		await db.query(
			'CREATE memory:m1 SET content="c", kind="semantic", namespace="default", scope="project", embedding=array::repeat(0.0, 1024), importance=7.0, status="active", screen_status="clean";',
			{}
		);
		await db.query(
			'CREATE session:s1 SET kind="task", status="running", project=type::thing("project", $pid), model={provider:"x",model_id:"y"};',
			{ pid: project.split(':')[1] }
		);
		const [wi] = await db.query<[Array<{ id: unknown }>]>(
			"CREATE work_item SET work_type='review', payload={}, priority=5 RETURN AFTER;"
		);
		const wiId = String(wi[0].id);

		const g = await buildSceneGraph(db);
		const byId = new Map(g.nodes.map((n) => [n.id, n]));

		expect(byId.get('entity:auth')).toMatchObject({ class: 'memory', subclass: 'entity', label: 'Auth', status: 'active' });
		expect(byId.get('memory:m1')).toMatchObject({ class: 'memory', subclass: 'memory', status: 'active' });
		expect(byId.get('session:s1')).toMatchObject({ class: 'job', subclass: 'session', status: 'running' });
		expect(byId.get(wiId)).toMatchObject({ class: 'job', subclass: 'work_item', status: 'pending' });

		// F-013 — memory.at is an ISO string (never str(NONE)); session.at present too.
		const mem = byId.get('memory:m1')!;
		expect(typeof mem.at).toBe('string');
		expect(new Date(mem.at!).toISOString()).toBe(mem.at);
		// project lifted off the session row.
		expect(byId.get('session:s1')!.project).toBe(project);
	});

	it('derives references edges (entity↔entity + entity↔memory), filtered to the node window', async () => {
		await db.query('CREATE entity:a SET label="A", type="t", status="active";');
		await db.query('CREATE entity:b SET label="B", type="t", status="active";');
		await db.query(
			'CREATE memory:m SET content="c", kind="semantic", namespace="default", scope="project", embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";'
		);
		// entity↔entity and entity↔memory references edges.
		await db.query('RELATE entity:a->references->entity:b SET kind="relates_to";');
		await db.query('RELATE entity:a->references->memory:m SET kind="derived_from";');

		const g = await buildSceneGraph(db);
		const refEdges = g.edges.filter((e) => e.kind === 'references');
		expect(refEdges).toContainEqual({ from: 'entity:a', to: 'entity:b', kind: 'references' });
		expect(refEdges).toContainEqual({ from: 'entity:a', to: 'memory:m', kind: 'references' });
	});

	it('derives session_target (session→project) + job_target (work_item→session) edges', async () => {
		const project = await seedProject();
		const pid = project.split(':')[1];
		await db.query(
			'CREATE session:s SET kind="task", status="running", project=type::thing("project", $pid), model={provider:"x",model_id:"y"};',
			{ pid }
		);
		const [wi] = await db.query<[Array<{ id: unknown }>]>(
			'CREATE work_item SET work_type="review", session=session:s, payload={}, priority=5 RETURN AFTER;'
		);
		const wiId = String(wi[0].id);

		const g = await buildSceneGraph(db);
		// session→project is a session_target ONLY if the project is also a node — project
		// nodes are a later wave (fork #2), so this edge is correctly DROPPED, not faked.
		expect(g.edges.find((e) => e.kind === 'session_target')).toBeUndefined();
		// work_item→session: both endpoints are nodes → a job_target edge is drawn.
		expect(g.edges).toContainEqual({ from: wiId, to: 'session:s', kind: 'job_target' });
	});

	it('drops dangling edges whose endpoint is outside the returned node window (bounded)', async () => {
		await db.query('CREATE entity:a SET label="A", type="t", status="active";');
		await db.query('CREATE entity:b SET label="B", type="t", status="active";');
		await db.query('RELATE entity:a->references->entity:b SET kind="relates_to";');
		// Cap entities to 1 → only one of the two endpoints is a node → the edge is dropped.
		const g = await buildSceneGraph(db, { entities: 1 });
		expect(g.nodes.filter((n) => n.subclass === 'entity')).toHaveLength(1);
		expect(g.edges.filter((e) => e.kind === 'references')).toHaveLength(0);
	});
});

// ── shadow paths ───────────────────────────────────────────────────────────────────

describe('buildSceneGraph — shadow paths (F-008 honest)', () => {
	it('SHADOW nil — a null/undefined db yields an honest empty graph (no throw)', async () => {
		expect(await buildSceneGraph(null)).toEqual({ nodes: [], edges: [] });
		expect(await buildSceneGraph(undefined)).toEqual({ nodes: [], edges: [] });
	});

	it('SHADOW empty — a connected but empty DB yields {nodes:[],edges:[]} (never a fake graph)', async () => {
		const g = await buildSceneGraph(db);
		expect(g).toEqual({ nodes: [], edges: [] });
	});

	it('SHADOW upstream-error — a query failure PROPAGATES (not swallowed into a fake-empty)', async () => {
		const broken = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await broken.close();
		// A closed connection: the SELECT rejects. The aggregator must NOT mask a DB failure
		// as an empty graph (empty means "nothing exists", not "the DB broke") — it throws,
		// and the loader degrades to connected:false.
		await expect(buildSceneGraph(broken)).rejects.toThrow();
	});

	it('D-026 — a quarantined memory row is never surfaced as a node', async () => {
		await db.query(
			'CREATE memory:clean SET content="ok", kind="semantic", namespace="default", scope="project", embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";'
		);
		await db.query(
			'CREATE memory:secret SET content="leak", kind="semantic", namespace="default", scope="project", embedding=array::repeat(0.0, 1024), status="active", screen_status="quarantined";'
		);
		const g = await buildSceneGraph(db);
		const memIds = g.nodes.filter((n) => n.subclass === 'memory').map((n) => n.id);
		expect(memIds).toContain('memory:clean');
		expect(memIds).not.toContain('memory:secret');
	});
});

// ── bounded ─────────────────────────────────────────────────────────────────────────

describe('buildSceneGraph — bounded window', () => {
	it('honors per-class caps (recent/active window, not all-history)', async () => {
		for (let i = 0; i < 5; i++) {
			await db.query(`CREATE entity:e${i} SET label="E${i}", type="t", status="active";`);
			await db.query(
				`CREATE session:s${i} SET kind="task", status="running", model={provider:"x",model_id:"y"};`
			);
		}
		const g = await buildSceneGraph(db, { entities: 2, sessions: 3 });
		expect(g.nodes.filter((n) => n.subclass === 'entity')).toHaveLength(2);
		expect(g.nodes.filter((n) => n.subclass === 'session')).toHaveLength(3);
	});
});

// ── read-only invariant (grep-provable, asserted) ────────────────────────────────────

describe('buildSceneGraph — read-only invariant', () => {
	it('the aggregator source contains NO mutating SurrealQL verb (derive, never write)', () => {
		const src = readFileSync(fileURLToPath(new URL('./scene.ts', import.meta.url)), 'utf8');
		// Strip line + block comments so a verb appearing in prose doesn't false-positive.
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.map((l) => l.replace(/\/\/.*$/, ''))
			.join('\n');
		for (const verb of ['CREATE', 'UPDATE', 'DELETE', 'RELATE', 'UPSERT', 'INSERT', 'REMOVE']) {
			expect(code).not.toMatch(new RegExp(`\\b${verb}\\b`));
		}
		// Positive: every query the module issues is a SELECT.
		expect(code).toMatch(/db\.query/);
	});
});
