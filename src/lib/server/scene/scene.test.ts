import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { buildSceneGraph, listSceneEvents } from './scene';
import { appendSceneEvent } from './projector';

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
		'DELETE references; DELETE concept_edge; DELETE entity; DELETE memory; DELETE concept; DELETE session; DELETE work_item; DELETE project; DELETE task; DELETE scene_event; DELETE causal_chain; DELETE skill; DELETE retrieval_outcome;'
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
		// session→project: the project IS now a node (project class) → the edge is DRAWN
		// (previously dropped for want of a project node — the interactive-graph wave un-drops it).
		expect(g.edges).toContainEqual({ from: 'session:s', to: project, kind: 'session_target' });
		// work_item→session: both endpoints are nodes → a job_target edge is drawn.
		expect(g.edges).toContainEqual({ from: wiId, to: 'session:s', kind: 'job_target' });
	});

	it('derives PROJECT nodes (name label, status) and un-drops the work_item→project edge', async () => {
		const [p] = await db.query<[Array<{ id: unknown }>]>(
			'CREATE project SET slug="atelier", name="Atelier", root_path="/x", status="active" RETURN AFTER;'
		);
		const pid = String(p[0].id);
		await db.query(
			'CREATE work_item SET work_type="review", project=type::thing("project", $rid), payload={}, priority=5;',
			{ rid: pid.split(':')[1] }
		);

		const g = await buildSceneGraph(db);
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		expect(byId.get(pid)).toMatchObject({ class: 'project', subclass: 'project', label: 'Atelier', status: 'active' });
		// F-013 — project.at (created_at) is an ISO string when present.
		expect(typeof byId.get(pid)!.at).toBe('string');
		// work_item→project edge now draws (project node exists).
		const wiNode = g.nodes.find((n) => n.subclass === 'work_item')!;
		expect(g.edges).toContainEqual({ from: wiNode.id, to: pid, kind: 'job_target' });
	});

	it('synthesizes AGENT nodes from session.agent (m0069) + draws the session→agent edge', async () => {
		// Two sessions ran on the same agent slot, one on another → two agent nodes, clustered.
		await db.query(
			'CREATE session:a1 SET kind="task", status="running", agent="sonnet-1", model={provider:"x",model_id:"y"};'
		);
		await db.query(
			'CREATE session:a2 SET kind="task", status="done", agent="sonnet-1", model={provider:"x",model_id:"y"};'
		);
		await db.query(
			'CREATE session:a3 SET kind="task", status="running", agent="opus-1", model={provider:"x",model_id:"y"};'
		);
		// A legacy session with NO agent → no agent node, no agent edge (F-008 honest).
		await db.query(
			'CREATE session:legacy SET kind="task", status="running", model={provider:"x",model_id:"y"};'
		);

		const g = await buildSceneGraph(db);
		const agents = g.nodes.filter((n) => n.class === 'agent');
		expect(agents.map((n) => n.id).sort()).toEqual(['agent:opus-1', 'agent:sonnet-1']);
		// sonnet-1 has a running session → status running; its label is the slot id.
		const sonnet = agents.find((n) => n.id === 'agent:sonnet-1')!;
		expect(sonnet).toMatchObject({ subclass: 'agent', label: 'sonnet-1', status: 'running' });
		// Each agent-bearing session draws a session→agent edge; the legacy one does not.
		expect(g.edges).toContainEqual({ from: 'session:a1', to: 'agent:sonnet-1', kind: 'agent' });
		expect(g.edges).toContainEqual({ from: 'session:a2', to: 'agent:sonnet-1', kind: 'agent' });
		expect(g.edges).toContainEqual({ from: 'session:a3', to: 'agent:opus-1', kind: 'agent' });
		expect(g.edges.filter((e) => e.kind === 'agent' && e.from === 'session:legacy')).toHaveLength(0);
		// The session node surfaces its agent slot (for the inspect panel); legacy omits it.
		const s1 = g.nodes.find((n) => n.id === 'session:a1')!;
		expect(s1.agent).toBe('sonnet-1');
		expect(g.nodes.find((n) => n.id === 'session:legacy')!.agent).toBeUndefined();
	});

	it('derives S3 cognitive nodes — concept / causal / skill / correction — from real rows', async () => {
		await db.query(
			`CREATE concept:c1 SET label="idempotent migrations", summary="every migration must be idempotent",
			   namespace="default", embedding=array::repeat(0.0, 1024), importance=8.0, status="active", screen_status="clean";`
		);
		await db.query('CREATE causal_chain:cc1 SET trigger="t", outcome="o", kind="fix", success=true, confidence=0.9;');
		await db.query(
			'CREATE skill:sk1 SET name="retry-on-timeout", description="d", embedding=array::repeat(0.0, 1024), steps=["a"], status="active";'
		);
		await db.query(
			`CREATE memory:fix1 SET content="corrected fact", kind="semantic", namespace="default", scope="project",
			   embedding=array::repeat(0.0, 1024), importance=9.0, status="active", screen_status="clean", category="correction";`
		);

		const g = await buildSceneGraph(db);
		const byId = new Map(g.nodes.map((n) => [n.id, n]));
		expect(byId.get('concept:c1')).toMatchObject({ class: 'concept', subclass: 'concept', label: 'idempotent migrations', status: 'active' });
		expect(byId.get('concept:c1')!.summary).toBe('every migration must be idempotent'); // screened summary surfaced
		expect(byId.get('causal_chain:cc1')).toMatchObject({ class: 'causal', subclass: 'causal', status: 'done' });
		expect(byId.get('skill:sk1')).toMatchObject({ class: 'skill', subclass: 'skill', label: 'retry-on-timeout', status: 'active' });
		expect(byId.get('memory:fix1')).toMatchObject({ class: 'correction', subclass: 'correction', status: 'active' });
		// A correction memory is classed as correction, NOT double-counted as a memory node.
		expect(g.nodes.filter((n) => n.id === 'memory:fix1' && n.class === 'memory')).toHaveLength(0);
	});

	it('derives S3 edges — extracted-from (about_concept), supersedes, retrieved + grounded-on', async () => {
		const project = await seedProject();
		const pid = project.split(':')[1];
		await db.query(
			`CREATE memory:src SET content="src", kind="semantic", namespace="default", scope="project",
			   embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";`
		);
		await db.query(
			`CREATE concept:c2 SET label="build cmd", summary="npm run build", namespace="default",
			   embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";`
		);
		await db.query(
			`CREATE concept:old SET label="old", summary="old", namespace="default",
			   embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";`
		);
		// about_concept (memory→concept) renders as extracted-from; supersedes keeps its name.
		await db.query('RELATE memory:src->concept_edge->concept:c2 SET kind="about_concept";');
		await db.query('RELATE concept:c2->concept_edge->concept:old SET kind="supersedes";');
		// retrieval_outcome: a session retrieved memory:src — utilized=true ⇒ grounded-on.
		await db.query(
			'CREATE session:rs SET kind="task", status="running", project=type::thing("project", $pid), model={provider:"x",model_id:"y"};',
			{ pid }
		);
		await db.query('CREATE retrieval_outcome SET session=session:rs, memory=memory:src, utilized=true, cited=true, score=0.8;');

		const g = await buildSceneGraph(db);
		expect(g.edges).toContainEqual({ from: 'memory:src', to: 'concept:c2', kind: 'extracted-from' });
		expect(g.edges).toContainEqual({ from: 'concept:c2', to: 'concept:old', kind: 'supersedes' });
		expect(g.edges).toContainEqual({ from: 'session:rs', to: 'memory:src', kind: 'grounded-on' });
	});

	it('a plain (un-utilized) retrieval_outcome draws a `retrieved` edge', async () => {
		const project = await seedProject();
		const pid = project.split(':')[1];
		await db.query(
			`CREATE memory:r2 SET content="r2", kind="semantic", namespace="default", scope="project",
			   embedding=array::repeat(0.0, 1024), status="active", screen_status="clean";`
		);
		await db.query(
			'CREATE session:r2s SET kind="task", status="running", project=type::thing("project", $pid), model={provider:"x",model_id:"y"};',
			{ pid }
		);
		await db.query('CREATE retrieval_outcome SET session=session:r2s, memory=memory:r2, utilized=false, cited=false, score=0.3;');
		const g = await buildSceneGraph(db);
		expect(g.edges).toContainEqual({ from: 'session:r2s', to: 'memory:r2', kind: 'retrieved' });
	});

	it('a QUARANTINED concept is never surfaced as a node (D-026)', async () => {
		await db.query(
			`CREATE concept:q SET label="leak", summary="secret", namespace="default",
			   embedding=array::repeat(0.0, 1024), status="active", screen_status="quarantined";`
		);
		const g = await buildSceneGraph(db);
		expect(g.nodes.find((n) => n.id === 'concept:q')).toBeUndefined();
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

// ── activity feed reader (MEMORY-SCENE-SPEC §5) ───────────────────────────────────────

describe('listSceneEvents — the activity feed reader', () => {
	it('returns recent scene_events newest-first, normalized (F-013 ISO at)', async () => {
		const project = await seedProject();
		await appendSceneEvent(db, {
			kind: 'memory_added',
			ref: 'memory:m1',
			source: 'memory',
			meta: { kind: 'semantic' }
		});
		await appendSceneEvent(db, {
			kind: 'job_fired',
			ref: 'session:s1',
			source: 'session',
			project,
			meta: { status: 'running', kind: 'task' }
		});

		const feed = await listSceneEvents(db, 40);
		expect(feed.length).toBe(2);
		// newest-first: job_fired was appended second → it's first.
		expect(feed[0].kind).toBe('job_fired');
		expect(feed[1].kind).toBe('memory_added');
		// normalized fields.
		expect(feed[0]).toMatchObject({ ref: 'session:s1', source: 'session', project });
		expect(feed[0].meta).toMatchObject({ status: 'running', kind: 'task' });
		// F-013 — `at` is an ISO string (DEFAULT time::now()), never str(NONE).
		expect(typeof feed[0].at).toBe('string');
		expect(new Date(feed[0].at!).toISOString()).toBe(feed[0].at);
	});

	it('SHADOW nil — null/undefined db yields an honest empty feed (no throw)', async () => {
		expect(await listSceneEvents(null)).toEqual([]);
		expect(await listSceneEvents(undefined)).toEqual([]);
	});

	it('SHADOW empty — a connected DB with no events yields [] (no fabricated line)', async () => {
		expect(await listSceneEvents(db)).toEqual([]);
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
		await expect(listSceneEvents(broken)).rejects.toThrow();
	});

	it('bounded — honors the LIMIT window (most-recent slice, not all-history)', async () => {
		for (let i = 0; i < 6; i++) {
			await appendSceneEvent(db, { kind: 'memory_added', ref: `memory:m${i}`, source: 'memory' });
		}
		const feed = await listSceneEvents(db, 3);
		expect(feed.length).toBe(3);
	});

	it('an invalid/zero limit falls back to the default window (never an unbounded scan)', async () => {
		await appendSceneEvent(db, { kind: 'memory_added', ref: 'memory:x', source: 'memory' });
		expect((await listSceneEvents(db, 0)).length).toBe(1);
		expect((await listSceneEvents(db, -5)).length).toBe(1);
		expect((await listSceneEvents(db, Number.NaN)).length).toBe(1);
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
