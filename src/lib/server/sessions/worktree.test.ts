import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	acquireSessionWorktree,
	safeSegment,
	sessionBranch,
	NotAGitRepoError,
	WorktreeGitError,
	execFileRunner,
	type CommandRunner
} from './worktree';

// WI-1 (WORKSPACE-ISOLATION-SPEC) VERIFY — against REAL temp git repos (init a throwaway
// repo, NOT a mock). Covers: acquire creates a worktree+branch off HEAD; re-acquire returns
// the SAME tree (idempotent, no second tree); non-git root throws the NAMED error; cleanup
// removes the tree and is a no-op on a second call; a projectRoot/sessionId with spaces /
// metacharacters is handled as inert argv (no shell injection); the per-session branch
// SURVIVES cleanup (WI-3 owns merge/preserve).

// ── A real throwaway git repo per test (no mock — the runner is the live execFile) ──

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dirName = 'proj'): string {
	const base = mkdtempSync(join(tmpdir(), 'wt-test-'));
	const repo = join(base, dirName);
	execFileSync('git', ['init', '-b', 'main', repo]);
	git(repo, 'config', 'user.email', 'test@test.local');
	git(repo, 'config', 'user.name', 'Test');
	writeFileSync(join(repo, 'README.md'), '# seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-m', 'seed');
	return repo;
}

/** Track temp roots so afterEach removes every worktree tree we created (no orphans). */
let toClean: string[] = [];
function trackParent(repo: string): void {
	// the mkdtemp base is two levels up from the worktrees root sibling
	toClean.push(join(repo, '..'));
}

beforeEach(() => {
	toClean = [];
});
afterEach(() => {
	for (const p of toClean) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

describe('safeSegment / sessionBranch', () => {
	it('collapses non-[a-zA-Z0-9_-] runs to _ and caps length', () => {
		expect(safeSegment('sess id: ~^?*[\\]/foo')).toBe('sess_id_foo');
		expect(safeSegment('').length).toBeGreaterThan(0); // empty → constant fallback
		expect(safeSegment('a'.repeat(200)).length).toBe(64);
	});
	it('produces a git-ref-safe branch with no separators in the segment', () => {
		const b = sessionBranch('proj/../escape');
		expect(b).toBe('atelier/session/proj_escape');
		expect(b.includes('..')).toBe(false);
	});
});

describe('acquireSessionWorktree — happy path (real repo)', () => {
	it('creates a worktree + branch off HEAD, OUTSIDE the project tree', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-A');

		// the tree exists on disk and carries the repo's seed commit (off HEAD)
		expect(existsSync(wt.cwd)).toBe(true);
		expect(existsSync(join(wt.cwd, 'README.md'))).toBe(true);
		expect(wt.branch).toBe('atelier/session/sess-A');

		// it is OUTSIDE the project tree (sibling .atelier-worktrees, not under repo/)
		expect(wt.cwd.startsWith(repo + '/')).toBe(false);
		expect(wt.cwd.replace(/\\/g, '/')).toContain('.atelier-worktrees/sess-A');

		// the branch is checked out in the worktree, off the same HEAD
		expect(git(wt.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('atelier/session/sess-A');
		expect(git(wt.cwd, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));

		await wt.cleanup();
	});

	it('post-task commit composition: a commit in the worktree lands on the SESSION branch (HB-1)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-commit');

		writeFileSync(join(wt.cwd, 'feature.txt'), 'work\n');
		git(wt.cwd, 'add', '-A');
		git(wt.cwd, 'commit', '-m', 'feat: session work');

		// the commit is on the session branch, NOT on the project's main branch
		const branchHead = git(repo, 'rev-parse', 'atelier/session/sess-commit');
		const mainHead = git(repo, 'rev-parse', 'main');
		expect(branchHead).not.toBe(mainHead);

		// cleanup removes the tree but PRESERVES the branch + its commit (WI-3 owns merge)
		await wt.cleanup();
		expect(existsSync(wt.cwd)).toBe(false);
		expect(git(repo, 'rev-parse', 'atelier/session/sess-commit')).toBe(branchHead);
	});
});

describe('acquireSessionWorktree — idempotent re-acquire (resume)', () => {
	it('returns the SAME worktree, never a second tree', async () => {
		const repo = initRepo();
		trackParent(repo);
		const first = await acquireSessionWorktree(repo, 'sess-R');
		const second = await acquireSessionWorktree(repo, 'sess-R');

		expect(second.cwd).toBe(first.cwd);
		expect(second.branch).toBe(first.branch);

		// exactly ONE session worktree registered (the main worktree + ours = 2 entries)
		const list = git(repo, 'worktree', 'list', '--porcelain');
		const sessionTrees = list
			.split(/\r?\n/)
			.filter((l) => l.startsWith('worktree ') && l.replace(/\\/g, '/').includes('.atelier-worktrees'));
		expect(sessionTrees.length).toBe(1);

		await first.cleanup();
	});

	it('re-acquire after committed work on the branch reuses the tree (never loses commits, F-007)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const first = await acquireSessionWorktree(repo, 'sess-resume');
		writeFileSync(join(first.cwd, 'wip.txt'), 'wip\n');
		git(first.cwd, 'add', '-A');
		git(first.cwd, 'commit', '-m', 'wip');
		const committed = git(repo, 'rev-parse', 'atelier/session/sess-resume');

		const second = await acquireSessionWorktree(repo, 'sess-resume');
		expect(second.cwd).toBe(first.cwd);
		expect(existsSync(join(second.cwd, 'wip.txt'))).toBe(true);
		expect(git(repo, 'rev-parse', 'atelier/session/sess-resume')).toBe(committed);

		await first.cleanup();
	});

	it('absorbs a half-state: branch exists but tree was removed (partial prior acquire)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const first = await acquireSessionWorktree(repo, 'sess-half');
		// commit so the branch carries work, then remove ONLY the tree (branch survives)
		writeFileSync(join(first.cwd, 'half.txt'), 'half\n');
		git(first.cwd, 'add', '-A');
		git(first.cwd, 'commit', '-m', 'half');
		const head = git(repo, 'rev-parse', 'atelier/session/sess-half');
		git(repo, 'worktree', 'remove', '--force', first.cwd);
		expect(existsSync(first.cwd)).toBe(false);
		expect(() => git(repo, 'rev-parse', 'atelier/session/sess-half')).not.toThrow();

		// re-acquire must check out the EXISTING branch into a fresh tree (no -b, no loss)
		const again = await acquireSessionWorktree(repo, 'sess-half');
		expect(again.branch).toBe('atelier/session/sess-half');
		expect(existsSync(join(again.cwd, 'half.txt'))).toBe(true);
		expect(git(repo, 'rev-parse', 'atelier/session/sess-half')).toBe(head);

		await again.cleanup();
	});
});

describe('acquireSessionWorktree — fail closed (shadow paths)', () => {
	it('throws NotAGitRepoError for a non-git directory (NEVER falls back to shared root)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wt-nogit-'));
		toClean.push(dir);
		await expect(acquireSessionWorktree(dir, 'sess-X')).rejects.toBeInstanceOf(NotAGitRepoError);
	});

	it('throws NotAGitRepoError for a missing directory', async () => {
		const missing = join(tmpdir(), 'wt-does-not-exist-' + Date.now());
		await expect(acquireSessionWorktree(missing, 'sess-X')).rejects.toBeInstanceOf(NotAGitRepoError);
	});

	it('throws NotAGitRepoError for nil / empty projectRoot', async () => {
		await expect(acquireSessionWorktree('', 'sess-X')).rejects.toBeInstanceOf(NotAGitRepoError);
		// @ts-expect-error — exercise the nil shadow path
		await expect(acquireSessionWorktree(undefined, 'sess-X')).rejects.toBeInstanceOf(NotAGitRepoError);
	});
});

describe('cleanup — idempotent (F-014)', () => {
	it('removes the tree and is a no-op on a second call', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-C');
		expect(existsSync(wt.cwd)).toBe(true);

		await wt.cleanup();
		expect(existsSync(wt.cwd)).toBe(false);

		// second cleanup must NOT throw (double-cleanup safety)
		await expect(wt.cleanup()).resolves.toBeUndefined();

		// no orphan worktree registered with git
		const list = git(repo, 'worktree', 'list', '--porcelain');
		expect(list.replace(/\\/g, '/')).not.toContain('.atelier-worktrees/sess-C');
	});

	it('is a no-op when the dir was deleted out from under it (already gone)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-D');
		rmSync(wt.cwd, { recursive: true, force: true });
		await expect(wt.cleanup()).resolves.toBeUndefined();
	});
});

describe('no shell injection — projectRoot / sessionId as inert argv (D-008 / F-002)', () => {
	it('handles a projectRoot containing spaces', async () => {
		const repo = initRepo('proj with spaces');
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-space');
		expect(existsSync(wt.cwd)).toBe(true);
		expect(git(wt.cwd, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
		await wt.cleanup();
	});

	it('treats a metacharacter-laden sessionId as inert (sanitized, no second command)', async () => {
		const repo = initRepo();
		trackParent(repo);
		// a malicious id: it must be sanitized into one inert path/ref segment, never executed
		const evil = 'sess; rm -rf / && echo pwned `whoami`';
		const wt = await acquireSessionWorktree(repo, evil);
		expect(wt.branch).toBe('atelier/session/' + safeSegment(evil));
		expect(wt.branch.includes(';')).toBe(false);
		expect(wt.branch.includes('`')).toBe(false);
		expect(existsSync(wt.cwd)).toBe(true);
		// the seed file still exists — nothing was rm'd
		expect(existsSync(join(repo, 'README.md'))).toBe(true);
		await wt.cleanup();
	});
});

describe('WI-1 red-team — concurrent same-session acquire: loser NEVER deletes winner tree (F-007/F-046)', () => {
	it('two concurrent acquires for one session id → the winner tree survives, the loser fails without removing it', async () => {
		const repo = initRepo();
		trackParent(repo);

		// Fire both acquires for the SAME session id concurrently. git serializes the two
		// `worktree add` calls on the same path: #0 wins+creates, #1's add fails ("already
		// exists"). The branch already exists (created by the winner), so the loser's no-b
		// retry ALSO fails (the path is occupied). Pre-fix, the loser's UNCONDITIONAL cleanup
		// removed the winner's live tree. Post-fix the loser fails honestly, untouched.
		const results = await Promise.allSettled([
			acquireSessionWorktree(repo, 'sess-race'),
			acquireSessionWorktree(repo, 'sess-race')
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');

		// exactly one winner, one loser
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		// the loser failed HONESTLY (a named git error), it did not silently succeed
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorktreeGitError);

		// THE INVARIANT: the winner's live tree SURVIVES — on disk, registered, on its branch.
		const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSessionWorktree>>>)
			.value;
		expect(existsSync(winner.cwd)).toBe(true);
		expect(existsSync(join(winner.cwd, 'README.md'))).toBe(true);
		expect(git(winner.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('atelier/session/sess-race');

		// exactly ONE session worktree registered (the loser left no orphan, removed nothing)
		const list = git(repo, 'worktree', 'list', '--porcelain');
		const sessionTrees = list
			.split(/\r?\n/)
			.filter((l) => l.startsWith('worktree ') && l.replace(/\\/g, '/').includes('.atelier-worktrees'));
		expect(sessionTrees.length).toBe(1);

		await winner.cleanup();
	});

	it('concurrent acquire with UNCOMMITTED work in the winner: the winner keeps its uncommitted file (the F-007 loss the red-team proved)', async () => {
		const repo = initRepo();
		trackParent(repo);

		// Race both acquires; the winner then writes UNCOMMITTED work into its tree. Pre-fix the
		// loser's unconditional cleanup `git worktree remove --force` deleted exactly this
		// (uncommitted, unrecoverable) work. We assert it survives.
		const [r0, r1] = await Promise.allSettled([
			acquireSessionWorktree(repo, 'sess-uncommit'),
			acquireSessionWorktree(repo, 'sess-uncommit')
		]);
		const winnerRes = (r0.status === 'fulfilled' ? r0 : r1) as PromiseFulfilledResult<
			Awaited<ReturnType<typeof acquireSessionWorktree>>
		>;
		const loserRes = r0.status === 'rejected' ? r0 : r1;
		expect(winnerRes.status).toBe('fulfilled');
		expect((loserRes as PromiseRejectedResult).reason).toBeInstanceOf(WorktreeGitError);

		const winner = winnerRes.value;
		writeFileSync(join(winner.cwd, 'uncommitted.txt'), 'live work, not yet committed\n');
		// the loser already rejected above; the winner's uncommitted work must be intact
		expect(existsSync(join(winner.cwd, 'uncommitted.txt'))).toBe(true);
		expect(existsSync(winner.cwd)).toBe(true);

		await winner.cleanup();
	});

	it('a genuinely self-created tree IS removed on this-call cleanup (cleanup itself still removes a real tree)', async () => {
		// Direct proof that the cleanup we GATE is the same one that legitimately removes a tree
		// this call created — so the gate narrows WHEN it runs, it does not weaken WHAT it does.
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-realremove');
		expect(existsSync(wt.cwd)).toBe(true);
		await wt.cleanup(); // the exact closure the failure path would invoke when didCreate
		expect(existsSync(wt.cwd)).toBe(false);
		const list = git(repo, 'worktree', 'list', '--porcelain');
		expect(list.replace(/\\/g, '/')).not.toContain('.atelier-worktrees/sess-realremove');
	});
});

describe('WorktreeGitError surfaces a failed git op (named)', () => {
	it('throws WorktreeGitError (named) when worktree add fails on a passing repo check', async () => {
		const repo = initRepo();
		trackParent(repo);
		// a runner that passes the repo check but fails the add → exercise the named error
		const failingRun: CommandRunner = async (file, args, opts) => {
			if (args[0] === 'worktree' && args[1] === 'add') {
				return { code: 128, stdout: '', stderr: 'fatal: simulated add failure' };
			}
			if (args[0] === 'show-ref') return { code: 1, stdout: '', stderr: '' }; // branch does not exist
			return execFileRunner(file, args, opts);
		};
		await expect(
			acquireSessionWorktree(repo, 'sess-fail', { run: failingRun })
		).rejects.toBeInstanceOf(WorktreeGitError);
	});
});
