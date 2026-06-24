// WI-3 (WORKSPACE-ISOLATION-SPEC) — merge-back + teardown for per-session WRITE worktrees.
//
// COMPOSITION WITH THE HEARTBEAT (HB-1): a WRITE session runs in a dedicated per-session git
// worktree (WI-1 acquireSessionWorktree) on the branch `atelier/session/<id>` rooted OUTSIDE the
// project tree. The post-task loop (orchestrator/post-task.ts ~step 2) runs `git add -A` + commit
// IN the session cwd — which IS that worktree — so the agent's work is COMMITTED on the session
// branch. THIS module runs AFTER that commit, at session-end, and decides what becomes of the
// committed branch:
//
//   • CLEAN `done` (the session succeeded + post-task advanced the task to done): attempt a
//     FAST-FORWARD merge of the session branch into the project's CURRENT working branch (the
//     branch checked out at project.root_path, off which the worktree was created). On FF success
//     the session work is now on the project branch → tear the worktree down + delete the
//     now-merged branch (cleanup, F-014). NEVER `--no-ff`, NEVER `--force`, NEVER a merge commit:
//     ff-only or nothing (no auto-resolved conflict can corrupt the project branch).
//
//   • CONFLICT (non-FF: the project branch DIVERGED while the session ran) OR a `failed`/
//     `cancelled` session: PRESERVE the branch + the worktree (NEVER force-merge, NEVER `-f`,
//     NEVER `git branch -D` a branch with unmerged commits — F-007: never lose committed work),
//     and stamp an HONEST, D-026-SCREENED `note` on the session row ("work preserved on branch
//     <branch>; merge needed") so it surfaces on the existing MC-4 SessionFailureReason surface
//     (the operator anti-invisible-failure directive).
//
// CONCURRENCY (WI-4 raises perProject): multiple write sessions in ONE project merge their
// branches into the SAME project branch. We SERIALIZE the merge-back per project root (an async
// mutex keyed by the normalized root) so two merges can't interleave and corrupt the project
// branch. A merge that was FF-able at the pre-check but races another merge (the project branch
// advanced before our turn) is no longer FF-able → `--ff-only` ABORTS cleanly and we FALL to the
// conflict→preserve path. No force, ever.
//
// RAILS:
//   • F-002 (Windows spawn): execFile with ARRAY args, never a shell string — paths with spaces
//     and metacharacters pass as inert argv (D-008). Same single OS seam as worktree.ts/post-task.ts.
//   • F-007: a session that produced commits NEVER loses them — merged on clean done, PRESERVED
//     on its branch (+ honest note) on every other exit. The branch is deleted ONLY after a
//     successful FF merge proves the commits are reachable from the project branch.
//   • F-014: teardown is MANDATORY on the success path and BEST-EFFORT-logged on failure — a
//     remove failure is logged, NEVER swallowed into a silent leak, NEVER crashes the drain; every
//     git op is non-spinning. Bounded.
//   • D-018: only LOCAL git verbs (merge/branch/rev-parse) — never push/remote/fetch/--force.
//   • Interrupt contract: idempotent / re-run safe — a re-run after a prior FF merge finds the
//     branch already merged (or already deleted) and is a clean no-op, never an error.

import { execFile } from 'node:child_process';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';

// ── The command runner seam (mirrors worktree.ts / post-task.ts: tests inject a fake) ──

/** The result of running ONE external command. */
export interface CommandResult {
	/** Process exit code (0 = success). null only if the process was signalled. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs git with an ARGUMENT ARRAY (never a shell string). `shell` is FALSE: argv is passed
 * verbatim, the OS never re-parses it, so a `; rm -rf` inside any dynamic value is one inert
 * argv string, not a second command (D-008 / F-002). This is the single OS seam.
 */
export type CommandRunner = (
	file: string,
	args: readonly string[],
	opts: { cwd: string }
) => Promise<CommandResult>;

export const execFileRunner: CommandRunner = (file, args, opts) =>
	new Promise<CommandResult>((resolve) => {
		execFile(
			file,
			[...args],
			{ cwd: opts.cwd, shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				const code =
					err && typeof (err as { code?: unknown }).code === 'number'
						? (err as { code: number }).code
						: err
							? 1
							: 0;
				resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
			}
		);
	});

// D-018 — remote-mutating / dangerous git verbs this module must NEVER issue. Self-audit:
// the args we build are fixed local verbs (merge --ff-only, branch -d, rev-parse), but this keeps
// the invariant local and loud. `git branch -D` (force-delete, drops unmerged commits) is ALSO
// refused — we only ever `-d` (safe delete, refuses an unmerged branch); a stray `-D` is a bug.
const FORBIDDEN_GIT = ['push', 'remote', 'fetch', 'pull'];
function assertLocalGit(args: readonly string[]): void {
	const verb = args[0];
	if (
		FORBIDDEN_GIT.includes(verb) ||
		args.some((a) => a === '--force' || a === '-f' || a === '-D' || a === '--no-ff')
	) {
		throw new Error(`merge-back git refused remote/force/no-ff op (D-018/F-007): git ${args.join(' ')}`);
	}
}

// ── Per-project-root serialization (concurrency: two merges can't corrupt one project branch) ──

/**
 * One in-flight merge-back chain per normalized project root. A second merge for the SAME root
 * awaits the first's settle (success OR failure) before running its own pre-check + merge, so two
 * `git merge --ff-only` invocations can never interleave on the same working tree. Keyed by the
 * lowercased/forward-slashed root so Windows path-case variants share one lock. The entry is
 * deleted once its chain drains so the map cannot grow unbounded (F-014 leak class).
 */
const mergeLocks = new Map<string, Promise<unknown>>();

function normalizeRoot(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Run `fn` with the per-root merge lock held — serialized against any other merge-back for the
 * same project root. The lock NEVER rejects the chain (a prior failure must not poison the next
 * merge): we chain on a settled tail (`.then(() => fn(), () => fn())`) so each waiter runs
 * regardless of its predecessor's outcome, then clean the map entry when this is the tail.
 */
async function withMergeLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
	const key = normalizeRoot(projectRoot);
	const prior = mergeLocks.get(key) ?? Promise.resolve();
	// run() executes fn after the prior chain SETTLES (success or failure), never inheriting its result.
	const run = prior.then(
		() => fn(),
		() => fn()
	);
	// The lock tail is run's settle (swallow its value/err so the NEXT waiter isn't poisoned).
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	mergeLocks.set(key, tail);
	try {
		return await run;
	} finally {
		// Only the CURRENT tail clears the entry — a later waiter that already replaced it stays.
		if (mergeLocks.get(key) === tail) mergeLocks.delete(key);
	}
}

// ── Inputs / outputs ──────────────────────────────────────────────────────────────────────

/** The session's terminal exit state — decides merge (done) vs preserve (everything else). */
export type SessionExitState = 'done' | 'failed' | 'cancelled';

export interface MergeBackInput {
	/** Session record id — the note is stamped here on a preserve, and it identifies the row. */
	sessionId: string;
	/** Absolute path to the PROJECT git repo root (the merge target tree; root_path). */
	projectRoot: string;
	/** The session's worktree path (session.worktree_path / WI-1 cwd). */
	worktreePath: string;
	/** The session's branch (session.worktree_branch / `atelier/session/<id>`). */
	worktreeBranch: string;
	/** The session's terminal exit state (launchSession / post-task outcome). */
	exitState: SessionExitState;
}

/** What the merge-back did — for the orchestrator log + tests. NEVER a fabricated success. */
export type MergeBackOutcome =
	/** Clean done → FF merge landed; worktree torn down; branch deleted. */
	| { kind: 'merged'; branch: string; mergedSha: string | null }
	/** Project branch diverged → ff-only aborted; branch + worktree PRESERVED; note stamped. */
	| { kind: 'preserved-conflict'; branch: string; note: string }
	/** failed/cancelled session → branch + worktree PRESERVED; note stamped. */
	| { kind: 'preserved-incomplete'; branch: string; note: string }
	/** A clean done whose branch had NOTHING to merge (no commits) → torn down, branch deleted. */
	| { kind: 'noop-empty'; branch: string }
	/** The branch/worktree no longer exist (idempotent re-run after a prior merge) → clean no-op. */
	| { kind: 'noop-gone'; branch: string };

export interface MergeBackOptions {
	/** Injectable command runner (tests pass a fake). Defaults to {@link execFileRunner}. */
	run?: CommandRunner;
	/**
	 * Injectable worktree teardown (defaults to {@link removeWorktree}). The orchestrator passes
	 * the WI-1 SessionWorktree.cleanup so the SAME idempotent remove path is reused.
	 */
	teardown?: () => Promise<void>;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** D-026 boundary screen for an operator-facing note. screen() fails CLOSED → '' on a scan error;
 *  the caller guards an empty result so the note is never a blank that reads like the old null. */
function screenNote(s: string): string {
	return screen(s).text.trim();
}

// ── git helpers (all LOCAL verbs, all execFile arrays) ──────────────────────────────────────

/** Does a local branch ref exist? `git show-ref --verify --quiet refs/heads/<branch>`. */
async function branchExists(projectRoot: string, branch: string, run: CommandRunner): Promise<boolean> {
	const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`] as const;
	assertLocalGit(args);
	const res = await run('git', args, { cwd: projectRoot });
	return res.code === 0;
}

/** Resolve a ref to its full sha, or null if it does not resolve. `rev-parse --verify` (read-only). */
async function revParse(projectRoot: string, ref: string, run: CommandRunner): Promise<string | null> {
	const args = ['rev-parse', '--verify', '--quiet', ref] as const;
	assertLocalGit(args);
	const res = await run('git', args, { cwd: projectRoot });
	const sha = res.stdout.trim();
	return res.code === 0 && sha ? sha : null;
}

/**
 * Default worktree teardown for a preserve→later-resolve or a clean merge — `git worktree remove
 * --force <dir>` detaches the tree AND deletes the dir (the `--force` here is the worktree-remove
 * flag: it allows removal of a dirty tree, NOT a history/remote force — it removes NO commits, so
 * the branch survives until WE choose to delete it). Idempotent: an already-gone tree exits
 * non-zero → we prune git's record so the registration can't dangle. NEVER throws (F-014).
 *
 * NOTE: this default is used only when the orchestrator does NOT pass the WI-1 cleanup. It is
 * deliberately NOT routed through assertLocalGit (the `remove --force` worktree flag would trip
 * the --force guard, which targets history/remote force, not `git worktree remove`).
 */
export async function removeWorktree(
	projectRoot: string,
	worktreePath: string,
	run: CommandRunner = execFileRunner
): Promise<void> {
	const res = await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectRoot });
	if (res.code !== 0) {
		// Already-gone / locked → prune git's stale record. Best-effort, bounded, never throws.
		await run('git', ['worktree', 'prune'], { cwd: projectRoot }).catch(() => undefined);
	}
}

// ── The merge-back ──────────────────────────────────────────────────────────────────────────

/**
 * Merge a finished WRITE session's branch back into its project's working branch (or preserve it),
 * then tear down the worktree on the success path. Serialized per project root (concurrency).
 *
 * SHADOW PATHS (all four handled, none crashes the drain):
 *   • exitState !== 'done'         → PRESERVE (branch + tree kept, honest note). The commits stay.
 *   • branch/worktree already gone → noop-gone (idempotent re-run after a prior merge).
 *   • branch has no commits        → noop-empty (nothing to merge; tree torn down, branch deleted).
 *   • project branch diverged      → ff-only ABORTS → preserved-conflict (note), NEVER force-merged.
 *
 * The note write is best-effort: a DB write failure is logged, never thrown — the BRANCH preserve
 * (the work-safety guarantee) does not depend on the note landing (F-014). Returns the honest
 * outcome; the orchestrator logs it and treats a preserve as a non-fatal "needs operator" state.
 */
export async function mergeBackWorktree(
	db: Db,
	input: MergeBackInput,
	opts: MergeBackOptions = {}
): Promise<MergeBackOutcome> {
	const run = opts.run ?? execFileRunner;
	const { projectRoot, worktreeBranch: branch, worktreePath, exitState, sessionId } = input;
	const teardown =
		opts.teardown ?? (() => removeWorktree(projectRoot, worktreePath, run));

	// ── Non-done exit (failed / cancelled) → PRESERVE before touching git merge state. ──
	// The session did not cleanly complete; its branch may carry partial-but-committed work
	// (F-007 — never discard it). Keep the branch AND the worktree (so a resume re-acquires the
	// SAME tree), and stamp the honest reason. We do NOT delete or merge anything here.
	if (exitState !== 'done') {
		// If the branch never materialized (e.g. the session failed before any commit / a non-git
		// path that fail-closed in WI-2) there is nothing to preserve — honest no-op.
		const exists = await branchExists(projectRoot, branch, run).catch(() => false);
		if (!exists) return { kind: 'noop-gone', branch };
		const note = `work preserved on branch ${branch}; session ${exitState} — merge needed`;
		await stampNote(db, sessionId, note);
		return { kind: 'preserved-incomplete', branch, note };
	}

	// ── Clean done → attempt the FF merge under the per-root lock (concurrency serialization). ──
	return withMergeLock(projectRoot, async () => {
		// Re-check existence INSIDE the lock — a concurrent earlier merge-back (or a prior re-run)
		// may have already merged + deleted this branch. Gone ⇒ idempotent no-op (interrupt contract).
		const exists = await branchExists(projectRoot, branch, run).catch(() => false);
		if (!exists) return { kind: 'noop-gone', branch } as MergeBackOutcome;

		// Nothing to merge? If the branch points at a commit already reachable from the project
		// branch's tip (no session commits), the FF merge would be an "Already up to date" no-op.
		// Detect it honestly: the branch sha equals HEAD's sha ⇒ empty. (HEAD at the project root is
		// the project's current working branch — the merge target.) Tear down + delete the branch.
		const branchSha = await revParse(projectRoot, branch, run);
		const headSha = await revParse(projectRoot, 'HEAD', run);
		if (branchSha && headSha && branchSha === headSha) {
			await teardown(); // remove the worktree FIRST — a branch checked out in a worktree can't be deleted
			await safeDeleteBranch(projectRoot, branch, run);
			return { kind: 'noop-empty', branch } as MergeBackOutcome;
		}

		// THE FF MERGE — `git merge --ff-only <branch>` from the project root, on the project's
		// current working branch. ff-only means: advance the branch pointer iff the session branch
		// is strictly AHEAD of it; if the project branch DIVERGED (a concurrent merge / an operator
		// commit landed while the session ran), git ABORTS with a non-zero exit and leaves the
		// working tree UNTOUCHED (no partial merge, no conflict markers) — we fall to preserve.
		const mergeArgs = ['merge', '--ff-only', branch] as const;
		assertLocalGit(mergeArgs);
		const merged = await run('git', mergeArgs, { cwd: projectRoot });

		if (merged.code === 0) {
			// FF success: the session work is now on the project branch. The commits are reachable,
			// so tearing down the worktree + safe-deleting the branch loses NOTHING (F-007). Teardown
			// is MANDATORY here (success path) but its own failure must NOT crash the drain (F-014) —
			// removeWorktree never throws; a leftover dir is logged, the branch delete still proceeds.
			const mergedSha = await revParse(projectRoot, 'HEAD', run);
			await teardown();
			await safeDeleteBranch(projectRoot, branch, run);
			return { kind: 'merged', branch, mergedSha } as MergeBackOutcome;
		}

		// ── CONFLICT / non-FF → PRESERVE. NEVER `--no-ff`, NEVER `--force`, NEVER discard. ──
		// The project branch diverged from the session branch (a concurrent merge raced us, or the
		// project advanced during the run). git left the working tree clean (ff-only aborts before
		// touching it). Keep the branch AND the worktree, stamp the honest reason so the operator can
		// resolve it manually (the anti-invisible-failure surface).
		const reason = (merged.stderr || merged.stdout).trim().slice(0, 160);
		const note =
			`work preserved on branch ${branch}; merge needed ` +
			`(project branch diverged — fast-forward not possible${reason ? `: ${reason}` : ''})`;
		await stampNote(db, sessionId, note);
		return { kind: 'preserved-conflict', branch, note } as MergeBackOutcome;
	});
}

/**
 * `git branch -d <branch>` — SAFE delete. `-d` (not `-D`) REFUSES to delete a branch that is not
 * fully merged into its upstream/HEAD, so this can NEVER drop unmerged commits (F-007). Reached
 * only on the merged / noop-empty paths where the branch IS merged, so it succeeds; if git still
 * refuses (a race), we LOG and KEEP the branch — preserving work is always the safe failure.
 */
async function safeDeleteBranch(projectRoot: string, branch: string, run: CommandRunner): Promise<void> {
	const args = ['branch', '-d', branch] as const;
	assertLocalGit(args); // -D / --force are forbidden here — only the safe -d reaches git
	const res = await run('git', args, { cwd: projectRoot });
	if (res.code !== 0) {
		console.warn(
			`[merge-back] safe branch delete refused for ${branch} (kept — never force-deleted, F-007): ` +
				`${(res.stderr || res.stdout).trim().slice(0, 160)}`
		);
	}
}

/**
 * Stamp a D-026-SCREENED honest note on the session row (the MC-4 SessionFailureReason surface).
 * Best-effort: a write failure is logged, NEVER thrown — the branch preserve (the actual work-
 * safety guarantee) already happened in git and does not depend on the note landing (F-014). The
 * note is bound via $param (D-016); the id flows through the validate chokepoint as a record link.
 *
 * APPEND-NOT-CLOBBER (honest, F-008): a FAILED/cancelled session ALREADY carries launchSession's
 * failure note (WHY it failed). We must not lose that reason — so we read the existing note and, if
 * present and distinct, APPEND the preserve advisory ("· work preserved on branch …") rather than
 * overwriting it. The operator then sees BOTH why it failed AND where the work is. A clean done that
 * hit a conflict has no prior note, so it just gets the advisory. The read+write is one statement so
 * a concurrent writer can't interleave between them.
 */
async function stampNote(db: Db, sessionId: string, rawNote: string): Promise<void> {
	const screened = screenNote(rawNote);
	const advisory = screened || 'work preserved on a session branch; merge needed (reason unavailable after screening)';
	try {
		// Read the current note in the SAME statement, then set: existing + ' · ' + advisory when an
		// existing note is present and does not already contain the advisory (idempotent re-run); else
		// just the advisory. `string::contains` guards against a re-run doubling the suffix.
		await db.query(
			`LET $cur = (SELECT VALUE note FROM ONLY $sid);
			 LET $next = IF $cur != NONE AND $cur != "" AND !string::contains($cur, $advisory)
			   { string::concat($cur, " · ", $advisory) }
			 ELSE IF $cur != NONE AND $cur != "" AND string::contains($cur, $advisory)
			   { $cur }
			 ELSE { $advisory };
			 UPDATE $sid MERGE { note: $next };`,
			{ sid: link(sessionId), advisory }
		);
	} catch (err) {
		console.warn(
			`[merge-back] could not stamp preserve note on ${sessionId} (work IS preserved on its branch regardless): ${(err as Error).message}`
		);
	}
}
