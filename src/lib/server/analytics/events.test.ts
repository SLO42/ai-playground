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
import { writeAgentEvent } from './events';

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

	it('launch path still emits spawn + completion via the shared writer', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'token_usage', input: 80, output: 20 },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_launch_x' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_launch_x') });
		const input: LaunchInput = {
			projectId,
			taskId,
			agentId: 'agent_x',
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			intent: 'code-write',
			budgets: {},
			toolPolicy: { allow: ['Read'] }
		};
		const res = await launchSession({ db, bus: new EventBus(), runtime, input });
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT type, detail, at FROM agent_event WHERE session = $sid ORDER BY at ASC;`,
			{ sid: new StringRecordId(res.sessionId) }
		);
		const types = evs.map((e) => e.type);
		expect(types).toContain('spawn');
		expect(types).toContain('completion');
		// spawn detail carries the how/why (intent) for the trace chain.
		const spawn = evs.find((e) => e.type === 'spawn');
		expect((spawn!.detail as Record<string, unknown>).intent).toBe('code-write');
	});
});
