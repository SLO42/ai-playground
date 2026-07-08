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
import { writeAgentEvent, __setPricingForTest } from './events';

// TASK 2.4 VERIFY (part 1) — every lifecycle step writes an agent_event, through the ONE
// shared writer. We prove: (a) the writer creates a valid row for each of the 5 types,
// omits absent optionals (no fabricated cost), and binds links via the D-016 guard; and
// (b) the existing launch path (refactored onto the shared writer) still emits spawn +
// completion. All rows read back from the live throwaway DB (F-008; mock runtime is a
// TEST seam — not fabricated product data).

function scriptedBackend(events: RuntimeEvent[], cc = `cc_${Math.random().toString(36).slice(2, 9)}`): CcBackend {
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
	const p = await createProject(db, { slug: 'analytics', name: 'Analytics Host', root_path: 'F:/code/an' });
	projectId = p.id;
	const t = await createTask(db, { project: projectId, title: 'Trace me', description: 'do work' });
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('writeAgentEvent — the shared lifecycle writer (2.4; DATA-MODEL §4.4)', () => {
	it('writes each of the 5 lifecycle types as valid rows', async () => {
		const types = ['spawn', 'completion', 'escalation', 'cancel', 'error'] as const;
		for (const type of types) {
			const id = await writeAgentEvent(db, { type, project: projectId, detail: { reason: `t-${type}` } });
			expect(id.startsWith('agent_event:')).toBe(true);
		}
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT type FROM agent_event WHERE project = $pid;`,
			{ pid: new StringRecordId(projectId) }
		);
		const seen = new Set(rows.map((r) => r.type));
		for (const type of types) expect(seen.has(type)).toBe(true);
	});

	it('omits absent optionals — never fabricates a cost (F-008)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			tokensIn: 100,
			tokensOut: 50
			// no costUsd passed → must stay NONE, not 0
		});
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(id)
		});
		expect(rows[0].tokens_in).toBe(100);
		expect(rows[0].cost_usd === undefined || rows[0].cost_usd === null).toBe(true);
	});

	it('writes a priced cost ONLY when given a real figure', async () => {
		const id = await writeAgentEvent(db, { type: 'completion', project: projectId, costUsd: 0.042 });
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT cost_usd FROM $rid;`, {
			rid: new StringRecordId(id)
		});
		expect(rows[0].cost_usd).toBeCloseTo(0.042, 5);
	});

	it('rejects an invalid record id at the D-016 chokepoint', async () => {
		await expect(writeAgentEvent(db, { type: 'spawn', project: 'not a valid id' })).rejects.toThrow();
	});

	// LIFECYCLE-GRAPH (m0067) — parent_event_id persists the EXPLICIT cause when KNOWN, omits when not.
	it('persists parent_event_id when the cause is known + omits it (NONE) when not', async () => {
		// Cause KNOWN (a triggering work_item id) → the column carries the opaque table:id ref.
		const cause = `work_item:cause_${Date.now()}`;
		const withParent = await writeAgentEvent(db, {
			type: 'spawn',
			project: projectId,
			parentEventId: cause
		});
		// Cause UNKNOWN (omitted) → the column stays NONE — never a fabricated link (F-008).
		const noParent = await writeAgentEvent(db, { type: 'spawn', project: projectId });
		// A blank/whitespace ref is treated as unknown (omitted), never stored as ''.
		const blankParent = await writeAgentEvent(db, {
			type: 'spawn',
			project: projectId,
			parentEventId: '   '
		});

		const [pr] = await db.query<[Array<{ parent_event_id?: unknown }>]>(`SELECT parent_event_id FROM $rid;`, {
			rid: new StringRecordId(withParent)
		});
		expect(pr[0].parent_event_id).toBe(cause);

		const [np] = await db.query<[Array<{ parent_event_id?: unknown }>]>(`SELECT parent_event_id FROM $rid;`, {
			rid: new StringRecordId(noParent)
		});
		expect(np[0].parent_event_id === undefined || np[0].parent_event_id === null).toBe(true);

		const [bp] = await db.query<[Array<{ parent_event_id?: unknown }>]>(`SELECT parent_event_id FROM $rid;`, {
			rid: new StringRecordId(blankParent)
		});
		expect(bp[0].parent_event_id === undefined || bp[0].parent_event_id === null).toBe(true);
	});

	it('launch path still emits spawn + completion via the shared writer', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'token_usage', input: 80, output: 20 },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_launch_x' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_launch_x') });
		const causeWorkItem = `work_item:launch_cause_${Date.now()}`;
		const input: LaunchInput = {
			projectId,
			taskId,
			agentId: 'agent_x',
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			intent: 'code-write',
			budgets: {},
			toolPolicy: { allow: ['Read'] },
			// LIFECYCLE-GRAPH (m0067): the orchestrator drain passes the triggering work_item id; the
			// spawn agent_event must carry it as parent_event_id so the graph draws the queue→session edge.
			parentEventId: causeWorkItem
		};
		// WI-2: inject a fake worktree acquirer so this code-write spawn (against a non-git path
		// fixture) exercises the persist path without git mechanics this analytics test doesn't cover.
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input,
			acquireWorktree: async (root, sid) => ({
				cwd: `${root}/.wt/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
				branch: `atelier/session/${sid.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
				cleanup: async () => {}
			})
		});
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT type, detail, parent_event_id, at FROM agent_event WHERE session = $sid ORDER BY at ASC;`,
			{ sid: new StringRecordId(res.sessionId) }
		);
		const types = evs.map((e) => e.type);
		expect(types).toContain('spawn');
		expect(types).toContain('completion');
		// spawn detail carries the how/why (intent) for the trace chain.
		const spawn = evs.find((e) => e.type === 'spawn');
		expect((spawn!.detail as Record<string, unknown>).intent).toBe('code-write');
		// LIFECYCLE-GRAPH (m0067): the spawn carries the explicit cause threaded through launchSession.
		expect(spawn!.parent_event_id).toBe(causeWorkItem);
	});
});

// COST-GOVERNANCE-SPEC CG-1 — cost_usd is METERED at this one completion-write chokepoint.
// Real-surreal (F-020): every assertion reads cost_usd back from the live throwaway DB, so the
// computed figure round-trips as a real number/NULL — a stubDb couldn't prove the write persists.
// A deterministic pricing map is injected so the test never depends on config/pricing.yaml contents.
describe('writeAgentEvent — CG-1 cost metering (real-surreal)', () => {
	beforeAll(() => {
		__setPricingForTest({
			models: {
				'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
				'gpt-oss:20b': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 }
			}
		});
	});
	afterAll(() => __setPricingForTest(null));

	async function costOf(id: string): Promise<unknown> {
		const [rows] = await db.query<[Array<{ cost_usd?: unknown }>]>(`SELECT cost_usd FROM $rid;`, {
			rid: new StringRecordId(id)
		});
		return rows[0].cost_usd;
	}

	it('a PRICED model + tokens ⇒ a computed cost_usd (200 in / 80 out @ opus = $0.003)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 200,
			tokensOut: 80
		});
		expect(await costOf(id)).toBeCloseTo(0.003, 9);
	});

	it('a LOCAL/$0 model + tokens ⇒ a GENUINE 0 (recorded as 0, NOT null — CG-1)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' },
			tokensIn: 5000,
			tokensOut: 5000
		});
		expect(await costOf(id)).toBe(0);
	});

	it('an UNPRICED model + tokens ⇒ cost_usd stays NULL (never a fabricated $0 — F-008)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-sonnet-4-6', tier: 'sonnet' },
			tokensIn: 1000,
			tokensOut: 1000
		});
		const c = await costOf(id);
		expect(c === undefined || c === null).toBe(true);
	});

	it('a priced model with NO tokens (a spawn) ⇒ NONE, not 0 (nothing to meter)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'spawn',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' }
		});
		const c = await costOf(id);
		expect(c === undefined || c === null).toBe(true);
	});

	it('an explicit caller-priced costUsd wins over computation (gauntlet sumPricedCost path)', async () => {
		const id = await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 200,
			tokensOut: 80,
			costUsd: 9.99
		});
		expect(await costOf(id)).toBeCloseTo(9.99, 5);
	});
});
