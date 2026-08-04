import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { runPostTask } from './post-task';
import { shouldHoldMergeBack } from './orchestrator';
import type { CommandResult, CommandRunner } from './command-runner';

// PCG-1 VERIFY (integration, REAL SurrealDB) — the pre-commit gate + the review wiring inside the
// post-task loop. Every query here is parsed by a real SurrealDB instance (a stubDb does not parse
// SurrealQL — F-020), and every OS command goes through an INJECTED runner (no live process).
//
// The load-bearing proofs, in the order the operator's finding lists them:
//   1. HAPPY — gate green ⇒ task `done`, work committed, the full gate record on the completion
//      event, and (when the change is large) a `review` work_item enqueued before any merge.
//   2. FAILURE (the important one) — gate RED ⇒ the task lands `failed`, the caller is TOLD not to
//      merge, the work is NOT deleted (the commit still happened, on the session branch), and the
//      failure is VISIBLE: every step, command, exit code and reason is on the event.
//   3. DB FAULT mid-gate — a DB failure never crashes, and never lets a red gate read as green.
//   4. RE-RUN after a mid-gate crash — idempotent: the second run absorbs the first's partial work
//      instead of erroring, and does not double-enqueue a review.

let tdb: TestDb;
let db: Db;
let projectId: string;
/** A real temp dir carrying a package.json that declares build/lint/typecheck/test. */
let cwd: string;

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
	cwd = mkdtempSync(join(tmpdir(), 'pcg-pt-'));
	writeFileSync(
		join(cwd, 'package.json'),
		JSON.stringify({
			name: 'gated',
			scripts: { build: 'vite build', lint: 'eslint .', typecheck: 'svelte-check', test: 'vitest run' }
		})
	);
	// An INSTALLED tree: without node_modules the gate refuses to spawn npm at all and records an
	// honest skip (the false-RED fix). These cases are about a project whose checks CAN run.
	mkdirSync(join(cwd, 'node_modules'));
	const project = await createProject(db, {
		slug: 'pcg_proj',
		name: 'pcg-proj',
		root_path: cwd,
		build_tool: 'npm',
		test_command: 'npm test'
	});
	projectId = project.id;
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(cwd, { recursive: true, force: true });
});

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

function fakeRunner(
	script: (file: string, args: readonly string[]) => CommandResult
): CommandRunner & { calls: { file: string; args: string[] }[] } {
	const calls: { file: string; args: string[] }[] = [];
	const fn: CommandRunner = async (file, args) => {
		calls.push({ file, args: [...args] });
		return script(file, args);
	};
	return Object.assign(fn, { calls });
}

/** git succeeds; `npm run <x>`/`npm test` follow the caller's script. */
function gitAnd(script: (file: string, args: readonly string[]) => CommandResult) {
	return fakeRunner((file, args) => {
		if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'dec0de1\n', stderr: '' };
		if (file === 'git' && args[0] === 'diff') {
			// 6 distinct files ⇒ over the default review threshold of 5.
			return { code: 0, stdout: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', stderr: '' };
		}
		if (file === 'git') return OK;
		return script(file, args);
	});
}

async function freshRunningTask(title: string): Promise<string> {
	const t = await createTask(db, { project: projectId, title, description: 'pcg', status: 'ready' });
	await setStatus(db, t.id, 'in_progress');
	return t.id;
}

async function makeSession(taskId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   project: $p, task: $t, kind: "task", runtime: "claude-code",
		   model: { provider: "claude", model_id: "claude-opus-4-8", tier: "opus" }
		 } RETURN AFTER;`,
		{ p: new StringRecordId(projectId), t: new StringRecordId(taskId) }
	);
	return String(rows[0].id);
}

async function readTaskStatus(taskId: string): Promise<string> {
	const [rows] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM ONLY $t;`, {
		t: new StringRecordId(taskId)
	});
	const row = (Array.isArray(rows) ? rows[0] : rows) as { status?: string } | undefined;
	return row?.status ?? 'missing';
}

/** Read one agent_event's detail back from the real DB. */
async function readEventDetail(eventId: string): Promise<Record<string, unknown>> {
	const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
		`SELECT detail FROM ONLY $e;`,
		{ e: new StringRecordId(eventId) }
	);
	const row = (Array.isArray(rows) ? rows[0] : rows) as { detail?: Record<string, unknown> } | undefined;
	return row?.detail ?? {};
}

/** Count active `review` work_items for a task (the exactly-one-review guarantee). */
async function countReviewItems(taskId: string): Promise<number> {
	// Every ORDER BY / GROUP BY field must be in the SELECT (F-020) — this projects what it filters on.
	const [rows] = await db.query<[Array<{ dedup_scope: string; work_type: string }>]>(
		`SELECT work_type, dedup_scope FROM work_item
		   WHERE work_type = $wt AND dedup_scope = $scope
		   ORDER BY dedup_scope;`,
		{ wt: 'review', scope: taskId }
	);
	return Array.isArray(rows) ? rows.length : 0;
}

describe('PCG-1 — the pre-commit gate inside the post-task loop', () => {
	it('HAPPY: gate green ⇒ task done, work committed, the whole gate record on the completion event', async () => {
		const taskId = await freshRunningTask('happy gate');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd(() => OK);

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd,
				commitMessage: 'feat: did the work',
				testCommand: 'npm test',
				buildTool: 'npm',
				runOk: true
			},
			{ run: runner, gate: { enabled: true } }
		);

		expect(res.gate?.status).toBe('passed');
		expect(res.divergent).toBe(false);
		expect(res.taskStatus).toBe('done');
		expect(await readTaskStatus(taskId)).toBe('done');
		expect(res.commit.ok).toBe(true);

		// THE ORDERING PROOF: every gate command ran BEFORE `git commit`.
		const idx = runner.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'commit');
		const gateIdx = runner.calls.map((c, i) => (c.file === 'npm' ? i : -1)).filter((i) => i >= 0);
		expect(gateIdx.length).toBe(4);
		expect(Math.max(...gateIdx)).toBeLessThan(idx);

		// The test suite ran EXACTLY ONCE (the gate's test step subsumes the legacy post-commit run).
		expect(runner.calls.filter((c) => c.file === 'npm' && c.args[0] === 'test').length).toBe(1);
		expect(res.test.attempted).toBe(true);
		expect(res.test.ok).toBe(true);

		// ANALYTICS IS FIRST-CLASS — the event carries the ordered per-step record, not a flat flag.
		const detail = await readEventDetail(res.agentEventId);
		expect(detail.gate_failed).toBe(false);
		const gate = detail.gate as { status: string; steps: Array<{ name: string; ok: boolean; code: number | null }> };
		expect(gate.status).toBe('passed');
		expect(gate.steps.map((s) => s.name)).toEqual(['build', 'lint', 'typecheck', 'test']);
		expect(gate.steps.every((s) => s.ok)).toBe(true);
		// POJOs only — nothing here can blow up devalue on a `load` (F-013).
		expect(JSON.parse(JSON.stringify(gate))).toEqual(gate);
		expect(String(detail.gate_consequence)).toMatch(/eligible to merge/);
	});

	it('FAILURE: gate RED ⇒ task FAILED, caller told not to merge, work NOT deleted, failure VISIBLE', async () => {
		const taskId = await freshRunningTask('red gate');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd((file, args) =>
			args[0] === 'test' ? { code: 1, stdout: '2 tests failed', stderr: '' } : OK
		);

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd,
				commitMessage: 'feat: broke the tests',
				testCommand: 'npm test',
				buildTool: 'npm',
				runOk: true
			},
			{ run: runner, gate: { enabled: true } }
		);

		// 1. THE TASK DOES NOT REPORT SUCCESS.
		expect(res.gate?.status).toBe('failed');
		expect(res.gate?.failedAt).toBe('test');
		expect(res.taskStatus).toBe('failed');
		expect(await readTaskStatus(taskId)).toBe('failed');

		// 2. THE WORK IS NOT DELETED (F-007): the commit still ran, on the session branch, and its
		//    subject says WHY it is sitting there unmerged.
		expect(res.commit.attempted).toBe(true);
		expect(res.commit.ok).toBe(true);
		const commitCall = runner.calls.find((c) => c.file === 'git' && c.args[0] === 'commit')!;
		expect(commitCall.args[2]).toMatch(/pre-commit gate FAILED at test — preserved, NOT merged/);

		// 3. NOTHING WAS MERGED BY US and no review was requested for red work.
		expect(res.review).toBeUndefined();
		expect(runner.calls.some((c) => c.file === 'git' && c.args[0] === 'merge')).toBe(false);

		// 4. THE FAILURE IS VISIBLE — read the real row back, not the in-memory result.
		const detail = await readEventDetail(res.agentEventId);
		expect(detail.gate_failed).toBe(true);
		expect(String(detail.gate_consequence)).toMatch(/PRESERVED, NOT merged/);
		const gate = detail.gate as { failed_at: string; steps: Array<{ name: string; ran: boolean; detail: string }> };
		expect(gate.failed_at).toBe('test');
		expect(gate.steps.find((s) => s.name === 'test')?.detail).toMatch(/2 tests failed/);
		// The green steps are still on the record — the operator sees WHAT passed too.
		expect(gate.steps.filter((s) => s.ran).map((s) => s.name)).toEqual([
			'build',
			'lint',
			'typecheck',
			'test'
		]);
	});

	it('FAILURE: a gate that could not RUN is red-with-errored, and still does not lose the work', async () => {
		const taskId = await freshRunningTask('gate machinery down');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner((file, args) => {
			if (file === 'npm') throw new Error('spawn npm ENOENT');
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'f00d\n', stderr: '' };
			return OK;
		});

		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: x', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true } }
		);

		expect(res.gate?.status).toBe('failed');
		expect(res.gate?.errored).toBe(true);
		expect(res.taskStatus).toBe('failed');
		// The server/drain is still standing and the work is committed for inspection.
		expect(res.commit.ok).toBe(true);
	});

	it('SKIPPED is honest and NOT a failure — a project with no targets still lands `done`', async () => {
		const bare = mkdtempSync(join(tmpdir(), 'pcg-bare-pt-'));
		try {
			const taskId = await freshRunningTask('nothing to verify');
			const sessionId = await makeSession(taskId);
			const runner = gitAnd(() => OK);
			const res = await runPostTask(
				db,
				{ projectId, taskId, sessionId, cwd: bare, commitMessage: 'docs: notes', runOk: true },
				{ run: runner, gate: { enabled: true } }
			);
			expect(res.gate?.status).toBe('skipped');
			expect(res.gate?.verified).toBe(false);
			expect(res.taskStatus).toBe('done');
			const detail = await readEventDetail(res.agentEventId);
			expect(detail.gate_failed).toBe(false);
			expect(String(detail.gate_consequence)).toMatch(/UNVERIFIED but not blocked/);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it('the gate is OPT-IN: with it off, nothing changes (no gate on the result, no extra commands)', async () => {
		const taskId = await freshRunningTask('gate off');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd((file, args) => (args[0] === 'test' ? { code: 1, stdout: 'fail', stderr: '' } : OK));
		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'chore: x', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner }
		);
		expect(res.gate).toBeUndefined();
		// The pre-PCG-1 contract: a failing test does NOT change the terminal status.
		expect(res.taskStatus).toBe('done');
		expect(runner.calls.filter((c) => c.file === 'npm').map((c) => c.args[0])).toEqual(['test']);
	});
});

describe('PCG-1 — the review wiring (maybeEnqueueReview finally has a caller)', () => {
	it('a gate-green large change enqueues EXACTLY ONE review work_item, recorded on the event', async () => {
		const taskId = await freshRunningTask('large green change');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd(() => OK);

		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: big', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true }, review: { enabled: true } }
		);

		expect(res.review?.changedFiles).toBe(6);
		expect(res.review?.triggered).toBe(true);
		expect(res.review?.workItemId).toBeTruthy();
		expect(await countReviewItems(taskId)).toBe(1);

		// The measurement happened AFTER the commit (so it measures the real committed footprint)…
		const diffIdx = runner.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'diff');
		const commitIdx = runner.calls.findIndex((c) => c.file === 'git' && c.args[0] === 'commit');
		expect(diffIdx).toBeGreaterThan(commitIdx);
		// …and therefore it MUST diff against the PRE-COMMIT sha, not 'HEAD'. This is the DoD-review's
		// finding #2: after `git add -A && git commit` the tree is clean, so `git diff HEAD` prints
		// NOTHING — the count was always 0 and no review could ever be enqueued in production. The
		// ordering assertion above passed while the feature was dead; this is the assertion that
		// would have caught it.
		const diffCall = runner.calls[diffIdx];
		expect(diffCall.args).toEqual(['diff', '--name-only', '--no-renames', 'dec0de1']);
		expect(diffCall.args).not.toContain('HEAD');

		const detail = await readEventDetail(res.agentEventId);
		expect(detail.review_triggered).toBe(true);
		expect(detail.review_changed_files).toBe(6);
		expect(String(detail.review_work_item)).toMatch(/^work_item:/);
	});

	it('a SMALL change does not request a review — the threshold is honored, not a blanket', async () => {
		const taskId = await freshRunningTask('small change');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'sma11\n', stderr: '' };
			if (file === 'git' && args[0] === 'diff') return { code: 0, stdout: 'only.ts\n', stderr: '' };
			return OK;
		});
		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'fix: typo', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true }, review: { enabled: true } }
		);
		expect(res.review?.triggered).toBe(false);
		expect(await countReviewItems(taskId)).toBe(0);
	});

	it('a RED gate never requests a review (no second signal for work nobody should read yet)', async () => {
		const taskId = await freshRunningTask('red no review');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd((file, args) => (args[1] === 'lint' ? { code: 1, stdout: 'lint red', stderr: '' } : OK));
		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: y', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true }, review: { enabled: true } }
		);
		expect(res.gate?.status).toBe('failed');
		expect(res.review).toBeUndefined();
		expect(await countReviewItems(taskId)).toBe(0);
		expect(runner.calls.some((c) => c.args[0] === 'diff')).toBe(false);
	});

	it('DB FAULT mid-review: the fault is NAMED, the commit and the terminal status are untouched', async () => {
		const taskId = await freshRunningTask('review db fault');
		const sessionId = await makeSession(taskId);
		const runner = gitAnd(() => OK);

		// A Db proxy that fails ONLY the work-queue read the review's enqueue performs (`FROM $rid`
		// against the deterministic work_item id). Every other query — the guarded transition
		// (`FROM ONLY $tid`) and the completion event — goes to the real DB untouched.
		const faulty = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'query') {
					return async (sql: string, vars?: Record<string, unknown>) => {
						if (/FROM \$rid/.test(sql)) throw new Error('DB down: work_item read refused');
						return (target as Db).query(sql, vars as never);
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as Db;

		const res = await runPostTask(
			faulty,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: z', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true }, review: { enabled: true } }
		);

		// Best-effort by construction: the review failure is NAMED and changes nothing else.
		expect(res.reviewError).toMatch(/review decision failed: DB down/);
		expect(res.gate?.status).toBe('passed');
		expect(res.review).toBeUndefined();
		expect(res.commit.ok).toBe(true);
		expect(res.taskStatus).toBe('done');
		expect(await readTaskStatus(taskId)).toBe('done');
		const detail = await readEventDetail(res.agentEventId);
		expect(String(detail.review_note)).toMatch(/review decision failed/);
	});

	it('INTERRUPT CONTRACT: a crash DURING the gate leaves no state; the re-run lands normally', async () => {
		const taskId = await freshRunningTask('killed mid-gate');
		const sessionId = await makeSession(taskId);

		// A process killed mid-gate never reaches the transition, the commit or any DB write — the
		// gate holds NO state of its own. Model that faithfully: run the gate step alone (as the
		// dying process would have), then assert the task is untouched and the re-run works.
		const { runPreCommitGate } = await import('./pre-commit-gate');
		const partial = await runPreCommitGate(
			{ cwd, buildTool: 'npm', testCommand: 'npm test' },
			{
				run: fakeRunner((file, args) => {
					if (args[1] === 'lint') throw new Error('killed mid-gate');
					return OK;
				})
			}
		);
		expect(partial.errored).toBe(true);
		// NOTHING was written: the task is exactly where the session left it.
		expect(await readTaskStatus(taskId)).toBe('in_progress');
		expect(await countReviewItems(taskId)).toBe(0);

		// The re-run absorbs the (empty) prior state and lands the full outcome.
		const rerun = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: resumed', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: gitAnd(() => OK), gate: { enabled: true }, review: { enabled: true } }
		);
		expect(rerun.gate?.status).toBe('passed');
		expect(rerun.divergent).toBe(false);
		expect(await readTaskStatus(taskId)).toBe('done');
		expect(await countReviewItems(taskId)).toBe(1);
	});

	it('INTERRUPT CONTRACT: re-running a completed post-task is idempotent — never a SECOND review', async () => {
		const taskId = await freshRunningTask('idempotent re-drive');
		const sessionId = await makeSession(taskId);

		const first = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: once', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: gitAnd(() => OK), gate: { enabled: true }, review: { enabled: true } }
		);
		expect(first.review?.workItemId).toBeTruthy();

		// The identical call again (a re-drain after a crash between the commit and the ack). The
		// guarded transition absorbs the already-terminal task, and the work_item dedup key collapses
		// the second enqueue to a no-op instead of erroring on it.
		const second = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: once', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: gitAnd(() => OK), gate: { enabled: true }, review: { enabled: true } }
		);
		expect(second.divergent).toBe(false);
		expect(second.taskStatus).toBe('done');
		expect(second.review?.triggered).toBe(true);
		expect(second.review?.workItemId).toBeUndefined(); // deduped, not created twice
		expect(await countReviewItems(taskId)).toBe(1);
	});

	it('a ROOT commit (unborn HEAD) is measured against the EMPTY TREE, not silently counted as 0', async () => {
		const taskId = await freshRunningTask('root commit import');
		const sessionId = await makeSession(taskId);
		// `git rev-parse --verify HEAD` in a repo with no commits exits 128 ("Needed a single
		// revision") — verified against real git. That is not an error, it is the first commit.
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
				return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
			}
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'r00t001\n', stderr: '' };
			if (file === 'git' && args[0] === 'diff') {
				return { code: 0, stdout: 'a.ts\nb.ts\nc.ts\nd.ts\ne.ts\nf.ts\n', stderr: '' };
			}
			return OK;
		});
		const res = await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd, commitMessage: 'feat: initial import', testCommand: 'npm test', buildTool: 'npm', runOk: true },
			{ run: runner, gate: { enabled: true }, review: { enabled: true } }
		);
		const diffCall = runner.calls.find((c) => c.file === 'git' && c.args[0] === 'diff')!;
		expect(diffCall.args[3]).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
		expect(res.review?.changedFiles).toBe(6);
		expect(res.review?.triggered).toBe(true);
	});
});

// ── REGRESSION (DoD-review finding #1, at the post-task level, against a REAL SurrealDB): the
//    ARMED gate must not WEDGE a project it cannot verify. The WI-2 worktree the gate runs in has
//    no node_modules, so every npm step used to exit non-zero → task `failed` → branch preserved,
//    never merged, for EVERY write task on EVERY npm project.
describe('PCG-1 — an UNVERIFIABLE working dir does not wedge the task (the false-RED fix)', () => {
	it('an npm project whose worktree has NO node_modules lands `done` with an honest UNVERIFIED gate', async () => {
		const worktreeLike = mkdtempSync(join(tmpdir(), 'pcg-wt-'));
		writeFileSync(
			join(worktreeLike, 'package.json'),
			JSON.stringify({ name: 'wt', scripts: { build: 'vite build', test: 'vitest run' } })
		);
		try {
			const taskId = await freshRunningTask('work in an uninstalled worktree');
			const sessionId = await makeSession(taskId);
			// The runner would say RED for any npm step — the point is that npm is never spawned.
			const runner = gitAnd(() => ({ code: 1, stdout: '', stderr: "'vite' is not recognized" }));

			const res = await runPostTask(
				db,
				{
					projectId,
					taskId,
					sessionId,
					cwd: worktreeLike,
					commitMessage: 'feat: in a worktree',
					testCommand: 'npm test',
					buildTool: 'npm',
					runOk: true
				},
				{ run: runner, gate: { enabled: true }, review: { enabled: true } }
			);

			// NOT failed: the environment could not verify, which is not a verdict on the change.
			expect(res.gate?.status).toBe('skipped');
			expect(res.gate?.verified).toBe(false);
			expect(res.taskStatus).toBe('done');
			expect(await readTaskStatus(taskId)).toBe('done');
			expect(runner.calls.some((c) => c.file === 'npm')).toBe(false);

			// HONEST, not silent: the completion event says UNVERIFIED and names the reason.
			const detail = await readEventDetail(res.agentEventId);
			expect(detail.gate_failed).toBe(false);
			expect(String(detail.gate_consequence)).toMatch(/UNVERIFIED but not blocked/);
			const gateDetail = detail.gate as { steps: Array<{ name: string; detail: string }> };
			expect(gateDetail.steps.find((s) => s.name === 'build')?.detail).toMatch(
				/NO installed dependency tree/
			);

			// …and the safety net still engages: an unverified LARGE change queues a review, which is
			// the operator's surface on a change nothing could check here.
			expect(res.review?.triggered).toBe(true);
			expect(await countReviewItems(taskId)).toBe(1);

			// REGRESSION (the follow-on DoD-review finding, at the composition level): this skip is
			// flagged as an ENVIRONMENT skip, so boot.ts's holdMergeBack:'unverified' does NOT turn
			// it into a merge hold. Holding here stalled every large change on every npm project with
			// no automated release, which is exactly the "cannot stall a healthy project" invariant
			// the gate is armed under.
			expect(res.gate?.unrunnable).toBe(true);
			expect(shouldHoldMergeBack('unverified', res.review?.triggered === true, res.gate)).toBe(
				false
			);
			// The persisted record carries the distinction too — an operator asking "why did this
			// land unverified" gets the environment named, not a false "no build/test target".
			expect((detail.gate as { unrunnable?: boolean }).unrunnable).toBe(true);
			expect(String(detail.gate_consequence)).toMatch(/could not RUN them/);
		} finally {
			rmSync(worktreeLike, { recursive: true, force: true });
		}
	});
});
