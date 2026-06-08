import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask, setStatus } from '../tasks/repo';
import { countByStatus } from './workqueue';
import type { CommandRunner, CommandResult } from './post-task';
import { maybeEnqueueReview, countChangedFiles, DEFAULT_REVIEW_THRESHOLD } from './review';

// TASK 2.8 VERIFY (ARCHITECTURE §2.2 "(b) Background heavy work"; D-021; D-008/D-016;
// DATA-MODEL §4.12).
//
// The review agent decides — AFTER a task's session committed — whether the change touched
// N+ files and, if so, enqueues EXACTLY ONE `review` work_item (drained off the interactive
// path like every other background job). We inject a FAKE CommandRunner (same mocked-backend
// pattern 1.4/1.6b/2.7 used — NO live process, NO shell, NO Anthropic) that returns a scripted
// `git diff --name-only` output, and read every enqueued row back from a real throwaway
// SurrealDB (no fabricated runtime data — F-008; a mock runner in a TEST is allowed).
//
// The two load-bearing proofs:
//   1. a change touching N+ files triggers EXACTLY ONE review spawn (one work_item, idempotent
//      under a re-run via the §4.12 dedup_key).
//   2. a change below the threshold triggers NONE.

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
		slug: 'rv_proj',
		name: 'rv-proj',
		root_path: 'F:/code/ai-playground-v2'
	});
	projectId = project.id;
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** A fake runner: records calls; returns a scripted `git diff --name-only` body. NO live process. */
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

/** Build a `git diff --name-only` stdout body with `n` distinct file paths. */
function diffOf(n: number): CommandResult {
	const files = Array.from({ length: n }, (_, i) => `src/file${i}.ts`);
	return { code: 0, stdout: files.join('\n') + (n ? '\n' : ''), stderr: '' };
}

async function freshDoneTask(title: string): Promise<string> {
	const t = await createTask(db, {
		project: projectId,
		title,
		description: 'review-agent test task',
		status: 'ready'
	});
	await setStatus(db, t.id, 'in_progress');
	return t.id;
}

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

async function readWorkItem(
	id: string
): Promise<{ work_type: string; payload: Record<string, unknown>; project: unknown } | undefined> {
	const { StringRecordId } = await import('surrealdb');
	const [rows] = await db.query<
		[Array<{ work_type: string; payload: Record<string, unknown>; project: unknown }>]
	>(`SELECT work_type, payload, project FROM ONLY $w;`, { w: new StringRecordId(id) });
	return (Array.isArray(rows) ? rows[0] : rows) as
		| { work_type: string; payload: Record<string, unknown>; project: unknown }
		| undefined;
}

describe('review agent — changed-file count via git diff (no shell, D-008)', () => {
	it('countChangedFiles counts distinct paths from git diff --name-only, execFile arrays', async () => {
		const runner = fakeRunner(() => diffOf(7));
		const cwd = 'F:/code/ai-playground-v2';
		const n = await countChangedFiles({ cwd, runner });

		expect(n).toBe(7);
		// diff was run as git with an ARGUMENT ARRAY (no shell), name-only, against HEAD.
		const diffCall = runner.calls.find((c) => c.file === 'git')!;
		expect(diffCall).toBeTruthy();
		expect(diffCall.args[0]).toBe('diff');
		expect(diffCall.args).toContain('--name-only');
		expect(diffCall.cwd).toBe(cwd);
		// no program other than git was invoked.
		expect(runner.calls.every((c) => c.file === 'git')).toBe(true);
	});

	it('blank / whitespace-only diff output counts as zero changed files', async () => {
		const runner = fakeRunner(() => ({ code: 0, stdout: '\n  \n', stderr: '' }));
		expect(await countChangedFiles({ cwd: 'F:/code/ai-playground-v2', runner })).toBe(0);
	});
});

describe('review agent — N+ changed files ⇒ EXACTLY ONE review spawn (2.8)', () => {
	it('a change touching N+ files enqueues exactly one review work_item', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshDoneTask('big refactor');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(DEFAULT_REVIEW_THRESHOLD)); // exactly at threshold

		const res = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);

		expect(res.changedFiles).toBe(DEFAULT_REVIEW_THRESHOLD);
		expect(res.triggered).toBe(true);
		expect(res.workItemId).toBeTruthy();

		// exactly one new pending work_item was created.
		const after = await countByStatus(db, 'pending');
		expect(after).toBe(before + 1);

		// it is a `review` item carrying the task/session/changedFiles in its payload.
		const wi = await readWorkItem(res.workItemId!);
		expect(wi?.work_type).toBe('review');
		expect(String(wi?.payload.taskId)).toBe(taskId);
		expect(String(wi?.payload.sessionId)).toBe(sessionId);
		expect(Number(wi?.payload.changedFiles)).toBe(DEFAULT_REVIEW_THRESHOLD);
		expect(String(wi?.project)).toBe(projectId);
	});

	it('above the threshold also triggers exactly one (not one-per-file)', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshDoneTask('huge change');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(DEFAULT_REVIEW_THRESHOLD + 42));

		const res = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);

		expect(res.triggered).toBe(true);
		const after = await countByStatus(db, 'pending');
		expect(after).toBe(before + 1); // ONE, regardless of how many files
	});

	it('a re-run for the same task does NOT enqueue a second review (idempotent, §4.12 dedup)', async () => {
		const taskId = await freshDoneTask('flaky double-fire');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(DEFAULT_REVIEW_THRESHOLD + 1));

		const first = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);
		const before = await countByStatus(db, 'pending');
		const second = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);
		const after = await countByStatus(db, 'pending');

		expect(first.triggered).toBe(true);
		expect(first.workItemId).toBeTruthy();
		// second call still reports "triggered" (it crossed the threshold) but NO new row.
		expect(second.triggered).toBe(true);
		expect(second.workItemId).toBeUndefined();
		expect(after).toBe(before); // no second review work_item
	});
});

describe('review agent — below the threshold ⇒ NO spawn (2.8)', () => {
	it('a change below N files triggers no review and enqueues nothing', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshDoneTask('tiny tweak');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(DEFAULT_REVIEW_THRESHOLD - 1)); // just below

		const res = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);

		expect(res.changedFiles).toBe(DEFAULT_REVIEW_THRESHOLD - 1);
		expect(res.triggered).toBe(false);
		expect(res.workItemId).toBeUndefined();
		const after = await countByStatus(db, 'pending');
		expect(after).toBe(before); // nothing enqueued
	});

	it('a zero-file change triggers no review', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshDoneTask('no-op');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(0));

		const res = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner }
		);

		expect(res.triggered).toBe(false);
		expect(await countByStatus(db, 'pending')).toBe(before);
	});

	it('respects a custom threshold', async () => {
		const before = await countByStatus(db, 'pending');
		const taskId = await freshDoneTask('custom-threshold change');
		const sessionId = await makeSession(taskId);
		const runner = fakeRunner(() => diffOf(3));

		// threshold 3: 3 files meets it.
		const res = await maybeEnqueueReview(
			db,
			{ projectId, taskId, sessionId, cwd: 'F:/code/ai-playground-v2' },
			{ runner, threshold: 3 }
		);
		expect(res.triggered).toBe(true);
		expect(await countByStatus(db, 'pending')).toBe(before + 1);
	});
});
