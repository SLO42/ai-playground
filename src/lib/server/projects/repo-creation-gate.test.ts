import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, getProject, updateProject } from './repo';
import {
	runRepoCreationGate,
	repoCreateConfirmToken,
	REPO_CREATE_ADAPTER_ID,
	sameRepoTarget
} from './repo-creation-gate';
import type { CommandResult, CommandRunner } from '../orchestrator/post-task';
import type { GitHubClient, CreateRepoInput, CreateRepoOutcome, AuthStatus } from '../sync/gh-client';
import { confirmTokenFor } from '../adapters/driver';

// RC-2 VERIFY — the GATED repo-creation driver against a REAL throwaway SurrealDB. The gh seam and the
// outward git runner are STUBBED (NO real network, NO real `gh`, NO real `git push`, NO real repo). The
// project row asserted is a real DB row (F-008). Covers the BUILD prompt's integrity cases:
//   • consent + valid token + authed → create → remote add + push → repo_url written (created:true);
//   • MISSING consent → fail closed at 'consent', NO outward call;
//   • BAD/forged token → fail closed at 'token', NO outward call (a publish token cannot confirm);
//   • not authed → halt at 'auth', NO create;
//   • requestedPublic → halt at 'private' (private-first, NEVER created);
//   • already-exists → honest no-op success, remote still backed, repo_url recorded;
//   • already-set origin → idempotent (git remote add dup absorbed), push still runs;
//   • a push failure → named red at 'remote';
//   • GH_TOKEN value never appears in any check detail (D-026).

let tdb: TestDb;
let db: Db;
let projectId: string;
let seq = 0;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain('0062_pm_repo_create_preauthorized');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query('DELETE project;').catch(() => {});
	const p = await createProject(db, {
		slug: `rcgate${++seq}`,
		name: 'Repo Host',
		root_path: 'F:/code/whatever'
	});
	projectId = p.id;
});

// ── A controllable fake GitHubClient (NO network) ──────────────────────────────────────
class FakeClient implements GitHubClient {
	authed = true;
	createOutcome: CreateRepoOutcome = { kind: 'created', url: 'https://github.com/me/repo-host' };
	createCalls: Array<{ input: CreateRepoInput; cwd: string }> = [];
	authCalls = 0;
	/** The login resolveOwner returns. null = gh could not resolve it (finding #3 fallback). */
	ownerLogin: string | null = 'me';
	resolveOwnerCalls = 0;

	async isAuthenticated(): Promise<AuthStatus> {
		this.authCalls++;
		return this.authed ? { ok: true } : { ok: false, reason: 'GitHub CLI is not authenticated — run `gh auth login` or set GH_TOKEN.' };
	}
	async resolveOwner(): Promise<string | null> {
		this.resolveOwnerCalls++;
		return this.ownerLogin;
	}
	async resolveRepo(): Promise<string | null> {
		return null;
	}
	async listIssues() {
		return [];
	}
	async createIssue() {
		return { number: 1, url: 'x' };
	}
	async updateIssue() {}
	async createRepo(input: CreateRepoInput, cwd: string): Promise<CreateRepoOutcome> {
		this.createCalls.push({ input, cwd });
		return this.createOutcome;
	}
}

/** A git runner that captures every (file,args,cwd) and returns scripted exits keyed by the verb. */
function fakeGit(
	opts: {
		remoteAddCode?: number;
		remoteAddOut?: string;
		setUrlCode?: number;
		setUrlOut?: string;
		pushCode?: number;
		pushOut?: string;
		/** The branch `git symbolic-ref --short HEAD` reports. '' = unborn/detached (non-zero exit). Default 'main'. */
		currentBranch?: string;
		/** The local branches `git rev-parse --verify --quiet refs/heads/<b>` finds. Default: [currentBranch]. */
		existingBranches?: string[];
		/** Exit code for the `git branch -m master <b>` normalization (F-050). Default 0. */
		renameCode?: number;
		renameOut?: string;
	} = {}
) {
	const currentBranch = opts.currentBranch ?? 'main';
	const existingBranches = opts.existingBranches ?? (currentBranch ? [currentBranch] : []);
	const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
	const fn: CommandRunner = async (file, args, o): Promise<CommandResult> => {
		calls.push({ file, args: [...args], cwd: o.cwd });
		// F-050 branch resolution: `git symbolic-ref --short HEAD` → current branch; `git rev-parse
		// --verify --quiet refs/heads/<b>` → does <b> exist; `git branch -m master <b>` → normalize.
		if (args[0] === 'symbolic-ref') {
			return currentBranch
				? { code: 0, stdout: `${currentBranch}\n`, stderr: '' }
				: { code: 1, stdout: '', stderr: 'fatal: ref HEAD is not a symbolic ref' };
		}
		if (args[0] === 'rev-parse' && args[1] === '--verify') {
			const ref = args[args.length - 1]; // refs/heads/<name>
			const name = ref.replace(/^refs\/heads\//, '');
			return { code: existingBranches.includes(name) ? 0 : 1, stdout: '', stderr: '' };
		}
		if (args[0] === 'branch' && args[1] === '-m') {
			return { code: opts.renameCode ?? 0, stdout: '', stderr: opts.renameCode ? (opts.renameOut ?? 'rename failed') : '' };
		}
		// `git remote add origin <url>` → args[0]='remote',args[1]='add'; `git remote set-url origin <url>`
		// → args[1]='set-url'; `git push -u origin <branch>` → args[0]='push'.
		if (args[0] === 'remote' && args[1] === 'add') {
			return { code: opts.remoteAddCode ?? 0, stdout: '', stderr: opts.remoteAddOut ?? '' };
		}
		if (args[0] === 'remote' && args[1] === 'set-url') {
			return { code: opts.setUrlCode ?? 0, stdout: '', stderr: opts.setUrlOut ?? '' };
		}
		if (args[0] === 'push') {
			return { code: opts.pushCode ?? 0, stdout: opts.pushOut ?? '', stderr: opts.pushCode ? (opts.pushOut ?? 'rejected') : '' };
		}
		return { code: 0, stdout: '', stderr: '' };
	};
	return { fn, calls };
}

function validToken(name = 'repo-host', owner?: string) {
	return repoCreateConfirmToken({ projectId, name, owner });
}

// ── HAPPY PATH ──────────────────────────────────────────────────────────────────────────
describe('runRepoCreationGate — consent + valid token + authed → creates, backs, records', () => {
	it('drives create → remote add → push → repo_url written (created:true)', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken(),
			name: 'repo-host',
			branch: 'main',
			client,
			gitRunner: git.fn
		});

		expect(out.created).toBe(true);
		expect(out.failedAt).toBeNull();
		expect(out.createOutcome).toBe('created');
		expect(out.repoUrl).toBe('https://github.com/me/repo-host');
		expect(out.checks.map((c) => c.name)).toEqual(['consent', 'token', 'auth', 'private', 'create', 'remote', 'url']);
		expect(out.checks.every((c) => c.ok)).toBe(true);

		// createRepo got NO public field (private-first) + the project cwd.
		expect(client.createCalls.length).toBe(1);
		expect(client.createCalls[0].input).toEqual({ name: 'repo-host' });
		expect('owner' in client.createCalls[0].input).toBe(false);
		expect(client.createCalls[0].cwd).toBe('F:/code/whatever');

		// The OUTWARD runner did remote add + push -u origin -- main (D-008 array args; the `--`
		// separator means a branch can never be misparsed as a flag — RC-2 finding #2).
		expect(git.calls).toEqual([
			{ file: 'git', args: ['symbolic-ref', '--short', 'HEAD'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['remote', 'add', 'origin', 'https://github.com/me/repo-host'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['push', '-u', 'origin', '--', 'main'], cwd: 'F:/code/whatever' }
		]);

		// repo_url persisted (F-013 normalized, real DB read-back).
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('defaults the push branch to main when none given', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(git.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'main']);
	});
});

// ── MISSING CONSENT → fail closed, no outward call ───────────────────────────────────────
describe('runRepoCreationGate — no consent fails closed', () => {
	it('consent:false → failedAt consent, NO createRepo, NO git', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({ db, projectId, consent: false, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('consent');
		expect(client.createCalls.length).toBe(0);
		expect(git.calls.length).toBe(0);
		expect(client.authCalls).toBe(0);
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBeUndefined();
	});
});

// ── BAD / FORGED TOKEN → fail closed ─────────────────────────────────────────────────────
describe('runRepoCreationGate — invalid confirm token fails closed', () => {
	it('a missing token → failedAt token, NO outward call', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: '', name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('token');
		expect(client.createCalls.length).toBe(0);
		expect(git.calls.length).toBe(0);
	});

	it('a token for a DIFFERENT name does not confirm (forge attempt)', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const wrong = repoCreateConfirmToken({ projectId, name: 'some-other-repo' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: wrong, name: 'repo-host', client, gitRunner: git.fn });
		expect(out.failedAt).toBe('token');
		expect(client.createCalls.length).toBe(0);
	});

	it('a PUBLISH-kind token cannot confirm a repo-create (kind isolation)', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		// A token derived the publish way (kind:'publish') over the same id/config — must NOT match.
		const publishTok = confirmTokenFor({ projectId, kind: 'publish', adapterId: REPO_CREATE_ADAPTER_ID, config: { name: 'repo-host' } });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: publishTok, name: 'repo-host', client, gitRunner: git.fn });
		expect(out.failedAt).toBe('token');
		expect(client.createCalls.length).toBe(0);
	});
});

// ── NOT AUTHED → halt at auth, no create ─────────────────────────────────────────────────
describe('runRepoCreationGate — unauthenticated gh halts before create', () => {
	it('not authed → failedAt auth, NO createRepo', async () => {
		const client = new FakeClient();
		client.authed = false;
		const git = fakeGit();
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('auth');
		expect(client.createCalls.length).toBe(0);
		expect(git.calls.length).toBe(0);
	});
});

// ── PRIVATE-FIRST re-asserted ────────────────────────────────────────────────────────────
describe('runRepoCreationGate — private-first is non-negotiable', () => {
	it('requestedPublic:true → failedAt private, NEVER creates', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken(),
			name: 'repo-host',
			requestedPublic: true,
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('private');
		expect(client.createCalls.length).toBe(0);
		expect(git.calls.length).toBe(0);
	});
});

// ── IDEMPOTENT already-exists ────────────────────────────────────────────────────────────
describe('runRepoCreationGate — idempotent already-exists is an honest no-op success', () => {
	it('already-exists → created:true, remote still backed, repo_url recorded', async () => {
		const client = new FakeClient();
		client.createOutcome = { kind: 'already-exists' };
		const git = fakeGit();
		// owner is part of the token's config — supply the token derived WITH the owner.
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken('repo-host', 'me'), name: 'repo-host', owner: 'me', client, gitRunner: git.fn });
		expect(out.created).toBe(true);
		expect(out.createOutcome).toBe('already-exists');
		expect(out.repoUrl).toBe('https://github.com/me/repo-host');
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('an already-set origin is absorbed (git remote add dup) and the push still runs', async () => {
		const client = new FakeClient();
		const git = fakeGit({ remoteAddCode: 1, remoteAddOut: 'error: remote origin already exists.' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(true);
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/already set/i);
		// push still ran despite the dup remote.
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(true);
	});

	// ── RC-H GAP 1/2: STALE-ORIGIN GUARD ON THE `created` PATH (the hole the second-pass review found) ──
	// A scanner-imported project has a PRE-EXISTING LOCAL `origin` (detect.ts readRepoUrl). On a fresh
	// `created` outcome the create-outcome stale-origin guard never runs, so before this fix backRemote
	// absorbed the dup `origin` WITHOUT reconciling its URL and `git push -u origin` targeted whatever
	// stale remote was already configured. The reconcile (`git remote set-url origin <resolvedUrl>`) must
	// run on the absorb path so the push ALWAYS targets the gate-resolved URL — on BOTH branches.
	it('created path: a pre-existing (stale) origin is RECONCILED to the resolved URL before push', async () => {
		const client = new FakeClient();
		// gh creates a genuinely new repo; the LOCAL origin already exists and is stale/unrelated.
		client.createOutcome = { kind: 'created', url: 'https://github.com/me/repo-host' };
		const git = fakeGit({ remoteAddCode: 1, remoteAddOut: 'error: remote origin already exists.' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', branch: 'main', client, gitRunner: git.fn });

		expect(out.created).toBe(true);
		expect(out.createOutcome).toBe('created');

		// THE load-bearing assertions: set-url reconciled origin to the resolved URL, and the push targets
		// origin (which now points at the resolved URL) — the gate can never push to the stale pre-existing remote.
		const setUrl = git.calls.find((c) => c.args[0] === 'remote' && c.args[1] === 'set-url');
		expect(setUrl).toBeDefined();
		expect(setUrl?.args).toEqual(['remote', 'set-url', 'origin', 'https://github.com/me/repo-host']);
		// Exact outward sequence: resolve branch (symbolic-ref, already main) → add (dup) → set-url
		// (reconcile) → push.
		expect(git.calls).toEqual([
			{ file: 'git', args: ['symbolic-ref', '--short', 'HEAD'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['remote', 'add', 'origin', 'https://github.com/me/repo-host'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['remote', 'set-url', 'origin', 'https://github.com/me/repo-host'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['push', '-u', 'origin', '--', 'main'], cwd: 'F:/code/whatever' }
		]);
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/reconciled/i);
	});

	it('created path: a FRESH origin (no dup) is NOT set-url (already points at the resolved URL)', async () => {
		const client = new FakeClient();
		const git = fakeGit(); // remote add exits 0 → origin freshly added, no reconcile needed.
		await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', branch: 'main', client, gitRunner: git.fn });
		// No set-url call when we just added origin — it already points at the resolved URL.
		expect(git.calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'set-url')).toBe(false);
	});

	it('a set-url failure on the reconcile path is a NAMED red (no silent stale push)', async () => {
		const client = new FakeClient();
		const git = fakeGit({ remoteAddCode: 1, remoteAddOut: 'error: remote origin already exists.', setUrlCode: 1, setUrlOut: 'fatal: No such remote origin' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('remote');
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/set-url/i);
		// Never pushed once the reconcile failed.
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(false);
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBeUndefined();
	});
});

// ── PUSH failure → named red ─────────────────────────────────────────────────────────────
describe('runRepoCreationGate — a push failure is a named red', () => {
	it('push exits non-zero → failedAt remote (repo created but unbacked, honest)', async () => {
		const client = new FakeClient();
		const git = fakeGit({ pushCode: 1, pushOut: 'rejected: non-fast-forward' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('remote');
		// repo_url NOT written (only set on full success).
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBeUndefined();
	});
});

// ── createRepo permission-denied / error → named red, no push ────────────────────────────
describe('runRepoCreationGate — createRepo failures surface honestly', () => {
	it('permission-denied → failedAt create, NO push', async () => {
		const client = new FakeClient();
		client.createOutcome = { kind: 'permission-denied', reason: 'Authenticated, but not permitted to create a repo under that owner.' };
		const git = fakeGit();
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.failedAt).toBe('create');
		expect(git.calls.length).toBe(0);
	});

	it('error outcome → failedAt create, NO push, honest reason (no token value)', async () => {
		const client = new FakeClient();
		client.createOutcome = { kind: 'error', reason: 'could not create repository: upstream server error' };
		const git = fakeGit();
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.failedAt).toBe('create');
		const detail = out.checks.find((c) => c.name === 'create')?.detail ?? '';
		expect(detail).toContain('upstream server error');
		// D-026: no env token value leaks into any detail (we never read it; assert no obvious secret echo).
		expect(out.checks.every((c) => !/gh[pousr]_/i.test(c.detail))).toBe(true);
	});
});

// ── RC-2 finding #1: STALE-ORIGIN GUARD (already-exists) ─────────────────────────────────
describe('runRepoCreationGate — stale-origin guard on already-exists (RC-2 finding #1)', () => {
	it('a recorded repo_url that does NOT match the repo being created → fail closed, NO push', async () => {
		// Seed a STALE origin on the project (as a scanner could): points at an UNRELATED remote.
		await updateProject(db, projectId, { repo_url: 'https://github.com/someoneelse/unrelated-repo' });
		const client = new FakeClient();
		client.createOutcome = { kind: 'already-exists' };
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken('repo-host', 'me'),
			name: 'repo-host',
			owner: 'me',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('create');
		// THE load-bearing assertion: NEVER pushed to the mismatched remote.
		expect(git.calls.length).toBe(0);
		expect(out.checks.find((c) => c.name === 'create')?.detail).toMatch(/mismatched|does not match/i);
		// The stale repo_url is left UNTOUCHED (we did not overwrite it with the canonical).
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBe('https://github.com/someoneelse/unrelated-repo');
	});

	it('a recorded repo_url that DOES match (different URL form, .git suffix) → trusted, pushes canonical', async () => {
		// scp-style + .git suffix for the SAME owner/name — must be recognized as a match.
		await updateProject(db, projectId, { repo_url: 'git@github.com:me/repo-host.git' });
		const client = new FakeClient();
		client.createOutcome = { kind: 'already-exists' };
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken('repo-host', 'me'),
			name: 'repo-host',
			owner: 'me',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(true);
		expect(out.repoUrl).toBe('https://github.com/me/repo-host');
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(true);
	});
});

// ── RC-2 finding #3: owner-less already-exists resolves a well-formed URL ─────────────────
describe('runRepoCreationGate — owner-less already-exists (RC-2 finding #3)', () => {
	it('no owner given → resolveOwner fills it → well-formed https://github.com/<owner>/<name>', async () => {
		const client = new FakeClient();
		client.createOutcome = { kind: 'already-exists' };
		client.ownerLogin = 'resolved-acct';
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken('repo-host'), // token derived WITHOUT owner
			name: 'repo-host',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(true);
		expect(client.resolveOwnerCalls).toBe(1);
		// Well-formed: owner present, never the malformed owner-less https://github.com/repo-host.
		expect(out.repoUrl).toBe('https://github.com/resolved-acct/repo-host');
		expect(git.calls.find((c) => c.args[0] === 'remote' && c.args[1] === 'add')?.args).toEqual([
			'remote',
			'add',
			'origin',
			'https://github.com/resolved-acct/repo-host'
		]);
	});

	it('no owner AND resolveOwner returns null → fail closed, never a malformed owner-less URL, NO push', async () => {
		const client = new FakeClient();
		client.createOutcome = { kind: 'already-exists' };
		client.ownerLogin = null; // gh could not resolve the account
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken('repo-host'),
			name: 'repo-host',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('create');
		expect(git.calls.length).toBe(0);
		expect(out.checks.find((c) => c.name === 'create')?.detail).toMatch(/owner could not be resolved/i);
	});
});

// ── RC-2 finding #2: branch-name validation / flag-misparse defense ──────────────────────
describe('runRepoCreationGate — branch validation (RC-2 finding #2)', () => {
	it('a `-`-prefixed branch is rejected (flag misparse) → failedAt remote, NO push', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken(),
			name: 'repo-host',
			branch: '--upload-pack=touch pwned',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('remote');
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/invalid push branch/i);
		// Never reached git at all (validated before the outward runner).
		expect(git.calls.length).toBe(0);
	});

	it('a valid branch is pushed with a `--` separator (git can never read it as a flag)', async () => {
		const client = new FakeClient();
		// The repo is actually on `feature/x` → resolution reports it and pushes it as-is.
		const gitFeature = fakeGit({ currentBranch: 'feature/x' });
		await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken(),
			name: 'repo-host',
			branch: 'feature/x',
			client,
			gitRunner: gitFeature.fn
		});
		expect(gitFeature.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'feature/x']);
	});
});

// ── F-050: master-default local repo → normalize to main before pushing ──────────────────
// The original defect: the push leg hardcoded `git push -u origin main`, so a repo whose only branch
// was `master` (ROUNDS was scaffolded on `master`) failed with `src refspec main does not match any`
// → failedAt:'remote', "repo exists but unbacked". The fix resolves the ACTUAL current branch and
// normalizes a master-default repo to the requested branch (rename master→main) before pushing.
describe('runRepoCreationGate — F-050 branch resolution / master→main normalization', () => {
	it('REGRESSION: a master-default repo (no local main) is renamed master→main, then main is pushed', async () => {
		const client = new FakeClient();
		// The local repo is on `master` and has NO `main` — exactly the F-050 ROUNDS scaffold.
		const git = fakeGit({ currentBranch: 'master', existingBranches: ['master'] });
		const out = await runRepoCreationGate({
			db,
			projectId,
			consent: true,
			confirmToken: validToken(),
			name: 'repo-host',
			branch: 'main',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(true);
		expect(out.failedAt).toBeNull();
		// The load-bearing fix: master was renamed to main BEFORE the push, and the push targets main
		// (never the pre-fix `push -u origin main` against a non-existent local main).
		expect(git.calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-m' && c.args[2] === 'master' && c.args[3] === 'main')).toBe(true);
		expect(git.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'main']);
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/normalized master -> main/i);
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('a repo already on main is a no-op (no rename) and pushes main', async () => {
		const client = new FakeClient();
		const git = fakeGit({ currentBranch: 'main', existingBranches: ['main'] });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(true);
		// Never renamed — main already exists.
		expect(git.calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-m')).toBe(false);
		expect(git.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'main']);
	});

	it('requested branch absent + NOT master → pushes the ACTUAL current branch (never assumes main)', async () => {
		const client = new FakeClient();
		// On `develop`, no `main`, no `master` — resolution must push the real branch, not invent main.
		const git = fakeGit({ currentBranch: 'develop', existingBranches: ['develop'] });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(true);
		expect(git.calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-m')).toBe(false);
		expect(git.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'develop']);
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/pushing actual branch develop/i);
	});

	it('requested branch already exists locally (not checked out) → pushed by name, no rename', async () => {
		const client = new FakeClient();
		// HEAD is on `dev` but a local `main` already exists → push main by name (git pushes named refs).
		const git = fakeGit({ currentBranch: 'dev', existingBranches: ['dev', 'main'] });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', branch: 'main', client, gitRunner: git.fn });
		expect(out.created).toBe(true);
		expect(git.calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-m')).toBe(false);
		expect(git.calls.find((c) => c.args[0] === 'push')?.args).toEqual(['push', '-u', 'origin', '--', 'main']);
	});

	it('a rename failure is a NAMED red at remote (no push, repo stays unbacked honestly)', async () => {
		const client = new FakeClient();
		const git = fakeGit({ currentBranch: 'master', existingBranches: ['master'], renameCode: 1, renameOut: 'fatal: no commit on branch master yet' });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('remote');
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/normalizing master -> main/i);
		// Never pushed once the normalization failed — no half-state.
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(false);
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBeUndefined();
	});

	it('an unborn/detached HEAD with no requested branch → named red at remote, NO push', async () => {
		const client = new FakeClient();
		// symbolic-ref exits non-zero (unborn/detached) and no `main` exists → nothing safe to push.
		const git = fakeGit({ currentBranch: '', existingBranches: [] });
		const out = await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('remote');
		expect(out.checks.find((c) => c.name === 'remote')?.detail).toMatch(/no local branch to push/i);
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(false);
	});
});

// ── SHADOW: missing project / empty root ─────────────────────────────────────────────────
describe('runRepoCreationGate — shadow paths (nil/empty)', () => {
	it('missing project row → failedAt auth, no outward call', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		const token = repoCreateConfirmToken({ projectId: 'project:does_not_exist', name: 'repo-host' });
		const out = await runRepoCreationGate({
			db,
			projectId: 'project:does_not_exist',
			consent: true,
			confirmToken: token,
			name: 'repo-host',
			client,
			gitRunner: git.fn
		});
		expect(out.created).toBe(false);
		expect(out.failedAt).toBe('auth');
		expect(client.createCalls.length).toBe(0);
	});

	it('empty root_path → failedAt auth (refuses git in the wrong cwd)', async () => {
		const p = await createProject(db, { slug: `rcgate_noroot${++seq}`, name: 'No Root', root_path: '' });
		const client = new FakeClient();
		const git = fakeGit();
		const out = await runRepoCreationGate({
			db,
			projectId: p.id,
			consent: true,
			confirmToken: repoCreateConfirmToken({ projectId: p.id, name: 'repo-host' }),
			name: 'repo-host',
			client,
			gitRunner: git.fn
		});
		expect(out.failedAt).toBe('auth');
		expect(git.calls.length).toBe(0);
	});
});

// ── sameRepoTarget — pure URL-matching for the stale-origin guard (RC-2 finding #1) ──────
describe('sameRepoTarget — recognizes a remote pointing at owner/name (and rejects others)', () => {
	it('matches the common GitHub remote forms (case-insensitive, .git/trailing-slash tolerant)', () => {
		for (const url of [
			'https://github.com/me/repo-host',
			'https://github.com/me/repo-host.git',
			'https://github.com/me/repo-host/',
			'http://github.com/ME/Repo-Host',
			'git@github.com:me/repo-host.git',
			'ssh://git@github.com/me/repo-host.git'
		]) {
			expect(sameRepoTarget(url, 'me', 'repo-host')).toBe(true);
		}
	});
	it('rejects a different owner or name (the stale/unrelated remote → no push)', () => {
		expect(sameRepoTarget('https://github.com/someoneelse/repo-host', 'me', 'repo-host')).toBe(false);
		expect(sameRepoTarget('https://github.com/me/other-repo', 'me', 'repo-host')).toBe(false);
		expect(sameRepoTarget('https://gitlab.com/me/repo-host', 'me', 'repo-host')).toBe(false);
	});
	it('rejects nil/empty/unparseable input (fail closed)', () => {
		expect(sameRepoTarget('', 'me', 'repo-host')).toBe(false);
		expect(sameRepoTarget('   ', 'me', 'repo-host')).toBe(false);
		expect(sameRepoTarget('not a url', 'me', 'repo-host')).toBe(false);
	});
});
