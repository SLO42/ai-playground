// LG-3 ROUTE VERIFY — the /projects/[id]/graph loader against a REAL throwaway SurrealDB.
//
// The loader returns the LG-2 read model assembled live from real rows; this test drives the
// loader end-to-end (it reads tryGetDb() — we init it with the test DB so the real loader code
// runs unchanged) and asserts the four shadow paths + the assembled graph contract:
//
//   • happy   — a seeded Continue → session → completion → PM-tick → proposed-task chain flows
//               through the loader as classed nodes + explicit/inferred edges (connected:true).
//   • empty   — a connected project with NO activity → an honest-empty graph (not fabricated).
//   • not-found — an unknown project id → 404 (never an empty graph dressed as a real project).
//   • boundary — a malformed id → 404 (validated at the chokepoint, never an interpolated query).
//
// F-008: every assertion reads through the loader's REAL read path. The exhaustive read-model
// edge/attribute matrix is owned by observability/lifecycle.test.ts; this guards the ROUTE wiring.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject, deleteProject } from '$lib/server/projects/repo';
import { createTask } from '$lib/server/tasks/repo';
import { appendSceneEvent } from '$lib/server/scene/projector';
import { writeAgentEvent } from '$lib/server/analytics/events';
import { load } from './+page.server';
import type { GraphData } from './+page.server';

let tdb: TestDb;
let db: Db;
let projectId: string;
let slug: string;

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
	// Re-init as the runtime singleton so the loader's tryGetDb() returns this DB.
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

beforeEach(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	slug = `lg3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	const p = await createProject(db, { slug, name: 'Graph Host', root_path: 'F:/code/lg3' });
	projectId = p.id;
});

/** Invoke the real loader with a route param. */
async function callLoad(id: string): Promise<GraphData> {
	const depends = () => {};
	return (await load({ params: { id }, depends } as unknown as Parameters<typeof load>[0])) as GraphData;
}

/** Capture a thrown SvelteKit error's status. */
async function loadStatus(id: string): Promise<number> {
	try {
		await callLoad(id);
		return 200;
	} catch (err) {
		return (err as { status?: number }).status ?? 500;
	}
}

describe('/projects/[id]/graph loader — shadow paths + the assembled chain', () => {
	it('empty — a connected project with no activity yields an honest-empty graph', async () => {
		const data = await callLoad(slug);
		expect(data.connected).toBe(true);
		expect(data.projectId).toBe(projectId);
		expect(data.projectName).toBe('Graph Host');
		expect(data.graph.nodes).toEqual([]);
		expect(data.graph.edges).toEqual([]);
		expect(data.graph.complete).toBe(true);
		expect(data.graph.failedSources).toEqual([]);
	});

	it('happy — a Continue→session→completion→PM→task chain flows through as nodes + edges', async () => {
		const t0 = Date.parse('2026-06-25T10:00:00.000Z');

		const continueId = await appendSceneEvent(db, {
			kind: 'continue',
			ref: `project:${slug}`,
			source: 'project',
			project: projectId,
			meta: { readyCount: 1, spawned: 1 }
		});
		await db.query(`UPDATE $id SET at = $at;`, {
			id: new StringRecordId(continueId),
			at: new Date(t0)
		});

		const drained = await createTask(db, {
			project: projectId,
			title: 'Build the widget',
			description: 'x',
			status: 'in_progress'
		});

		// A session the Continue spawned (real role/tool/skill columns).
		const [srows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT $c RETURN AFTER;`,
			{
				c: {
					project: new StringRecordId(projectId),
					task: new StringRecordId(drained.id),
					kind: 'task',
					model: { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' },
					status: 'done',
					runtime: 'claude-code',
					tool_iter_count: 5,
					granted_skills: ['svelte5-patterns'],
					started_at: new Date(t0 + 60_000),
					ended_at: new Date(t0 + 200_000)
				}
			}
		);
		const sessionId = String(srows[0].id);

		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'completion',
			detail: { ok: true, summary: 'done' }
		});

		const pmTickId = await appendSceneEvent(db, {
			kind: 'pm_tick',
			ref: 'pm:tick1',
			source: 'pm',
			project: projectId,
			meta: { state: 'acted', reason: 'task done', ticksUsed: 1 }
		});
		await db.query(`UPDATE $id SET at = $at;`, {
			id: new StringRecordId(pmTickId),
			at: new Date(t0 + 260_000)
		});

		const [pmRows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE pm CONTENT { project: $p, name: "PM", authority: "act" } RETURN AFTER;`,
			{ p: new StringRecordId(projectId) }
		);
		await createTask(db, {
			project: projectId,
			title: 'Polish the widget',
			description: 'follow on',
			proposed_by: String(pmRows[0].id),
			provenance: { kind: 'pm_proposal', evidence: [] }
		});

		const data = await callLoad(slug);
		expect(data.connected).toBe(true);
		const g = data.graph;
		expect(g.complete).toBe(true);

		const byKind = (k: string) => g.nodes.filter((n) => n.kind === k);
		expect(byKind('continue')).toHaveLength(1);
		expect(byKind('session')).toHaveLength(1);
		expect(byKind('pm')).toHaveLength(1);
		expect(byKind('task')).toHaveLength(2);

		// The session node carries the live attributes the UI renders.
		const sNode = byKind('session')[0];
		expect(sNode.label).toBe('session: Build the widget');
		expect(sNode.toolCount).toBe(5);
		expect(sNode.skills).toEqual(['svelte5-patterns']);

		// Edges: the explicit PM→task proposal (inferred:false) and the inferred causal edges.
		const proposed = g.edges.find((e) => e.kind === 'proposed');
		expect(proposed).toBeDefined();
		expect(proposed?.inferred).toBe(false);
		const spawned = g.edges.find((e) => e.kind === 'spawned');
		expect(spawned).toBeDefined();
		const reported = g.edges.find((e) => e.kind === 'reported-to');
		expect(reported).toBeDefined();
		expect(reported?.inferred).toBe(true); // session→PM is the documented inference
	});

	it('not-found — an unknown project id is a 404 (not an empty graph dressed as real)', async () => {
		expect(await loadStatus(`nope_${Date.now()}`)).toBe(404);
	});

	it('boundary — a malformed project id is a 404 (validated at the chokepoint)', async () => {
		expect(await loadStatus('bad id with spaces!')).toBe(404);
	});
});
