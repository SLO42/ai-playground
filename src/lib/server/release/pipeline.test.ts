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
import { getWorkflowRun } from '../workflows/index';
import {
	RELEASE_STAGES,
	buildReleaseSteps,
	createReleaseWorkflow,
	runRelease,
	listReleaseRuns,
	getReleaseChangelogHtml
} from './pipeline';

// TASK 3.4 VERIFY (D-013; DATA-MODEL §4.11; dep 2.17) — a multi-step RELEASE runs as a
// tracked workflow_run with per-step session records, driven by a MOCKED/SANDBOXED runtime
// (the same scripted-stream backend pattern 1.4/1.6b/2.17 used — NO live API, NO creds, NO
// network to Anthropic, NO real `git tag`/`npm publish`). Every row read back came from the
// live throwaway DB the pipeline+runtime actually produced (F-008: a mocked runtime in a
// TEST is allowed; no fabricated PRODUCT data). The capstone real credentialed end-to-end
// release transcript (real publish + tag) is the deferred live proof; the pipeline LOGIC is
// fully built + verified here over the reused 2.17 runner.

const M = { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' };

// A scripted backend: records each plan, emits done(ok) per step. done.ok is controllable
// (failPrompts) so we can prove a red stage aborts the release + short-circuits downstream.
function scriptedBackend(opts?: { failPrompts?: string[] }): CcBackend & { plans: CcSpawnPlan[] } {
	const plans: CcSpawnPlan[] = [];
	let seq = 0;
	return {
		plans,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			const fail = (opts?.failPrompts ?? []).some((p) => plan.prompt.includes(p));
			const cc = `cc_rel_${Math.random().toString(36).slice(2, 8)}_${seq++}`;
			const events: RuntimeEvent[] = [
				{ type: 'log', message: `release step ${plan.agentId}` },
				{ type: 'token_usage', input: 8, output: 4 },
				{
					type: 'done',
					result: { ok: !fail, summary: fail ? 'stage failed' : 'stage ok', ccSessionId: cc }
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

function rt(opts?: { failPrompts?: string[] }) {
	return new ClaudeCodeRuntime({
		backend: scriptedBackend(opts),
		harnessConfigRoot: 'F:/code/rel/.harness-cc'
	});
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
	const p = await createProject(db, { slug: 'rel', name: 'Release Host', root_path: 'F:/code/rel' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('buildReleaseSteps — the canonical pipeline shape', () => {
	it('is the 7-stage linear chain dry-run → … → publish → verify (14.7)', () => {
		const steps = buildReleaseSteps({ version: 'v0.4', cwd: 'F:/code/rel', model: M });
		expect(steps.map((s) => s.id)).toEqual([...RELEASE_STAGES]);
		// First stage has no dependency; every later stage depends on exactly its predecessor.
		expect(steps[0].depends_on).toBeUndefined();
		for (let i = 1; i < steps.length; i++) {
			expect(steps[i].depends_on).toEqual([RELEASE_STAGES[i - 1]]);
		}
		// Every stage is sequential (never parallel) and runs in the project cwd.
		expect(steps.every((s) => s.parallel === false)).toBe(true);
		expect(steps.every((s) => s.cwd === 'F:/code/rel')).toBe(true);
		// The target version is substituted into each prompt.
		expect(steps.every((s) => s.prompt.includes('v0.4'))).toBe(true);
	});
});

describe('createReleaseWorkflow — persisted, DAG-validated (§4.11)', () => {
	it('persists a manual "release <version>" workflow with the 7 ordered steps', async () => {
		const wf = await createReleaseWorkflow(db, {
			projectId,
			version: 'v0.9',
			cwd: 'F:/code/rel',
			model: M
		});
		expect(wf.name).toBe('release v0.9');
		expect(wf.trigger).toBe('manual');
		expect(wf.project).toBe(projectId);
		expect(wf.steps.map((s) => s.id)).toEqual([...RELEASE_STAGES]);
	});
});

describe('runRelease — a multi-step release as a tracked workflow_run (D-013, dep 2.17)', () => {
	it('runs all 7 stages to "done" with one per-stage session linked to the run', async () => {
		const res = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt(),
			projectId,
			version: 'v1.0',
			cwd: 'F:/code/rel',
			model: M
		});

		expect(res.status).toBe('done');
		expect(res.version).toBe('v1.0');
		// Every stage is "done".
		expect(res.stepState).toEqual(
			Object.fromEntries(RELEASE_STAGES.map((s) => [s, 'done']))
		);

		// The workflow_run row is the durable tracked record (step_state persisted).
		const run = await getWorkflowRun(db, res.runId);
		expect(run?.status).toBe('done');
		expect(run?.workflow).toBe(res.workflowId);

		// Per-stage session records: exactly one session per stage, each linked to THIS run
		// (the §4.11 "each executing step is a session" contract). Read back from the DB.
		const [sessRows] = await db.query<[Array<{ id: unknown; workflow_run: unknown; task: unknown }>]>(
			`SELECT id, workflow_run, task FROM session WHERE workflow_run = $rid;`,
			{ rid: new StringRecordId(res.runId) }
		);
		expect(sessRows.length).toBe(RELEASE_STAGES.length);
		expect(sessRows.every((s) => String(s.workflow_run) === res.runId)).toBe(true);
		// A release stage has NO task link (option<record<task>> omitted, §6.1).
		expect(sessRows.every((s) => s.task == null)).toBe(true);
		// Every stage reported its session id, and each maps to a real session row.
		expect(Object.keys(res.sessions).sort()).toEqual([...RELEASE_STAGES].sort());
		for (const sid of Object.values(res.sessions)) {
			expect(sessRows.some((s) => String(s.id) === sid)).toBe(true);
		}
	});

	it('runs the stages in strict pipeline order (each after the previous)', async () => {
		const res = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt(),
			projectId,
			version: 'v1.1',
			cwd: 'F:/code/rel',
			model: M
		});
		expect(res.status).toBe('done');

		const [rows] = await db.query<[Array<{ id: unknown; started_at: string }>]>(
			`SELECT id, started_at FROM session WHERE workflow_run = $rid;`,
			{ rid: new StringRecordId(res.runId) }
		);
		const startOf = (stage: string) =>
			new Date(rows.find((r) => String(r.id) === res.sessions[stage])!.started_at).getTime();
		// Each stage started no earlier than the one before it (strict linear chain).
		for (let i = 1; i < RELEASE_STAGES.length; i++) {
			expect(startOf(RELEASE_STAGES[i])).toBeGreaterThanOrEqual(startOf(RELEASE_STAGES[i - 1]));
		}
	});

	it('a red stage aborts the release and short-circuits every later stage', async () => {
		// "test" fails → changelog/version/tag/publish/verify can never become ready (stay
		// pending); dry-run (before it) still ran. The run = failed (abort on first red gate).
		const res = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt({ failPrompts: ['Run the full test suite'] }),
			projectId,
			version: 'v1.2',
			cwd: 'F:/code/rel',
			model: M
		});

		expect(res.status).toBe('failed');
		expect(res.stepState['dry-run']).toBe('done');
		expect(res.stepState.test).toBe('failed');
		// Everything downstream of the failed stage stayed pending (never spawned a session).
		for (const stage of ['changelog', 'version', 'tag', 'publish', 'verify'] as const) {
			expect(res.stepState[stage]).toBe('pending');
			expect(res.sessions[stage]).toBeUndefined();
		}

		const run = await getWorkflowRun(db, res.runId);
		expect(run?.status).toBe('failed');
	});

	it('republishes each stage transcript onto the bus (the live render path)', async () => {
		const bus = new EventBus();
		const transcripts: BusEvent[] = [];
		bus.subscribe(
			(e) => transcripts.push(e),
			(e) => e.type === 'transcript'
		);
		const res = await runRelease({
			db,
			bus,
			runtime: rt(),
			projectId,
			version: 'v1.3',
			cwd: 'F:/code/rel',
			model: M
		});
		expect(res.status).toBe('done');
		const topics = new Set(transcripts.map((e) => e.topic));
		// Every stage's session republished its stream onto the one bus (per-session topic).
		for (const stage of RELEASE_STAGES) {
			expect(topics.has(res.sessions[stage])).toBe(true);
		}
	});
});

describe('listReleaseRuns — the Release tab read model', () => {
	it('returns this project release runs newest-first with version + step_state', async () => {
		// Two distinct release runs for this project (different versions).
		const a = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt(),
			projectId,
			version: 'v2.0',
			cwd: 'F:/code/rel',
			model: M
		});
		const b = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt(),
			projectId,
			version: 'v2.1',
			cwd: 'F:/code/rel',
			model: M
		});

		const runs = await listReleaseRuns(db, projectId);
		// Both our just-run releases appear among the project's release runs.
		const ours = runs.filter((r) => r.runId === a.runId || r.runId === b.runId);
		expect(ours.length).toBe(2);
		// Newest-first: b (run after a) precedes a in the list.
		const idxB = runs.findIndex((r) => r.runId === b.runId);
		const idxA = runs.findIndex((r) => r.runId === a.runId);
		expect(idxB).toBeLessThan(idxA);
		// Version is derived from the workflow name; step_state round-trips.
		const rowB = runs[idxB];
		expect(rowB.version).toBe('v2.1');
		expect(rowB.workflowName).toBe('release v2.1');
		expect(rowB.status).toBe('done');
		expect(rowB.stepState.publish).toBe('done');
		expect(rowB.endedAt).toBeTruthy();
		// Every run carries a changelogHtml string (honest — empty or real, never absent).
		expect(typeof rowB.changelogHtml).toBe('string');
	});
});

// TASK 11.2 — the REAL generated changelog renders on the Release page. The changelog STEP's
// session assistant output is read back and rendered to SAFE HTML (markdown → sanitized).
// A backend that emits a markdown changelog for the changelog step proves the round-trip
// through the live DB + the page-load read model (F-008 — real session output, not fabricated).
describe('changelog render — the REAL generated changelog (TASK 11.2)', () => {
	// A backend that emits a real markdown changelog (including an injection attempt) for the
	// changelog step, and a plain log line for every other step.
	function changelogBackend(): CcBackend & { plans: CcSpawnPlan[] } {
		const plans: CcSpawnPlan[] = [];
		let seq = 0;
		const CHANGELOG_MD = [
			'# v3.0',
			'',
			'## Added',
			'- **Release** changelog rendering on `/release`',
			'- Step → session links on /workflows',
			'',
			'See [the docs](https://example.com/changelog).',
			'',
			'<script>alert(1)</script>'
		].join('\n');
		return {
			plans,
			kind: 'mock',
			run(plan: CcSpawnPlan): CcBackendRun {
				plans.push(plan);
				const isChangelog = plan.prompt.includes('Generate the CHANGELOG entry');
				const cc = `cc_cl_${Math.random().toString(36).slice(2, 8)}_${seq++}`;
				const events: RuntimeEvent[] = [
					{ type: 'log', message: isChangelog ? CHANGELOG_MD : `release step ${plan.agentId}` },
					{ type: 'token_usage', input: 8, output: 4 },
					{ type: 'done', result: { ok: true, summary: 'stage ok', ccSessionId: cc } }
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

	it('renders the changelog step session output as safe HTML on the run summary', async () => {
		const res = await runRelease({
			db,
			bus: new EventBus(),
			runtime: new ClaudeCodeRuntime({
				backend: changelogBackend(),
				harnessConfigRoot: 'F:/code/rel/.harness-cc'
			}),
			projectId,
			version: 'v3.0',
			cwd: 'F:/code/rel',
			model: M
		});
		expect(res.status).toBe('done');

		// Direct read: the changelog step's session output rendered to HTML.
		const html = await getReleaseChangelogHtml(db, res.runId);
		expect(html).toContain('<h1>v3.0</h1>');
		expect(html).toContain('<li><strong>Release</strong> changelog rendering on <code>/release</code></li>');
		expect(html).toContain('<a href="https://example.com/changelog"');
		// SAFETY: the injected <script> must be escaped, never passed through.
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');

		// Through the page-load read model: listReleaseRuns carries the same rendered HTML.
		const runs = await listReleaseRuns(db, projectId);
		const row = runs.find((r) => r.runId === res.runId);
		expect(row).toBeTruthy();
		expect(row!.changelogHtml).toContain('<h1>v3.0</h1>');
		expect(row!.changelogHtml).not.toContain('<script>');
	});

	it('returns an empty changelog (honest) for a run with no changelog session', async () => {
		// A run whose changelog stage never ran: a red "test" stage short-circuits changelog.
		const res = await runRelease({
			db,
			bus: new EventBus(),
			runtime: rt({ failPrompts: ['Run the full test suite'] }),
			projectId,
			version: 'v3.1',
			cwd: 'F:/code/rel',
			model: M
		});
		expect(res.status).toBe('failed');
		expect(res.stepState.changelog).toBe('pending');
		const html = await getReleaseChangelogHtml(db, res.runId);
		expect(html).toBe('');
	});
});
