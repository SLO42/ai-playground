// TASK 2.8 — the review agent (ARCHITECTURE §2.2 "(b) Background heavy work"; D-021;
// D-008/D-016; DATA-MODEL §4.12; deps 2.2 orchestrator + 1.4 runtime).
//
// After a task's session commits (post-task loop, 2.7), the change may be large enough to
// warrant an automatic code review. This module makes that decision and, when warranted,
// enqueues EXACTLY ONE `review` work_item — drained off the interactive path through the
// same background claim queue as every other heavy job (§4.12 / D-021). It NEVER spawns the
// review inline and NEVER consumes the interactive semaphore (the two queues stay distinct,
// ARCHITECTURE §2.2).
//
// PCG-1 CORRECTION (this module had ZERO production callers until PCG-1 wired it, and this
// paragraph is part of the reason why): the header used to say the drain "runs it through
// launchSession exactly like a task_run". That would have been a DEFECT the moment a real caller
// existed — a review item's `payload.taskId` is the REVIEWED task, so the task-spawn path would
// have re-spawned the very task under review, burning a session and redoing the work. The drain
// now intercepts `review` in its own fork (orchestrator.ts #runItem), which escalates the request
// to the operator and spawns NOTHING. Wiring an automated reviewer is a separate, operator-gated
// decision (it arms a new spawn class) — see boot.ts's named deferral.
//
// "N+ changed files" is measured the same way the post-task loop touches the OS: via the
// `CommandRunner` seam (execFile ARRAYS, never a shell — D-008/F-002). We ask git for
// `diff --name-only` and count distinct, non-blank lines. The runner is injectable so the
// contract suite drives it with a scripted diff — NO live process, NO Anthropic, NO network
// (the same mocked-backend pattern 1.4/1.6b/2.7 used; a mock in a TEST is allowed, F-008).
//
// Boundary discipline (D-016): record ids pass the db/validate chokepoint and bind as
// StringRecordId via the workqueue's own enqueue(); absent optionals are OMITTED (§6.1).
// The "exactly one" guarantee is the work_item DETERMINISTIC primary id (workqueue.activeWorkItemId
// over work_type|session|dedup_scope; F-048 fix + F-026) scoped per-task via dedup_scope: a re-run
// for the same task collides atomically on the id and is a no-op, so a double-fire (e.g. two
// post-task re-drains) can NEVER produce two reviews — even across the pending→processing transition.

import type { Db } from '../db/client';
// D-026 — git's own output is UNTRUSTED text that gets PERSISTED (agent_event.detail.review_note)
// and rendered to the operator. It goes through the codebase's existing screening chokepoint before
// it can reach a detail string — never a second, hand-rolled redactor (F-055).
import { screen } from '../memory/screen';
// PCG-1: the runner seam now lives in ./command-runner (extracted from post-task.ts). Importing it
// from there — not from post-task.ts — is what keeps post-task → review a one-way edge now that
// post-task calls maybeEnqueueReview.
import { execFileRunner, type CommandRunner } from './command-runner';
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
	 * The git ref to diff the WORKING TREE against. Default 'HEAD' — i.e. the UNCOMMITTED
	 * footprint only.
	 *
	 * READ THIS BEFORE CALLING AFTER A COMMIT. The default does NOT mean "the files in the
	 * just-made commit": `git diff <ref>` compares the working tree to `<ref>`, so once the
	 * caller has committed, `HEAD` is the tree itself and the diff is EMPTY. (The previous
	 * wording claimed "HEAD vs its parent PLUS unstaged changes"; it was wrong, and the
	 * post-task caller inherited the default and measured 0 changed files on every real
	 * commit — the review never fired.) A caller measuring a change it has ALREADY committed
	 * MUST pass an explicit base: the pre-commit sha (see post-task.ts's `preCommitSha`), or
	 * git's empty-tree id for a root commit.
	 */
	baseRef?: string;
}

/**
 * The honest result of measuring a change's footprint — the count AND whether git could answer.
 *
 * THE DEFECT THIS SEPARATES (the follow-on review's finding, and the same class as the two the
 * DoD-review caught): `countChangedFiles` returned 0 both when the change genuinely touched no
 * files and when git could not be asked at all (the cwd is not a repo, the base ref does not
 * resolve, git itself is unspawnable — `execFileRunner` reports a spawn ENOENT as exit 1 with
 * empty output). Those are opposite facts with the same recorded value: `review_changed_files: 0`
 * on the completion event, `triggered:false`, no review, and — because the merge hold only ever
 * fires on a TRIGGERED review — no hold either. A measurement fault therefore disabled the whole
 * review half SILENTLY, and the persisted row said "this change was small" about a change nobody
 * had measured. `measured` is the discriminator, and `detail` names the fault so an operator
 * reading the event can tell a small change from an unmeasured one (F-008).
 */
export interface ChangedFilesMeasurement {
	/** Distinct files touched. 0 when `measured` is false — a floor, NOT a finding. */
	changedFiles: number;
	/** True ⇔ git actually answered. False ⇒ `changedFiles` is unknown, not zero. */
	measured: boolean;
	/** Named reason git could not answer (screened, D-026). '' when `measured` is true. */
	detail: string;
}

/**
 * Measure the DISTINCT files a change touched, via `git diff --name-only <ref>` run with an
 * ARGUMENT ARRAY (no shell — D-008). Blank/whitespace lines are ignored; duplicate paths are
 * collapsed. A non-zero git exit does NOT throw and does NOT trigger a review — but it is
 * reported as `measured:false` with a named reason rather than laundered into a count of 0.
 * Never throws on a non-zero exit; a runner that REJECTS still propagates to the caller's
 * best-effort catch (post-task names it as `reviewError`).
 */
export async function measureChangedFiles(
	opts: CountChangedOptions
): Promise<ChangedFilesMeasurement> {
	const run = opts.runner ?? execFileRunner;
	const ref = opts.baseRef ?? 'HEAD';
	// `diff --name-only <ref>` — every token is a literal argv element; the ref is data, not
	// a shell-parsed string (D-008). `--no-color`/`--no-renames` keep the output to bare paths.
	const res = await run('git', ['diff', '--name-only', '--no-renames', ref], { cwd: opts.cwd });
	if (res.code !== 0) {
		// D-026 — git's stderr is untrusted text that lands on a persisted agent_event and is
		// rendered to the operator; it routinely carries the absolute worktree path (home-path PII).
		// Through the EXISTING chokepoint, which fails closed, never a second redactor (F-055).
		const raw = (res.stderr || res.stdout).replace(/\s+/g, ' ').trim();
		const scanned = screen(raw);
		const why =
			scanned.status === 'quarantined'
				? '(git output withheld — it contained a secret)'
				: scanned.text.slice(0, 200);
		return {
			changedFiles: 0,
			measured: false,
			detail:
				`git diff --name-only ${ref} exited ${res.code} — the change's footprint could NOT be ` +
				`measured, so no review was requested (this describes the repo/environment, not the ` +
				`change)${why ? `: ${why}` : ''}`
		};
	}
	const files = new Set(
		res.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0)
	);
	return { changedFiles: files.size, measured: true, detail: '' };
}

/**
 * Count the DISTINCT files a change touched. Thin wrapper over {@link measureChangedFiles} kept
 * for callers that genuinely only want the number; an UNMEASURABLE change counts 0 here, so a
 * caller that must not confuse "small" with "unmeasured" reads the measurement instead.
 */
export async function countChangedFiles(opts: CountChangedOptions): Promise<number> {
	return (await measureChangedFiles(opts)).changedFiles;
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
	/**
	 * Diff base ref (see {@link CountChangedOptions.baseRef}). Default 'HEAD' — which measures
	 * only UNCOMMITTED work; a caller running after its own commit must pass the pre-commit sha.
	 */
	baseRef?: string;
}

export interface ReviewDecision {
	/** How many distinct files the change touched. 0 AND `measured:false` ⇒ unknown, not zero. */
	changedFiles: number;
	/** True iff changedFiles >= threshold (the review condition was met). */
	triggered: boolean;
	/**
	 * True ⇔ git actually measured the footprint. When FALSE the decision is "no review" because we
	 * could not look, NOT because the change was small — see {@link ChangedFilesMeasurement}. The
	 * caller persists this so a reader can tell the two apart; without it a repo/environment fault
	 * silently disables the review AND the merge hold behind it (F-008).
	 */
	measured: boolean;
	/** Named reason the footprint could not be measured (screened). Absent when `measured`. */
	measureNote?: string;
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
	const { changedFiles, measured, detail } = await measureChangedFiles({
		cwd: input.cwd,
		runner: opts.runner,
		baseRef: opts.baseRef
	});

	// UNMEASURED is NOT "small". We still do not enqueue a review (a fabricated footprint would be
	// worse), but the decision says so out loud instead of reporting a confident 0 — the caller puts
	// the named reason on the completion event.
	if (!measured) {
		return { changedFiles, triggered: false, measured: false, measureNote: detail };
	}

	if (changedFiles < threshold) {
		return { changedFiles, triggered: false, measured: true };
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
		? { changedFiles, triggered: true, measured: true, workItemId: id }
		: { changedFiles, triggered: true, measured: true };
}
