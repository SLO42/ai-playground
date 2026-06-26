// WI-1 (WORKSPACE-ISOLATION-SPEC) — per-session git worktree for WRITE sessions.
//
// THE PROBLEM (F-046 / F-007 class): all of a project's sessions run in the SAME cwd
// (project.root_path, launch.ts). Two concurrent WRITE sessions in one repo race the
// working tree and the index → file/git stomping. perProject=1 was a stopgap (F-046);
// the real fix is a dedicated git worktree per write session so each gets its OWN working
// tree + branch off the same repo, and concurrency can be raised back (WI-4) safely.
//
// WHAT THIS DOES: `acquireSessionWorktree(projectRoot, sessionId)` creates (or, on resume,
// REUSES) a git worktree off the project repo's current HEAD on a per-session branch
//   `atelier/session/<safe sessionId segment>`
// rooted OUTSIDE the project tree (a sibling `.atelier-worktrees/<segment>` dir) so it
// never pollutes the project working tree or gets caught by the project's own globs.
//
// COMPOSITION WITH THE HEARTBEAT (HB-1): the post-task loop (orchestrator/post-task.ts)
// runs `git add -A` + commit IN the session cwd. Once WI-2 points a write session's cwd at
// the worktree returned here, those commits land on the per-session BRANCH inside the
// worktree — so WI-3's merge-back runs AFTER the post-task commit (it merges the committed
// session branch into the project branch). cleanup() here NEVER deletes a branch with
// commits (WI-3 owns the merge/preserve decision); it only removes the worktree.
//
// RAILS:
//   • F-002 (Windows spawn): execFile with ARRAY args, never a shell string — paths with
//     spaces and metacharacters in projectRoot/sessionId pass as inert argv (D-008).
//   • Fail CLOSED if projectRoot is not a git repo / missing — throw a NAMED error, NEVER
//     silently fall back to the shared project root (that re-opens the F-046 race).
//   • IDEMPOTENT re-acquire — one worktree per session; a re-run absorbs prior partial work
//     (interrupt contract) instead of erroring on it.
//   • cleanup() is safe to double-call (no throw when the worktree is already gone); bounds
//     and never spins; leaves no orphan trees (F-014).
//   • D-018: only LOCAL git verbs (worktree/branch/rev-parse) — never push/remote/--force.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ── Named errors (EVERY ERROR HAS A NAME) ──────────────────────────────────────────────

/**
 * projectRoot is missing on disk or is not a git repository. A WRITE session MUST get a
 * real worktree; we FAIL CLOSED here rather than fall back to the shared project root (that
 * fallback is exactly the F-046 concurrent-cwd race this whole effort closes).
 */
export class NotAGitRepoError extends Error {
	constructor(public readonly projectRoot: string, cause?: string) {
		super(
			`acquireSessionWorktree: projectRoot is not a git repository (fail closed, F-046): ` +
				`${projectRoot}${cause ? ` — ${cause}` : ''}`
		);
		this.name = 'NotAGitRepoError';
	}
}

/** A git worktree/branch operation exited non-zero. Carries the first stderr lines. */
export class WorktreeGitError extends Error {
	constructor(
		public readonly op: string,
		public readonly code: number | null,
		public readonly stderr: string
	) {
		super(`acquireSessionWorktree: git ${op} failed (code ${code ?? 'signal'}): ${stderr.slice(0, 300)}`);
		this.name = 'WorktreeGitError';
	}
}

// ── The command runner seam (mirrors post-task.ts: tests inject a fake; default = execFile) ──

/** The result of running ONE external command. */
export interface CommandResult {
	/** Process exit code (0 = success). null only if the process was signalled. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs git with an ARGUMENT ARRAY (never a shell string). `shell` is FALSE: argv is passed
 * verbatim, the OS never re-parses it, so a `; rm -rf` inside projectRoot/sessionId is one
 * inert argv string, not a second command (D-008 / F-002). This is the single OS seam.
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
// the args we build are fixed local verbs, but this keeps the invariant local and loud.
const FORBIDDEN_GIT = ['push', 'remote', 'fetch', 'pull'];
function assertLocalGit(args: readonly string[]): void {
	const verb = args[0];
	if (FORBIDDEN_GIT.includes(verb) || args.some((a) => a === '--force' || a === '-f')) {
		throw new Error(`worktree git refused remote/force op (D-018): git ${args.join(' ')}`);
	}
}

// ── Sanitization (mirror runtime/index.ts safeSegment discipline) ──────────────────────

/**
 * Sanitize a session id into a segment that is BOTH filesystem-safe AND git-ref-safe.
 * git refs forbid space, ~ ^ : ? * [ \ and runs of `.` / leading-trailing `.`; we collapse
 * every non `[a-zA-Z0-9_-]` run to `_` (a superset of both rule sets), cap length, and fall
 * back to a constant when the input sanitizes to empty — so `atelier/session/<seg>` is always
 * a valid ref and `<seg>` is always a valid single path component (no separators survive).
 */
export function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'session';
}

/** Per-session branch name. The segment is sanitized, so this is always a valid git ref. */
export function sessionBranch(sessionId: string): string {
	return `atelier/session/${safeSegment(sessionId)}`;
}

// ── Public shape ────────────────────────────────────────────────────────────────────────

export interface SessionWorktree {
	/** Absolute path to the worktree dir — the WRITE session's cwd (WI-2). */
	cwd: string;
	/** The per-session branch the worktree is checked out on. */
	branch: string;
	/**
	 * Remove the worktree (`git worktree remove`). Safe to call when it is already gone
	 * (idempotent, no throw — F-014: clean up on every exit path). Does NOT delete the
	 * branch — WI-3 owns the merge/preserve decision for any commits on it.
	 */
	cleanup: () => Promise<void>;
}

export interface AcquireOptions {
	/** Injectable command runner (tests pass a fake). Defaults to {@link execFileRunner}. */
	run?: CommandRunner;
	/**
	 * Root dir under which per-session worktrees live, OUTSIDE the project tree. Defaults to
	 * a sibling `<projectRoot>/../.atelier-worktrees`. Kept out of the project tree so it is
	 * never caught by the project's globs / status (D-018: the worktree IS the confinement
	 * root, but it must not pollute the source repo's working set).
	 */
	worktreesRoot?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────

/** True iff `dir` exists and is a directory. */
async function isDir(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True iff `dir` exists, is a directory, AND has ZERO entries. Used to distinguish the
 * DOCUMENTED safe-to-delete half-state (an empty dir left by a crash between `mkdir` and
 * `git worktree add`) from a NON-EMPTY dir that may carry uncommitted work (F-007 work-loss).
 * A missing dir / read error → false (we treat unknown as NOT-empty, the conservative side:
 * a false-non-empty merely preserves a dir that was actually empty — never destroys work).
 */
async function isEmptyDir(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length === 0;
	} catch {
		return false;
	}
}

/**
 * PRESERVE a stale, work-bearing on-disk dir at `worktreeDir` instead of hard-deleting it
 * (F-007 work-loss class). The dir is on disk but git does NOT track it as a worktree, AND it
 * is NON-EMPTY — it may hold a prior run's uncommitted work — so we rename it ASIDE to a
 * deterministic sibling `<worktreeDir>.orphaned-<segment>` (id-based for traceability) and emit
 * a NAMED warning. The caller then proceeds to a clean `git worktree add` at the now-vacant
 * worktreeDir.
 *
 * Bounded + idempotent: if the id-based target already exists (a prior preserve), append a
 * timestamp so we never collide with or overwrite an earlier rescued tree (still PRESERVE,
 * never destroy). `rename` is atomic on the same filesystem. On the rare cross-device /
 * permission failure we DO NOT fall back to `rm` (that would destroy the work) — we leave the
 * dir in place and surface a named warning; the caller's subsequent `worktree add` then fails
 * loudly on the occupied path rather than silently eating the dir.
 */
async function preserveOrphanedDir(worktreeDir: string, segment: string): Promise<void> {
	let target = `${worktreeDir}.orphaned-${segment}`;
	if (await isDir(target)) target = `${target}-${Date.now()}`;
	try {
		await rename(worktreeDir, target);
		console.warn(
			`[worktree] StaleOrphanedDirPreserved: non-empty stale dir (possible uncommitted work, ` +
				`F-007) renamed ${worktreeDir} → ${target} before a clean worktree add`
		);
	} catch (err) {
		console.warn(
			`[worktree] StaleOrphanedDirPreserveFailed: could NOT move non-empty stale dir ` +
				`${worktreeDir} (left in place, NOT deleted — F-007): ${(err as Error)?.message ?? String(err)}`
		);
	}
}

/**
 * Assert projectRoot is a git repo, FAIL CLOSED otherwise. Three shadow paths handled:
 *   • nil/empty projectRoot   → NotAGitRepoError (named).
 *   • dir missing on disk      → NotAGitRepoError (named).
 *   • dir present but not git  → NotAGitRepoError (named, carries git stderr).
 * Uses `git rev-parse --is-inside-work-tree` (read-only, local) at the projectRoot.
 */
async function assertGitRepo(projectRoot: string, run: CommandRunner): Promise<void> {
	if (!projectRoot || !projectRoot.trim()) throw new NotAGitRepoError(String(projectRoot), 'empty path');
	if (!(await isDir(projectRoot))) throw new NotAGitRepoError(projectRoot, 'directory does not exist');
	const args = ['rev-parse', '--is-inside-work-tree'] as const;
	assertLocalGit(args);
	const res = await run('git', args, { cwd: projectRoot });
	if (res.code !== 0 || res.stdout.trim() !== 'true') {
		throw new NotAGitRepoError(projectRoot, res.stderr.trim().slice(0, 200) || 'not a work tree');
	}
}

/**
 * Does a worktree already exist for `worktreeDir`? `git worktree list --porcelain` prints a
 * `worktree <abs path>` line per tree. We normalize separators (git emits forward slashes on
 * Windows) and compare to the resolved worktreeDir — so a resume detects its own tree and we
 * never `git worktree add` over an existing path (which errors). Idempotency proof point.
 */
async function worktreeExists(
	projectRoot: string,
	worktreeDir: string,
	run: CommandRunner
): Promise<boolean> {
	const args = ['worktree', 'list', '--porcelain'] as const;
	assertLocalGit(args);
	const res = await run('git', args, { cwd: projectRoot });
	if (res.code !== 0) return false; // can't list → treat as absent; add will surface the real error
	const want = normalizePath(worktreeDir);
	for (const line of res.stdout.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			if (normalizePath(line.slice('worktree '.length).trim()) === want) return true;
		}
	}
	return false;
}

/** Lowercase + forward-slash + strip trailing slash, for cross-platform path equality. */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// ── Acquire ─────────────────────────────────────────────────────────────────────────────

/**
 * Acquire (create or reuse) the per-session git worktree for a WRITE session.
 *
 * @param projectRoot absolute path to the project git repo. NON-git → fail closed (named).
 * @param sessionId   the session's unique id. Sanitized for the branch + dir segment.
 *
 * IDEMPOTENT: if the session's worktree already exists (resume / partial prior run), it is
 * REUSED — never a second tree. The branch is created off the repo's current HEAD on first
 * acquire; on reuse the existing branch/tree is left as-is (it may carry the prior run's
 * committed work — F-007: never lose committed work).
 */
export async function acquireSessionWorktree(
	projectRoot: string,
	sessionId: string,
	opts: AcquireOptions = {}
): Promise<SessionWorktree> {
	const run = opts.run ?? execFileRunner;

	// FAIL CLOSED before touching anything — a non-git root never reaches the add path.
	await assertGitRepo(projectRoot, run);

	const segment = safeSegment(sessionId);
	const branch = sessionBranch(sessionId);
	const worktreesRoot = opts.worktreesRoot
		? opts.worktreesRoot
		: join(projectRoot, '..', '.atelier-worktrees');
	const worktreeDir = join(worktreesRoot, segment);

	const cleanup = makeCleanup(projectRoot, worktreeDir, run);

	// WI-1 RED-TEAM (work-loss HIGH): track whether THIS invocation actually created the tree
	// via a successful `git worktree add`. The failure-path cleanup removes ONLY a tree this
	// call created — NEVER a tree it merely found occupied. If `add` fails because the path is
	// already taken by a CONCURRENT WINNER (or a resumable tree that appeared after our
	// worktreeExists() check), `didCreate` stays false and we DO NOT touch the winner's live
	// tree (deleting it would lose the winner's uncommitted work — the exact F-007/F-046 class
	// this whole effort prevents). A genuine self-created tree (didCreate=true) is still cleaned
	// on a later-step failure.
	let didCreate = false;

	// ── IDEMPOTENT re-acquire: the tree already exists for this session → REUSE it. ──
	// Detected via `git worktree list` (authoritative) — never re-`add` over an existing
	// path. Covers resume AND a re-run after a partial prior acquire (interrupt contract).
	if (await worktreeExists(projectRoot, worktreeDir, run)) {
		return { cwd: worktreeDir, branch, cleanup };
	}

	// A stale dir on disk that git does NOT track as a worktree (a half-state from a prior
	// crash between mkdir and `worktree add`): prune git's stale records, then vacate the dir
	// so `worktree add` lands clean. Both bounded, both idempotent (absorb the partial work).
	if (await isDir(worktreeDir)) {
		const pruneArgs = ['worktree', 'prune'] as const;
		assertLocalGit(pruneArgs);
		await run('git', pruneArgs, { cwd: projectRoot });
		// Re-check: prune may have made the now-registered tree reusable.
		if (await worktreeExists(projectRoot, worktreeDir, run)) {
			return { cwd: worktreeDir, branch, cleanup };
		}
		// Vacate the untracked dir so `worktree add` lands clean — but NEVER blindly hard-delete:
		//   • EMPTY (the DOCUMENTED crash half-state) → rm and proceed.
		//   • NON-EMPTY (may hold a prior run's uncommitted work) → PRESERVE it: rename aside to a
		//     sibling `.orphaned-<segment>` path + NAMED warning, then proceed to a clean add. This
		//     is the F-007 work-loss guard: an unconditional rm here would silently destroy work.
		if (await isEmptyDir(worktreeDir)) {
			await rm(worktreeDir, { recursive: true, force: true });
		} else {
			await preserveOrphanedDir(worktreeDir, segment);
		}
	}

	// Ensure the parent root exists (idempotent; recursive). Lives OUTSIDE the project tree.
	await mkdir(worktreesRoot, { recursive: true });

	// ── Create the worktree on a NEW per-session branch off the repo's current HEAD. ──
	// `git worktree add -b <branch> <dir> HEAD`: -b creates the branch; HEAD is the start
	// point. Every dynamic value (worktreeDir, branch) is a separate argv element — execFile
	// hands them to git verbatim, so spaces/metacharacters can't word-split or inject (D-008).
	let addArgs: readonly string[] = ['worktree', 'add', '-b', branch, worktreeDir, 'HEAD'];
	assertLocalGit(addArgs);
	let res = await run('git', addArgs, { cwd: projectRoot });
	if (res.code === 0) didCreate = true;

	if (res.code !== 0) {
		// The branch may already exist (a prior partial acquire created the branch but the
		// tree got pruned/removed). Re-run idempotently WITHOUT -b: check out the EXISTING
		// branch into a fresh tree, never lose its committed work (F-007).
		const branchExists = await refExists(projectRoot, branch, run);
		if (branchExists) {
			addArgs = ['worktree', 'add', worktreeDir, branch];
			assertLocalGit(addArgs);
			res = await run('git', addArgs, { cwd: projectRoot });
			if (res.code === 0) didCreate = true;
		}
		if (res.code !== 0) {
			// Could not establish a worktree → fail closed (named). Best-effort clean up ONLY a
			// tree THIS call created (didCreate) so we leave no orphan tree (F-014) — but NEVER
			// remove a tree we merely found occupied. When `add` fails because the path/branch is
			// already taken (a CONCURRENT WINNER's live tree for the same session id, or a
			// resumable tree that materialized after our worktreeExists() check), didCreate is
			// false: the tree belongs to the winner / is the resume target, and removing it would
			// destroy the winner's uncommitted work (F-007/F-046). So the LOSER fails honestly
			// here WITHOUT touching the winner's tree.
			if (didCreate) await cleanup();
			throw new WorktreeGitError(`worktree add ${branch}`, res.code, res.stderr || res.stdout);
		}
	}

	return { cwd: worktreeDir, branch, cleanup };
}

/** Does a local branch ref exist? `git show-ref --verify --quiet refs/heads/<branch>`. */
async function refExists(projectRoot: string, branch: string, run: CommandRunner): Promise<boolean> {
	const args = ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`] as const;
	assertLocalGit(args);
	const res = await run('git', args, { cwd: projectRoot });
	return res.code === 0;
}

/**
 * Build the cleanup closure. `git worktree remove --force <dir>` detaches the tree from git
 * AND deletes the dir; `--force` here is the worktree-remove flag (allows removal with a
 * dirty tree), NOT a remote/history force — it is NOT in the assertLocalGit forbidden set and
 * removes no commits, so the per-session BRANCH (and any commits on it) SURVIVES for WI-3.
 *
 * Idempotent (F-014): if the tree is already gone the remove exits non-zero — we swallow that
 * and best-effort `git worktree prune` + `rm` the dir, so a double-cleanup never throws.
 */
function makeCleanup(projectRoot: string, worktreeDir: string, run: CommandRunner): () => Promise<void> {
	return async () => {
		// Nothing registered AND nothing on disk → already cleaned, no-op.
		const registered = await worktreeExists(projectRoot, worktreeDir, run).catch(() => false);
		const onDisk = await isDir(worktreeDir);
		if (!registered && !onDisk) return;

		if (registered) {
			// NOTE: 'remove' is a worktree subverb, not the forbidden top-level 'remote'. The
			// '--force' here is `git worktree remove`'s own flag — assertLocalGit's --force guard
			// targets history/remote force, so we deliberately do NOT route this through it.
			const res = await run('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: projectRoot });
			if (res.code !== 0) {
				// Already-gone / locked → prune git's record, then ensure the dir is gone. Best
				// effort, bounded, never throws (double-cleanup safety).
				await run('git', ['worktree', 'prune'], { cwd: projectRoot }).catch(() => undefined);
			}
		}
		// Belt-and-suspenders: if the dir still exists (remove failed / was never registered),
		// remove it directly. force:true makes a missing dir a no-op (idempotent).
		await rm(worktreeDir, { recursive: true, force: true }).catch(() => undefined);
	};
}
