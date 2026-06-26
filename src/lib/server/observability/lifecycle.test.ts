import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { appendSceneEvent } from '../scene/projector';
import { writeAgentEvent } from '../analytics/events';
import {
	buildLifecycleGraph,
	type LifecycleGraph,
	type LifecycleEdge
} from './lifecycle';

// LG-2 VERIFY (LIFECYCLE-GRAPH-SPEC §LG-2) — the lifecycle read model from REAL persisted rows.
// Integration vs a real SurrealDB: seed a Continue → sessions → completion → PM-proposed-task chain
// (scene_event markers + session rows with role/role_version/tool_iter_count/granted_skills +
// task.proposed_by/provenance + agent_event spawn/completion + parent_event_id) and assert the
// graph returns the expected NODES (with role/toolCount/skills) and EDGES (explicit ones resolved
// from real links; inferred ones MARKED inferred). Plus: honest-empty, bounded cap, and shadow paths.

let tdb: TestDb;
let db: Db;
let projectId: string;

/** CREATE one raw session row with explicit lifecycle columns; return its id. */
async function seedSession(opts: {
	task?: string;
	role?: string;
	roleVersion?: string;
	status?: string;
	toolIter?: number;
	skills?: string[];
	startedAt?: string;
	endedAt?: string;
}): Promise<string> {
	const content: Record<string, unknown> = {
		project: new StringRecordId(projectId),
		kind: 'task',
		model: { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' },
		status: opts.status ?? 'running',
		runtime: 'claude-code',
		tool_iter_count: opts.toolIter ?? 0
	};
	if (opts.task) content.task = new StringRecordId(opts.task);
	if (opts.role) content.role = new StringRecordId(opts.role);
	if (opts.roleVersion) content.role_version = new StringRecordId(opts.roleVersion);
	if (opts.skills) content.granted_skills = opts.skills;
	if (opts.startedAt) content.started_at = new Date(opts.startedAt);
	if (opts.endedAt) content.ended_at = new Date(opts.endedAt);
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(rows[0].id);
}

/** CREATE a role + role_version pair so a session can carry a real role/hire link. */
async function seedRole(slug: string): Promise<{ role: string; version: string }> {
	const [r] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE role CONTENT { slug: $slug, name: $slug, purpose: "test role" } RETURN AFTER;`,
		{ slug }
	);
	const role = String(r[0].id);
	const [v] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE role_version CONTENT $c RETURN AFTER;`,
		{
			c: {
				role: new StringRecordId(role),
				version: 1,
				prompt_core: 'x',
				prompt_sha: `sha_${slug}`,
				default_tier: 'opus'
			}
		}
	);
	return { role, version: String(v[0].id) };
}

/** CREATE a pm row for the project so proposed_by has a real target. */
async function seedPm(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE pm CONTENT { project: $p, name: "PM", authority: "act" } RETURN AFTER;`,
		{ p: new StringRecordId(projectId) }
	);
	return String(rows[0].id);
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
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

// Fresh project per test → isolated node sets (project-scoped reads keep tests independent).
beforeEach(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	const p = await createProject(db, {
		slug: `lg2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
		name: 'Lifecycle Host',
		root_path: 'F:/code/lg2'
	});
	projectId = p.id;
});

function edge(g: LifecycleGraph, kind: string): LifecycleEdge[] {
	return g.edges.filter((e) => e.kind === kind);
}

describe('LG-2 buildLifecycleGraph — the full Continue→session→completion→PM→task chain', () => {
	it('assembles nodes with role/toolCount/skills + resolves explicit and inferred edges', async () => {
		const t0 = Date.parse('2026-06-25T10:00:00.000Z');
		const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

		// Continue marker roots the chain. appendSceneEvent stamps `at` = time::now(); UPDATE it to
		// our anchored t0 so the inference window (Continue precedes the session start) is deterministic.
		const continueId = await appendSceneEvent(db, {
			kind: 'continue',
			ref: `project:${projectId.split(':')[1]}`,
			source: 'project',
			project: projectId,
			meta: { readyCount: 2, spawned: 2 }
		});
		await db.query(`UPDATE $id SET at = $at;`, {
			id: new StringRecordId(continueId),
			at: new Date(t0)
		});

		// A role/hire + a backlog task the Continue drained.
		const { role, version } = await seedRole('coder');
		const drainedTask = await createTask(db, {
			project: projectId,
			title: 'Build the widget',
			description: 'do it',
			status: 'in_progress'
		});

		// A session the Continue spawned (role/hire/toolCount/skills all REAL columns).
		const sessionId = await seedSession({
			task: drainedTask.id,
			role,
			roleVersion: version,
			status: 'done',
			toolIter: 7,
			skills: ['svelte5-patterns', 'error-learning'],
			startedAt: iso(60_000), // 1 min after the Continue
			endedAt: iso(300_000)
		});

		// spawn + completion agent_events for the session.
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'spawn',
			detail: { intent: 'code-write', reason: 'spawn' }
		});
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'completion',
			tokensIn: 1200,
			tokensOut: 800,
			costUsd: 0.0342,
			durationMs: 240_000,
			detail: { ok: true, summary: 'built the widget' }
		});

		// A PM tick fires after the session finished.
		const pmTickId = await appendSceneEvent(db, {
			kind: 'pm_tick',
			ref: `pm:tick1`,
			source: 'pm',
			project: projectId,
			meta: { state: 'acted', reason: 'task done', ticksUsed: 1 }
		});
		// Stamp the pm_tick AT after the session ended so the inference window resolves session→PM.
		await db.query(`UPDATE $id SET at = $at;`, {
			id: new StringRecordId(pmTickId),
			at: new Date(t0 + 360_000)
		});

		// A NEW task the PM proposed (explicit proposed_by + provenance).
		const pm = await seedPm();
		const proposedTask = await createTask(db, {
			project: projectId,
			title: 'Polish the widget',
			description: 'follow on',
			proposed_by: pm,
			provenance: { kind: 'pm_proposal', evidence: [] }
		});

		const g = await buildLifecycleGraph(db, projectId);

		expect(g.complete).toBe(true);
		expect(g.failedSources).toEqual([]);
		expect(g.project).toBe(projectId);

		// Nodes: 1 continue, 1 pm, 1 session, 2 tasks.
		const byKind = (k: string) => g.nodes.filter((n) => n.kind === k);
		expect(byKind('continue')).toHaveLength(1);
		expect(byKind('pm')).toHaveLength(1);
		expect(byKind('session')).toHaveLength(1);
		expect(byKind('task')).toHaveLength(2);

		// Session node carries the real attributes.
		const sNode = byKind('session')[0];
		expect(sNode.id).toBe(sessionId);
		expect(sNode.label).toBe('session: Build the widget');
		expect(sNode.role).toBe(role);
		expect(sNode.hire).toBe(version);
		expect(sNode.toolCount).toBe(7);
		expect(sNode.skills).toEqual(['svelte5-patterns', 'error-learning']);
		expect(sNode.status).toBe('done');
		expect(sNode.elapsed).toBe(240_000); // 5min - 1min

		// EXPLICIT edge: PM → proposed task (proposed_by + provenance), not inferred.
		const proposed = edge(g, 'proposed');
		expect(proposed).toHaveLength(1);
		expect(proposed[0].from).toBe(pmTickId);
		expect(proposed[0].to).toBe(proposedTask.id);
		expect(proposed[0].inferred).toBe(false);

		// INFERRED edge: Continue → session (spawn parent is not a marker → timestamp window).
		const spawned = edge(g, 'spawned');
		expect(spawned).toHaveLength(1);
		expect(spawned[0].from).toBe(continueId);
		expect(spawned[0].to).toBe(sessionId);
		expect(spawned[0].inferred).toBe(true);

		// INFERRED edge: session → PM (finished session reports to the following pm_tick).
		const reported = edge(g, 'reported-to');
		expect(reported).toHaveLength(1);
		expect(reported[0].from).toBe(sessionId);
		expect(reported[0].to).toBe(pmTickId);
		expect(reported[0].inferred).toBe(true);

		// DETAIL: the session node's token/cost detail is folded from the completion agent_event.
		const det = g.details[sessionId];
		expect(det).toBeDefined();
		expect(det.tokensIn).toBe(1200);
		expect(det.tokensOut).toBe(800);
		expect(det.costUsd).toBeCloseTo(0.0342, 6);
		expect(det.durationMs).toBe(240_000);
		expect(det.tools).toEqual([]); // no tool_use rows seeded → honest empty breakdown
		expect(det.toolTotal).toBe(0);
	});

	it('resolves an EXPLICIT Continue→session edge when the spawn parent_event_id IS the marker', async () => {
		const continueId = await appendSceneEvent(db, {
			kind: 'continue',
			ref: 'project:x',
			source: 'project',
			project: projectId,
			meta: { readyCount: 1 }
		});
		const sessionId = await seedSession({ status: 'running', startedAt: new Date().toISOString() });
		// Spawn carries the Continue marker id as its explicit cause (m0067).
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'spawn',
			parentEventId: continueId,
			detail: { intent: 'code-write' }
		});

		const g = await buildLifecycleGraph(db, projectId);
		const spawned = edge(g, 'spawned');
		expect(spawned).toHaveLength(1);
		expect(spawned[0].from).toBe(continueId);
		expect(spawned[0].to).toBe(sessionId);
		expect(spawned[0].inferred).toBe(false); // EXPLICIT — a real parent link, not a guess
	});

	it('draws an EXPLICIT follow-up edge from revision_of/parent', async () => {
		const orig = await createTask(db, {
			project: projectId,
			title: 'v1',
			description: 'orig'
		});
		const followUp = await createTask(db, {
			project: projectId,
			title: 'v2',
			description: 'revised',
			revision_of: orig.id
		});
		const g = await buildLifecycleGraph(db, projectId);
		const fu = edge(g, 'follow-up');
		expect(fu).toHaveLength(1);
		expect(fu[0].from).toBe(orig.id);
		expect(fu[0].to).toBe(followUp.id);
		expect(fu[0].inferred).toBe(false);
	});
});

describe('LG-2 per-session DETAIL — token usage + cost + per-tool breakdown (F-008)', () => {
	/** CREATE a tool_use message row naming a tool for a session. */
	async function seedToolUse(sessionId: string, tool: string): Promise<void> {
		await db.query(`CREATE message CONTENT $c;`, {
			c: {
				session: new StringRecordId(sessionId),
				role: 'tool',
				kind: 'tool_use',
				content: '',
				tool_call: { name: tool }
			}
		});
	}

	it('sums tokens/cost/duration across multiple agent_events and folds per-tool counts', async () => {
		const sessionId = await seedSession({
			status: 'done',
			toolIter: 5,
			startedAt: new Date().toISOString()
		});
		// Two priced agent_events → the detail SUMS each signal.
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'completion',
			tokensIn: 100,
			tokensOut: 50,
			costUsd: 0.01,
			durationMs: 1000
		});
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'completion',
			tokensIn: 200,
			tokensOut: 25,
			costUsd: 0.02,
			durationMs: 500
		});
		// tool_use rows: Bash×2, Read×1 → desc by count then name.
		await seedToolUse(sessionId, 'Bash');
		await seedToolUse(sessionId, 'Read');
		await seedToolUse(sessionId, 'Bash');

		const g = await buildLifecycleGraph(db, projectId);
		const det = g.details[sessionId];
		expect(det).toBeDefined();
		expect(det.tokensIn).toBe(300);
		expect(det.tokensOut).toBe(75);
		expect(det.costUsd).toBeCloseTo(0.03, 6);
		expect(det.durationMs).toBe(1500);
		expect(det.tools).toEqual([
			{ tool: 'Bash', count: 2 },
			{ tool: 'Read', count: 1 }
		]);
		expect(det.toolTotal).toBe(3);
		expect(det.toolsCapped).toBe(false);
	});

	it('omits cost for an UNPRICED model but still reports tokens (honest — never fake $)', async () => {
		const sessionId = await seedSession({ status: 'done', startedAt: new Date().toISOString() });
		await writeAgentEvent(db, {
			session: sessionId,
			project: projectId,
			type: 'completion',
			tokensIn: 500,
			tokensOut: 300
			// costUsd omitted → unpriced
		});
		const g = await buildLifecycleGraph(db, projectId);
		const det = g.details[sessionId];
		expect(det).toBeDefined();
		expect(det.tokensIn).toBe(500);
		expect(det.tokensOut).toBe(300);
		expect(det.costUsd).toBeUndefined(); // absent → omitted, not 0
	});

	it('a session with NO recorded usage gets NO detail entry (empty shadow path → popover shows —)', async () => {
		const sessionId = await seedSession({ status: 'running', startedAt: new Date().toISOString() });
		const g = await buildLifecycleGraph(db, projectId);
		// The session node exists, but with no agent_event/tool_use rows it has no detail entry.
		expect(g.nodes.some((n) => n.id === sessionId)).toBe(true);
		expect(g.details[sessionId]).toBeUndefined();
	});

	it('folds a tool-only session (no token rows) into a tools breakdown with absent token fields', async () => {
		const sessionId = await seedSession({ status: 'running', startedAt: new Date().toISOString() });
		await seedToolUse(sessionId, 'Grep');
		const g = await buildLifecycleGraph(db, projectId);
		const det = g.details[sessionId];
		expect(det).toBeDefined();
		expect(det.tools).toEqual([{ tool: 'Grep', count: 1 }]);
		expect(det.toolTotal).toBe(1);
		expect(det.tokensIn).toBeUndefined();
		expect(det.costUsd).toBeUndefined();
	});
});

describe('LG-2 shadow paths — nil / empty / honest attributes', () => {
	it('honest-empty for a project with no activity (F-008)', async () => {
		const g = await buildLifecycleGraph(db, projectId);
		expect(g.nodes).toEqual([]);
		expect(g.edges).toEqual([]);
		expect(g.complete).toBe(true);
		expect(g.capped).toBe(false);
	});

	it('nil db → honest empty graph (no throw)', async () => {
		const g = await buildLifecycleGraph(null, projectId);
		expect(g.nodes).toEqual([]);
		expect(g.edges).toEqual([]);
		expect(g.project).toBe(projectId);
		expect(g.complete).toBe(true);
	});

	it('a malformed projectId throws at the boundary (fail-loud, not honest-empty)', async () => {
		await expect(buildLifecycleGraph(db, 'not-a-record-id')).rejects.toThrow();
	});

	it('omits absent attributes — never fabricates role/toolCount/skills (F-008)', async () => {
		// A bare session: no role, no skills, tool_iter_count defaults to 0, still running (no end).
		const sessionId = await seedSession({ startedAt: new Date().toISOString() });
		const g = await buildLifecycleGraph(db, projectId);
		const sNode = g.nodes.find((n) => n.id === sessionId)!;
		expect(sNode).toBeDefined();
		expect(sNode.role).toBeUndefined();
		expect(sNode.hire).toBeUndefined();
		expect(sNode.skills).toBeUndefined();
		expect(sNode.toolCount).toBe(0); // a real 0 (column default), not omitted — honest
		expect(sNode.status).toBe('running');
		expect(sNode.label).toBe('session'); // no task → bare label, not a fabricated name
		// A live (un-ended) session has an elapsed (start→now), positive.
		expect(sNode.elapsed).toBeGreaterThanOrEqual(0);
	});

	it('does NOT draw a session→PM edge for an UNFINISHED session', async () => {
		const t0 = Date.now();
		await appendSceneEvent(db, {
			kind: 'pm_tick',
			ref: 'pm:t',
			source: 'pm',
			project: projectId,
			meta: { state: 'acted' }
		});
		// A running session with NO completion event → never reports.
		await seedSession({ status: 'running', startedAt: new Date(t0).toISOString() });
		const g = await buildLifecycleGraph(db, projectId);
		expect(edge(g, 'reported-to')).toHaveLength(0);
	});

	it('does NOT draw an inferred edge across nodes of a DIFFERENT project', async () => {
		// Continue in THIS project, session in ANOTHER project → no cross-project spawned edge.
		await appendSceneEvent(db, {
			kind: 'continue',
			ref: 'project:x',
			source: 'project',
			project: projectId,
			meta: { readyCount: 1 }
		});
		const other = await createProject(db, {
			slug: `lg2_other_${Date.now()}`,
			name: 'Other',
			root_path: 'F:/code/other'
		});
		try {
			// Session in the OTHER project.
			const content = {
				project: new StringRecordId(other.id),
				kind: 'task',
				model: { provider: 'claude', model_id: 'm', tier: 'opus' },
				status: 'running',
				runtime: 'claude-code',
				tool_iter_count: 0,
				started_at: new Date()
			};
			await db.query(`CREATE session CONTENT $content RETURN AFTER;`, { content });
			const g = await buildLifecycleGraph(db, projectId);
			// THIS project's graph only has the Continue node; no session, no spawned edge.
			expect(g.nodes.filter((n) => n.kind === 'session')).toHaveLength(0);
			expect(edge(g, 'spawned')).toHaveLength(0);
		} finally {
			await deleteProject(db, other.id).catch(() => {});
		}
	});
});

describe('LG-2 bounded (F-014)', () => {
	it('caps the node window and reports capped=true', async () => {
		const now = Date.now();
		// Seed 4 sessions; cap to 2 → only 2 session nodes, capped flagged.
		for (let i = 0; i < 4; i++) {
			await seedSession({ status: 'running', startedAt: new Date(now - i * 1000).toISOString() });
		}
		const g = await buildLifecycleGraph(db, projectId, { sessions: 2 });
		expect(g.nodes.filter((n) => n.kind === 'session')).toHaveLength(2);
		expect(g.capped).toBe(true);
	});

	it('does not flag capped when everything fits under the caps', async () => {
		await seedSession({ status: 'running', startedAt: new Date().toISOString() });
		const g = await buildLifecycleGraph(db, projectId);
		expect(g.capped).toBe(false);
	});
});
