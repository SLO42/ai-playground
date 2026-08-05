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

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { enqueue } from './workqueue';
import { testCommandFor } from '../scanner/detect';
import { execFileRunner, splitCommand, type CommandRunner } from './command-runner';
import { runPreCommitGate, type GateOutcome, type GateStepName } from './pre-commit-gate';
import { maybeEnqueueReview, type ReviewDecision } from './review';

// ── The command runner seam (so tests inject a fake — NO live process, the same
//    mocked-backend pattern 1.4/1.6b used; F-008 holds: a mock in a TEST is allowed).
//    The definitions MOVED to ./command-runner (PCG-1 broke the post-task ⇄ gate/review
//    import cycle); they are re-exported here so every existing import site is unchanged. ──
export {
	execFileRunner,
	splitCommand,
	type CommandRunner,
	type CommandResult
} from './command-runner';

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
	/**
	 * PCG-1 — `project.build_tool` (a bare detected tool like 'npm'/'dotnet', or an operator-edited
	 * real command). Used ONLY by the pre-commit gate, to resolve the build/lint/typecheck steps.
	 * Absent ⇒ the gate has no build step (an honest per-step skip, not a failure).
	 */
	buildTool?: string | null;
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
	/**
	 * PCG-1 — the pre-commit gate verdict, present ONLY when the gate was enabled AND the run
	 * succeeded (a failed run has nothing to gate). `status:'failed'` is the caller's signal to
	 * REFUSE THE MERGE: the work is committed on the session branch but must not land on the
	 * project branch. Absent ⇒ the gate did not run (byte-identical to the pre-PCG-1 behaviour).
	 */
	gate?: GateOutcome;
	/**
	 * PCG-1 — the review decision, present ONLY when review wiring was enabled AND the gate did
	 * not fail AND a commit actually landed. `triggered:true` means the change was large enough to
	 * warrant a code review and (unless it deduped to an existing one) a `review` work_item now
	 * exists. The caller decides whether that HOLDS the merge — see the orchestrator's
	 * `holdMergeBack` policy.
	 */
	review?: ReviewDecision;
	/**
	 * PCG-1 — set when the review DECISION itself could not be made (a git/DB fault inside
	 * `maybeEnqueueReview`). Best-effort by construction: the failure is named here and on the
	 * completion event, and it never changes the commit or the terminal status.
	 */
	reviewError?: string;
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
	/**
	 * PCG-1 — THE PRE-COMMIT GATE. When enabled, the project's build/lint/typecheck/test run
	 * BEFORE the terminal transition, and a RED gate lands the task `failed` and tells the caller
	 * to withhold the merge (see pre-commit-gate.ts for the full reasoning and the F-007 argument
	 * for committing-but-not-merging). Absent/false ⇒ the gate never runs and this module behaves
	 * exactly as it did before (F-053: an additive branch is opt-in and falls through byte-identical).
	 */
	gate?: {
		enabled: boolean;
		/** Injectable runner for the GATE's commands (test seam). Defaults to `opts.run`/execFile. */
		runner?: CommandRunner;
		/** Narrow the gate to these steps. Default: all four. */
		steps?: readonly GateStepName[];
	};
	/**
	 * PCG-1 — wire the (previously caller-less) review capability. When enabled, a change that
	 * passed the gate and produced a real commit is measured, and a large one enqueues EXACTLY ONE
	 * `review` work_item via the EXISTING {@link maybeEnqueueReview} (F-055 — no second path).
	 * Absent/false ⇒ no review is ever enqueued (byte-identical to the pre-PCG-1 behaviour).
	 */
	review?: {
		enabled: boolean;
		/** Files-changed threshold; >= this triggers a review. Default DEFAULT_REVIEW_THRESHOLD (5). */
		threshold?: number;
		/** Injectable runner for the review's `git diff` (test seam). Defaults to `opts.run`/execFile. */
		runner?: CommandRunner;
	};
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

/**
 * Git's canonical EMPTY TREE object id — the well-known hash of the empty tree, present in every
 * git repository without being written by anyone. `git diff --name-only <empty-tree>` against a
 * repo whose first commit just landed lists that commit's files, which is what lets the review
 * measure a ROOT commit (unborn HEAD before the commit, so there is no parent to diff against).
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
 *
 * ORDERING (PCG-1 — the pre-commit gate). When `opts.gate.enabled`, step 0 runs the project's
 * build/lint/typecheck/test BEFORE the terminal transition, so the transition itself is decided
 * WITH the verdict in hand. A RED gate:
 *   • lands the task `failed` (not `done`) — the terminal transition is honest;
 *   • STILL COMMITS the agent's work to the session branch (F-007 — refusing to commit would let
 *     merge-back's worktree teardown DESTROY the very work an operator needs to inspect). The
 *     commit is preservation; the MERGE is the assertion, and the caller withholds the merge;
 *   • carries the full per-step gate record onto the `completion` event and returns it to the
 *     caller, which records a named `pre_commit_gate` drain fault (F-008 — never a silent drop).
 * The legacy post-commit test step is SUBSUMED by the gate's own `test` step when the gate ran, so
 * a project's test suite is never executed twice. With the gate off, everything below is
 * byte-identical to the pre-PCG-1 behaviour.
 */
export async function runPostTask(
	db: Db,
	input: PostTaskInput,
	opts: PostTaskOptions = {}
): Promise<PostTaskResult> {
	const run = opts.run ?? execFileRunner;
	const followUpOnTestFail = opts.followUpOnTestFail ?? true;

	// ── 0. THE PRE-COMMIT GATE (PCG-1) — runs BEFORE the terminal transition and the commit. ──
	// Only for a run that actually succeeded: a failed agent run has no work to verify, and gating
	// it would just append a second, redundant red. runPreCommitGate NEVER throws (every failure is
	// a named step detail), so this cannot crash the drain (F-014/F-048).
	let gate: GateOutcome | undefined;
	if (opts.gate?.enabled && input.runOk) {
		gate = await runPreCommitGate(
			{ cwd: input.cwd, buildTool: input.buildTool, testCommand: input.testCommand },
			{ run: opts.gate.runner ?? run, steps: opts.gate.steps }
		);
	}
	// A gate that RAN and came back red is the one signal that overrides a successful run. 'skipped'
	// (nothing detectable to verify) is honestly recorded but is NOT a failure — failing a project
	// for having no test suite would be a false RED that wedges every non-JS/.NET project (HB-2).
	const gateFailed = gate?.status === 'failed';

	// The terminal status the task SHOULD land in. Decided by the run outcome AND — new in PCG-1 —
	// the pre-commit gate: a run whose work does not build/lint/typecheck/test is NOT `done`.
	const taskStatus: 'done' | 'failed' = input.runOk && !gateFailed ? 'done' : 'failed';

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
			// DRAIN LEDGER (COMPLETION-LEDGER Wave A) — tag this pre-existing divergence event into the
			// drain ledger so /atelier/queue surfaces it alongside every other named drain fault. TAGGED,
			// not duplicated: no second writer (F-055). `reason` is left byte-identical — it is the
			// stable machine discriminator existing queries and tests match on.
			kind: 'drain_fault',
			stage: 'post_task_divergence',
			absorbed: false,
			by: 'post-task',
			reason: 'post-task-divergence-midrun',
			error:
				`post-task terminal transition did NOT land: task ${input.taskId} was moved out of a ` +
				`post-task-eligible status (in_progress/review) before the transition could land ` +
				`(now '${actualStatus}') — a concurrent operator/PM status move during the session run. ` +
				`NO commit performed; NO ok completion event written.`,
			taskId: input.taskId,
			intended_status: taskStatus,
			actual_status: actualStatus,
			// PCG-1: the gate ran BEFORE the transition, so on a divergence we already hold a real
			// verdict. Carry it — an operator reconciling this half-state needs to know whether the
			// abandoned work was even green (omitted when the gate did not run).
			gate: gate ? gateDetail(gate) : undefined
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
			commit: { attempted: false, ok: false, note: 'post-task-divergence-midrun: transition not landed' },
			test: { attempted: false, ok: false, note: 'skipped (divergence)' },
			taskStatus: actualStatus,
			agentEventId: divEventId,
			divergent: true,
			gate
		}) as PostTaskResult;
	}

	// ── 2. git commit (only when the run succeeded) — execFile ARRAYS, never a shell ──
	// Reached ONLY after the terminal transition LANDED, so a commit can never be stranded
	// under a non-terminal task. A failed run (runOk=false) commits nothing.
	//
	// PCG-1 — A RED GATE STILL COMMITS. This is the deliberate choice, not an oversight: the
	// agent's edits live in a per-session worktree that merge-back TEARS DOWN, so "refuse to
	// commit" would DESTROY the failing work (F-007) — the opposite of preserving it for
	// inspection. We commit to the session BRANCH (invisible to the project branch) and the
	// CALLER refuses to merge. The subject is marked so `git log` on that branch says why it
	// is sitting there unmerged.
	const commit: CommitOutcome = { attempted: false, ok: false };
	/**
	 * The sha HEAD pointed at BEFORE this loop committed — the review's diff base (step 4b).
	 *
	 * THE DEFECT THIS CLOSES (the DoD-review's second finding, reproduced in a scratch repo): step 4b
	 * measured the change with `maybeEnqueueReview`'s DEFAULT ref, 'HEAD'. But `git diff HEAD` is
	 * "working tree vs HEAD", and step 2 has just `git add -A`-ed and committed everything — the tree
	 * is CLEAN by construction, so the diff printed NOTHING. Six new files measured as 0 changed
	 * files; `triggered` was therefore always false, no `review` work_item could ever be enqueued in
	 * production, and the orchestrator's `reviewHeld` / 'review-held' exit state was unreachable
	 * code. The whole review half of the feature was a no-op that the scripted-runner tests could
	 * not see, because their fake `git diff` returned a fabricated file list for ANY ref.
	 *
	 * Read BEFORE the commit (that is the only moment the base still exists as HEAD) and via the
	 * same argv-array runner seam (D-008). `rev-parse --verify HEAD` is read-only and local (D-018).
	 * A non-zero exit means "no commits yet" — an UNBORN HEAD, i.e. this is the repo's root commit —
	 * which is not an error and must not silently suppress the review of a whole initial import; see
	 * EMPTY_TREE below.
	 */
	let preCommitSha: string | null = null;
	if (input.runOk) {
		commit.attempted = true;
		const revArgs = ['rev-parse', '--verify', 'HEAD'] as const;
		assertLocalGit(revArgs);
		const pre = await run('git', revArgs, { cwd: input.cwd });
		preCommitSha = pre.code === 0 ? pre.stdout.trim() || null : null;
		// Stage everything the agent changed, then commit. `commitMessage` is ONE argv
		// element (after -m) — execFile hands it to git verbatim; a `; rm -rf /` inside it
		// is an inert commit subject, not a second command (D-008).
		const message = gateFailed
			? `${input.commitMessage} [pre-commit gate FAILED at ${gate?.failedAt} — preserved, NOT merged]`
			: input.commitMessage;
		const addArgs = ['add', '-A'] as const;
		const commitArgs = ['commit', '-m', message] as const;
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
	//
	// PCG-1: when the gate ran, IT already executed this exact command as its `test` step — so we
	// PROJECT the gate's step onto the legacy TestOutcome instead of spawning the suite a second
	// time. Same field semantics, one execution.
	const test: TestOutcome = { attempted: false, ok: false };
	if (gate) {
		const step = gate.steps.find((s) => s.name === 'test');
		test.attempted = step?.ran === true;
		test.ok = step?.ok === true;
		if (step?.code !== undefined) test.code = step.code;
		test.note = step ? step.detail.slice(-200) : 'test step not part of the configured gate';
	} else if (input.runOk) {
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

	// ── 4b. THE REVIEW DECISION (PCG-1) — the production caller `maybeEnqueueReview` never had ──
	// It sits HERE, after the commit and BEFORE the caller's merge-back, because that is the only
	// point where both facts it needs exist: the change is committed (so `git diff HEAD` measures
	// the real footprint) and nothing has merged yet (so the decision can still hold the merge).
	//
	// PRECONDITIONS, deliberately narrow:
	//   • the gate did NOT fail — a red change is already being withheld; asking for a review of it
	//     would enqueue a second, redundant signal for work nobody should be reading yet;
	//   • a commit actually landed (`commit.ok`) — a no-op commit has nothing to review.
	// BEST-EFFORT (F-014/F-048): a git or DB fault here is NAMED on the result + the completion
	// event and changes NOTHING about the commit or the terminal status. `enqueue` is idempotent
	// per task via the work_item dedup key, so a re-run after a mid-gate crash collapses to a
	// no-op rather than producing a second review (interrupt contract).
	let review: ReviewDecision | undefined;
	let reviewError: string | undefined;
	if (opts.review?.enabled && input.runOk && !gateFailed && commit.ok) {
		try {
			review = await maybeEnqueueReview(
				db,
				{
					projectId: input.projectId,
					taskId: input.taskId,
					sessionId: input.sessionId,
					cwd: input.cwd
				},
				{
					runner: opts.review.runner ?? run,
					threshold: opts.review.threshold,
					// THE FIX: diff against the sha HEAD held BEFORE step 2's commit, so the count is
					// the footprint that just landed. Never 'HEAD' — post-commit that is an empty diff
					// (see `preCommitSha`). On an unborn HEAD (root commit) we diff against git's
					// EMPTY TREE, which enumerates every file in the first commit rather than silently
					// measuring 0 — an initial import is exactly the change most worth reviewing.
					baseRef: preCommitSha ?? EMPTY_TREE
				}
			);
		} catch (err) {
			reviewError = `review decision failed: ${(err as Error).message}`;
		}
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
		// PCG-1 — ANALYTICS IS FIRST-CLASS (CLAUDE.md §3). Not a flat "gate: false": the whole
		// ordered record, every step with its resolved command, exit code and output tail, plus
		// the consequence. An operator asking "why did task X's work not land" must be able to
		// answer it from this row alone, without reading a log file that may not exist.
		gate: gate ? gateDetail(gate) : undefined,
		gate_failed: gate ? gateFailed : undefined,
		gate_consequence: gate
			? gateFailed
				? 'task marked FAILED; work committed to the session branch and PRESERVED, NOT merged into the project branch'
				: gate.status === 'skipped'
					? gate.unrunnable
						? 'the project declares real checks but this working dir could not RUN them — the change is UNVERIFIED but not blocked (an environment skip, not a verdict on the change)'
						: 'no build/test target detected — the change is UNVERIFIED but not blocked (honest skip)'
					: gate.unrunnable
						? // PARTIALLY verified: some checks ran green, but at least one resolved to a real
							// command this working dir could not run. "Gate green" alone would overstate what
							// was actually checked — the steps array says which, and this says that.
							'gate green on the checks this working dir COULD run — at least one other declared ' +
							'check could not be run here, so the work is eligible to merge but is only PARTLY ' +
							'verified'
						: 'gate green — the work is eligible to merge'
			: undefined,
		// The review decision (or the honest reason there is none).
		review_changed_files: review?.changedFiles,
		review_triggered: review?.triggered,
		review_work_item: review?.workItemId,
		// F-008 — `review_changed_files: 0` means TWO opposite things unless this says which: the
		// change really touched nothing, or git could not be asked (not a repo / bad base ref /
		// unspawnable git — the seam reports a spawn failure as exit 1 with no output). An
		// unmeasured change requests no review, and since the merge hold only fires on a TRIGGERED
		// review, it takes the hold down with it — a refusal that must not be invisible.
		review_measured: review?.measured,
		// One field for "why there is no review decision to read": a thrown fault (reviewError) or a
		// git that could not measure (measureNote). Both are named; neither is ever silence.
		review_note: reviewError ?? review?.measureNote,
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
			// DRAIN LEDGER — same tagging as the pre-commit divergence above (one writer, F-055).
			kind: 'drain_fault',
			stage: 'post_task_divergence',
			absorbed: false,
			by: 'post-task',
			reason: 'post-task-divergence-midrun',
			error:
				`post-task terminal status changed AFTER the commit but BEFORE the completion event: ` +
				`task ${input.taskId} is now '${movedStatus}' (intended '${taskStatus}'). Work WAS committed ` +
				`(${commit.sha ?? 'no sha'}); NO ok completion event written — the divergence is recorded instead.`,
			taskId: input.taskId,
			intended_status: taskStatus,
			actual_status: movedStatus,
			commit_sha: commit.sha,
			gate: gate ? gateDetail(gate) : undefined
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
			divergent: true,
			gate,
			review,
			reviewError
		}) as PostTaskResult;
	}

	return omitUndefined({
		commit,
		test,
		taskStatus,
		followUpWorkId,
		agentEventId: completionId,
		divergent: false,
		gate,
		review,
		reviewError
	}) as PostTaskResult;
}

/**
 * PCG-1 — flatten a {@link GateOutcome} into a PLAIN, DB-safe detail object for the agent_event.
 *
 * POJOs only: every value is a string/number/boolean/array-of-those. There is no Date, no SDK
 * datetime and no class instance anywhere in a gate outcome, so nothing here can produce the
 * devalue-500 class (F-013) when a `load` reads the event back. Steps keep their ORDER (an
 * operator reads the gate top-to-bottom) and every step is included — including the ones that did
 * not run, with the reason — because a truncated record is how a skipped check becomes invisible.
 */
function gateDetail(gate: GateOutcome): Record<string, unknown> {
	return {
		status: gate.status,
		verified: gate.verified,
		errored: gate.errored,
		// WHY a skip was a skip — "no target at all" vs "this working dir could not run the project's
		// real checks". The merge-hold policy keys on this distinction, so the row an operator reads
		// must carry it too (CLAUDE.md §3 — never a flat event).
		unrunnable: gate.unrunnable,
		failed_at: gate.failedAt ?? null,
		summary: gate.summary,
		steps: gate.steps.map((s) => ({
			name: s.name,
			command: s.command,
			ran: s.ran,
			ok: s.ok,
			// `code` is option<number> upstream; NULL (not undefined) so the shape is stable per row.
			code: s.code ?? null,
			detail: s.detail
		}))
	};
}
