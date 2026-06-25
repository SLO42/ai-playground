import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, getProject } from './repo';
import {
	runRepoCreationGate,
	repoCreateConfirmToken,
	REPO_CREATE_ADAPTER_ID
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

	async isAuthenticated(): Promise<AuthStatus> {
		this.authCalls++;
		return this.authed ? { ok: true } : { ok: false, reason: 'GitHub CLI is not authenticated — run `gh auth login` or set GH_TOKEN.' };
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
function fakeGit(opts: { remoteAddCode?: number; remoteAddOut?: string; pushCode?: number; pushOut?: string } = {}) {
	const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
	const fn: CommandRunner = async (file, args, o): Promise<CommandResult> => {
		calls.push({ file, args: [...args], cwd: o.cwd });
		// `git remote add origin <url>` → args[0]='remote'; `git push -u origin <branch>` → args[0]='push'.
		if (args[0] === 'remote' && args[1] === 'add') {
			return { code: opts.remoteAddCode ?? 0, stdout: '', stderr: opts.remoteAddOut ?? '' };
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

		// The OUTWARD runner did remote add + push -u origin main (D-008 array args).
		expect(git.calls).toEqual([
			{ file: 'git', args: ['remote', 'add', 'origin', 'https://github.com/me/repo-host'], cwd: 'F:/code/whatever' },
			{ file: 'git', args: ['push', '-u', 'origin', 'main'], cwd: 'F:/code/whatever' }
		]);

		// repo_url persisted (F-013 normalized, real DB read-back).
		const p = await getProject(db, projectId);
		expect(p?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('defaults the push branch to main when none given', async () => {
		const client = new FakeClient();
		const git = fakeGit();
		await runRepoCreationGate({ db, projectId, consent: true, confirmToken: validToken(), name: 'repo-host', client, gitRunner: git.fn });
		expect(git.calls[1].args).toEqual(['push', '-u', 'origin', 'main']);
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
