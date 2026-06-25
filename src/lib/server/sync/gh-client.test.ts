import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubCliClient, assertRepoName, assertBranchName } from './gh-client';

// RC-1 VERIFY (REPO-CREATION-SPEC; D-008; D-026; F-008) — `createRepo` is exercised against a
// STUBBED `gh` (a fake-gh Node script pointed at via the `bin` override). NO real network, NO
// real `gh`, NO real repo is created. The fake records its full argv to a file so we can assert
// the EXACT command — proving `--private` is ALWAYS present (private-first, public
// unrepresentable) and that a metacharacter-laden name arrives as ONE inert argv element.
//
// The real client invokes `gh` directly (no shell): we point `bin` at the Node executable and
// pass a fake-gh script, exercising the SAME direct-spawn path production uses with real gh.exe.

let dir: string;
let scriptPath: string;
let argvLog: string;

// A fake "gh": branches on subcommand.
//  - `auth status`      → exit 0 (authed) unless FAKE_GH_UNAUTHED is set (exit 1).
//  - `repo create <…>`  → appends its full argv to FAKE_GH_ARGV_LOG, then:
//       * FAKE_GH_MODE=exists  → stderr "Name already exists on this account", exit 1
//       * FAKE_GH_MODE=denied  → stderr "HTTP 403: Resource not accessible", exit 1
//       * FAKE_GH_MODE=other   → stderr "could not create repository: server error", exit 1
//       * default              → stdout the canonical https URL for the slug, exit 0
const FAKE_JS = `
const fs = require('fs');
const argv = process.argv.slice(2);
const sub = argv[0] + ' ' + (argv[1] || '');
if (sub === 'auth status') {
  process.exit(process.env.FAKE_GH_UNAUTHED ? 1 : 0);
}
if (sub === 'repo create') {
  if (process.env.FAKE_GH_ARGV_LOG) {
    fs.writeFileSync(process.env.FAKE_GH_ARGV_LOG, JSON.stringify(argv));
  }
  const mode = process.env.FAKE_GH_MODE || 'ok';
  if (mode === 'exists') { process.stderr.write('GraphQL: Name already exists on this account (createRepository)'); process.exit(1); }
  if (mode === 'denied') { process.stderr.write('HTTP 403: Resource not accessible by integration'); process.exit(1); }
  if (mode === 'other')  { process.stderr.write('could not create repository: upstream server error'); process.exit(1); }
  // A BENIGN error that merely MENTIONS 'scope' (not a permission refusal) — must NOT be permission-denied.
  if (mode === 'benignscope') { process.stderr.write('error: the requested name is out of scope for this template'); process.exit(1); }
  // Empty stderr, non-zero exit (the noisy err.message leak case — finding #5).
  if (mode === 'emptyerr') { process.exit(7); }
  const slug = argv[2];
  process.stdout.write('https://github.com/' + slug + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake-gh invocation: ' + argv.join(' '));
process.exit(2);
`;

/**
 * A client whose `gh` is the fake-gh Node script: bin = the Node executable, prefixArgs =
 * [scriptPath]. The client spawns node directly with an args ARRAY (no shell — D-008),
 * exercising the SAME direct-spawn path production uses with the real gh.exe binary.
 */
function fakeClient(): GitHubCliClient {
	return new GitHubCliClient({ bin: process.execPath, prefixArgs: [scriptPath] });
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'gh-client-test-'));
	scriptPath = join(dir, 'fake-gh.js');
	argvLog = join(dir, 'argv.json');
	writeFileSync(scriptPath, FAKE_JS, 'utf8');
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.FAKE_GH_UNAUTHED;
	delete process.env.FAKE_GH_MODE;
	delete process.env.FAKE_GH_ARGV_LOG;
});

function resetEnv() {
	delete process.env.FAKE_GH_UNAUTHED;
	delete process.env.FAKE_GH_MODE;
	process.env.FAKE_GH_ARGV_LOG = argvLog;
}

describe('assertRepoName — boundary validation (D-008)', () => {
	it('accepts clean repo names', () => {
		expect(assertRepoName('atelier')).toBe('atelier');
		expect(assertRepoName('my.repo_1-x')).toBe('my.repo_1-x');
	});
	it('rejects shell-metacharacter / malformed names', () => {
		expect(() => assertRepoName('repo; rm -rf /')).toThrow();
		expect(() => assertRepoName('$(touch x)')).toThrow();
		expect(() => assertRepoName('a/b')).toThrow();
		expect(() => assertRepoName('')).toThrow();
		expect(() => assertRepoName('-leading-dash')).toThrow();
	});
});

describe('GitHubCliClient.createRepo — private-first, honest named outcomes (RC-1)', () => {
	it('ALWAYS passes --private and returns the URL on success (private-first)', async () => {
		resetEnv();
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('created');
		if (res.kind === 'created') {
			expect(res.url).toBe('https://github.com/octo/atelier');
		}
		// The recorded argv proves the EXACT command carried --private and the inert slug.
		const argv = JSON.parse(readArgv()) as string[];
		expect(argv).toEqual(['repo', 'create', 'octo/atelier', '--private']);
		expect(argv).toContain('--private');
	});

	it('uses the bare name (no owner) when owner is omitted, still --private', async () => {
		resetEnv();
		const res = await fakeClient().createRepo({ name: 'atelier' }, dir);
		expect(res.kind).toBe('created');
		const argv = JSON.parse(readArgv()) as string[];
		expect(argv).toEqual(['repo', 'create', 'atelier', '--private']);
	});

	it('maps an existing repo to the named already-exists outcome (idempotent)', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'exists';
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('already-exists');
	});

	it('maps a 403/permission stderr to the named permission-denied outcome', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'denied';
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('permission-denied');
		if (res.kind === 'permission-denied') expect(res.reason).toMatch(/permitted|permission/i);
	});

	it('maps any other gh failure to the named error outcome (honest, not a crash)', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'other';
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('error');
		if (res.kind === 'error') expect(res.reason).toMatch(/upstream server error/i);
	});

	it('returns the named unauthed outcome when gh is not authenticated (no fabricated success)', async () => {
		resetEnv();
		process.env.FAKE_GH_UNAUTHED = '1';
		// Remove any argv recorded by a prior test so we can PROVE repo-create never ran.
		rmSync(argvLog, { force: true });
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('unauthed');
		if (res.kind === 'unauthed') expect(res.reason).toBeTruthy();
		// Precheck failed → `gh repo create` must NEVER have run (no argv file written).
		expect(existsSync(argvLog)).toBe(false);
	});

	it('a name with shell metacharacters is rejected at the boundary (inert, never a shell)', async () => {
		resetEnv();
		// createRepo validates the name; a metachar-laden name throws BEFORE any gh call.
		await expect(
			fakeClient().createRepo({ name: '; rm -rf / && echo $(touch pwned)' }, dir)
		).rejects.toThrow(/invalid GitHub repo name/);
	});

	it('a metacharacter-laden OWNER is rejected at the boundary', async () => {
		resetEnv();
		await expect(
			fakeClient().createRepo({ name: 'atelier', owner: 'evil; rm -rf /' }, dir)
		).rejects.toThrow(/invalid GitHub owner/);
	});

	// Public is UNREPRESENTABLE: there is no input field to request it. This is a
	// type-level guarantee — the following would be a compile error, asserted here in prose +
	// the runtime check that --private is always present (above). A red-team caller cannot
	// pass { private: false } / { visibility: 'public' } because CreateRepoInput has no such key.
	it('exposes no way to request a public repo (private is unrepresentable in the input)', async () => {
		resetEnv();
		// @ts-expect-error — CreateRepoInput has no `private`/`visibility` field; public is untypeable.
		const res = await fakeClient().createRepo({ name: 'atelier', private: false }, dir);
		// Even when a caller smuggles an extra key, the impl ignores it and still sends --private.
		expect(res.kind).toBe('created');
		const argv = JSON.parse(readArgv()) as string[];
		expect(argv).toContain('--private');
		expect(argv).not.toContain('--public');
	});
});

describe('createRepo error mapping — finding #4 (scope over-broad) + #5 (empty-stderr leak)', () => {
	it('a BENIGN error that merely mentions "scope" is NOT mislabeled permission-denied (finding #4)', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'benignscope';
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('error'); // honest error, NOT permission-denied
		if (res.kind === 'error') expect(res.reason).toMatch(/out of scope/i);
	});

	it('a genuine OAuth-scope refusal still maps to permission-denied (finding #4 keeps real refusals)', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'denied'; // "HTTP 403: Resource not accessible by integration"
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('permission-denied');
	});

	it('an empty-stderr non-zero exit yields a CLEAN operator message, not the internal err string (finding #5)', async () => {
		resetEnv();
		process.env.FAKE_GH_MODE = 'emptyerr';
		const res = await fakeClient().createRepo({ name: 'atelier', owner: 'octo' }, dir);
		expect(res.kind).toBe('error');
		if (res.kind === 'error') {
			// No internal "gh repo create failed: …" / "Command failed" leakage; a clean operator line.
			expect(res.reason).not.toMatch(/gh repo create|Command failed|failed: /i);
			expect(res.reason).toMatch(/GitHub CLI exited|did not respond/i);
		}
	});
});

describe('assertBranchName — flag-shaped / ref-unsafe rejection (RC-2 finding #2)', () => {
	it('accepts plain branch names', () => {
		expect(assertBranchName('main')).toBe('main');
		expect(assertBranchName('feature/x-1')).toBe('feature/x-1');
		expect(assertBranchName('release.2')).toBe('release.2');
	});
	it('rejects a leading-dash / flag-shaped branch', () => {
		expect(() => assertBranchName('-x')).toThrow(/invalid git branch/);
		expect(() => assertBranchName('--upload-pack=touch pwned')).toThrow(/invalid git branch/);
	});
	it('rejects ref-unsafe / empty branches', () => {
		expect(() => assertBranchName('')).toThrow();
		expect(() => assertBranchName('has space')).toThrow();
		expect(() => assertBranchName('a..b')).toThrow();
		expect(() => assertBranchName('a~1')).toThrow();
		expect(() => assertBranchName('foo.lock')).toThrow();
		expect(() => assertBranchName('foo@{1}')).toThrow();
	});
});

function readArgv(): string {
	return readFileSync(argvLog, 'utf8');
}
