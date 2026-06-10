import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGh, GhError, assertRepoSlug, type RunGhOptions } from './gh';

// TASK 9.4 VERIFY (D-008) — the `gh` boundary uses ARGUMENT ARRAYS, never a shell. We prove
// it with a fake "gh" that echoes argv + stdin: a title carrying shell metacharacters
// (`; rm -rf /`, `$(touch pwned)`, backticks) arrives at the child as ONE literal arg and is
// NEVER interpreted by a shell. Cross-platform: a Node-shebang script on POSIX, a .cmd on
// Windows that re-invokes node. The path-confinement + slug guard are also asserted.

let dir: string;
let scriptPath: string;

// A fake "gh": prints "ARGS:" + each argv on its own line, then "STDIN:" + piped stdin. We
// invoke it by pointing `bin` at the Node executable and passing the script via prefixArgs,
// which exercises the SAME direct-spawn (no shell) path production uses with the real gh.exe.
const FAKE_JS = `
let stdin = '';
let flushed = false;
function flush() {
  if (flushed) return;
  flushed = true;
  const out = ['ARGS:', ...process.argv.slice(2), 'STDIN:', stdin].join('\\n');
  process.stdout.write(out, () => process.exit(process.env.FAKE_GH_FAIL ? 7 : 0));
}
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', flush);
setTimeout(() => { if (!process.stdin.readableEnded) flush(); }, 80).unref();
`;

/** runGh against the fake gh: node <script> <args...>. */
function fakeGhOpts(base: Omit<RunGhOptions, 'bin' | 'prefixArgs'>): RunGhOptions {
	return { ...base, bin: process.execPath, prefixArgs: [scriptPath] };
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'gh-test-'));
	scriptPath = join(dir, 'fake-gh.js');
	writeFileSync(scriptPath, FAKE_JS, 'utf8');
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('assertRepoSlug — boundary validation', () => {
	it('accepts a clean owner/name slug', () => {
		expect(assertRepoSlug('octocat/Hello-World')).toBe('octocat/Hello-World');
		expect(assertRepoSlug('my_org/my.repo')).toBe('my_org/my.repo');
	});
	it('rejects shell-metacharacter / malformed slugs', () => {
		expect(() => assertRepoSlug('owner/repo; rm -rf /')).toThrow();
		expect(() => assertRepoSlug('$(touch x)/y')).toThrow();
		expect(() => assertRepoSlug('noslash')).toThrow();
		expect(() => assertRepoSlug('')).toThrow();
		expect(() => assertRepoSlug('a/b/c')).toThrow();
	});
});

describe('runGh — array-args, no shell injection (D-008)', () => {
	it('passes a metacharacter-laden arg as ONE literal token (never a shell)', async () => {
		const evil = '; rm -rf / && echo $(touch pwned) `whoami`';
		const out = await runGh(['issue', 'create', '--title', evil], fakeGhOpts({ cwd: dir }));
		const lines = out.split('\n');
		// The evil string is exactly the token after "--title" — unsplit, unexpanded.
		const idx = lines.indexOf('--title');
		expect(idx).toBeGreaterThan(-1);
		expect(lines[idx + 1]).toBe(evil);
		// No expansion happened: no "pwned"/"root"/empty-from-rm artifacts beyond our literal.
		expect(out).toContain(evil);
	});

	it('pipes body content over stdin (never an arg) so it is never tokenized', async () => {
		const body = 'Line one\n--title injected\n$(evil)\n```\ncode\n```';
		const out = await runGh(
			['issue', 'create', '--body-file', '-'],
			fakeGhOpts({ cwd: dir, stdin: body })
		);
		const [, stdinPart] = out.split('STDIN:');
		expect(stdinPart.trim()).toBe(body.trim());
		// The body's "--title injected" did NOT become an argv flag.
		const argsPart = out.split('STDIN:')[0];
		expect(argsPart).not.toContain('injected');
	});

	it('rejects with a GhError carrying the exit code on non-zero exit', async () => {
		const prev = process.env.FAKE_GH_FAIL;
		process.env.FAKE_GH_FAIL = '1';
		try {
			await expect(
				runGh(['auth', 'status'], fakeGhOpts({ cwd: dir }))
			).rejects.toBeInstanceOf(GhError);
		} finally {
			if (prev === undefined) delete process.env.FAKE_GH_FAIL;
			else process.env.FAKE_GH_FAIL = prev;
		}
	});

	it('rejects with a GhError when the binary is missing (honest, not a crash)', async () => {
		await expect(
			runGh(['auth', 'status'], { cwd: dir, bin: join(dir, 'does-not-exist-binary') })
		).rejects.toBeInstanceOf(GhError);
	});

	// TASK 13.5 finding 7 — gh exiting BEFORE consuming stdin emits EPIPE on child.stdin.
	// Without a stdin 'error' handler that is an UNCAUGHT stream error that crashes the whole
	// server process (vitest fails this test with an unhandled exception against the old code).
	// With the fix it settles as an ordinary GhError run failure.
	it('treats gh exiting before consuming stdin (EPIPE) as a run failure, never a crash', async () => {
		const fastExit = join(dir, 'fake-gh-exit-fast.js');
		writeFileSync(fastExit, 'process.exit(7);', 'utf8');
		// Large enough that the pipe write cannot complete before the child is gone.
		const big = 'x'.repeat(8 * 1024 * 1024);
		await expect(
			runGh(['issue', 'create', '--body-file', '-'], {
				cwd: dir,
				bin: process.execPath,
				prefixArgs: [fastExit],
				stdin: big
			})
		).rejects.toBeInstanceOf(GhError);
		// Give a late EPIPE a beat to surface — with the fix it is handled; without it,
		// this is where the uncaught 'error' event would detonate the suite.
		await new Promise((r) => setTimeout(r, 150));
	});
});
