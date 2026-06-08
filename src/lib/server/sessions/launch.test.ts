import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus, type BusEvent } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { launchSession, type LaunchInput } from './launch';

// TASK 1.6b VERIFY (DATA-MODEL §4.3/§4.4; D-011) — the NON-LIVE half of 1.6.
//
// A SCRIPTED runtime stream (the same mocked/sandboxed backend pattern 1.4's
// contract suite used — NO live API, NO creds, NO network to Anthropic) is launched
// for a real project+task. The launch path persists a `session`(+cc_session_id
// bridge) + per-transcript `message` rows + `agent_event` rows, ALL read back from
// the live throwaway DB (no fake runtime data — F-008; a mocked runtime in a TEST is
// allowed). The same path publishes a `transcript` bus event per stream event — the
// render-live path that the SSE fan-out (1.5) already proves reaches the dashboard.
//
// The capstone (a REAL credentialed transcript end-to-end) is deferred to the
// credential wave (needs CLAUDE_CODE_OAUTH_TOKEN); the LOGIC is fully built+verified
// here against the mock.

// ── A scripted backend: records the plan, emits a fixed transcript stream ──────────
// `ccSessionId` is per-instance unique so the session_dedup UNIQUE index (dedup_key =
// cc_session_id OR id) does not collide across the suite's independent launches.
function scriptedBackend(
	events: RuntimeEvent[],
	ccSessionId = `cc_sess_${Math.random().toString(36).slice(2, 10)}`
): CcBackend & { plans: CcSpawnPlan[]; ccSessionId: string } {
	const plans: CcSpawnPlan[] = [];
	return {
		plans,
		ccSessionId,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return {
				ccSessionId: req.ccSessionId,
				async *stream() {
					yield { type: 'done', result: { ok: true, summary: 'resumed' } };
				},
				async cancel() {}
			};
		},
		async interject() {}
	};
}

/** A 5-event scripted transcript; the done event bridges a UNIQUE cc_session_id. */
function transcript(ccSessionId: string): RuntimeEvent[] {
	return [
		{ type: 'log', message: 'session started' },
		{ type: 'tool_call', name: 'Read', args: { file: 'src/x.ts' }, needsConfirm: false },
		{ type: 'tool_result', name: 'Read', ok: true, output: 'file contents' },
		{ type: 'token_usage', input: 120, output: 45 },
		{ type: 'done', result: { ok: true, summary: 'all done', ccSessionId } }
	];
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
	const p = await createProject(db, {
		slug: 'sess',
		name: 'Session Host',
		root_path: 'F:/code/sess'
	});
	projectId = p.id;
	const t = await createTask(db, {
		project: projectId,
		title: 'Do the thing',
		description: 'Read x and report.'
	});
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

function baseInput(over: Partial<LaunchInput> = {}): LaunchInput {
	return {
		projectId,
		taskId,
		agentId: 'agent_coder_1',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		...over
	};
}

describe('launchSession — persistence plumbing (1.6b; D-011)', () => {
	it('persists a session row, cwd = project root, with the cc_session_id bridge', async () => {
		const backend = scriptedBackend(transcript('cc_sess_AB12'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cc' });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		// cwd handed to the runtime is the PROJECT ROOT (D-002 / 1.4a).
		expect(backend.plans[0]?.cwd).toBe('F:/code/sess');
		// 1.4a deny rules are active via the isolated config carried on the plan.
		expect(backend.plans[0]?.isolated.env.CLAUDE_CONFIG_DIR).toBeTruthy();

		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: res.sessionId.startsWith('session:')
				? new (await import('surrealdb')).StringRecordId(res.sessionId)
				: res.sessionId
		});
		const sess = rows[0];
		expect(sess).toBeTruthy();
		// cc_session_id bridge persisted from the runtime's done result.
		expect(sess.cc_session_id).toBe('cc_sess_AB12');
		expect(String(sess.task)).toBe(taskId);
		expect(String(sess.project)).toBe(projectId);
		expect(sess.kind).toBe('task');
		expect(sess.runtime).toBe('claude-code');
		// terminal status reflects the runtime's done(ok:true).
		expect(sess.status).toBe('done');
		expect(sess.ended_at).toBeTruthy();
	});

	it('persists transcript messages linked to the session (assistant + tool rows)', async () => {
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_msg_1')) });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		const sid = new (await import('surrealdb')).StringRecordId(res.sessionId);
		const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM message WHERE session = $sid ORDER BY at ASC;`,
			{ sid }
		);
		// log → assistant, tool_call → tool, tool_result → tool.
		expect(msgs.length).toBeGreaterThanOrEqual(3);
		const roles = msgs.map((m) => m.role);
		expect(roles).toContain('assistant');
		expect(roles).toContain('tool');
		// tool_call message carries its tool_call object.
		const toolMsg = msgs.find((m) => m.role === 'tool' && m.tool_call);
		expect(toolMsg).toBeTruthy();
		expect((toolMsg!.tool_call as Record<string, unknown>).name).toBe('Read');
	});

	it('persists agent_event rows: a spawn and a completion with token totals', async () => {
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_evt_1')) });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		const sid = new (await import('surrealdb')).StringRecordId(res.sessionId);
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM agent_event WHERE session = $sid ORDER BY at ASC;`,
			{ sid }
		);
		const types = evs.map((e) => e.type);
		expect(types).toContain('spawn');
		expect(types).toContain('completion');
		const completion = evs.find((e) => e.type === 'completion');
		expect(completion!.tokens_in).toBe(120);
		expect(completion!.tokens_out).toBe(45);
		expect(String(completion!.project)).toBe(projectId);
	});

	it('emits a transcript bus event per stream event (the render-live path)', async () => {
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe(
			(e) => seen.push(e),
			(e) => e.type === 'transcript'
		);
		const events = transcript('cc_bus_1');
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events) });
		const res = await launchSession({ db, bus, runtime, input: baseInput() });

		// One transcript event per runtime stream event, topic = session id (per §2.11).
		expect(seen.length).toBe(events.length);
		expect(seen.every((e) => e.topic === res.sessionId)).toBe(true);
		const kinds = seen.map((e) => (e.data as { kind: string }).kind);
		expect(kinds).toEqual(['log', 'tool_call', 'tool_result', 'token_usage', 'done']);
	});

	it('a failed runtime done marks the session failed and records an error completion', async () => {
		const fail: RuntimeEvent[] = [
			{ type: 'log', message: 'working' },
			{ type: 'error', error: 'boom' },
			{ type: 'done', result: { ok: false, summary: 'failed' } }
		];
		const bus = new EventBus();
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(fail) });
		const res = await launchSession({ db, bus, runtime, input: baseInput() });

		const sid = new (await import('surrealdb')).StringRecordId(res.sessionId);
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: sid
		});
		expect(rows[0].status).toBe('failed');
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM agent_event WHERE session = $sid AND type = "error";`,
			{ sid }
		);
		expect(evs.length).toBeGreaterThanOrEqual(1);
	});
});
