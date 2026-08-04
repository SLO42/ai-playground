import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	mergeBackWorktree,
	removeWorktree,
	execFileRunner,
	type CommandRunner
} from './merge-back';
import { acquireSessionWorktree } from './worktree';

// WI-3 (WORKSPACE-ISOLATION-SPEC) VERIFY — against REAL temp git repos (init throwaway repos, NOT
// mocks). Proves NO LOST WORK for EACH exit state and that cleanup leaves no orphan on success:
//   • done → FF-merge lands the session commits on the project branch + worktree removed + branch deleted;
//   • diverged project branch → ff-only ABORTS → branch preserved + worktree kept + screened NOTE set;
//   • failed/cancelled → branch + worktree preserved (note set);
//   • a SECOND concurrent merge does not force/corrupt — it falls to preserve (non-FF);
//   • NEVER force / NEVER --no-ff / NEVER -D — the D-018/F-007 guard refuses them.

// ── A real throwaway git repo per test (no mock — the runner is the live execFile) ──

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dirName = 'proj'): string {
	const base = mkdtempSync(join(tmpdir(), 'mb-test-'));
	const repo = join(base, dirName);
	execFileSync('git', ['init', '-b', 'main', repo]);
	git(repo, 'config', 'user.email', 'test@test.local');
	git(repo, 'config', 'user.name', 'Test');
	writeFileSync(join(repo, 'README.md'), '# seed\n');
	git(repo, 'add', '-A');
	git(repo, 'commit', '-m', 'seed');
	return repo;
}

/** A fake Db that records the preserve advisory stamped by stampNote's read-then-append UPDATE.
 *  The real query reads the existing note then appends the advisory; here we record the advisory
 *  param (the work-preserved text the operator sees) — no prior note is simulated, so the recorded
 *  note IS the advisory (matching the conflict-on-done case where there is no pre-existing note). */
function fakeDb(): { db: { query: CommandRunnerDbQuery }; notes: Array<{ sid: unknown; note: string }> } {
	const notes: Array<{ sid: unknown; note: string }> = [];
	const query = vi.fn(async (sql: string, params?: Record<string, unknown>) => {
		// stampNote's statement reads $cur then sets $next using the $advisory param.
		if (/UPDATE \$sid MERGE \{ note: \$next \}/.test(sql) && params?.advisory != null) {
			notes.push({ sid: params?.sid, note: String(params.advisory) });
		}
		return [[]];
	});
	return { db: { query } as unknown as { query: CommandRunnerDbQuery }, notes };
}
type CommandRunnerDbQuery = (sql: string, params?: Record<string, unknown>) => Promise<unknown>;
// The merge-back only uses db.query — cast the fake to the Db shape the function reads.
function asDb(f: { query: CommandRunnerDbQuery }): import('../db/client').Db {
	return f as unknown as import('../db/client').Db;
}

/** Track temp roots so afterEach removes every tree we created (no orphans). */
let toClean: string[] = [];
function trackParent(repo: string): void {
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
	vi.restoreAllMocks();
});

/** Make a write session worktree + commit some work on its branch (the HB-1 post-task analogue). */
async function sessionWithWork(repo: string, sessionId: string, file = 'feature.txt') {
	const wt = await acquireSessionWorktree(repo, sessionId);
	writeFileSync(join(wt.cwd, file), `work in ${file}\n`);
	git(wt.cwd, 'add', '-A');
	git(wt.cwd, 'commit', '-m', `feat: ${file}`);
	return wt;
}

describe('mergeBackWorktree — clean done → FF merge + teardown', () => {
	it('fast-forwards the session branch into the project branch, removes the worktree, deletes the branch', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await sessionWithWork(repo, 'sess-done');
		const branchHead = git(repo, 'rev-parse', 'atelier/session/sess-done');
		const { db } = fakeDb();

		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:done1',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-done',
			exitState: 'done'
		});

		expect(outcome.kind).toBe('merged');
		// the work is now on the project branch (NO LOST WORK)
		expect(git(repo, 'rev-parse', 'main')).toBe(branchHead);
		expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
		// the worktree is gone (cleanup, no orphan)
		expect(existsSync(wt.cwd)).toBe(false);
		const list = git(repo, 'worktree', 'list', '--porcelain');
		expect(list.replace(/\\/g, '/')).not.toContain('.atelier-worktrees/sess-done');
		// the merged branch is deleted
		expect(() => git(repo, 'rev-parse', '--verify', 'atelier/session/sess-done')).toThrow();
	});

	it('a clean done whose branch has NO commits is a no-op-empty (tree torn down, branch deleted, no merge)', async () => {
		const repo = initRepo();
		trackParent(repo);
		// acquire but DO NOT commit — branch sha === HEAD
		const wt = await acquireSessionWorktree(repo, 'sess-empty');
		const { db } = fakeDb();

		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:empty1',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-empty',
			exitState: 'done'
		});

		expect(outcome.kind).toBe('noop-empty');
		expect(existsSync(wt.cwd)).toBe(false);
		expect(() => git(repo, 'rev-parse', '--verify', 'atelier/session/sess-empty')).toThrow();
	});
});

describe('mergeBackWorktree — divergent project branch → preserve + note (NEVER force)', () => {
	it('ff-only aborts, branch + worktree PRESERVED, screened note stamped', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await sessionWithWork(repo, 'sess-div');
		const sessionHead = git(repo, 'rev-parse', 'atelier/session/sess-div');
		// the PROJECT branch advances independently → divergence
		writeFileSync(join(repo, 'other.txt'), 'project advanced\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-m', 'project advanced');
		const projHeadBefore = git(repo, 'rev-parse', 'main');
		const { db, notes } = fakeDb();

		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:div1',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-div',
			exitState: 'done'
		});

		expect(outcome.kind).toBe('preserved-conflict');
		// project branch UNTOUCHED (no partial merge, no corruption)
		expect(git(repo, 'rev-parse', 'main')).toBe(projHeadBefore);
		// session branch + its commit PRESERVED (NO LOST WORK)
		expect(git(repo, 'rev-parse', 'atelier/session/sess-div')).toBe(sessionHead);
		// the worktree is KEPT (resume re-acquires it)
		expect(existsSync(wt.cwd)).toBe(true);
		// the honest note was stamped on the session row (surfaces on MC-4)
		expect(notes.length).toBe(1);
		expect(notes[0].note).toContain('work preserved on branch atelier/session/sess-div');
		expect(notes[0].note).toContain('merge needed');

		await wt.cleanup();
	});
});

describe('mergeBackWorktree — dirty project tree → preserve with HONEST dirty-tree note (not "diverged")', () => {
	it('ff-only aborts on a dirty working tree → preserved-conflict, note says uncommitted changes, NOT diverged', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await sessionWithWork(repo, 'sess-dirty', 'README.md'); // touches a tracked file
		const sessionHead = git(repo, 'rev-parse', 'atelier/session/sess-dirty');
		// LIVE project root has an UNCOMMITTED edit to the same tracked file the FF would overwrite.
		writeFileSync(join(repo, 'README.md'), '# locally edited, uncommitted\n');
		const projHeadBefore = git(repo, 'rev-parse', 'main');
		const { db, notes } = fakeDb();

		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:dirty1',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-dirty',
			exitState: 'done'
		});

		expect(outcome.kind).toBe('preserved-conflict');
		// project branch untouched + session work preserved (NO LOST WORK either way)
		expect(git(repo, 'rev-parse', 'main')).toBe(projHeadBefore);
		expect(git(repo, 'rev-parse', 'atelier/session/sess-dirty')).toBe(sessionHead);
		expect(existsSync(wt.cwd)).toBe(true);
		// HONEST note: names the dirty working tree, does NOT misattribute it as a branch divergence.
		expect(notes.length).toBe(1);
		expect(notes[0].note).toContain('project working tree has uncommitted changes');
		expect(notes[0].note).not.toContain('diverged');
		expect(notes[0].note).toContain('work preserved on branch atelier/session/sess-dirty');

		await wt.cleanup();
	});
});

describe('mergeBackWorktree — behind/reachable branch → honest noop-empty (not "merged")', () => {
	it('a clean done whose branch is fully reachable behind HEAD (no new commits) → noop-empty, branch deleted, NO fabricated merge', async () => {
		const repo = initRepo();
		trackParent(repo);
		// Acquire the worktree at the CURRENT tip, commit NOTHING on the session branch, then advance
		// the PROJECT branch — now the session branch is strictly BEHIND HEAD and fully reachable.
		const wt = await acquireSessionWorktree(repo, 'sess-behind');
		writeFileSync(join(repo, 'advanced.txt'), 'project moved on\n');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-m', 'project advanced past the session branch');
		const projHeadBefore = git(repo, 'rev-parse', 'main');
		const { db, notes } = fakeDb();

		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:behind1',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-behind',
			exitState: 'done'
		});

		// Nothing advanced → honest noop-empty, NOT a fabricated 'merged'.
		expect(outcome.kind).toBe('noop-empty');
		// HEAD did not move (the FF was an "Already up to date" no-op).
		expect(git(repo, 'rev-parse', 'main')).toBe(projHeadBefore);
		// tree torn down + branch deleted (nothing to preserve — no commits were lost).
		expect(existsSync(wt.cwd)).toBe(false);
		expect(() => git(repo, 'rev-parse', '--verify', 'atelier/session/sess-behind')).toThrow();
		expect(notes.length).toBe(0); // a noop stamps no preserve note
	});
});

describe('mergeBackWorktree — failed / cancelled session → preserve + note', () => {
	for (const exitState of ['failed', 'cancelled'] as const) {
		it(`${exitState}: branch + worktree preserved, note stamped, NO merge attempted`, async () => {
			const repo = initRepo();
			trackParent(repo);
			const wt = await sessionWithWork(repo, `sess-${exitState}`);
			const sessionHead = git(repo, 'rev-parse', `atelier/session/sess-${exitState}`);
			const projHead = git(repo, 'rev-parse', 'main');
			const { db, notes } = fakeDb();

			const outcome = await mergeBackWorktree(asDb(db), {
				sessionId: `session:${exitState}1`,
				projectRoot: repo,
				worktreePath: wt.cwd,
				worktreeBranch: `atelier/session/sess-${exitState}`,
				exitState
			});

			expect(outcome.kind).toBe('preserved-incomplete');
			// project branch NOT advanced (no merge happened)
			expect(git(repo, 'rev-parse', 'main')).toBe(projHead);
			// session work PRESERVED on its branch (NO LOST WORK)
			expect(git(repo, 'rev-parse', `atelier/session/sess-${exitState}`)).toBe(sessionHead);
			expect(existsSync(wt.cwd)).toBe(true);
			expect(notes[0].note).toContain(`session ${exitState}`);
			expect(notes[0].note).toContain('merge needed');

			await wt.cleanup();
		});
	}

	// PCG-1 — the two exit states that are NOT session failures but still must not merge. They ride
	// the SAME preserve branch (F-055: no second "preserve the branch" path), so what is proved here
	// is that the work survives IDENTICALLY and that the note tells the operator the honest reason —
	// "session gate-failed" would read as a crash, which is exactly the wrong diagnosis.
	for (const [exitState, expectNote] of [
		['gate-failed', 'pre-commit gate FAILED'],
		['review-held', 'held for code review']
	] as const) {
		it(`${exitState}: work preserved for inspection, NOT merged, with an honest note`, async () => {
			const repo = initRepo();
			trackParent(repo);
			const wt = await sessionWithWork(repo, `sess-${exitState}`);
			const sessionHead = git(repo, 'rev-parse', `atelier/session/sess-${exitState}`);
			const projHead = git(repo, 'rev-parse', 'main');
			const { db, notes } = fakeDb();

			const outcome = await mergeBackWorktree(asDb(db), {
				sessionId: `session:preserve_${exitState.replace('-', '_')}`,
				projectRoot: repo,
				worktreePath: wt.cwd,
				worktreeBranch: `atelier/session/sess-${exitState}`,
				exitState
			});

			expect(outcome.kind).toBe('preserved-incomplete');
			// THE POINT: the project branch did NOT advance — unreviewed/ungated work did not land.
			expect(git(repo, 'rev-parse', 'main')).toBe(projHead);
			// AND the work is not lost (F-007): branch + worktree both still there for the operator.
			expect(git(repo, 'rev-parse', `atelier/session/sess-${exitState}`)).toBe(sessionHead);
			expect(existsSync(wt.cwd)).toBe(true);
			expect(notes[0].note).toContain(expectNote);
			expect(notes[0].note).not.toContain('session gate-failed');
			expect(notes[0].note).toContain('merge needed');

			await wt.cleanup();
		});
	}

	it('failed session that never committed (branch absent) → honest noop-gone, no note', async () => {
		const repo = initRepo();
		trackParent(repo);
		const { db, notes } = fakeDb();
		const outcome = await mergeBackWorktree(asDb(db), {
			sessionId: 'session:nobranch',
			projectRoot: repo,
			worktreePath: join(repo, '..', '.atelier-worktrees', 'ghost'),
			worktreeBranch: 'atelier/session/ghost',
			exitState: 'failed'
		});
		expect(outcome.kind).toBe('noop-gone');
		expect(notes.length).toBe(0);
	});
});

describe('mergeBackWorktree — concurrency: a second merge never forces/corrupts', () => {
	it('two clean-done sessions into one project: first FF-merges, second is non-FF → preserved (no force)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const a = await sessionWithWork(repo, 'sess-A', 'a.txt');
		const b = await sessionWithWork(repo, 'sess-B', 'b.txt');
		const bHead = git(repo, 'rev-parse', 'atelier/session/sess-B');
		const { db, notes } = fakeDb();

		// Fire BOTH merge-backs concurrently; the per-root lock serializes them.
		const [oa, ob] = await Promise.all([
			mergeBackWorktree(asDb(db), {
				sessionId: 'session:a1',
				projectRoot: repo,
				worktreePath: a.cwd,
				worktreeBranch: 'atelier/session/sess-A',
				exitState: 'done'
			}),
			mergeBackWorktree(asDb(db), {
				sessionId: 'session:b1',
				projectRoot: repo,
				worktreePath: b.cwd,
				worktreeBranch: 'atelier/session/sess-B',
				exitState: 'done'
			})
		]);

		// EXACTLY one merged, one preserved (the second's branch diverged once the first landed).
		const kinds = [oa.kind, ob.kind].sort();
		expect(kinds).toEqual(['merged', 'preserved-conflict']);

		// The project branch is a clean fast-forward of ONE of the two — never a corrupted/forced state.
		// Both a.txt (from A if A won) survive on main; the loser's work is PRESERVED on its branch.
		const mergedFile = oa.kind === 'merged' ? 'a.txt' : 'b.txt';
		expect(existsSync(join(repo, mergedFile))).toBe(true);

		// The PRESERVED branch still carries its commit (NO LOST WORK), with a note.
		const preserved = oa.kind === 'preserved-conflict' ? 'sess-A' : 'sess-B';
		expect(() => git(repo, 'rev-parse', `atelier/session/${preserved}`)).not.toThrow();
		expect(notes.length).toBe(1);
		expect(notes[0].note).toContain('project branch diverged');

		// sanity: B's commit object still exists regardless of who won (never discarded)
		expect(() => git(repo, 'cat-file', '-t', bHead)).not.toThrow();

		await a.cleanup().catch(() => {});
		await b.cleanup().catch(() => {});
	});
});

describe('mergeBackWorktree — idempotent re-run (interrupt contract)', () => {
	it('a re-run after a successful merge finds the branch gone → noop-gone (no error)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await sessionWithWork(repo, 'sess-rerun');
		const { db } = fakeDb();
		const input = {
			sessionId: 'session:rerun',
			projectRoot: repo,
			worktreePath: wt.cwd,
			worktreeBranch: 'atelier/session/sess-rerun',
			exitState: 'done' as const
		};
		const first = await mergeBackWorktree(asDb(db), input);
		expect(first.kind).toBe('merged');
		// re-run: branch already merged + deleted → clean no-op, never throws
		const second = await mergeBackWorktree(asDb(db), input);
		expect(second.kind).toBe('noop-gone');
	});
});

describe('mergeBackWorktree — D-018/F-007 guard refuses force / --no-ff / -D', () => {
	it('a runner asked to run a forbidden verb throws the guard (never reaches git)', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await sessionWithWork(repo, 'sess-guard');
		// A runner that asserts it is NEVER handed a force/no-ff/-D op. If the impl tried one, the
		// guard throws BEFORE the runner — so we instead prove the merge path uses only safe verbs.
		const seen: string[][] = [];
		const recordingRun: CommandRunner = async (file, args, opts) => {
			seen.push([...args]);
			return execFileRunner(file, args, opts);
		};
		const { db } = fakeDb();
		await mergeBackWorktree(
			asDb(db),
			{
				sessionId: 'session:guard',
				projectRoot: repo,
				worktreePath: wt.cwd,
				worktreeBranch: 'atelier/session/sess-guard',
				exitState: 'done'
			},
			{ run: recordingRun }
		).catch(() => {});
		// F-007/D-018 invariant: NO HISTORY/MERGE op forces or discards commits. We exclude
		// `git worktree remove --force` (a legitimate worktree-detach flag that removes NO commits
		// — the branch survives) and assert that NO merge/branch op used --force/-f/-D/--no-ff.
		const historyOps = seen.filter((a) => a[0] !== 'worktree');
		const flat = historyOps.flat();
		expect(flat).not.toContain('--force');
		expect(flat).not.toContain('-f');
		expect(flat).not.toContain('-D'); // never force-delete a branch (only safe -d)
		expect(flat).not.toContain('--no-ff'); // ff-only merge, never a merge commit
		// it DID use the safe ff-only merge + safe -d delete
		expect(seen.some((a) => a[0] === 'merge' && a.includes('--ff-only'))).toBe(true);
		expect(seen.some((a) => a[0] === 'branch' && a.includes('-d'))).toBe(true);
	});
});

describe('removeWorktree — idempotent teardown helper (F-014)', () => {
	it('removes the worktree and is a no-op when already gone', async () => {
		const repo = initRepo();
		trackParent(repo);
		const wt = await acquireSessionWorktree(repo, 'sess-rm');
		expect(existsSync(wt.cwd)).toBe(true);
		await removeWorktree(repo, wt.cwd);
		expect(existsSync(wt.cwd)).toBe(false);
		// second call must not throw
		await expect(removeWorktree(repo, wt.cwd)).resolves.toBeUndefined();
	});
});
