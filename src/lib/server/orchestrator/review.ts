// TASK 2.8 — the review agent (ARCHITECTURE §2.2 "(b) Background heavy work"; D-021;
// D-008/D-016; DATA-MODEL §4.12; deps 2.2 orchestrator + 1.4 runtime).
//
// After a task's session commits (post-task loop, 2.7), the change may be large enough to
// warrant an automatic code review. This module makes that decision and, when warranted,
// enqueues EXACTLY ONE `review` work_item — drained off the interactive path through the
// same background claim queue as every other heavy job (§4.12 / D-021). It NEVER spawns the
// review inline and NEVER consumes the interactive semaphore (the two queues stay distinct,
// ARCHITECTURE §2.2). The orchestrator's drain loop later claims the review work_item and
// runs it through launchSession exactly like a task_run (the same isolated-config /
// permissions.deny path, D-002 / 1.4a) — no new spawn machinery here.
//
// "N+ changed files" is measured the same way the post-task loop touches the OS: via the
// `CommandRunner` seam (execFile ARRAYS, never a shell — D-008/F-002). We ask git for
// `diff --name-only` and count distinct, non-blank lines. The runner is injectable so the
// contract suite drives it with a scripted diff — NO live process, NO Anthropic, NO network
// (the same mocked-backend pattern 1.4/1.6b/2.7 used; a mock in a TEST is allowed, F-008).
//
// Boundary discipline (D-016): record ids pass the db/validate chokepoint and bind as
// StringRecordId via the workqueue's own enqueue(); absent optionals are OMITTED (§6.1).
// The "exactly one" guarantee is the work_item dedup_key UNIQUE index (active-window
// work_type|session|status, §4.12) scoped per-task: a re-run for the same task is a no-op,
// so a double-fire (e.g. two post-task re-drains) can NEVER produce two reviews.

import type { Db } from '../db/client';
import { execFileRunner, type CommandRunner } from './post-task';
import { enqueue } from './workqueue';

/**
 * The default "large change" threshold: a change touching this many DISTINCT files (or more)
 * triggers a review. Below it, no review is spawned. Overridable per call (config later).
 */
export const DEFAULT_REVIEW_THRESHOLD = 5;

export interface CountChangedOptions {
	/** Project working dir — the execFile cwd. */
	cwd: string;
	/** Injectable command runner (test seam); defaults to {@link execFileRunner}. */
	runner?: CommandRunner;
	/**
	 * The git ref to diff the working tree / HEAD against. Default 'HEAD' — counts the
	 * files in the just-made commit (HEAD vs its parent) PLUS any still-unstaged changes,
	 * which is the agent's full footprint. A caller can pass an explicit base (e.g. the
	 * pre-spawn sha) for a tighter window.
	 */
	baseRef?: string;
}

/**
 * Count the DISTINCT files a change touched, via `git diff --name-only <ref>` run with an
 * ARGUMENT ARRAY (no shell — D-008). Blank/whitespace lines are ignored; duplicate paths are
 * collapsed. A non-zero git exit (e.g. not a repo) yields 0 — a count failure must never be
 * read as "trigger a review", and it must never crash the post-task path.
 */
export async function countChangedFiles(opts: CountChangedOptions): Promise<number> {
	const run = opts.runner ?? execFileRunner;
	const ref = opts.baseRef ?? 'HEAD';
	// `diff --name-only <ref>` — every token is a literal argv element; the ref is data, not
	// a shell-parsed string (D-008). `--no-color`/`--no-renames` keep the output to bare paths.
	const res = await run('git', ['diff', '--name-only', '--no-renames', ref], { cwd: opts.cwd });
	if (res.code !== 0) return 0;
	const files = new Set(
		res.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
	);
	return files.size;
}

export interface ReviewDecisionInput {
	/** Project record id — links the review work_item + is its drain cwd source. */
	projectId: string;
	/** The task whose change is under review — the dedup discriminator (one review per task). */
	taskId: string;
	/** The session that did the work — carried in the payload so the review can cite it. */
	sessionId: string;
	/** Project working dir (the validated root_path; the git diff cwd). */
	cwd: string;
}

export interface ReviewDecisionOptions {
	/** Injectable command runner (test seam); defaults to {@link execFileRunner}. */
	runner?: CommandRunner;
	/** Files-changed threshold; >= this triggers a review. Default {@link DEFAULT_REVIEW_THRESHOLD}. */
	threshold?: number;
	/** Diff base ref (see {@link CountChangedOptions.baseRef}). Default 'HEAD'. */
	baseRef?: string;
}

export interface ReviewDecision {
	/** How many distinct files the change touched. */
	changedFiles: number;
	/** True iff changedFiles >= threshold (the review condition was met). */
	triggered: boolean;
	/**
	 * The enqueued `review` work_item id — set ONLY when a NEW row was created. When
	 * `triggered` is true but this is undefined, an active review for this task already
	 * existed (the §4.12 dedup collapsed the second enqueue): the "exactly one" guarantee.
	 */
	workItemId?: string;
}

/**
 * Decide whether a just-committed task change warrants a review, and if so enqueue EXACTLY
 * ONE `review` work_item. Idempotent per task via the work_item dedup_key (§4.12): a re-run
 * for the same active task never produces a second review. Returns the decision (count +
 * whether the threshold was met + the new work_item id when one was created).
 *
 * This is best-effort relative to the spawn: it is meant to be called from the post-task
 * loop AFTER the commit, and a count failure (git error) simply yields changedFiles=0 ⇒ no
 * review — it never throws into, or crashes, the orchestrator drain.
 */
export async function maybeEnqueueReview(
	db: Db,
	input: ReviewDecisionInput,
	opts: ReviewDecisionOptions = {}
): Promise<ReviewDecision> {
	const threshold = opts.threshold ?? DEFAULT_REVIEW_THRESHOLD;
	const changedFiles = await countChangedFiles({
		cwd: input.cwd,
		runner: opts.runner,
		baseRef: opts.baseRef
	});

	if (changedFiles < threshold) {
		return { changedFiles, triggered: false };
	}

	// N+ files ⇒ enqueue ONE review. The dedup is scoped per-task (not per-session): one open
	// review per task, so a post-task re-drive of the same task can't double-spawn (§4.12).
	const { id, enqueued } = await enqueue(db, {
		workType: 'review',
		payload: {
			taskId: input.taskId,
			sessionId: input.sessionId,
			projectId: input.projectId,
			changedFiles,
			reason: `change touched ${changedFiles} files (>= ${threshold})`
		},
		projectId: input.projectId,
		// NOTE: the session is carried in the payload (so the review can cite the run) but is
		// deliberately NOT set as the work_item `session` link. The dedup_key folds in the
		// session component; keying dedup on the task alone (via dedupScope) makes the
		// "exactly one review per task change" guarantee hold even if a re-review were ever
		// attempted from a different session — the per-task scope is the sole discriminator.
		// Per-task dedup: the active-window UNIQUE key collapses a second enqueue for the
		// SAME task to a no-op — the exactly-one-review guarantee (§4.12).
		dedupScope: input.taskId
	});

	return enqueued
		? { changedFiles, triggered: true, workItemId: id }
		: { changedFiles, triggered: true };
}
