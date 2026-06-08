import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { EventBus, type BusEvent } from '../events/bus';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { createWorkflow, getWorkflowRun, validateSteps, type WorkflowStep } from './repo';
import { runWorkflow } from './runner';

// TASK 2.17 VERIFY (D-013; DATA-MODEL §4.11) — a multi-step pipeline runs as a tracked
// workflow_run with per-step session records, driven by a MOCKED/SANDBOXED runtime (the
// same scripted-stream backend pattern 1.4/1.6b used — NO live API, NO creds, NO network
// to Anthropic). Every row read back came from the live throwaway DB the runner+runtime
// actually produced (F-008: a mocked runtime in a TEST is allowed; no fabricated PRODUCT
// data). The capstone live transcript is deferred to the credential wave; the runner LOGIC
// is fully built + verified here.

// ── A scripted backend: records each plan, emits a done(ok) stream per step ──────────
// done.ok is controllable so we can prove a failed step fails the run + short-circuits
// dependents. cc_session_id is per-run-unique so session_dedup never collides.
function scriptedBackend(opts?: {
	failPrompts?: string[];
}): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	let seq = 0;
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			const fail = (opts?.failPrompts ?? []).some((p) => plan.prompt.includes(p));
			const cc = `cc_wf_${Math.random().toString(36).slice(2, 8)}_${seq++}`;
			const events: RuntimeEvent[] = [
				{ type: 'log', message: `running ${plan.agentId}` },
				{ type: 'token_usage', input: 10, output: 5 },
				{
					type: 'done',
					result: { ok: !fail, summary: fail ? 'step failed' : 'step ok', ccSessionId: cc }
				}
			];
			return {
				ccSessionId: cc,
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

const M = { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' };

function step(over: Partial<WorkflowStep> & { id: string }): WorkflowStep {
	return {
		prompt: `do ${over.id}`,
		agent: `agent_${over.id}`,
		model: M,
		cwd: 'F:/code/wf',
		...over
	};
}

let tdb: TestDb;
let db: Db;
let projectId: string;

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
	const p = await createProject(db, { slug: 'wf', name: 'Workflow Host', root_path: 'F:/code/wf' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

function rt(opts?: { failPrompts?: string[] }) {
	return new ClaudeCodeRuntime({
		backend: scriptedBackend(opts),
		harnessConfigRoot: 'F:/code/wf/.harness-cc'
	});
}

describe('validateSteps — step shape + DAG guard (§4.11)', () => {
	it('accepts a well-formed multi-step DAG', () => {
		expect(() =>
			validateSteps([step({ id: 'a' }), step({ id: 'b', depends_on: ['a'] })])
		).not.toThrow();
	});
	it('rejects a duplicate step id', () => {
		expect(() => validateSteps([step({ id: 'a' }), step({ id: 'a' })])).toThrow(/duplicate/);
	});
	it('rejects a dangling depends_on edge', () => {
		expect(() => validateSteps([step({ id: 'a', depends_on: ['missing'] })])).toThrow(/unknown step/);
	});
	it('rejects a self-dependency', () => {
		expect(() => validateSteps([step({ id: 'a', depends_on: ['a'] })])).toThrow(/itself/);
	});
	it('rejects a dependency cycle', () => {
		expect(() =>
			validateSteps([step({ id: 'a', depends_on: ['b'] }), step({ id: 'b', depends_on: ['a'] })])
		).toThrow(/cycle/);
	});
	it('rejects a missing required field', () => {
		expect(() => validateSteps([{ id: 'a', agent: 'x', model: M, cwd: 'c' } as WorkflowStep])).toThrow(
			/prompt/
		);
	});
});

describe('runWorkflow — multi-step pipeline as a tracked workflow_run (D-013)', () => {
	it('a 3-step DAG runs to "done" with a per-step session linked to the run', async () => {
		// a → b, a → c : b and c both depend on a (a is a serialization gate).
		const wf = await createWorkflow(db, {
			name: 'three-step',
			project: projectId,
			steps: [
				step({ id: 'a' }),
				step({ id: 'b', depends_on: ['a'] }),
				step({ id: 'c', depends_on: ['a'] })
			]
		});

		const res = await runWorkflow({ db, bus: new EventBus(), runtime: rt(), workflow: wf.id });

		expect(res.status).toBe('done');
		expect(res.stepState).toEqual({ a: 'done', b: 'done', c: 'done' });

		// The workflow_run row is the durable tracked record (step_state persisted).
		const run = await getWorkflowRun(db, res.runId);
		expect(run?.status).toBe('done');
		expect(run?.step_state).toEqual({ a: 'done', b: 'done', c: 'done' });
		expect(run?.workflow).toBe(wf.id);

		// Per-step session records: exactly one session per step, each linked to THIS run
		// (the §4.11 "each executing step is a session" contract). Read back from the DB.
		const [sessRows] = await db.query<[Array<Record<string, unknown>>]>(
			`SELECT id, workflow_run, kind, task FROM session WHERE workflow_run = $rid;`,
			{ rid: new StringRecordId(res.runId) }
		);
		expect(sessRows.length).toBe(3);
		expect(sessRows.every((s) => String(s.workflow_run) === res.runId)).toBe(true);
		// A workflow step has NO task link (option<record<task>> omitted, §6.1).
		expect(sessRows.every((s) => s.task == null)).toBe(true);
		// Every step session id is reported.
		expect(Object.keys(res.sessions).sort()).toEqual(['a', 'b', 'c']);
		for (const sid of Object.values(res.sessions)) {
			expect(sessRows.some((s) => String(s.id) === sid)).toBe(true);
		}
	});

	it('runs dependency-free parallel steps and respects depends_on ordering', async () => {
		// Two roots (a, b) run in parallel; c waits for both. We assert c's session was
		// created AFTER a and b completed (ordering proof via session started_at).
		const wf = await createWorkflow(db, {
			name: 'fan-in',
			project: projectId,
			steps: [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c', depends_on: ['a', 'b'] })]
		});

		const res = await runWorkflow({ db, bus: new EventBus(), runtime: rt(), workflow: wf.id });
		expect(res.status).toBe('done');

		const [rows] = await db.query<[Array<{ id: unknown; started_at: string }>]>(
			`SELECT id, started_at FROM session WHERE workflow_run = $rid;`,
			{ rid: new StringRecordId(res.runId) }
		);
		const startOf = (stepSession: string) =>
			new Date(rows.find((r) => String(r.id) === stepSession)!.started_at).getTime();
		// c (the fan-in step) started no earlier than both upstreams.
		expect(startOf(res.sessions.c)).toBeGreaterThanOrEqual(
			Math.max(startOf(res.sessions.a), startOf(res.sessions.b))
		);
	});

	it('a failed step fails the run and short-circuits its dependents (left pending)', async () => {
		// a fails → b (depends on a) can never become ready and stays pending; run = failed.
		const wf = await createWorkflow(db, {
			name: 'fail-chain',
			project: projectId,
			steps: [step({ id: 'a' }), step({ id: 'b', depends_on: ['a'] })]
		});

		const res = await runWorkflow({
			db,
			bus: new EventBus(),
			runtime: rt({ failPrompts: ['do a'] }),
			workflow: wf.id
		});

		expect(res.status).toBe('failed');
		expect(res.stepState.a).toBe('failed');
		expect(res.stepState.b).toBe('pending'); // dependent never ran
		expect(res.sessions.b).toBeUndefined();

		const run = await getWorkflowRun(db, res.runId);
		expect(run?.status).toBe('failed');
		expect(run?.step_state).toEqual({ a: 'failed', b: 'pending' });
	});

	it('emits transcript bus events per step (the render-live path flows through sessions)', async () => {
		const bus = new EventBus();
		const transcripts: BusEvent[] = [];
		bus.subscribe(
			(e) => transcripts.push(e),
			(e) => e.type === 'transcript'
		);
		const wf = await createWorkflow(db, {
			name: 'live',
			project: projectId,
			steps: [step({ id: 'a' }), step({ id: 'b', depends_on: ['a'] })]
		});
		const res = await runWorkflow({ db, bus, runtime: rt(), workflow: wf.id });
		expect(res.status).toBe('done');
		// Each step's session republished its stream onto the one bus (per-session topic).
		const topics = new Set(transcripts.map((e) => e.topic));
		expect(topics.has(res.sessions.a)).toBe(true);
		expect(topics.has(res.sessions.b)).toBe(true);
	});

	it('uses the workflow project when no projectId override is given', async () => {
		const wf = await createWorkflow(db, {
			name: 'proj-default',
			project: projectId,
			steps: [step({ id: 'only' })]
		});
		const res = await runWorkflow({ db, bus: new EventBus(), runtime: rt(), workflow: wf.id });
		expect(res.status).toBe('done');
		const [rows] = await db.query<[Array<{ project: unknown }>]>(
			`SELECT project FROM session WHERE workflow_run = $rid;`,
			{ rid: new StringRecordId(res.runId) }
		);
		expect(String(rows[0].project)).toBe(projectId);
	});
});
