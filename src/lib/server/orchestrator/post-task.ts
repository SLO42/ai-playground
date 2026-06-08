// TASK 2.7 — the post-task loop (ARCHITECTURE §2.2 "post-task"; §3 step 7; D-008/D-016;
// D-018; DATA-MODEL §5 transactions; dep 2.2).
//
// When a session finishes (the orchestrator's #runItem sees a successful run), this is
// what step 7 of the data flow does:
//   • git commit the work — via execFile with ARGUMENT ARRAYS, never an interpolated
//     shell string (D-008: no shell injection). On Windows shell:true is sometimes
//     needed for paths-with-spaces in the binary, but we NEVER fold a dynamic/path value
//     into a shell-parsed command line even then — every dynamic value is a separate
//     array element so execFile passes it as a literal argv entry (F-002).
//   • run the project's `test_command` (also execFile arrays; the command is split into
//     a program + arg array, NOT handed to a shell to re-parse).
//   • optionally enqueue a follow-up `work_item` (D-021) — e.g. "add tests" when the
//     test step failed — so a follow-up runs off the interactive path, not inline.
//   • record the whole outcome ATOMICALLY: the task moves to its terminal status, a
//     `completion` agent_event carries the commit sha + test result in its how/why
//     `detail`, and the follow-up task (if any) is created — all in ONE transaction so a
//     mid-write crash leaves no partial state (DATA-MODEL §5, kills the v1 TOCTOU class).
//
// D-018 (remote ops restricted): this loop NEVER runs `git push`, `git remote …`, or any
// `--force` flag. The commit is purely local; remote-mutating git is gated out here as a
// belt-and-suspenders complement to the runtime gates (the args we build are fixed verbs).
//
// Boundary discipline (D-016): record ids pass the db/validate chokepoint and bind as
// StringRecordId; every VALUE binds via $param; absent optionals are OMITTED, never NULL
// (option<T> rejects NULL — MEMORY-SPEC §6.1).

import { execFile } from 'node:child_process';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { enqueue } from './workqueue';

// ── The command runner seam (so tests inject a fake — NO live process, the same
//    mocked-backend pattern 1.4/1.6b used; F-008 holds: a mock in a TEST is allowed) ──

/** The result of running ONE external command. */
export interface CommandResult {
	/** Process exit code (0 = success). null only if the process was signalled. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs an external program with an ARGUMENT ARRAY (never a shell string). This is the
 * single seam through which the post-task loop touches the OS — the default impl wraps
 * `execFile`, which spawns the program directly and passes each `args` element as a
 * literal argv entry (no shell word-splitting / metacharacter expansion). A malformed
 * path or a `;rm -rf …`-style task title therefore cannot inject a second command: it is
 * just one inert argv string handed to the program (D-008).
 */
export type CommandRunner = (
	file: string,
	args: readonly string[],
	opts: { cwd: string }
) => Promise<CommandResult>;

/**
 * The default runner: `execFile` with an argument array. `shell` is FALSE — even though
 * the platform note allows shell:true for binary-paths-with-spaces, this loop never needs
 * it (the programs are `git`/the test launcher on PATH) and shell:false is the strongest
 * no-injection guarantee: argv is passed verbatim, the OS never re-parses it (D-008/F-002).
 */
export const execFileRunner: CommandRunner = (file, args, opts) =>
	new Promise<CommandResult>((resolve) => {
		execFile(
			file,
			[...args],
			{ cwd: opts.cwd, shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// A non-zero exit shows up as an error with a `.code`; we surface it as a
				// CommandResult, never a throw — the loop decides what a failure means.
				const code =
					err && typeof (err as { code?: unknown }).code === 'number'
						? ((err as { code: number }).code)
						: err
							? 1
							: 0;
				resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
			}
		);
	});

// ── Inputs / outputs ──────────────────────────────────────────────────────────────

export interface PostTaskInput {
	/** Project record id — its root_path is the cwd; its test_command is run. */
	projectId: string;
	/** Task record id — moved to its terminal status; parent of any follow-up. */
	taskId: string;
	/** The session that did the work — the completion agent_event links to it. */
	sessionId: string;
	/** Project working dir (the validated root_path; execFile cwd). */
	cwd: string;
	/** Commit subject line. Bound as ONE argv element — never shell-interpreted. */
	commitMessage: string;
	/** The project test command, e.g. "npm test" — split to program + args (NOT a shell line). */
	testCommand?: string;
	/** Whether the agent run itself succeeded (decides the task's terminal status). */
	runOk: boolean;
}

export interface CommitOutcome {
	attempted: boolean;
	ok: boolean;
	/** The short commit sha, when a commit was made and we could read it back. */
	sha?: string;
	/** Set when nothing was staged (a no-op commit) or the commit failed. */
	note?: string;
}

export interface TestOutcome {
	attempted: boolean;
	ok: boolean;
	code?: number | null;
	/** A short tail of output for the agent_event detail (never the whole log). */
	note?: string;
}

export interface PostTaskResult {
	commit: CommitOutcome;
	test: TestOutcome;
	/** The terminal status the task landed in. */
	taskStatus: 'done' | 'failed';
	/** The follow-up work_item id, when one was enqueued. */
	followUpWorkId?: string;
	/** The completion agent_event id (so a caller can chain a join). */
	agentEventId: string;
}

export interface PostTaskOptions {
	/** Injectable command runner — defaults to {@link execFileRunner}. Tests pass a fake. */
	run?: CommandRunner;
	/**
	 * Enqueue a follow-up when the run succeeded but the test command FAILED (default
	 * behaviour). Off → never auto-plan a follow-up. The follow-up is a `work_item`
	 * (D-021), drained off the interactive path, never run inline here.
	 */
	followUpOnTestFail?: boolean;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/**
 * Split a project test command string into a program + argv array WITHOUT a shell. We
 * split on whitespace only — there is NO shell, so quoting/`&&`/`;`/`|`/redirections are
 * NOT honoured; each token becomes a literal argv element. This is deliberate: it means a
 * configured `test_command` can never smuggle a second command through a shell operator —
 * the operators are passed inert to the test program (which simply rejects them). D-008.
 */
export function splitCommand(cmd: string): { file: string; args: string[] } | null {
	const tokens = cmd.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	return { file: tokens[0], args: tokens.slice(1) };
}

// Remote-mutating / dangerous git verbs that this loop must NEVER issue (D-018). Used as
// a self-audit assertion: the args we build are fixed, but this keeps the invariant local.
const FORBIDDEN_GIT = ['push', 'remote'];
function assertLocalGit(args: readonly string[]): void {
	const verb = args[0];
	if (FORBIDDEN_GIT.includes(verb) || args.some((a) => a === '--force' || a === '-f')) {
		// A programming error (we only ever build local verbs) — fail loud, never spawn.
		throw new Error(`post-task git refused remote/force op (D-018): git ${args.join(' ')}`);
	}
}

// ── The loop ────────────────────────────────────────────────────────────────────────

/**
 * Run the post-task loop for a completed session. Commits via execFile arrays, runs the
 * project test command, optionally enqueues a follow-up, and records the task terminal
 * status + completion agent_event (+ follow-up task) in ONE transaction.
 *
 * The OS side-effects (commit, test) happen FIRST (they can't be transactional — they
 * touch the filesystem/process table). Their OUTCOMES are then committed atomically to
 * the DB so the recorded state is all-or-nothing. A failed agent run (runOk=false) skips
 * the commit (nothing to record) and marks the task failed.
 */
export async function runPostTask(
	db: Db,
	input: PostTaskInput,
	opts: PostTaskOptions = {}
): Promise<PostTaskResult> {
	const run = opts.run ?? execFileRunner;
	const followUpOnTestFail = opts.followUpOnTestFail ?? true;

	// ── 1. git commit (only when the run succeeded) — execFile ARRAYS, never a shell ──
	const commit: CommitOutcome = { attempted: false, ok: false };
	if (input.runOk) {
		commit.attempted = true;
		// Stage everything the agent changed, then commit. `commitMessage` is ONE argv
		// element (after -m) — execFile hands it to git verbatim; a `; rm -rf /` inside it
		// is an inert commit subject, not a second command (D-008).
		const addArgs = ['add', '-A'] as const;
		const commitArgs = ['commit', '-m', input.commitMessage] as const;
		assertLocalGit(addArgs);
		assertLocalGit(commitArgs);
		await run('git', addArgs, { cwd: input.cwd });
		const committed = await run('git', commitArgs, { cwd: input.cwd });
		if (committed.code === 0) {
			// Read back the short sha (also execFile arrays). rev-parse is read-only/local.
			const rev = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: input.cwd });
			commit.ok = true;
			commit.sha = rev.code === 0 ? rev.stdout.trim() : undefined;
		} else {
			// Non-zero on commit usually = "nothing to commit" — a no-op, not a hard failure.
			commit.ok = false;
			commit.note = (committed.stdout || committed.stderr).trim().slice(0, 200) || 'commit failed';
		}
	}

	// ── 2. project test command — execFile arrays (split, no shell) ──
	const test: TestOutcome = { attempted: false, ok: false };
	if (input.runOk && input.testCommand && input.testCommand.trim()) {
		const split = splitCommand(input.testCommand);
		if (split) {
			test.attempted = true;
			const res = await run(split.file, split.args, { cwd: input.cwd });
			test.code = res.code;
			test.ok = res.code === 0;
			test.note = (res.stderr || res.stdout).trim().slice(-200) || undefined;
		}
	}

	// ── 3. decide terminal status + whether to plan a follow-up ──
	const taskStatus: 'done' | 'failed' = input.runOk ? 'done' : 'failed';
	const wantFollowUp = input.runOk && followUpOnTestFail && test.attempted && !test.ok;

	// The follow-up work_item is enqueued OUTSIDE the status transaction (the work queue is
	// its own durable queue with its own dedup; D-021) so a follow-up dedup collision can't
	// roll back the legitimate status write. It is recorded in the result + the detail.
	let followUpWorkId: string | undefined;
	if (wantFollowUp) {
		const { id, enqueued } = await enqueue(db, {
			workType: 'follow_up',
			payload: {
				parentTaskId: input.taskId,
				projectId: input.projectId,
				reason: 'tests failed after task completion'
			},
			projectId: input.projectId,
			// Per-parent dedup: one open follow-up per task, not one per test run.
			dedupScope: input.taskId
		});
		if (enqueued) followUpWorkId = id;
	}

	// ── 4. record the outcome atomically: task status + completion agent_event ──
	// One transaction (DATA-MODEL §5): the status move and the analytics row are all-or-
	// nothing. The transition legality (in_progress/review → done|failed) is enforced by
	// the same guard setStatus uses, inlined here so it shares the transaction. The
	// completion detail carries the commit sha + test outcome — the how/why a reader needs.
	const detail = omitUndefined({
		ok: input.runOk,
		commit_sha: commit.sha,
		commit_note: commit.note,
		test_ran: test.attempted,
		test_ok: test.attempted ? test.ok : undefined,
		test_code: test.code ?? undefined,
		test_note: test.note,
		follow_up_work_item: followUpWorkId,
		reason: 'post-task loop'
	});

	const tid = link(input.taskId);
	const result = await db.query<unknown[]>(
		`BEGIN TRANSACTION;
		   LET $cur = (SELECT VALUE status FROM ONLY $tid);
		   IF $cur = NONE { THROW "task not found"; };
		   -- Only move a task that is still in a non-terminal, post-completion status.
		   -- A task already done/failed is left as-is (idempotent re-run), but we still
		   -- record the agent_event so analytics never loses a completion.
		   IF $cur IN ["in_progress","review"] {
		     UPDATE $tid SET status = $status, updated_at = time::now();
		   };
		   LET $ev = (CREATE agent_event CONTENT {
		     session: $sess,
		     project: $proj,
		     type: "completion",
		     detail: $detail
		   } RETURN AFTER);
		   RETURN $ev[0].id;
		 COMMIT TRANSACTION;`,
		{
			tid,
			status: taskStatus,
			sess: link(input.sessionId),
			proj: link(input.projectId),
			detail
		}
	);
	const agentEventId = String(result[result.length - 1]);

	return omitUndefined({
		commit,
		test,
		taskStatus,
		followUpWorkId,
		agentEventId
	}) as PostTaskResult;
}
