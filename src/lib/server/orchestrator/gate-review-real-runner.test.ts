import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreCommitGate } from './pre-commit-gate';
import { countChangedFiles } from './review';

// PCG-1 — THE REAL-RUNNER CONTRACT (the artifact the D-038 DoD-review found missing).
//
// WHY THIS FILE EXISTS. Every other gate/review test injects a scripted CommandRunner, and BOTH of
// this feature's shipped defects survived a green suite precisely because of that:
//   • the gate's npm steps were spawned in a WI-2 worktree with no node_modules — a fake runner
//     answers `npm run build` with whatever the test wants, so the real "'vite' is not recognized"
//     exit-1 (a FALSE RED that wedged every write task) was invisible;
//   • the review measured its diff with the default ref 'HEAD' AFTER committing — a fake `git diff`
//     returns a fabricated file list for ANY ref, so the real, always-EMPTY diff was invisible.
// So these tests use the DEFAULT `execFileRunner` (no `run`/`runner` option) against REAL temp
// trees and a REAL `git init`. They are the only place the production defaults are exercised.
//
// Bounded by construction (F-014 discipline): every spawn is git or npm in a temp dir, each one is
// a single short-lived process, and every dir is removed in `afterAll`. Nothing is left running.

/** Run a real git command in `cwd`; throws with git's own message on failure. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real git repo with one seed commit, and `n` files added + committed on top. */
function repoWithCommittedChange(n: number): { dir: string; preSha: string } {
	const dir = mkdtempSync(join(tmpdir(), 'pcg-real-git-'));
	git(dir, 'init', '-q', '.');
	git(dir, 'config', 'user.email', 'gate@test');
	git(dir, 'config', 'user.name', 'gate');
	writeFileSync(join(dir, 'seed.txt'), 'seed\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'seed');
	const preSha = git(dir, 'rev-parse', '--verify', 'HEAD');
	for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'the agent change');
	return { dir, preSha };
}

const dirs: string[] = [];
function track<T extends { dir: string }>(made: T): T {
	dirs.push(made.dir);
	return made;
}

/** An npm project on disk. `installed` decides whether a node_modules tree exists. */
function npmProject(installed: boolean, scripts: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'pcg-real-npm-'));
	dirs.push(dir);
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'real', scripts }));
	if (installed) mkdirSync(join(dir, 'node_modules'));
	return dir;
}

let gitAvailable = true;
beforeAll(() => {
	try {
		execFileSync('git', ['--version'], { encoding: 'utf8' });
	} catch {
		gitAvailable = false;
	}
});

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('REAL RUNNER — the pre-commit gate against a real, UNINSTALLED npm tree', () => {
	it('does NOT spawn npm and does NOT go RED when node_modules is absent (the wedge, closed)', async () => {
		const dir = npmProject(false, { build: 'vite build', test: 'vitest run' });
		// No `run` option ⇒ the production execFileRunner. Before the fix this spawned `npm run
		// build`, which exits 1 in an uninstalled tree, and the gate came back 'failed'.
		const gate = await runPreCommitGate({ cwd: dir, buildTool: 'npm', testCommand: 'npm test' });

		expect(gate.status).toBe('skipped');
		expect(gate.failedAt).toBeNull();
		expect(gate.verified).toBe(false);
		expect(gate.errored).toBe(false);
		expect(gate.steps.every((s) => !s.ran)).toBe(true);
		expect(gate.steps.find((s) => s.name === 'build')?.detail).toMatch(/NO installed dependency tree/);
	}, 30_000);

	it('an INSTALLED tree is honest about the SHIM limit — never an unexplained exit-1 RED', async () => {
		// The second half of the same defect, found by running the real runner: on Windows `npm` is
		// a `.cmd`, and `execFile(…, {shell:false})` (D-008) cannot spawn it — ENOENT, which the
		// seam reports as EXIT CODE 1 WITH EMPTY OUTPUT. That was an unexplained RED on a tree with
		// nothing wrong with it. Whatever the platform, the gate must never claim a verdict it did
		// not earn.
		const dir = npmProject(true, { build: 'node --eval process.exit(0)' });
		const gate = await runPreCommitGate({ cwd: dir, buildTool: 'npm' });
		const build = gate.steps.find((s) => s.name === 'build')!;

		if (build.ran) {
			// A platform where the argv-only seam CAN spawn npm: it really ran, and really passed.
			expect(gate.status).toBe('passed');
			expect(build.code).toBe(0);
		} else {
			// A platform where it cannot: an honest, NAMED skip — not a RED, and never an empty one.
			expect(gate.status).toBe('skipped');
			expect(gate.failedAt).toBeNull();
			expect(build.detail).toMatch(/shim, which the argv-only command seam refuses to spawn/);
		}
	}, 60_000);

	it('the default runner really DOES spawn — a spawnable tool exits for real, red and green', async () => {
		// Proves the pre-flight did not neuter the gate: `node` is a real executable on every
		// platform, so these two verdicts can only come from live processes.
		const dir = npmProject(true, {});
		const red = await runPreCommitGate({ cwd: dir, buildTool: 'node --eval process.exit(7)' });
		expect(red.status).toBe('failed');
		expect(red.failedAt).toBe('build');
		expect(red.errored).toBe(false); // it RAN and failed — not an infrastructure fault
		expect(red.steps.find((s) => s.name === 'build')?.code).toBe(7);

		const green = await runPreCommitGate({ cwd: dir, buildTool: 'node --eval process.exit(0)' });
		expect(green.status).toBe('passed');
		expect(green.verified).toBe(true);
		expect(green.steps.find((s) => s.name === 'build')?.code).toBe(0);
	}, 60_000);
});

describe('REAL RUNNER — countChangedFiles against a real git repo', () => {
	it("'HEAD' after a commit measures NOTHING — the exact defect the scripted runner hid", async () => {
		if (!gitAvailable) return;
		const { dir } = track(repoWithCommittedChange(6));
		// This is what production did: the post-task loop committed, then counted with the default
		// ref. `git diff <ref>` is WORKING TREE vs ref, and the tree is clean after a commit.
		expect(await countChangedFiles({ cwd: dir })).toBe(0);
		expect(await countChangedFiles({ cwd: dir, baseRef: 'HEAD' })).toBe(0);
	}, 30_000);

	it('the PRE-COMMIT sha measures the real footprint (6 files ⇒ over the review threshold)', async () => {
		if (!gitAvailable) return;
		const { dir, preSha } = track(repoWithCommittedChange(6));
		expect(await countChangedFiles({ cwd: dir, baseRef: preSha })).toBe(6);
	}, 30_000);

	it("git's EMPTY TREE measures a ROOT commit, so an initial import is not counted as 0", async () => {
		if (!gitAvailable) return;
		const dir = mkdtempSync(join(tmpdir(), 'pcg-real-root-'));
		dirs.push(dir);
		git(dir, 'init', '-q', '.');
		git(dir, 'config', 'user.email', 'gate@test');
		git(dir, 'config', 'user.name', 'gate');
		// An UNBORN HEAD: this is what makes post-task fall back to the empty tree.
		expect(() => git(dir, 'rev-parse', '--verify', 'HEAD')).toThrow();
		for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(dir, f), 'export {};\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', 'root');

		expect(
			await countChangedFiles({ cwd: dir, baseRef: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' })
		).toBe(3);
	}, 30_000);

	it('a non-repo cwd counts 0 and never throws into the post-task path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pcg-real-norepo-'));
		dirs.push(dir);
		expect(await countChangedFiles({ cwd: dir, baseRef: 'HEAD' })).toBe(0);
	}, 30_000);
});
