import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { EventBus, type BusEvent } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type AgentRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { launchSession, type LaunchInput } from './launch';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFleetAcrossProjects } from '../analytics/fleet';
import { writeAgentEvent } from '../analytics/events';
import { __setBudgetForTest, TokenBudgetExceededError } from '../analytics/spend-budget';

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
		// WI-2: these plumbing tests are intent-agnostic (persistence/transcript/analytics). They
		// use a READ class so they keep the shared project root (the project's root_path is a plain
		// path fixture, not a git repo); the WRITE→worktree wiring is proven in its own describe
		// block below against a REAL temp git repo. A WRITE intent here would fail closed (non-git).
		intent: 'code-read',
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		...over
	};
}

/** An AgentRuntime that yields a fixed event stream and then RETURNS (no throw) — models the
 *  real cli-backend path where a child spawn-fail / instant pre-init death / non-zero exit is
 *  surfaced as an `error` EVENT (NOT a throw, NOT a `done`). This is the path that previously
 *  recorded note=null (the live 6-ROUNDS observability gap). */
function eventStreamRuntime(events: RuntimeEvent[]): AgentRuntime {
	return {
		spawn: async function* () {
			for (const e of events) yield e;
		},
		async health() {
			return { runtime: 'mock', providers: [] };
		},
		tools() {
			return [];
		},
		async cancel() {}
	};
}

describe('launchSession — persistence plumbing (1.6b; D-011)', () => {
	it('persists a session row, cwd = project root (READ session), with the cc_session_id bridge', async () => {
		const backend = scriptedBackend(transcript('cc_sess_AB12'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cc' });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		// A READ-class session keeps the shared PROJECT ROOT (D-002 / 1.4a) — WI-2 only worktrees WRITE classes.
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
		// m0038: EVERY launched transcript turn is the driven agent's OWN output — a SELF-turn,
		// server-stamped origin='agent', NEVER operator (a self-turn can never become steering).
		expect(msgs.every((m) => m.origin === 'agent')).toBe(true);
		expect(msgs.some((m) => m.origin === 'operator')).toBe(false);
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

	it('emits a COALESCABLE token_usage bus event keyed by session id (latest-wins, not per-seq)', async () => {
		// TASK 2.1 (harden): the render-live transcript stream keeps a per-seq `transcript`
		// event (must never be lost), but token_usage is ALSO published as a dedicated
		// `token_usage` bus event keyed by the SESSION id (stable) carrying running totals.
		// A stable key is what lets the SSE layer coalesce latest-wins under backpressure;
		// the per-seq transcript key (sessionId:order) would make every event distinct and
		// never coalesce — that is the production bug this task closes.
		const bus = new EventBus();
		const usage: BusEvent[] = [];
		bus.subscribe(
			(e) => usage.push(e),
			(e) => e.type === 'token_usage'
		);
		// Two token_usage events so we can prove the key is stable across them.
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'go' },
			{ type: 'token_usage', input: 100, output: 10 },
			{ type: 'token_usage', input: 50, output: 5 },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_usage_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_usage_1') });
		const res = await launchSession({ db, bus, runtime, input: baseInput() });

		expect(usage.length).toBe(2);
		// Stable coalesce key = session id for BOTH events (not sessionId:seq).
		expect(usage.every((e) => e.topic === res.sessionId)).toBe(true);
		expect(usage.every((e) => e.key === res.sessionId)).toBe(true);
		// Running totals accumulate (latest event carries the cumulative figures).
		const last = usage[usage.length - 1].data as { tokensIn: number; tokensOut: number };
		expect(last.tokensIn).toBe(150);
		expect(last.tokensOut).toBe(15);
	});

	// ── transcript-persistence promotion: kind + seq + thinking + D-026 screen ──────────

	it('persists turns IN ORDER with a kind discriminator + monotonic seq (replayable)', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'first assistant turn' },
			{ type: 'thinking', text: 'let me reason about this' },
			{ type: 'tool_call', name: 'Read', args: { file: 'a.ts' }, needsConfirm: false },
			{ type: 'tool_result', name: 'Read', ok: true, output: 'contents' },
			{ type: 'log', message: 'final assistant turn' },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_order_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_order_1') });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		const sid = new StringRecordId(res.sessionId);
		const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT role, kind, seq, content FROM message WHERE session = $sid ORDER BY seq ASC;`,
			{ sid }
		);
		// Replay order is exactly the stream order, by the monotonic seq (m0037).
		expect(msgs.map((m) => m.kind)).toEqual([
			'assistant_text',
			'thinking',
			'tool_use',
			'tool_result',
			'assistant_text'
		]);
		// seq is strictly increasing.
		const seqs = msgs.map((m) => m.seq as number);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
		// the thinking turn persisted its text honestly.
		const think = msgs.find((m) => m.kind === 'thinking');
		expect(think!.content).toBe('let me reason about this');
	});

	it('persists EMPTY thinking honestly — empty stays empty, never invented (F-008)', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'thinking', text: '' },
			{ type: 'log', message: 'ok' },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_empty_think_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_empty_think_1') });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		const sid = new StringRecordId(res.sessionId);
		const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT kind, content FROM message WHERE session = $sid AND kind = "thinking";`,
			{ sid }
		);
		expect(msgs).toHaveLength(1);
		// Honest empty — the field is the empty string, not a fabricated placeholder.
		expect(msgs[0].content).toBe('');
	});

	it('SCREENS a planted secret out of assistant text + tool args before persist (D-026)', async () => {
		const SECRET = 'sk-ant-abcdEFGH1234secretvalue';
		const events: RuntimeEvent[] = [
			{ type: 'log', message: `here is the token ${SECRET} you asked for` },
			{ type: 'thinking', text: `I will use ${SECRET} to authenticate` },
			{
				type: 'tool_call',
				name: 'Bash',
				args: { command: `curl -H "Authorization: Bearer ${SECRET}" https://x` },
				needsConfirm: false
			},
			{ type: 'tool_result', name: 'Bash', ok: true, output: `auth used ${SECRET}` },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_secret_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_secret_1') });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		const sid = new StringRecordId(res.sessionId);
		const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT content, tool_call FROM message WHERE session = $sid;`,
			{ sid }
		);
		// The raw secret survives in NO persisted column (content or nested tool_call).
		const blob = JSON.stringify(msgs);
		expect(blob).not.toContain(SECRET);
		// And the redaction marker IS present (it was caught, not silently dropped).
		expect(blob).toContain('REDACTED');
	});

	it('a transcript-persist ERROR does NOT propagate into the session (fail-open, F-014)', async () => {
		// A db wrapper whose `CREATE message` throws, but every other query succeeds — the
		// transcript write is observability, never the work; the session must still complete.
		const failingDb = new Proxy(db, {
			get(target, prop, recv) {
				if (prop === 'query') {
					return async (sql: string, vars?: unknown) => {
						if (/CREATE message/i.test(sql)) throw new Error('simulated message write failure');
						return (target.query as (s: string, v?: unknown) => Promise<unknown>).call(target, sql, vars);
					};
				}
				return Reflect.get(target, prop, recv);
			}
		}) as typeof db;

		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_failopen_1')) });
		// Must NOT throw — the message-persist failure is swallowed.
		const res = await launchSession({ db: failingDb, bus: new EventBus(), runtime, input: baseInput() });
		// The session still reached a terminal DONE status (the work succeeded).
		expect(res.status).toBe('done');

		// And the session row itself persisted (its CREATE/UPDATE are not message writes).
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		expect(rows[0].status).toBe('done');
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

// ── TASK 13.2 — the terminal-status guarantee (regression) ────────────────────────
//
// FINDING (13.2a): the session row is CREATEd 'running' and the terminal UPDATE only ran
// after the stream loop — with NO try/catch, a mid-stream throw (a message-persist DB
// hiccup, an SDK iterator throw) skipped it entirely, leaving the row 'running' forever
// and dashboards counting phantom running agents. These tests FAIL without the
// launch.ts try/catch + guaranteed terminal write.

/** A bare AgentRuntime whose iterator THROWS mid-stream — the SDK-iterator-throw class.
 *  (ClaudeCodeRuntime converts BACKEND throws into `error` events, but launchSession must
 *  survive ANY AgentRuntime impl whose iterator itself throws — that is the wedge path.) */
function throwingRuntime(events: RuntimeEvent[], err: Error): AgentRuntime {
	return {
		spawn: async function* () {
			for (const e of events) yield e;
			throw err;
		},
		async health() {
			return { runtime: 'mock', providers: [] };
		},
		tools() {
			return [];
		},
		async cancel() {}
	};
}

// ── MODEL-BENCHMARK-SPEC class C — OPT-IN thinking capture (screened, provider-tagged) ──────
describe('launchSession — thinking capture (MODEL-BENCHMARK class C)', () => {
	async function captureRows(sessionId: string) {
		const sid = new StringRecordId(sessionId);
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT provider, model_id, content, seq FROM thinking_capture WHERE session = $sid ORDER BY seq ASC;`,
			{ sid }
		);
		return rows;
	}

	it('OFF by default — a thinking turn writes NO thinking_capture row (no-regression), but the transcript message still persists', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'thinking', text: 'reasoning here' },
			{ type: 'log', message: 'answer' },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_capture_off_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_capture_off_1') });
		// captureThinking omitted ⇒ OFF.
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		// No benchmark rows...
		expect(await captureRows(res.sessionId)).toHaveLength(0);
		// ...but the transcript message thinking row is UNAFFECTED (the existing always-on path).
		const sid = new StringRecordId(res.sessionId);
		const [msgs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT content FROM message WHERE session = $sid AND kind = "thinking";`,
			{ sid }
		);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].content).toBe('reasoning here');
	});

	it('ON — a Claude thinking turn persists a screened, provider-tagged thinking_capture row', async () => {
		const events: RuntimeEvent[] = [
			{ type: 'thinking', text: 'first thought' },
			{ type: 'log', message: 'answer' },
			{ type: 'thinking', text: 'second thought' },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_capture_on_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_capture_on_1') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput(),
			captureThinking: true
		});

		const rows = await captureRows(res.sessionId);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.content)).toEqual(['first thought', 'second thought']);
		// provider/model stamped INLINE (the Step-4 eval GROUP BY provider needs no session join).
		expect(rows[0].provider).toBe('claude');
		expect(rows[0].model_id).toBe('claude-opus-4-8');
		// seq monotonic — the capture rows carry the transcript turn order.
		expect((rows[1].seq as number) > (rows[0].seq as number)).toBe(true);
	});

	it('ON — a planted secret in a thinking turn is SCREENED before it reaches the capture row (D-026)', async () => {
		const SECRET = 'sk-ant-thinkCAPTURE1234secretvalue';
		const events: RuntimeEvent[] = [
			{ type: 'thinking', text: `I will authenticate with ${SECRET} now` },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_capture_secret_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_capture_secret_1') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput(),
			captureThinking: true
		});

		const rows = await captureRows(res.sessionId);
		expect(rows).toHaveLength(1);
		const blob = JSON.stringify(rows);
		expect(blob).not.toContain(SECRET); // the raw secret survives in no captured column
		expect(blob).toContain('REDACTED'); // it was caught, not silently dropped
	});

	it('ON — an Ollama session that emits NO thinking writes ZERO rows (honest empty, no fabrication, F-008)', async () => {
		// A local Ollama turn is a plain assistant `log` block — no {type:'thinking'} event at all.
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'a plain local answer with no thinking channel' },
			{ type: 'token_usage', input: 40, output: 12 },
			{ type: 'done', result: { ok: true, summary: 'done', ccSessionId: 'cc_capture_ollama_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_capture_ollama_1') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' } }),
			captureThinking: true
		});

		// Zero rows — the honest "produced none" signal (absence + session.model.provider='ollama'),
		// NEVER a fabricated/backfilled thinking row.
		expect(await captureRows(res.sessionId)).toHaveLength(0);
	});
});

describe('launchSession — terminal status on EVERY exit path (13.2)', () => {
	it("a mid-stream throw still ends the session 'failed' with ended_at + honest note + error agent_event", async () => {
		const bus = new EventBus();
		// The throw means launchSession never returns a result — capture the session id
		// from the live transcript republish (topic = session id, §2.11).
		const topics: string[] = [];
		bus.subscribe(
			(e) => topics.push(e.topic),
			(e) => e.type === 'transcript'
		);
		const runtime = throwingRuntime(
			[{ type: 'log', message: 'about to die' }],
			new Error('stream exploded mid-run')
		);

		await expect(launchSession({ db, bus, runtime, input: baseInput() })).rejects.toThrow(
			'stream exploded mid-run'
		);

		const sessionId = topics[0];
		expect(sessionId).toMatch(/^session:/);

		const sid = new StringRecordId(sessionId);
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: sid
		});
		const sess = rows[0];
		// NOT wedged 'running' — the 13.2 guarantee: terminal status + ended_at on a throw.
		expect(sess.status).toBe('failed');
		expect(sess.ended_at).toBeTruthy();
		// The honest failure note carries the throw message (F-008).
		expect(String(sess.note)).toContain('stream exploded mid-run');

		// The crash is recorded as an `error` agent_event (analytics first-class).
		const [evs] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT * FROM agent_event WHERE session = $sid AND type = "error";`,
			{ sid }
		);
		expect(evs.length).toBeGreaterThanOrEqual(1);
		const detail = evs[0].detail as Record<string, unknown>;
		expect(String(detail.error)).toContain('stream exploded mid-run');
	});

	it('a clean run is unaffected: terminal done, ended_at set, NO note', async () => {
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_clean_132')) });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('done');

		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		expect(rows[0].status).toBe('done');
		expect(rows[0].ended_at).toBeTruthy();
		// option<string> stays NONE on a clean run (§6.1) — no fabricated note.
		expect(rows[0].note ?? null).toBeNull();
	});
});

// ── OBSERVABILITY GAP FIX — a failed session ALWAYS records WHY (session.note) ──────────
//
// The live symptom: 6 ROUNDS dev sessions failed with cc_session_id=null, tool_iter_count=0,
// note=null — an invisible failure (an auth/launch failure recorded nothing). Root cause: the
// terminal `note` was stamped ONLY on the THROW path; an `error` EVENT (the common cli-backend
// case) or a done(ok=false) ended 'failed' with note=NONE. These tests FAIL without the
// error-event/done-failure note capture in launch.ts. They run against the live throwaway DB.

describe('launchSession — honest failure reason on EVERY failed exit (observability)', () => {
	it("an `error` EVENT (no done, no throw) persists a screened note, not null — the cc_session_id=null instant-fail case", async () => {
		// The cli-backend's instant pre-init fail / spawn-fail message shape (F-016 capture).
		const reason = 'claude CLI failed to start: spawn claude ENOENT';
		const runtime = eventStreamRuntime([{ type: 'error', error: reason }]);
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });

		expect(res.status).toBe('failed');
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		const sess = rows[0];
		expect(sess.status).toBe('failed');
		expect(sess.ended_at).toBeTruthy();
		// NOT null — the honest reason the cli-backend surfaced is persisted (the fix).
		expect(sess.note ?? null).not.toBeNull();
		expect(String(sess.note)).toContain('failed to start');
		expect(String(sess.note)).toContain('ENOENT');
		// And cc_session_id stays NONE on a pre-init fail (honest — no fabricated id).
		expect(sess.cc_session_id ?? null).toBeNull();
	});

	it('a non-zero exit whose reason rides STDOUT is captured honestly (F-029)', async () => {
		const reason =
			'claude CLI exited 1: {"type":"result","subtype":"error_max_turns","is_error":true}';
		const runtime = eventStreamRuntime([
			{ type: 'log', message: 'starting' },
			{ type: 'error', error: reason }
		]);
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('failed');
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		expect(String(rows[0].note)).toContain('exited 1');
		expect(String(rows[0].note)).toContain('error_max_turns');
	});

	it('a SECRET embedded in the failure text is REDACTED before it is persisted (D-026)', async () => {
		// A leaked OAuth token in the CLI stderr/stdout tail must never land in session.note raw.
		const leaky = 'claude CLI exited 1: auth failed with token sk-ant-abcDEF0123456789xyz aborting';
		const runtime = eventStreamRuntime([{ type: 'error', error: leaky }]);
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('failed');
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		const note = String(rows[0].note);
		// The raw token is GONE; the screen placeholder is present; the rest of the reason survives.
		expect(note).not.toContain('sk-ant-abcDEF0123456789xyz');
		expect(note).toContain('[REDACTED:anthropic-key]');
		expect(note).toContain('exited 1');
	});

	it('a done(ok=false) result records an honest reason (not null, not the throw path)', async () => {
		const runtime = eventStreamRuntime([
			{ type: 'log', message: 'ran' },
			{ type: 'done', result: { ok: false, summary: 'tests failed: 3 of 40', ccSessionId: 'cc_fail_df1' } }
		]);
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('failed');
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		expect(rows[0].note ?? null).not.toBeNull();
		expect(String(rows[0].note)).toContain('tests failed: 3 of 40');
		// The cc_session_id from the failing done is still bridged (honest — the run DID get an id).
		expect(String(rows[0].cc_session_id)).toBe('cc_fail_df1');
	});

	it('an EMPTY stream (no done, no error, no throw) records an honest no-output reason, never null', async () => {
		const runtime = eventStreamRuntime([]);
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('failed');
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		expect(rows[0].note ?? null).not.toBeNull();
		expect(String(rows[0].note)).toContain('failed before producing any output');
	});
});

// ── TASK 15.1 (B1 scope-lock) — editScope rides the launch path ──────────────────────

describe('launchSession — editScope wiring (15.1; real throwaway SurrealDB)', () => {
	it('merges the operator pattern lists (config/gates.yaml) onto the declared scope and pins it on the SpawnRequest', async () => {
		const backend = scriptedBackend(transcript('cc_scope_151'));
		const runtime = new ClaudeCodeRuntime({ backend });
		await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ editScope: { scopeRoots: ['src'], scopeAllow: ['**/docs/fails.md'] } })
		});

		const plan = backend.plans[0];
		expect(plan).toBeTruthy();
		const scope = plan.isolated.settings.editScope;
		expect(scope).toBeTruthy();
		expect(scope!.scopeRoots).toEqual(['src']);
		expect(scope!.scopeAllow).toEqual(['**/docs/fails.md']);
		// the destructive-bash lists came from CONFIG, not the caller (requirement (b))
		expect(scope!.destructiveBash?.deny?.length).toBeGreaterThan(0);
		expect(scope!.destructiveBash?.deny?.map((d) => d.id)).toContain('git-discard-worktree');
		expect(scope!.destructiveBash?.allow?.map((a) => a.id)).toContain('rm-build-artifacts');
		// and the SDK-path gate callback is armed (a declared scope forces it on)
		expect(typeof plan.canUseTool).toBe('function');
	});

	it('REFUSES a scoped launch when gates.yaml is missing — fail closed, backend never reached', async () => {
		const saved = process.env.CONFIG_DIR;
		process.env.CONFIG_DIR = 'F:/definitely/no/such/config-dir';
		try {
			const backend = scriptedBackend(transcript('cc_scope_151b'));
			const runtime = new ClaudeCodeRuntime({ backend });
			await expect(
				launchSession({
					db,
					bus: new EventBus(),
					runtime,
					input: baseInput({ editScope: { scopeRoots: ['src'] } })
				})
			).rejects.toThrow(/cannot read config file/);
			expect(backend.plans).toHaveLength(0); // never spawned silently unscoped
		} finally {
			if (saved === undefined) delete process.env.CONFIG_DIR;
			else process.env.CONFIG_DIR = saved;
		}
	});

	it('an UNSCOPED launch never touches gates.yaml (opt-in) — still launches with no editScope', async () => {
		const saved = process.env.CONFIG_DIR;
		process.env.CONFIG_DIR = 'F:/definitely/no/such/config-dir'; // would throw IF read
		try {
			const backend = scriptedBackend(transcript('cc_scope_151c'));
			const runtime = new ClaudeCodeRuntime({ backend });
			const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
			expect(res.status).toBe('done');
			expect(backend.plans[0].isolated.settings.editScope).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.CONFIG_DIR;
			else process.env.CONFIG_DIR = saved;
		}
	});
});

// ── WI-2 (WORKSPACE-ISOLATION-SPEC) — WRITE sessions run in an isolated per-session worktree ──
//
// Verified against a REAL temp git repo (init a throwaway repo, NOT a mock) + the real throwaway
// SurrealDB. Covers: a code-write spawn runs in a worktree cwd (cwd != root_path, worktree exists,
// session row carries worktree_path/branch); a code-read spawn runs in root_path (unchanged); a
// WRITE session on a NON-git root FAILS CLOSED (honest terminal note, never silent shared cwd);
// the fleet normalizer surfaces the worktree provenance honestly.
describe('launchSession — WI-2 per-session worktree (WRITE classes)', () => {
	function initRepo(): string {
		const base = mkdtempSync(join(tmpdir(), 'wi2-launch-'));
		const repo = join(base, 'proj');
		execFileSync('git', ['init', '-b', 'main', repo]);
		execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: repo });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
		writeFileSync(join(repo, 'README.md'), '# seed\n');
		execFileSync('git', ['add', '-A'], { cwd: repo });
		execFileSync('git', ['commit', '-m', 'seed'], { cwd: repo });
		return repo;
	}

	const tmpRoots: string[] = [];
	afterEach(() => {
		for (const r of tmpRoots.splice(0)) {
			try {
				rmSync(join(r, '..'), { recursive: true, force: true });
			} catch {
				/* best effort — sibling .atelier-worktrees lives under the same mkdtemp base */
			}
		}
	});

	it('a code-write spawn runs in a worktree cwd (≠ root_path) + persists worktree_path/branch', async () => {
		const repo = initRepo();
		tmpRoots.push(repo);
		const p = await createProject(db, { slug: `wi2w_${Math.random().toString(36).slice(2, 10)}`, name: 'WI2 Write', root_path: repo });
		const t = await createTask(db, { project: p.id, title: 'Build', description: 'edit + commit' });

		const backend = scriptedBackend(transcript('cc_wi2_write'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo, '.harness-cc') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ projectId: p.id, taskId: t.id, intent: 'code-write' })
		});

		// The cwd handed to the runtime is the per-session WORKTREE, NOT the shared project root.
		const cwd = backend.plans[0]?.cwd;
		expect(cwd).toBeTruthy();
		expect(cwd).not.toBe(repo);
		expect(existsSync(cwd!)).toBe(true);

		// The session row carries the worktree provenance (m0059) — real strings, not null/undefined.
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		const sess = rows[0];
		expect(sess.worktree_path).toBeTruthy();
		expect(String(sess.worktree_path)).toBe(cwd);
		expect(String(sess.worktree_branch)).toBe(`atelier/session/${res.sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64)}`);

		// The fleet normalizer surfaces the provenance honestly (non-null on a worktree session).
		const fleet = await listFleetAcrossProjects(db, 50);
		const row = fleet.find((f) => f.id === res.sessionId);
		expect(row).toBeTruthy();
		expect(row!.worktreePath).toBe(cwd);
		expect(row!.worktreeBranch).toBe(String(sess.worktree_branch));

		await deleteProject(db, p.id).catch(() => {});
	}, 60_000);

	it('a code-read spawn runs in root_path (unchanged) + leaves worktree fields NONE', async () => {
		const repo = initRepo();
		tmpRoots.push(repo);
		const p = await createProject(db, { slug: `wi2r_${Math.random().toString(36).slice(2, 10)}`, name: 'WI2 Read', root_path: repo });
		const t = await createTask(db, { project: p.id, title: 'Read', description: 'just read' });

		const backend = scriptedBackend(transcript('cc_wi2_read'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo, '.harness-cc') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ projectId: p.id, taskId: t.id, intent: 'code-read' })
		});

		// READ class is byte-identical to today: cwd = the shared project root.
		expect(backend.plans[0]?.cwd).toBe(repo);

		// option<string> worktree fields stay NONE (omit-when-absent, F-013) — normalizer → null.
		const fleet = await listFleetAcrossProjects(db, 50);
		const row = fleet.find((f) => f.id === res.sessionId);
		expect(row!.worktreePath).toBeNull();
		expect(row!.worktreeBranch).toBeNull();

		await deleteProject(db, p.id).catch(() => {});
	}, 60_000);

	it('a WRITE session on a NON-git root FAILS CLOSED (honest note, never silent shared cwd)', async () => {
		// A real dir that is NOT a git repo.
		const base = mkdtempSync(join(tmpdir(), 'wi2-nongit-'));
		tmpRoots.push(join(base, 'x')); // cleanup removes the mkdtemp base via `..`
		const p = await createProject(db, { slug: `wi2n_${Math.random().toString(36).slice(2, 10)}`, name: 'WI2 NonGit', root_path: base });
		const t = await createTask(db, { project: p.id, title: 'Build', description: 'edit' });

		const backend = scriptedBackend(transcript('cc_wi2_nongit'));
		const runtime = new ClaudeCodeRuntime({ backend });
		await expect(
			launchSession({
				db,
				bus: new EventBus(),
				runtime,
				input: baseInput({ projectId: p.id, taskId: t.id, intent: 'code-write' })
			})
		).rejects.toThrow(/not a git repository/i);

		// NEVER spawned into the shared root (fail closed — no plan recorded).
		expect(backend.plans).toHaveLength(0);

		// The session row was flipped to a terminal failed status with an honest note (not phantom-running).
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT status, note, worktree_path FROM session WHERE project = $pid;`,
			{ pid: new StringRecordId(p.id) }
		);
		const sess = rows.find((r) => r.status === 'failed');
		expect(sess).toBeTruthy();
		expect(String(sess!.note)).toMatch(/worktree acquisition failed/i);
		expect(sess!.worktree_path == null).toBe(true); // never recorded a worktree it couldn't make

		await deleteProject(db, p.id).catch(() => {});
	}, 60_000);

	it('the worktree is acquired with the SAME sessionId so resume re-acquires it (idempotent)', async () => {
		const repo = initRepo();
		tmpRoots.push(repo);
		const p = await createProject(db, { slug: `wi2i_${Math.random().toString(36).slice(2, 10)}`, name: 'WI2 Idem', root_path: repo });
		const t = await createTask(db, { project: p.id, title: 'Build', description: 'edit' });

		const backend = scriptedBackend(transcript('cc_wi2_idem'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: join(repo, '.harness-cc') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ projectId: p.id, taskId: t.id, intent: 'code-write' })
		});

		// Re-acquiring with the persisted sessionId returns the SAME tree (no second worktree) —
		// the resume idempotency contract, proven against the real WI-1 helper.
		const { acquireSessionWorktree } = await import('./worktree');
		const again = await acquireSessionWorktree(repo, res.sessionId);
		expect(again.cwd).toBe(backend.plans[0]?.cwd);

		await deleteProject(db, p.id).catch(() => {});
	}, 60_000);
});

// ── UO-1 (USAGE-OBSERVABILITY-SPEC) — persist the GRANTED capability set at the session CREATE ──────
//
// The granted set is known at spawn (input.capabilities + peerSendGranted + toolPolicy.allow +
// intent) but was never persisted. UO-1 records the ACTUAL composed/effective grant on the row at
// CREATE (NOT the static bundle — F-008), as additive OPTION fields (omit-when-absent, F-013). These
// tests assert the RAW row carries the granted columns at CREATE for a granted session, and omits
// the absent dimensions for a non-granted session — directly on the row (the fleet-projection
// read-back + legacy-null normalization are proven in analytics/fleet.test.ts).
describe('UO-1 — granted capability set lands on the session row at CREATE', () => {
	it('a peer-send-granted session row carries granted_* + reserved + tool_allow + intent', async () => {
		const backend = scriptedBackend([
			{ type: 'log', message: 'go' },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_uo1_l_g' } }
		]);
		const runtime = new ClaudeCodeRuntime({ backend });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			// READ class keeps the shared root (no git fixture needed); the grant fields are
			// intent-agnostic and computed BEFORE the worktree branch.
			input: baseInput({
				intent: 'code-read',
				capabilities: { skills: ['peer-send', 'design'], agents: ['coder'], mcp: ['atelier-memory'] },
				toolPolicy: { allow: ['Read', 'Edit'] }
			})
		});

		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		const sess = rows[0];
		expect(sess.granted_skills).toEqual(['peer-send', 'design']);
		expect(sess.granted_agents).toEqual(['coder']);
		expect(sess.granted_mcp).toEqual(['atelier-memory']);
		expect(sess.granted_reserved).toEqual(['peer-send']); // the EFFECTIVE reserved grant
		expect(sess.tool_allow).toEqual(['Read', 'Edit']);
		expect(sess.granted_intent).toBe('code-read');
	}, 60_000);

	it('a non-granted session OMITS empty capability dims (option NONE, never a stored [])', async () => {
		const backend = scriptedBackend([
			{ type: 'log', message: 'go' },
			{ type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_uo1_l_p' } }
		]);
		const runtime = new ClaudeCodeRuntime({ backend });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-read', toolPolicy: { allow: ['Read'] } }) // no capabilities
		});

		const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, {
			rid: new StringRecordId(res.sessionId)
		});
		const sess = rows[0];
		// Absent dims OMITTED (F-013/§6.1) — NONE, never a fabricated empty array.
		expect(sess.granted_skills == null).toBe(true);
		expect(sess.granted_agents == null).toBe(true);
		expect(sess.granted_mcp == null).toBe(true);
		expect(sess.granted_reserved == null).toBe(true); // peer-send not granted → no reserved
		// tool_allow + intent ARE recorded (always present on a launch).
		expect(sess.tool_allow).toEqual(['Read']);
		expect(sess.granted_intent).toBe('code-read');
	}, 60_000);
});

// ── SH-2 — the skill-proposal CAPTURE seam at session-end (SKILL-HARVEST-SPEC §"CAPTURE") ──────────
//
// An INJECTED SkillHarvester (stub = no spend) is offered the screened trajectory at session-end. It
// may DRAFT a skill_proposal (persisted via SH-1 proposeSkill, born 'open') or decline (null). The
// trigger is NARROW: ONLY a successful (done) code-write session harvests. A harvester fault NEVER
// fails the session (best-effort, D-019). A planted secret in the trajectory is screened before the
// seam ever sees it (D-026).

import type { SkillHarvester, SkillHarvestContext } from './launch';
import type { SessionWorktree } from './worktree';
import { listSkillProposals } from '../skills/proposal';

/** A worktree stub that points a WRITE session's cwd at the project root (no real git repo needed) —
 *  lets a `code-write` session reach `done` deterministically so the harvest trigger fires in-test. */
function fakeWorktree(projectRoot: string): (root: string, sessionId: string) => Promise<SessionWorktree> {
	return async () => ({ cwd: projectRoot, branch: 'sh2-test', cleanup: async () => {} });
}

describe('SH-2 — skill-proposal CAPTURE seam (SKILL-HARVEST-SPEC §CAPTURE)', () => {
	it('a successful code-write session drafts an OPEN proposal via SH-1 (asserted in the store)', async () => {
		const name = `harvest-pattern-${Math.random().toString(36).slice(2, 8)}`;
		let sawCtx: SkillHarvestContext | undefined;
		const harvester: SkillHarvester = {
			async propose(ctx) {
				sawCtx = ctx;
				return {
					name,
					description: 'A reusable procedure surfaced by this session.',
					body: '# Reusable\nSteps the agent established.',
					trigger_context: 'when you need to do the reusable thing',
					evidence: ['session:trajectory']
				};
			}
		};
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_sh2_ok')) });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-write' }),
			acquireWorktree: fakeWorktree('F:/code/sess'),
			skillHarvester: harvester
		});
		expect(res.status).toBe('done');

		// SH-1 store carries a BORN-'open' proposal stamped with THIS session/project provenance.
		const open = await listSkillProposals(db, { status: 'open' });
		const mine = open.find((p) => p.name === name);
		expect(mine).toBeTruthy();
		expect(mine!.status).toBe('open');
		expect(mine!.session).toBe(res.sessionId);
		expect(mine!.project).toBe(projectId);
		// The seam received the SCREENED trajectory text + honest provenance.
		expect(sawCtx?.transcriptText).toBeTruthy();
		expect(sawCtx?.sessionId).toBe(res.sessionId);
		expect(sawCtx?.projectId).toBe(projectId);
	});

	it('a harvester that THROWS does NOT fail the session (best-effort, D-019/F-014)', async () => {
		const harvester: SkillHarvester = {
			async propose() {
				throw new Error('harvester boom');
			}
		};
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_sh2_throw')) });
		// Must NOT throw — the harvester fault is swallowed; the session keeps its terminal verdict.
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-write' }),
			acquireWorktree: fakeWorktree('F:/code/sess'),
			skillHarvester: harvester
		});
		expect(res.status).toBe('done');
	});

	it('a NON-code-write session harvests NOTHING (narrow trigger)', async () => {
		let called = false;
		const harvester: SkillHarvester = {
			async propose() {
				called = true;
				return null;
			}
		};
		// A READ session (no worktree) — the trigger gates on intent='code-write'.
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(transcript('cc_sh2_read')) });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-read' }),
			skillHarvester: harvester
		});
		expect(res.status).toBe('done');
		expect(called).toBe(false);
	});

	it('a FAILED code-write session harvests NOTHING (narrow trigger — only success harvests)', async () => {
		let called = false;
		const harvester: SkillHarvester = {
			async propose() {
				called = true;
				return null;
			}
		};
		const fail: RuntimeEvent[] = [
			{ type: 'log', message: 'working' },
			{ type: 'error', error: 'build failed' },
			{ type: 'done', result: { ok: false, summary: 'failed' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(fail) });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-write' }),
			acquireWorktree: fakeWorktree('F:/code/sess'),
			skillHarvester: harvester
		});
		expect(res.status).toBe('failed');
		expect(called).toBe(false);
	});

	it('a PLANTED SECRET in the trajectory is screened before it reaches the seam AND before persist (D-026)', async () => {
		const SECRET = 'sk-ant-PLANTEDsecret1234harvest';
		const name = `secret-harvest-${Math.random().toString(36).slice(2, 8)}`;
		let sawText = '';
		const harvester: SkillHarvester = {
			async propose(ctx) {
				sawText = ctx.transcriptText;
				// Draft a clean proposal so we can assert the persisted row carries no raw secret either.
				return {
					name,
					description: 'cleaned procedure',
					body: '# Body\nno secrets here',
					trigger_context: 'when the cleaned thing applies',
					evidence: ['session:trajectory']
				};
			}
		};
		const events: RuntimeEvent[] = [
			{ type: 'log', message: `the token is ${SECRET}` },
			{ type: 'done', result: { ok: true, summary: `used ${SECRET} successfully`, ccSessionId: 'cc_sh2_secret' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events, 'cc_sh2_secret') });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ intent: 'code-write' }),
			acquireWorktree: fakeWorktree('F:/code/sess'),
			skillHarvester: harvester
		});
		expect(res.status).toBe('done');
		// The seam NEVER saw the raw secret (screened in eventToMessage AND re-screened before the seam).
		expect(sawText).not.toContain(SECRET);
		// And nothing the secret rode in on persisted raw — the proposal row + transcript messages are clean.
		const open = await listSkillProposals(db, { status: 'open' });
		expect(JSON.stringify(open)).not.toContain(SECRET);
	});
});

// ── CONVERSATION-LAYER-SPEC (pillar 3) — peer-send AFFORDANCE wiring ────────────────────────────
// The affordance reaches the agent's PROMPT (the backend CcSpawnPlan.prompt) as a REAL instruction
// — ONLY when the session is GRANTED peer-send, and NEVER for a non-granted session. The who-list
// is derived from a STUBBED FleetSnapshot (no DB dependency — deterministic), proving the agent
// addresses real running recipients. This is the integration counterpart to affordance.test.ts.
describe('launchSession — peer-send affordance reaches the prompt only when granted (pillar 3)', () => {
	/** A stub FleetSnapshot loader: one other running session in THIS project, plus a foreign one. */
	const stubFleet = async () => ({
		running: [
			{ id: 'session:teammate', role: 'reviewer', project: projectId, kind: 'task', pm: null },
			{ id: 'session:foreign', role: 'coder', project: 'project:other', kind: 'task', pm: null }
		],
		pmByProject: {}
	});

	it('a GRANTED session gets the peer_send affordance + the real who-list in its prompt', async () => {
		const backend = scriptedBackend(transcript('cc_sess_AFF1'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-aff' });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ capabilities: { skills: ['peer-send'], agents: [], mcp: [] } }),
			loadFleet: stubFleet
		});
		expect(res.status).toBe('done');
		const prompt = backend.plans[0]?.prompt ?? '';
		// The REAL affordance instruction is present (distinct from the "(not instructions)" context).
		expect(prompt).toContain('Peer messaging (your `peer_send` tool)');
		expect(prompt).toContain('peer_send({ to: { kind, ref?, project? }, body })');
		// The who-list lists the real in-project teammate, NOT the foreign-project session.
		expect(prompt).toContain('session:teammate');
		expect(prompt).not.toContain('session:foreign');
		// Honest classes: pm/atelier resolve LIVE since Concierge Stage-1 (inbox-pending when
		// offline), so the affordance DOES advertise them (affordance.test.ts asserts the same —
		// the old "never advertises pm/atelier" premise was the F-008 dishonesty that was fixed).
		expect(prompt).toContain('kind: "pm"');
		expect(prompt).toContain('kind: "atelier"');
	});

	it('a NON-granted session sees NO affordance (no dead affordance, loadFleet never called)', async () => {
		const backend = scriptedBackend(transcript('cc_sess_AFF2'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-aff2' });
		let fleetLoaded = false;
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput(), // no peer-send capability
			loadFleet: async () => {
				fleetLoaded = true;
				return { running: [], pmByProject: {} };
			}
		});
		expect(res.status).toBe('done');
		const prompt = backend.plans[0]?.prompt ?? '';
		expect(prompt).not.toContain('peer_send');
		expect(prompt).not.toContain('Peer messaging');
		// A non-granted session never even loads the fleet (the grant gate short-circuits).
		expect(fleetLoaded).toBe(false);
	});
});

// COST-GOVERNANCE-SPEC CG-2 — the token budget is enforced INSIDE launchSession (F-055: no caller
// can bypass it), BEFORE the session row is created. Background over-budget REFUSES with a typed
// error (no phantom row); operator+override PROCEEDS; the 0-sentinel is uncapped.
describe('launchSession — CG-2 token budget gate', () => {
	afterEach(() => {
		__setBudgetForTest(null); // clear back to the config-file path so no OTHER test sees a cap
	});

	/** Count session rows for THIS project (proves a refusal created NO phantom running row). */
	async function sessionCount(): Promise<number> {
		const [rows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM session WHERE project = $p GROUP ALL;`,
			{ p: new StringRecordId(projectId) }
		);
		return Number(rows?.[0]?.c ?? 0);
	}

	it('uncapped (0-sentinel) ⇒ launches normally even with prior spend (no-regression)', async () => {
		__setBudgetForTest(0);
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 10_000,
			tokensOut: 10_000,
			detail: { ok: true }
		});
		const backend = scriptedBackend(transcript('cc_cg2_uncapped'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cg2a' });
		const res = await launchSession({ db, bus: new EventBus(), runtime, input: baseInput() });
		expect(res.status).toBe('done');
	});

	it('BACKGROUND over budget ⇒ refuses with TokenBudgetExceededError + creates NO session row', async () => {
		__setBudgetForTest(1000);
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 800,
			tokensOut: 800, // 1600 ≥ 1000
			detail: { ok: true }
		});
		const before = await sessionCount();
		const backend = scriptedBackend(transcript('cc_cg2_bg'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cg2b' });
		// No overrideTokenBudget key ⇒ background source ⇒ hard refuse.
		await expect(
			launchSession({ db, bus: new EventBus(), runtime, input: baseInput() })
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
		// The refusal is BEFORE the session CREATE — no phantom running row, and the backend never ran.
		expect(await sessionCount()).toBe(before);
		expect(backend.plans.length).toBe(0);
	});

	it('OPERATOR without override, over budget ⇒ still refuses (the UI then confirms)', async () => {
		__setBudgetForTest(1000);
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 700,
			tokensOut: 700, // 1400 ≥ 1000
			detail: { ok: true }
		});
		const backend = scriptedBackend(transcript('cc_cg2_op_noover'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cg2c' });
		await expect(
			launchSession({
				db,
				bus: new EventBus(),
				runtime,
				input: baseInput({ overrideTokenBudget: false })
			})
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
		expect(backend.plans.length).toBe(0);
	});

	it('OPERATOR + override, over budget ⇒ PROCEEDS (operator authority)', async () => {
		__setBudgetForTest(1000);
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 900,
			tokensOut: 900, // 1800 ≥ 1000
			detail: { ok: true }
		});
		const backend = scriptedBackend(transcript('cc_cg2_op_override'));
		const runtime = new ClaudeCodeRuntime({ backend, harnessConfigRoot: 'F:/code/sess/.harness-cg2d' });
		const res = await launchSession({
			db,
			bus: new EventBus(),
			runtime,
			input: baseInput({ overrideTokenBudget: true })
		});
		expect(res.status).toBe('done');
		expect(backend.plans.length).toBe(1);
	});
});
