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
import { listFleet, listPoolSlots } from './fleet';

// TASK 2.4 VERIFY (part 4) — the /agents read models from REAL rows (F-008). Liveness
// comes from session.status, NEVER agent_slot.busy (UI-SPEC §199).

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
		const res = await launchSession({ db, bus: new EventBus(), runtime, input });

		const fleet = await listFleet(db);
		const mine = fleet.find((f) => f.id === res.sessionId);
		expect(mine).toBeTruthy();
		expect(mine!.status).toBe('done'); // terminal status from the real session row
		expect(mine!.tier).toBe('opus');
		expect(mine!.provider).toBe('claude');
		expect(mine!.projectId).toBe(projectId);
	});
});
