import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { launchSession, type LaunchInput } from '../sessions/launch';
import { writeRoutingEvent } from '../routing/resolve';
import { writeAgentEvent } from './events';
import { recordTurnOutcomes } from '../memory/outcomes';
import type { RecallItem } from '../memory/recall';
import { storeMemory } from '../memory/store';
import { FakeEmbedder } from '../memory/embed';
import { EventBus } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { traceAction, iso } from './trace';

// TASK 2.4 VERIFY (part 3) — "pick an action and trace its how/why chain."
// We build ONE real action end-to-end (no live model: a routing decision + a
// mock-runtime-driven session + a recorded escalation), then prove traceAction
// reconstructs the ordered routing → session → lifecycle chain, each step carrying its
// WHY. Every step read back from the live throwaway DB (F-008).

function scriptedBackend(events: RuntimeEvent[], cc = 'cc_trace_1'): CcBackend {
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
	const p = await createProject(db, { slug: 'trace', name: 'Trace Host', root_path: 'F:/code/trace' });
	projectId = p.id;
	const t = await createTask(db, {
		project: projectId,
		title: 'Implement the widget',
		description: 'add a widget feature'
	});
	taskId = t.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('traceAction — the how/why chain for one action (2.4 VERIFY)', () => {
	it('reconstructs routing → session → lifecycle, each step with its WHY', async () => {
		// 1. The routing decision (WHY this model) — the head of the chain.
		await writeRoutingEvent(db, {
			task: taskId,
			project: projectId,
			chosen: { provider: 'anthropic', modelId: 'claude-sonnet', tier: 'sonnet' },
			method: 'classify',
			reason: 'classify code-write → complexity 0.55 → tier sonnet',
			intent: 'code-write',
			complexity: 0.55,
			alternatives: [{ tier: 'haiku', reason: 'below complexity floor' }]
		});

		// 2. The run (session + lifecycle), driven by a mock runtime → real rows.
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'starting' },
			{ type: 'token_usage', input: 300, output: 120 },
			{ type: 'done', result: { ok: true, summary: 'widget added', ccSessionId: 'cc_trace_1' } }
		];
		const runtime = new ClaudeCodeRuntime({ backend: scriptedBackend(events) });
		const input: LaunchInput = {
			projectId,
			taskId,
			agentId: 'agent_trace',
			model: { provider: 'anthropic', modelId: 'claude-sonnet', tier: 'sonnet' },
			intent: 'code-write',
			budgets: {},
			toolPolicy: { allow: ['Read', 'Edit'] }
		};
		const res = await launchSession({ db, bus: new EventBus(), runtime, input });

		// 3. A recorded escalation on that session (the core how/why step).
		await writeAgentEvent(db, {
			type: 'escalation',
			session: res.sessionId,
			project: projectId,
			detail: { from: 'sonnet', to: 'opus', reason: 'sonnet stalled on the test suite' }
		});

		// 3a. The recall link (4.4 closeout): a REAL recalled memory tied to the session via a
		// REAL retrieval_outcome — the rung that answers WHY the agent had its context. Store a
		// memory through the screen→embed pipeline (FakeEmbedder; no Ollama), then record the turn
		// outcome from a tool stream so tool_success is REAL, not a hand boolean (F-008).
		const mem = await storeMemory(
			{ db, embedder: new FakeEmbedder() },
			{
				content: 'The widget API uses POST /widgets with an idempotency key.',
				kind: 'semantic',
				project: projectId
			}
		);
		expect(mem.persisted).toBe(true);
		const injected: RecallItem[] = [
			{
				id: mem.id,
				citationId: '1',
				score: 0.82,
				wasNeighbor: false,
				explain: { cosine: 0.82, utility: 0, recency: 0.5 },
				body: 'The widget API uses POST /widgets with an idempotency key.',
				fenced: { source: 'recall', citationId: '1', text: 'ref' }
			}
		];
		await recordTurnOutcomes(db, {
			session: res.sessionId,
			responseText: 'I will call the widget API [#1].',
			injected,
			events: [
				{ type: 'tool_call', name: 'Edit', args: {}, needsConfirm: false },
				{ type: 'tool_result', name: 'Edit', ok: true, output: 'edited' }
			]
		});

		// ── Trace it. ──
		const trace = await traceAction(db, taskId);
		expect(trace.taskId).toBe(taskId);

		const sources = trace.steps.map((s) => s.source);
		expect(sources).toContain('routing_event'); // WHY this model
		expect(sources).toContain('session'); // the run
		expect(sources).toContain('retrieval_outcome'); // WHY it had its context (4.4 closeout)
		expect(sources).toContain('agent_event'); // WHAT happened

		// The route step explains the model choice.
		const route = trace.steps.find((s) => s.source === 'routing_event')!;
		expect(route.why).toContain('code-write');
		expect(route.label).toBe('route: classify');

		// The escalation step explains the tier change with from→to + reason.
		const esc = trace.steps.find((s) => s.label === 'escalation')!;
		expect(esc.why).toContain('sonnet');
		expect(esc.why).toContain('opus');
		expect(esc.why).toContain('stalled');

		// The completion step carries the run's summary.
		const completion = trace.steps.find((s) => s.label === 'completion')!;
		expect(completion.why).toContain('widget added');

		// The recall step (4.4) answers WHY the agent had its context: it surfaces the recalled
		// memory's content, that it was cited, and that the turn's tools succeeded.
		const recall = trace.steps.find((s) => s.source === 'retrieval_outcome')!;
		expect(recall.label).toBe('recall');
		expect(recall.why).toContain('widget API'); // the recalled content preview
		expect(recall.why).toContain('cited'); // measured utility — it was cited [#1]
		expect(recall.why).toContain('tools succeeded'); // REAL tool outcome, not fabricated
		expect(recall.detail.memory).toBe(mem.id); // joins back to the memory row
		expect(recall.detail.tool_success).toBe(true);

		// Chain is time-ordered: routing first, completion before escalation we wrote last.
		const ats = trace.steps.map((s) => s.at);
		const sorted = [...ats].sort((a, b) => a.localeCompare(b));
		expect(ats).toEqual(sorted);
	});

	it('an action with no run yields an empty chain (no fabrication)', async () => {
		const t = await createTask(db, { project: projectId, title: 'untouched', description: 'never run' });
		const trace = await traceAction(db, t.id);
		expect(trace.steps).toEqual([]);
	});

	it('every step carries the REAL row datetime — never a fabricated "now" (13.4b)', async () => {
		// Before the 13.4b fix iso() stamped new Date().toISOString() for anything that was not a
		// JS Date or string — which is EVERY datetime the surrealdb SDK returns (its DateTime
		// wrapper), so the whole chain carried fake per-call timestamps (the F-008/F-013 class).
		const trace = await traceAction(db, taskId);
		expect(trace.steps.length).toBeGreaterThan(0);
		for (const s of trace.steps) {
			expect(s.at, `${s.source} ${s.id}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
			expect(Number.isNaN(Date.parse(s.at)), `${s.source} ${s.id} parseable`).toBe(false);
		}

		// The session step's `at` is the ROW's started_at, verbatim — not a minted value.
		const sessionStep = trace.steps.find((s) => s.source === 'session')!;
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT started_at FROM session ORDER BY started_at ASC LIMIT 1;`
		);
		expect(sessionStep.at).toBe(String(rows[0].started_at));

		// And the chain is STABLE across calls: a fabricated "now" changes per invocation.
		await new Promise((r) => setTimeout(r, 10));
		const again = await traceAction(db, taskId);
		expect(again.steps.map((s) => s.at)).toEqual(trace.steps.map((s) => s.at));
	});
});

describe('iso — datetime coercion never fabricates (13.4b regression)', () => {
	it('absent → empty string, NEVER a fake "now" (F-008/F-013)', () => {
		expect(iso(undefined)).toBe('');
		expect(iso(null)).toBe('');
		expect(iso(42)).toBe('');
		expect(iso({})).toBe(''); // stringifies to garbage, not a datetime → honest ''
		expect(iso('not a datetime')).toBe('');
	});

	it('an invalid Date → empty string', () => {
		expect(iso(new Date('not-a-date'))).toBe('');
	});

	it('a real datetime round-trips exactly', () => {
		const d = new Date('2026-06-10T12:34:56.789Z');
		expect(iso(d)).toBe('2026-06-10T12:34:56.789Z');
		// An already-ISO string passes through unchanged.
		expect(iso('2026-06-10T12:34:56.789Z')).toBe('2026-06-10T12:34:56.789Z');
		// The SDK DateTime wrapper shape (nanosecond ISO toString) passes through verbatim.
		const wrapper = { toString: () => '2026-06-10T16:39:38.2374435Z' };
		expect(iso(wrapper)).toBe('2026-06-10T16:39:38.2374435Z');
	});
});
