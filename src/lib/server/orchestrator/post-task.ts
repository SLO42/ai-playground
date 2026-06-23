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
import { testCommandFor } from '../scanner/detect';

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
	/**
	 * The status the task actually holds after the guarded terminal transition.
	 * On the happy/idempotent path this is the intended terminal status ('done'|'failed').
	 * On a MID-RUN divergence (the task was concurrently moved out of in_progress/review
	 * before the transition could land) it is the foreign status the task now holds — an
	 * HONEST report, never a false 'done'/'failed' (HB-H3).
	 */
	taskStatus: string;
	/** The follow-up work_item id, when one was enqueued (happy path only). */
	followUpWorkId?: string;
	/**
	 * The agent_event id. On the happy/idempotent path this is the `completion` event
	 * (reason 'post-task loop'). On a mid-run divergence it is the divergence `error`
	 * event (reason 'post-task-divergence-midrun') — there is NEVER an ok completion event
	 * under a non-terminal task (HB-H3).
	 */
	agentEventId: string;
	/**
	 * HB-H3 — true ⇔ the guarded terminal transition did NOT land because the task was
	 * concurrently moved out of a post-task-eligible status (in_progress/review) DURING the
	 * session run. When true: NO commit was performed, NO ok completion event was written,
	 * and a divergence `error` event was recorded instead. The concurrent mover now owns the
	 * task state; the divergence event makes the half-state observable to the operator/PM.
	 */
	divergent: boolean;
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

/**
 * HB-2 — resolve which test command (if any) the post-task loop should run, HONESTLY.
 *
 * The problem (HB-2): a project can carry a STORED `test_command` that is a bare/again-
 * unbuildable token which exits non-zero only because there is no real test target — ROUNDS
 * has `test_command='dotnet test'` + `build_tool='dotnet'` but NO test project, so `dotnet test`
 * exits 1. That must NEVER mark a succeeded task failed nor (with HB-1) trigger a false
 * "tests failed" follow-up. So we resolve through {@link testCommandFor}, which only returns a
 * command when a meaningful test target is positively detected under the project root.
 *
 * Precedence (the RESOLVER WINS when the stored command would false-fail):
 *   1. `build_tool` is one the resolver UNDERSTANDS (dotnet/npm/cargo/go):
 *        • resolver returns a command  → use it (a real target exists).
 *        • resolver returns null       → HONEST SKIP (no target). The stored `test_command`,
 *          even if set, is DISCARDED here — running a bare known-tool token with no target is
 *          exactly the false-fail HB-2 exists to prevent.
 *   2. `build_tool` absent/unknown to the resolver (resolver null for the "don't know" reason):
 *        • fall back to the STORED `test_command` (a hand-set custom command like
 *          `node scripts/check.js` is legitimate and the resolver has no opinion on it).
 *        • absent that → skip (nothing to run).
 *
 * Returns the command string to run, or null for an honest skip (do NOT attempt the test).
 * Pure (testCommandFor only reads the filesystem) so the orchestrator stays thin and this is
 * unit-testable in isolation.
 */
export function resolveTestCommand(input: {
	buildTool?: string | null;
	storedTestCommand?: string | null;
	cwd?: string | null;
}): string | null {
	const stored = input.storedTestCommand?.trim() || null;
	const tool = input.buildTool?.trim() || null;
	const cwd = input.cwd?.trim() || null;

	// Case 1: the build tool is one the resolver understands → the resolver is authoritative.
	if (tool && isResolvableTool(tool)) {
		return testCommandFor(tool, cwd); // command (real target) OR null (honest skip)
	}

	// Case 2: no build tool, or a tool the resolver has no opinion on → honor a hand-set command.
	return stored;
}

/** True when {@link testCommandFor} has a positive/negative opinion on this tool (vs "don't know"). */
function isResolvableTool(tool: string): boolean {
	return ['dotnet', 'npm', 'cargo', 'go'].includes(tool.trim().toLowerCase());
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
 * Run the post-task loop for a completed session.
 *
 * ORDERING (HB-H3 — close the mid-run divergence window): the GUARDED TERMINAL TRANSITION
 * is performed FIRST, transactionally, and reports back whether it actually LANDED. Only
 * then — and ONLY when it landed — do we git-commit, run the test command, enqueue a
 * follow-up, and write the ok `completion` event. This makes the divergence the prior code
 * left silent UNREACHABLE:
 *
 *   Before: the commit + an ok `completion` event fired UNCONDITIONALLY, while the terminal
 *   task UPDATE was guarded by `IF $cur IN ["in_progress","review"]`. So if an operator/PM
 *   moved the task out of in_progress/review mid-run, the commit + ok event STILL fired
 *   while the UPDATE silently skipped → {committed work + done work_item + ok event +
 *   non-terminal task} the PM never sees. HB-H2 closed this only at CLAIM time; this closes
 *   the residual mid-run window.
 *
 * The guarded transition (§ step 1) lands when the task is in a post-task-eligible status
 * (in_progress/review) OR is ALREADY in the intended terminal status (an idempotent re-run
 * after a partial prior run — interrupt contract). When it does NOT land (the task was
 * concurrently moved to a foreign status — blocked/withdrawn/another-terminal), we:
 *   • do NOT commit (the concurrent mover now owns the task state — F-007 NUANCE),
 *   • do NOT write an ok completion event (NEVER a false ok under a non-terminal task),
 *   • write a divergence `error` agent_event (reason 'post-task-divergence-midrun', carrying
 *     taskId) so the half-state is OBSERVABLE for the operator/PM to reconcile,
 *   • return `divergent: true` with the HONEST current status — the caller marks the
 *     work_item failed (mirrors the HB-H2 claim-time gate).
 *
 * The OS side-effects (commit, test) can't be transactional (they touch the filesystem/
 * process table); their OUTCOMES are recorded atomically with the completion event in a
 * SECOND transaction. A failed agent run (runOk=false) skips the commit (nothing to record)
 * and lands the task `failed` — still a legal terminal transition that must land.
 */
export async function runPostTask(
	db: Db,
	input: PostTaskInput,
	opts: PostTaskOptions = {}
): Promise<PostTaskResult> {
	const run = opts.run ?? execFileRunner;
	const followUpOnTestFail = opts.followUpOnTestFail ?? true;

	// The terminal status the task SHOULD land in (decided by the run outcome, NOT the test
	// result — tests only trigger a follow-up, they never change the terminal status).
	const taskStatus: 'done' | 'failed' = input.runOk ? 'done' : 'failed';

	// ── 1. GUARDED TERMINAL TRANSITION FIRST — does it land? ──────────────────────────────
	// One transaction performs the SAME guarded UPDATE the prior code did, and RETURNS both
	// whether the transition landed and the task's actual status afterwards. `landed` is true
	// when the guard fired (in_progress/review → terminal) OR the task is already in the
	// intended terminal status (idempotent re-run absorbs a partial prior run). It is FALSE
	// when the task is in any other (foreign/non-eligible) status — the mid-run divergence.
	const tid = link(input.taskId);
	const transition = await db.query<[Array<{ landed: boolean; status: string }>]>(
		`BEGIN TRANSACTION;
		   LET $cur = (SELECT VALUE status FROM ONLY $tid);
		   IF $cur = NONE { THROW "task not found"; };
		   IF $cur IN ["in_progress","review"] {
		     UPDATE $tid SET status = $status, updated_at = time::now();
		   };
		   LET $after = (SELECT VALUE status FROM ONLY $tid);
		   -- landed ⇔ the task now holds the intended terminal status. Covers both the legal
		   -- transition just applied AND an idempotent re-run where it was already terminal.
		   RETURN [{ landed: $after = $status, status: $after }];
		 COMMIT TRANSACTION;`,
		{ tid, status: taskStatus }
	);
	const trow = transition[transition.length - 1]?.[0];
	const landed = trow?.landed === true;
	const actualStatus = trow?.status ?? taskStatus;

	// ── DIVERGENCE PATH — the transition did NOT land (task concurrently moved mid-run) ──
	if (!landed) {
		// NO commit, NO test, NO follow-up, NO ok completion event. Record an observable
		// divergence `error` event instead (mirror HB-H2: name what triggered it, what caught
		// it, what a reader sees). `error` is the schema-accepted "the failure" agent_event
		// type (`divergence` is not a valid type); the reason field distinguishes it.
		const divDetail = omitUndefined({
			by: 'post-task',
			reason: 'post-task-divergence-midrun',
			error:
				`post-task terminal transition did NOT land: task ${input.taskId} was moved out of a ` +
				`post-task-eligible status (in_progress/review) before the transition could land ` +
				`(now '${actualStatus}') — a concurrent operator/PM status move during the session run. ` +
				`NO commit performed; NO ok completion event written.`,
			taskId: input.taskId,
			intended_status: taskStatus,
			actual_status: actualStatus
		});
		const divResult = await db.query<unknown[]>(
			`CREATE agent_event CONTENT {
			   session: $sess, project: $proj, type: "error", detail: $detail
			 } RETURN VALUE id;`,
			{ sess: link(input.sessionId), proj: link(input.projectId), detail: divDetail }
		);
		const divEventId = String(
			Array.isArray(divResult[0]) ? (divResult[0] as unknown[])[0] : divResult[0]
		);
		return {
			commit: { attempted: false, ok: false, note: 'post-task-divergence-midrun: transition not landed' },
			test: { attempted: false, ok: false, note: 'skipped (divergence)' },
			taskStatus: actualStatus,
			agentEventId: divEventId,
			divergent: true
		};
	}

	// ── 2. git commit (only when the run succeeded) — execFile ARRAYS, never a shell ──
	// Reached ONLY after the terminal transition LANDED, so a commit can never be stranded
	// under a non-terminal task. A failed run (runOk=false) commits nothing.
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

	// ── 3. project test command — execFile arrays (split, no shell) ──
	// HB-2: `input.testCommand` is the ALREADY-RESOLVED command (the caller runs it through
	// resolveTestCommand). When it is absent the test is an HONEST SKIP — attempted stays
	// false, recorded as 'no test target', never a fake pass and never a false fail.
	const test: TestOutcome = { attempted: false, ok: false };
	if (input.runOk) {
		const cmd = input.testCommand?.trim();
		const split = cmd ? splitCommand(cmd) : null;
		if (split) {
			test.attempted = true;
			const res = await run(split.file, split.args, { cwd: input.cwd });
			test.code = res.code;
			test.ok = res.code === 0;
			test.note = (res.stderr || res.stdout).trim().slice(-200) || undefined;
		} else {
			// No resolved test command (no real test target / unbuildable token) → honest skip.
			test.note = 'no test target';
		}
	}

	// ── 4. plan a follow-up (off the interactive path) ──
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

	// ── 5. record the ok completion agent_event (re-checking the task is STILL terminal) ──
	// The terminal transition ALREADY landed (§ step 1) — this records the commit sha + test
	// outcome an analytics reader needs. We re-assert the task is STILL in the intended
	// terminal status inside the SAME transaction (belt-and-suspenders against a status move
	// in the narrow window between step 1 and here). The completion event is created ONLY when
	// the re-check holds — `CREATE … WHERE` via an IF guard — so an ok completion can NEVER be
	// written under a non-terminal task. `$ev` is an empty array iff the guard failed.
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

	const result = await db.query<[Array<{ id?: unknown; status: string }>]>(
		`BEGIN TRANSACTION;
		   LET $cur = (SELECT VALUE status FROM ONLY $tid);
		   LET $ev = IF $cur = $status {
		     (CREATE agent_event CONTENT {
		       session: $sess,
		       project: $proj,
		       type: "completion",
		       detail: $detail
		     } RETURN AFTER)[0].id
		   } ELSE { NONE };
		   RETURN [{ id: $ev, status: $cur }];
		 COMMIT TRANSACTION;`,
		{
			tid,
			status: taskStatus,
			sess: link(input.sessionId),
			proj: link(input.projectId),
			detail
		}
	);
	const evRow = result[result.length - 1]?.[0];
	const completionId = evRow?.id ? String(evRow.id) : undefined;

	if (!completionId) {
		// The narrow-window race: the task was moved out of its terminal status between step 1
		// and now — AFTER the commit already happened. The work is legitimately committed, but
		// an ok completion under the now-foreign status would be the very lie this wave closes.
		// Record an OBSERVABLE divergence instead (commit retained, named, visible to the PM).
		const movedStatus = evRow?.status ?? 'unknown';
		const divDetail = omitUndefined({
			by: 'post-task',
			reason: 'post-task-divergence-midrun',
			error:
				`post-task terminal status changed AFTER the commit but BEFORE the completion event: ` +
				`task ${input.taskId} is now '${movedStatus}' (intended '${taskStatus}'). Work WAS committed ` +
				`(${commit.sha ?? 'no sha'}); NO ok completion event written — the divergence is recorded instead.`,
			taskId: input.taskId,
			intended_status: taskStatus,
			actual_status: movedStatus,
			commit_sha: commit.sha
		});
		const divResult = await db.query<unknown[]>(
			`CREATE agent_event CONTENT {
			   session: $sess, project: $proj, type: "error", detail: $detail
			 } RETURN VALUE id;`,
			{ sess: link(input.sessionId), proj: link(input.projectId), detail: divDetail }
		);
		const divEventId = String(
			Array.isArray(divResult[0]) ? (divResult[0] as unknown[])[0] : divResult[0]
		);
		return omitUndefined({
			commit,
			test,
			taskStatus: movedStatus,
			followUpWorkId,
			agentEventId: divEventId,
			divergent: true
		}) as PostTaskResult;
	}

	return omitUndefined({
		commit,
		test,
		taskStatus,
		followUpWorkId,
		agentEventId: completionId,
		divergent: false
	}) as PostTaskResult;
}
