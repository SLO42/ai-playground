import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
	sessionToolBreakdown,
	usageRollup,
	DEFAULT_ROLLUP_SESSION_CAP
} from './usage';

// UO-2 VERIFY — the usage read model from REAL persisted rows (UO-1 grants + tool_use messages).
// Integration vs a real SurrealDB: seed sessions whose scripted runtime stream emits tool_call
// events (→ tool_use message rows) and whose LaunchInput grants capabilities (→ session.granted_*),
// then assert the per-session breakdown + cross-session roll-up + dead-grant distinction + honest
// empties + the F-014 cap. GRANTED and USED are kept DISTINCT — never conflated.

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

/** Build a tool_call → tool_result event pair for `tool`, which persists a `tool_use` message row. */
function toolEvents(...tools: string[]): RuntimeEvent[] {
	const evs: RuntimeEvent[] = [];
	for (const t of tools) {
		evs.push({ type: 'tool_call', name: t, args: {}, needsConfirm: false });
		evs.push({ type: 'tool_result', name: t, ok: true, output: 'ok' });
	}
	return evs;
}

let tdb: TestDb;
let db: Db;
let projectId: string;
let taskId: string;
let ccCounter = 0;

/** Launch one session with the given granted capabilities + scripted tool calls; return its id. */
async function seedSession(opts: {
	tools: string[];
	skills?: string[];
	agents?: string[];
	mcp?: string[];
	toolAllow?: string[];
}): Promise<string> {
	const cc = `cc_uo2_${ccCounter++}`;
	const events: RuntimeEvent[] = [
		{ type: 'log', message: 'go' },
		...toolEvents(...opts.tools),
		{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: cc } }
	];
	const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, cc) });
	const input: LaunchInput = {
		projectId,
		taskId,
		agentId: 'agent_uo2',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: {},
		toolPolicy: { allow: opts.toolAllow ?? [] },
		capabilities: {
			skills: opts.skills ?? [],
			agents: opts.agents ?? [],
			mcp: opts.mcp ?? []
		}
	};
	const res = await launchSession({
		db,
		bus: new EventBus(),
		runtime,
		input,
		acquireWorktree: fakeAcquireWorktree
	});
	return res.sessionId;
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
	const p = await createProject(db, {
		slug: 'uo2',
		name: 'Usage Obs Host',
		root_path: 'F:/code/uo2'
	});
	projectId = p.id;
	const t = await createTask(db, { project: projectId, title: 'work', description: 'do it' });
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('UO-2 sessionToolBreakdown — per-session tool_use → name→count (F-014 bounded)', () => {
	it('folds a session tool_use rows into correct per-name counts + total', async () => {
		// Bash x3, Read x2, Edit x1 → 6 total tool calls.
		const sid = await seedSession({ tools: ['Bash', 'Read', 'Bash', 'Edit', 'Read', 'Bash'] });
		const b = await sessionToolBreakdown(db, sid);
		expect(b.sessionId).toBe(sid);
		expect(b.total).toBe(6);
		expect(b.capped).toBe(false);
		const map = Object.fromEntries(b.tools.map((t) => [t.tool, t.count]));
		expect(map).toEqual({ Bash: 3, Read: 2, Edit: 1 });
		// sorted desc by count → Bash first.
		expect(b.tools[0].tool).toBe('Bash');
	});

	it('honest-empty for a session that called no tools (F-008)', async () => {
		const sid = await seedSession({ tools: [] });
		const b = await sessionToolBreakdown(db, sid);
		expect(b.tools).toEqual([]);
		expect(b.total).toBe(0);
		expect(b.capped).toBe(false);
	});

	it('respects the row cap and reports capped=true (F-014)', async () => {
		const sid = await seedSession({ tools: ['Bash', 'Bash', 'Bash', 'Bash'] });
		// cap below the row count → honest lower bound + capped flag.
		const b = await sessionToolBreakdown(db, sid, 2);
		expect(b.total).toBe(2);
		expect(b.capped).toBe(true);
	});

	it('honest-empty for a session id that has no rows at all', async () => {
		// A real-but-tool-less session reads as empty (no fabricated bucket).
		const sid = await seedSession({ tools: [] });
		const b = await sessionToolBreakdown(db, sid);
		expect(b.total).toBe(0);
	});
});

describe('UO-2 usageRollup — cross-session granted-vs-used attribution (distinct, F-008)', () => {
	it('maps a granted skill → its sessions and a used tool → its sessions; granted≠used', async () => {
		const s1 = await seedSession({
			tools: ['Bash', 'Read'],
			skills: ['svelte5-patterns'],
			toolAllow: ['Bash', 'Read', 'Edit']
		});
		const s2 = await seedSession({
			tools: ['Bash'],
			skills: ['svelte5-patterns', 'error-learning'],
			toolAllow: ['Bash']
		});

		const r = await usageRollup(db);

		// Granted skill svelte5-patterns → both sessions.
		const skill = r.granted.find((g) => g.dimension === 'skill' && g.id === 'svelte5-patterns');
		expect(skill).toBeTruthy();
		expect(skill!.grantedSessionCount).toBe(2);
		const skillSessions = new Set(skill!.grantedTo.map((s) => s.sessionId));
		expect(skillSessions.has(s1)).toBe(true);
		expect(skillSessions.has(s2)).toBe(true);
		// A skill grant carries used=null — we never fabricate a skill→tool_use mapping (F-008).
		expect(skill!.used).toBeNull();
		expect(skill!.usedCallCount).toBeNull();

		// error-learning granted to s2 only.
		const el = r.granted.find((g) => g.dimension === 'skill' && g.id === 'error-learning');
		expect(el!.grantedSessionCount).toBe(1);
		expect(el!.grantedTo[0].sessionId).toBe(s2);

		// Used tool Bash → at least s1 + s2 (the DB is shared across tests, so assert membership +
		// a per-session count, never an exact global total that prior tests perturb).
		const bash = r.usedTools.find((t) => t.tool === 'Bash');
		expect(bash).toBeTruthy();
		const bashSessions = new Set(bash!.sessions.map((s) => s.sessionId));
		expect(bashSessions.has(s1)).toBe(true);
		expect(bashSessions.has(s2)).toBe(true);
		expect(bash!.callCount).toBeGreaterThanOrEqual(2);
		// Bash was on these sessions' tool_allow grant → wasGranted true.
		expect(bash!.wasGranted).toBe(true);

		// attribution carries task + intent on the rolled-up session refs.
		const s1Ref = bash!.sessions.find((s) => s.sessionId === s1);
		expect(s1Ref!.taskId).toBe(taskId);
		expect(s1Ref!.intent).toBe('code-write');
	});

	it('surfaces a DEAD grant: tool-allow id granted but never used → used=false / 0 calls', async () => {
		// Edit is on s1's tool_allow but s1 never CALLED Edit (only Bash+Read).
		const r = await usageRollup(db);
		const editGrant = r.granted.find((g) => g.dimension === 'tool-allow' && g.id === 'Edit');
		expect(editGrant).toBeTruthy();
		expect(editGrant!.used).toBe(false); // GRANTED but never invoked — the dead-grant view
		expect(editGrant!.usedCallCount).toBe(0);

		// vs Bash tool-allow which WAS used.
		const bashGrant = r.granted.find((g) => g.dimension === 'tool-allow' && g.id === 'Bash');
		expect(bashGrant!.used).toBe(true);
		expect(bashGrant!.usedCallCount).toBeGreaterThan(0);
	});

	it('keeps granted and used DISTINCT — a used tool with no recorded grant is not invented as a grant', async () => {
		// A session that USES a tool NOT on its tool_allow grant → the tool appears in usedTools but
		// NOT as a tool-allow grant for that session; wasGranted reflects whether ANY using session
		// granted it.
		const sUngranted = await seedSession({
			tools: ['WebFetch'],
			skills: ['svelte5-patterns'],
			toolAllow: ['Bash'] // WebFetch deliberately NOT granted
		});
		const r = await usageRollup(db);
		const web = r.usedTools.find((t) => t.tool === 'WebFetch');
		expect(web).toBeTruthy();
		expect(web!.sessions.some((s) => s.sessionId === sUngranted)).toBe(true);
		// Not granted to anyone → wasGranted false (a recorded session used it ungranted).
		expect(web!.wasGranted).toBe(false);
		// And there is NO tool-allow grant for WebFetch (we never fabricated one).
		const webGrant = r.granted.find((g) => g.dimension === 'tool-allow' && g.id === 'WebFetch');
		expect(webGrant).toBeUndefined();
	});

	it('legacy/unrecorded grant (null) contributes no grant but its tool_use still counts as used', async () => {
		// Simulate a legacy row: a session with NO granted fields persisted. We write a bare session
		// + a tool_use row by hand (predates UO-1) — normGrantedRow → null.
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT $c RETURN AFTER;`,
			{
				c: {
					project: undefined,
					kind: 'task',
					model: { provider: 'claude', model_id: 'claude-opus-4-8', tier: 'opus' },
					status: 'done'
				}
			}
		);
		const legacyId = String(created[0].id);
		await db.query(`CREATE message CONTENT $c;`, {
			c: {
				session: created[0].id,
				role: 'tool',
				kind: 'tool_use',
				content: '→ Grep',
				seq: 0,
				tool_call: { name: 'Grep' }
			}
		});

		const r = await usageRollup(db);
		// No grant rows attributable to the legacy session (it recorded none).
		const legacyGrants = r.granted.filter((g) =>
			g.grantedTo.some((s) => s.sessionId === legacyId)
		);
		expect(legacyGrants).toEqual([]);
		// But Grep IS counted as used, attributed to the legacy session, wasGranted=null (no grant
		// recorded for ANY using session → honest tri-state, not false).
		const grep = r.usedTools.find((t) => t.tool === 'Grep');
		expect(grep).toBeTruthy();
		expect(grep!.sessions.some((s) => s.sessionId === legacyId)).toBe(true);
		expect(grep!.wasGranted).toBeNull();
	});

	it('honest-empty roll-up when scanned over an empty DB window via tiny caps still bounded', async () => {
		// The rollup is always bounded — assert the caps are honored + reported. With a generous DB
		// already seeded, force a session cap of 1 and assert sessionsCapped fires.
		const r = await usageRollup(db, { sessionCap: 1 });
		expect(r.sessionsScanned).toBe(1);
		expect(r.sessionsCapped).toBe(true);
	});

	it('default session cap is bounded (F-014 — never an unbounded scan)', async () => {
		const r = await usageRollup(db);
		expect(r.sessionsScanned).toBeLessThanOrEqual(DEFAULT_ROLLUP_SESSION_CAP);
	});

	it('reports toolRowsCapped when the tool_use scan hits its cap (F-014)', async () => {
		await seedSession({ tools: ['Bash', 'Bash', 'Bash'] });
		const r = await usageRollup(db, { toolRowCap: 2 });
		expect(r.toolRowsCapped).toBe(true);
	});
});
