import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, getProject } from './repo';
import { createPm, getPm, updatePmAuthority } from './pm-repo';
import { getBrief, getOpenBriefForArtifact } from './briefs';
import {
	proposeRepoCreate,
	applyRepoCreateDecision,
	repoCreateFingerprint,
	RepoProposalError,
	RepoCreateGateError
} from './repo-create-proposal';
import type { CommandResult, CommandRunner } from '../orchestrator/post-task';
import type { GitHubClient, CreateRepoInput, CreateRepoOutcome, AuthStatus } from '../sync/gh-client';

// RC-3 VERIFY — the TWO trigger paths onto the RC-2 gate, against a REAL throwaway SurrealDB. The gh seam
// + the outward git runner are STUBBED (NO real network, NO real `gh`, NO real repo created). Covers the
// BUILD prompt's integrity contract:
//   • PM-PROPOSED: proposeRepoCreate raises a repo_create brief (DATA) and NEVER creates a repo; an
//     observe-only / no-PM / already-has-repo PM is refused (named); the brief is idempotent (absorbed);
//   • a PM/agent-origin attempt to create directly fails CLOSED — applyRepoCreateDecision approve WITHOUT
//     operatorConfirmed is refused BEFORE consent is recorded and BEFORE the gate runs (no repo);
//   • the proposal→operator-approve→gate path works (stubbed gh): approve with operatorConfirmed records
//     consent + drives the gate → created:true, repo_url written, brief 'approved';
//   • reject creates nothing, no consent recorded, brief 'rejected'.

let tdb: TestDb;
let db: Db;
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
	expect(applied).toContain('0063_repo_create_brief');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject(opts: { repoUrl?: string } = {}) {
	return createProject(db, {
		slug: `rcprop${++seq}`,
		name: 'Repo Host',
		root_path: 'F:/code/whatever',
		...(opts.repoUrl ? { repo_url: opts.repoUrl } : {})
	});
}

// ── A controllable fake GitHubClient (NO network) ──────────────────────────────────────
class FakeClient implements GitHubClient {
	authed = true;
	createOutcome: CreateRepoOutcome = { kind: 'created', url: 'https://github.com/me/repo-host' };
	createCalls: Array<{ input: CreateRepoInput; cwd: string }> = [];

	async isAuthenticated(): Promise<AuthStatus> {
		return this.authed ? { ok: true } : { ok: false, reason: 'GitHub CLI is not authenticated.' };
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

function fakeGit() {
	const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
	const fn: CommandRunner = async (file, args, o): Promise<CommandResult> => {
		calls.push({ file, args: [...args], cwd: o.cwd });
		return { code: 0, stdout: '', stderr: '' };
	};
	return { fn, calls };
}

// ── PATH B step 1 — the PM recommendation is DATA (a brief), never a repo ────────────────
describe('proposeRepoCreate — raises a repo_create brief, creates NOTHING', () => {
	it("a 'propose'/'act' PM raises a repo_create brief on the PROJECT artifact (no gate, no repo)", async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' }); // default authority 'act'
		const res = await proposeRepoCreate(db, { project: p.id, name: 'repo-host', rationale: 'needs a remote' });

		expect(res.raised).toBe(true);
		expect(res.brief.artifact_kind).toBe('repo_create');
		expect(res.brief.classification).toBe('confirm');
		expect(res.brief.status).toBe('open');
		// The artifact is the PROJECT row (the matter is "create THIS project's repo").
		expect(res.brief.artifact).toBe(p.id);
		// The repo name is recoverable from the stowed payload (cost_if_wrong = "repo:<name>").
		expect(res.brief.challenge?.cost_if_wrong).toBe('repo:repo-host');
		// Fingerprint anchors anti-spam to the project.
		expect(res.brief.fingerprint).toBe(repoCreateFingerprint(p.id));
		// NOTHING was created; no consent recorded.
		expect((await getProject(db, p.id))?.repo_url).toBeFalsy();
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(false);
	});

	it('is idempotent — a re-run absorbs the standing open brief (no duplicate ask)', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const first = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		expect(first.raised).toBe(true);
		const second = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		expect(second.raised).toBe(false);
		expect(second.brief.id).toBe(first.brief.id);
	});

	it('refuses a project with NO hired PM (named — no implicit PM may recommend)', async () => {
		const p = await freshProject();
		await expect(proposeRepoCreate(db, { project: p.id, name: 'repo-host' })).rejects.toBeInstanceOf(
			RepoProposalError
		);
		expect(await getOpenBriefForArtifact(db, p.id)).toBeNull();
	});

	it("refuses an OBSERVE-only PM (named — observe records, does not recommend)", async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		await updatePmAuthority(db, p.id, 'observe');
		await expect(proposeRepoCreate(db, { project: p.id, name: 'repo-host' })).rejects.toBeInstanceOf(
			RepoProposalError
		);
	});

	it('refuses when the project ALREADY has a repo (idempotent — nothing to propose)', async () => {
		const p = await freshProject({ repoUrl: 'https://github.com/me/already' });
		await createPm(db, { project: p.id, name: 'Vesper' });
		await expect(proposeRepoCreate(db, { project: p.id, name: 'repo-host' })).rejects.toBeInstanceOf(
			RepoProposalError
		);
	});

	it('refuses a malformed recommended repo name at the boundary (named)', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		await expect(
			proposeRepoCreate(db, { project: p.id, name: 'has spaces/and slash' })
		).rejects.toBeInstanceOf(RepoProposalError);
	});
});

// ── INTEGRITY — a PM/agent-origin direct create fails CLOSED at the proposal boundary ────
describe('applyRepoCreateDecision — the integrity wall (no gate without an operator confirm)', () => {
	it('approve WITHOUT operatorConfirmed fails closed BEFORE consent + BEFORE the gate (no repo)', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		const client = new FakeClient();
		const git = fakeGit();

		await expect(
			applyRepoCreateDecision(db, brief.id, 'approve', {
				operatorConfirmed: false, // a PM/agent context cannot set this true — the route does, from the operator
				client,
				gitRunner: git.fn
			})
		).rejects.toBeInstanceOf(RepoCreateGateError);

		// FAIL CLOSED: no create attempted, no consent recorded, brief still OPEN.
		expect(client.createCalls.length).toBe(0);
		expect(git.calls.length).toBe(0);
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(false);
		expect((await getBrief(db, brief.id))?.status).toBe('open');
	});

	it("rejects a brief that is not artifact_kind 'repo_create' (named)", async () => {
		// A cert_hire-shaped artifact_kind is rejected by the dispatch guard. We assert with a non-existent
		// brief id which surfaces the named 'not found' error (same RepoCreateGateError class).
		await expect(
			applyRepoCreateDecision(db, 'decision_brief:doesnotexist', 'approve', { operatorConfirmed: true })
		).rejects.toBeInstanceOf(RepoCreateGateError);
	});
});

// ── PATH B step 2 — proposal → operator approve → gate (stubbed gh) ─────────────────────
describe('applyRepoCreateDecision — operator approve drives the RC-2 gate (stubbed gh)', () => {
	it('records consent + creates private + writes repo_url + marks the brief approved', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		const client = new FakeClient();
		client.createOutcome = { kind: 'created', url: 'https://github.com/me/repo-host' };
		const git = fakeGit();

		const res = await applyRepoCreateDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			client,
			gitRunner: git.fn
		});

		expect(res.gate?.created).toBe(true);
		expect(res.repoUrl).toBe('https://github.com/me/repo-host');
		expect(res.brief.status).toBe('approved');
		// The gate created PRIVATE (the stub records the create call) and backed the remote.
		expect(client.createCalls.length).toBe(1);
		expect(client.createCalls[0].input.name).toBe('repo-host');
		expect(git.calls.some((c) => c.args[0] === 'remote' && c.args[1] === 'add')).toBe(true);
		expect(git.calls.some((c) => c.args[0] === 'push')).toBe(true);
		// Consent recorded + repo_url written on the project (F-008 — read back from the DB).
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(true);
		expect((await getProject(db, p.id))?.repo_url).toBe('https://github.com/me/repo-host');
	});

	it('a RED gate leaves the brief OPEN with an honest failedAt (no fake approval)', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		const client = new FakeClient();
		client.authed = false; // gh not authenticated → the gate halts at 'auth'
		const git = fakeGit();

		const res = await applyRepoCreateDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			client,
			gitRunner: git.fn
		});

		expect(res.gate?.created).toBe(false);
		expect(res.gate?.failedAt).toBe('auth');
		expect(res.repoUrl).toBeNull();
		// The brief stays OPEN (re-decidable); NO create attempted; project repo still unset.
		expect((await getBrief(db, brief.id))?.status).toBe('open');
		expect(client.createCalls.length).toBe(0);
		expect((await getProject(db, p.id))?.repo_url).toBeFalsy();
	});

	it('reject creates nothing, records no consent, marks the brief rejected', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		const client = new FakeClient();
		const git = fakeGit();

		const res = await applyRepoCreateDecision(db, brief.id, 'reject', {
			operatorConfirmed: false,
			client,
			gitRunner: git.fn
		});

		expect(res.gate).toBeNull();
		expect(res.repoUrl).toBeNull();
		expect(res.brief.status).toBe('rejected');
		expect(client.createCalls.length).toBe(0);
		expect((await getPm(db, p.id))?.repo_create_preauthorized).toBe(false);
		expect((await getProject(db, p.id))?.repo_url).toBeFalsy();
	});

	it('idempotent re-approve absorbs (markBriefDecided) after the gate already created', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		const { brief } = await proposeRepoCreate(db, { project: p.id, name: 'repo-host' });
		const client = new FakeClient();
		const git = fakeGit();

		const first = await applyRepoCreateDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			client,
			gitRunner: git.fn
		});
		expect(first.brief.status).toBe('approved');

		// Re-approve the now-decided brief → absorbed (same terminal status), no throw.
		const again = await applyRepoCreateDecision(db, brief.id, 'approve', {
			operatorConfirmed: true,
			client,
			gitRunner: git.fn
		});
		expect(again.brief.status).toBe('approved');
	});
});
