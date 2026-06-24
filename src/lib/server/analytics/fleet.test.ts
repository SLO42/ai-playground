import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { launchSession, type LaunchInput } from '../sessions/launch';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import {
	listFleet,
	listPoolSlots,
	listFleetAcrossProjects,
	getFleetSession,
	listAgentCatalog
} from './fleet';

// TASK 2.4 VERIFY (part 4) — the /agents read models from REAL rows (F-008). Liveness
// comes from session.status, NEVER agent_slot.busy (UI-SPEC §199).

// WI-2: these fleet read-model tests launch code-write sessions only incidentally (their subject
// is the fleet projection, not git mechanics). The project roots are plain path fixtures, not git
// repos, so we inject a FAKE worktree acquirer that returns a deterministic per-session worktree
// path+branch — exercising the WI-2 persist path without a real repo. The real worktree mechanics
// are proven against a temp git repo in launch.test.ts + worktree.test.ts.
const fakeAcquireWorktree = async (projectRoot: string, sessionId: string) => ({
	cwd: `${projectRoot}/.wt/${sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	branch: `atelier/session/${sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
	cleanup: async () => {}
});

function scriptedBackend(events: RuntimeEvent[], cc: string): CcBackend {
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			void plan;
			return {
				ccSessionId: cc,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;

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
	const p = await createProject(db, { slug: 'fleet', name: 'Fleet Host', root_path: 'F:/code/fleet' });
	projectId = p.id;
	const t = await createTask(db, { project: projectId, title: 'work', description: 'do it' });
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('fleet read models (2.4; UI-SPEC §198–200)', () => {
	it('listPoolSlots returns real agent_slot definitions', async () => {
		await db.query(`CREATE agent_slot CONTENT { name: "coder-1", tier: "opus", role: "coder" };`);
		await db.query(`CREATE agent_slot CONTENT { name: "scout-1", tier: "local", role: "scout" };`);
		const slots = await listPoolSlots(db);
		expect(slots.length).toBeGreaterThanOrEqual(2);
		const tiers = new Set(slots.map((s) => s.tier));
		expect(tiers.has('opus')).toBe(true);
		expect(tiers.has('local')).toBe(true);
	});

	it('listFleet returns sessions, liveness from session.status', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_fleet_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_fleet_1') });
		const input: LaunchInput = {
			projectId,
			taskId,
			agentId: 'agent_fleet',
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			intent: 'code-write',
			budgets: {},
			toolPolicy: { allow: ['Read'] }
		};
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input,
			acquireWorktree: fakeAcquireWorktree
		});

		const fleet = await listFleet(db);
		const mine = fleet.find((f) => f.id === res.sessionId);
		expect(mine).toBeTruthy();
		expect(mine!.status).toBe('done'); // terminal status from the real session row
		expect(mine!.tier).toBe('opus');
		expect(mine!.provider).toBe('claude');
		expect(mine!.projectId).toBe(projectId);
	});

	// OBSERVABILITY — a FAILED session's honest reason (session.note) is surfaced by every fleet
	// read (project list, cross-project fleet, single-session header) so the project page +
	// /claude-code can render WHY it failed instead of a dead row with no reason. A clean session
	// carries note=null (honest absence, never str(undefined) — F-013 class).
	it('surfaces session.note (failure reason) on a failed session, null on a clean one', async () => {
		// A failed run: the backend yields an `error` event (the cli-backend instant-fail shape),
		// so launchSession stamps the honest reason on session.note (the observability fix).
		const failRuntime = new ClaudeCodeRuntime({
			backend: scriptedBackend(
				[{ type: 'error', error: 'claude CLI failed to start: spawn claude ENOENT' }],
				`cc_fleet_fail_${Math.random().toString(36).slice(2, 8)}`
			)
		});
		const failRes = await launchSession({
			db,
			bus: new EventBus(),
			runtime: failRuntime,
			acquireWorktree: fakeAcquireWorktree,
			input: {
				projectId,
				taskId,
				agentId: 'agent_fleet_fail',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: {},
				toolPolicy: { allow: ['Read'] }
			}
		});
		expect(failRes.status).toBe('failed');

		// (a) project-scoped list
		const byProject = await listFleet(db);
		const fp = byProject.find((s) => s.id === failRes.sessionId);
		expect(fp).toBeTruthy();
		expect(fp!.status).toBe('failed');
		expect(fp!.note).toBeTruthy();
		expect(fp!.note).toContain('failed to start');

		// (b) cross-project fleet
		const xp = await listFleetAcrossProjects(db);
		const xfp = xp.find((s) => s.id === failRes.sessionId);
		expect(xfp!.note).toContain('ENOENT');

		// (c) single-session header
		const meta = await getFleetSession(db, failRes.sessionId);
		expect(meta!.note).toContain('failed to start');

		// A clean done session carries note=null (honest absence — no fabricated reason).
		const cleanRuntime = new ClaudeCodeRuntime({
			backend: scriptedBackend(
				[{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_fleet_clean_note' } }],
				'cc_fleet_clean_note'
			)
		});
		const cleanRes = await launchSession({
			db,
			bus: new EventBus(),
			runtime: cleanRuntime,
			acquireWorktree: fakeAcquireWorktree,
			input: {
				projectId,
				taskId,
				agentId: 'agent_fleet_clean',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: {},
				toolPolicy: { allow: ['Read'] }
			}
		});
		const cleanMeta = await getFleetSession(db, cleanRes.sessionId);
		expect(cleanMeta!.status).toBe('done');
		expect(cleanMeta!.note).toBeNull();
	});

	// TASK 9.3 — the cross-project fleet joins the owning project's LABEL (name/slug) and
	// aggregates sessions ACROSS ALL projects, liveness from session.status (F-008 / §199).
	it('listFleetAcrossProjects joins project label and spans projects', async () => {
		// A second project with its own session — the fleet must surface both projects.
		const p2 = await createProject(db, {
			slug: 'fleet_two',
			name: 'Second Host',
			root_path: 'F:/code/fleet_two'
		});
		const t2 = await createTask(db, { project: p2.id, title: 'work2', description: 'do it' });
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_fleet_2' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_fleet_2') });
		const res2 = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			acquireWorktree: fakeAcquireWorktree,
			input: {
				projectId: p2.id,
				taskId: t2.id,
				agentId: 'agent_fleet_2',
				model: { provider: 'claude', modelId: 'claude-haiku-4', tier: 'haiku' },
				intent: 'code-write',
				budgets: {},
				toolPolicy: { allow: ['Read'] }
			}
		});

		const xp = await listFleetAcrossProjects(db);
		// Both projects' sessions appear in the one portfolio-wide fleet.
		const fromP1 = xp.find((s) => s.projectId === projectId);
		const fromP2 = xp.find((s) => s.id === res2.sessionId);
		expect(fromP1).toBeTruthy();
		expect(fromP2).toBeTruthy();
		// The project LABEL is joined (name + slug), not just the id (F-008 honest label).
		expect(fromP1!.projectName).toBe('Fleet Host');
		expect(fromP1!.projectSlug).toBe('fleet');
		expect(fromP2!.projectName).toBe('Second Host');
		expect(fromP2!.projectSlug).toBe('fleet_two');
		expect(fromP2!.tier).toBe('haiku');
		// cc_session_id rides along for resume/interject parity.
		expect(fromP2!.ccSessionId).toBe('cc_fleet_2');

		await deleteProject(db, p2.id).catch(() => {});
	});

	// TASK 11.3 — the agent-TYPE catalog reads the cc_agent MIRROR (F-008), grouping the same
	// agent name across scopes and joining each scope's kind + owning project (UI-SPEC §198).
	it('listAgentCatalog groups agent types by name and joins their scopes', async () => {
		// Two scopes: a global one and a project one. Same agent name "coder" defined in both
		// (must collapse to ONE catalog entry carrying both scopes); a global-only "reviewer".
		const [g] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE cc_scope CONTENT { kind: "global", path: "/home/u/.claude" } RETURN id;`
		);
		const globalScope = String(g[0].id);
		const [pr] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE cc_scope CONTENT { kind: "project", path: "F:/code/fleet/.claude", project: $project } RETURN id;`,
			{ project: new StringRecordId(projectId) }
		);
		const projScope = String(pr[0].id);

		await db.query(
			`CREATE cc_agent CONTENT { scope: $s, file_path: "f1", name: "coder", description: "writes code", frontmatter: {}, category: "core" };`,
			{ s: new StringRecordId(globalScope) }
		);
		await db.query(
			`CREATE cc_agent CONTENT { scope: $s, file_path: "f2", name: "coder", description: "writes code", frontmatter: {} };`,
			{ s: new StringRecordId(projScope) }
		);
		await db.query(
			`CREATE cc_agent CONTENT { scope: $s, file_path: "f3", name: "reviewer", description: "reviews", frontmatter: {}, category: "swarm" };`,
			{ s: new StringRecordId(globalScope) }
		);

		const cat = await listAgentCatalog(db);
		const coder = cat.find((c) => c.name === 'coder');
		const reviewer = cat.find((c) => c.name === 'reviewer');

		expect(coder).toBeTruthy();
		expect(reviewer).toBeTruthy();
		// "coder" collapses to ONE entry with BOTH scopes (global + project).
		expect(coder!.scopes.length).toBe(2);
		const kinds = new Set(coder!.scopes.map((s) => s.kind));
		expect(kinds.has('global')).toBe(true);
		expect(kinds.has('project')).toBe(true);
		// The project scope joins the owning project id (honest "where it's defined").
		const projEntry = coder!.scopes.find((s) => s.kind === 'project');
		expect(projEntry!.projectId).toBe(projectId);
		expect(coder!.description).toBe('writes code');
		// First non-null metadata wins (category came from the global scope row).
		expect(coder!.category).toBe('core');
		// reviewer is global-only.
		expect(reviewer!.scopes.length).toBe(1);
		expect(reviewer!.scopes[0].kind).toBe('global');
		expect(reviewer!.category).toBe('swarm');
		// Sorted by name (coder < reviewer).
		const names = cat.map((c) => c.name);
		expect(names.indexOf('coder')).toBeLessThan(names.indexOf('reviewer'));
	});
});

// TASK (transcript-panel) — getFleetSession backs the /claude-code?session=<id> transcript-panel
// header (one session's status/model/project label). SHADOW PATHS: happy (a real session) +
// unknown id (→ null, honest "no session found") + malformed id (→ throws at the D-016
// assertRecordId chokepoint; the loader catches and renders null, never interpolates).
describe('getFleetSession — single-session header metadata (transcript-panel)', () => {
	it('returns the launched session metadata (status/model/project label) by id', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_one_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_one_1') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			acquireWorktree: fakeAcquireWorktree,
			input: {
				projectId,
				taskId,
				agentId: 'agent_one',
				model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
				intent: 'code-write',
				budgets: {},
				toolPolicy: { allow: ['Read'] }
			}
		});

		const meta = await getFleetSession(db, res.sessionId);
		expect(meta).toBeTruthy();
		expect(meta!.id).toBe(res.sessionId);
		expect(meta!.status).toBe('done'); // terminal status from the real session row (F-008)
		expect(meta!.provider).toBe('claude');
		expect(meta!.tier).toBe('opus');
		// The owning project's LABEL is joined (not just the id) — honest header.
		expect(meta!.projectName).toBe('Fleet Host');
		expect(meta!.projectSlug).toBe('fleet');
		expect(meta!.ccSessionId).toBe('cc_one_1');
		// WI-2: the worktree provenance is surfaced honestly (this was a WRITE session via the fake
		// acquirer) — a real per-session branch, never null on a worktree session.
		expect(meta!.worktreePath).toBeTruthy();
		expect(meta!.worktreeBranch).toContain('atelier/session/');
	});

	it('returns null for an unknown (never-launched) session id — honest, never fabricated', async () => {
		// A well-FORMED record id that does not exist → null (the panel shows "no session found").
		const meta = await getFleetSession(db, 'session:does_not_exist_xyz');
		expect(meta).toBeNull();
	});

	it('rejects a malformed session id at the D-016 boundary (assertRecordId), never interpolates', async () => {
		// The loader wraps this in try/catch and renders null; here we assert the chokepoint
		// throws rather than building a query string from untrusted input.
		await expect(getFleetSession(db, 'not a record id !! { DROP }')).rejects.toThrow();
	});
});
