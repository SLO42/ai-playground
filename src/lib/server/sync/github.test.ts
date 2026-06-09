import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask, setStatus, getTask } from '../tasks/repo';
import { GitHubSyncAdapter, issueToTaskStatus, issueBodyForTask, listMappings } from './github';
import type { GitHubClient, GitHubIssue, CreatedIssue, AuthStatus } from './gh-client';

// TASK 9.4 VERIFY (D-037 reference SyncAdapter; D-038) — the FULL adapter reconcile logic
// runs against a REAL throwaway SurrealDB (the real task_sync ledger + the real task status
// machine), with a FAKE GitHubClient standing in for the network/creds (a fake client in a
// TEST is allowed; no fabricated PRODUCT data — every task_sync row read back is one the
// adapter actually wrote). The live GitHub round-trip (real `gh`, real repo) is the
// documented deferred proof — see the BUILD verdict's deferredLiveProof note.

const CWD = 'F:/code/synctest';
const REPO = 'octo/atelier';

/** An in-memory fake GitHub: issues live in a Map; create/update mutate it like the API. */
class FakeGitHub implements GitHubClient {
	auth: AuthStatus = { ok: true };
	repo: string | null = REPO;
	issues = new Map<number, GitHubIssue>();
	#next = 100;
	createdCalls = 0;

	async isAuthenticated(): Promise<AuthStatus> {
		return this.auth;
	}
	async resolveRepo(): Promise<string | null> {
		return this.repo;
	}
	async listIssues(): Promise<GitHubIssue[]> {
		return [...this.issues.values()];
	}
	async createIssue(
		_repo: string,
		input: { title: string; body: string; labels: string[] }
	): Promise<CreatedIssue> {
		this.createdCalls++;
		const number = this.#next++;
		this.issues.set(number, {
			number,
			title: input.title,
			body: input.body,
			state: 'open',
			labels: input.labels.map((name) => ({ name })),
			url: `https://github.com/${REPO}/issues/${number}`
		});
		return { number, url: `https://github.com/${REPO}/issues/${number}` };
	}
	async updateIssue(
		_repo: string,
		number: number,
		input: { labels: string[]; state: 'open' | 'closed' }
	): Promise<void> {
		const i = this.issues.get(number);
		if (i) {
			i.state = input.state;
			i.labels = input.labels.map((name) => ({ name }));
		}
	}
	/** Test helper: simulate an external edit (someone closes the issue on GitHub). */
	seedIssue(issue: Partial<GitHubIssue> & { number: number; title: string }): void {
		this.issues.set(issue.number, {
			body: '',
			state: 'open',
			labels: [{ name: 'atelier-task' }],
			url: `https://github.com/${REPO}/issues/${issue.number}`,
			...issue
		} as GitHubIssue);
	}
}

let tdb: TestDb;
let db: Db;
let projectId: string;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	// Fresh project + clean task/task_sync state per test.
	await db.query('DELETE task_sync; DELETE task; DELETE project;').catch(() => {});
	const p = await createProject(db, {
		slug: 'synctest',
		name: 'Sync Host',
		root_path: CWD,
		repo_url: `https://github.com/${REPO}`
	});
	projectId = p.id;
});

describe('pure mapping helpers', () => {
	it('issueToTaskStatus prefers the status:<s> label, falls back to open/closed', () => {
		expect(
			issueToTaskStatus({
				number: 1,
				title: 't',
				body: '',
				state: 'open',
				labels: [{ name: 'atelier-task' }, { name: 'status:review' }],
				url: 'u'
			})
		).toBe('review');
		expect(
			issueToTaskStatus({ number: 1, title: 't', body: '', state: 'closed', labels: [], url: 'u' })
		).toBe('done');
		expect(
			issueToTaskStatus({ number: 1, title: 't', body: '', state: 'open', labels: [], url: 'u' })
		).toBe('in_progress');
	});

	it('issueBodyForTask embeds the machine-readable task-id footer', () => {
		const body = issueBodyForTask({
			id: 'task:abc',
			project: 'project:synctest',
			title: 'T',
			description: 'hello',
			status: 'ready',
			priority: 'high',
			origin: 'manual',
			created_at: '',
			updated_at: ''
		});
		expect(body).toContain('hello');
		expect(body).toContain('<!-- atelier:task=task:abc -->');
		expect(body).toContain('status `ready`');
	});
});

describe('probe — honest degrade (F-008 / D-019)', () => {
	it('is available when authenticated with a resolvable repo', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		const probe = await adapter.probe({ cwd: CWD });
		expect(probe.available).toBe(true);
		expect(probe.target).toBe(REPO);
	});
	it('is unavailable (with a reason) when unauthenticated — never a fake success', async () => {
		const gh = new FakeGitHub();
		gh.auth = { ok: false, reason: 'GitHub CLI is not authenticated.' };
		const adapter = new GitHubSyncAdapter({ client: gh });
		const probe = await adapter.probe({ cwd: CWD });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/authenticated/i);
	});
	it('is unavailable when no repo resolves', async () => {
		const gh = new FakeGitHub();
		gh.repo = null;
		const adapter = new GitHubSyncAdapter({ client: gh });
		const probe = await adapter.probe({ cwd: CWD });
		expect(probe.available).toBe(false);
		expect(probe.reason).toMatch(/repository/i);
	});
});

describe('push — task → issue, idempotent (the create-or-update invariant)', () => {
	it('creates an issue for a new task and persists exactly one mapping', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		await createTask(db, { project: projectId, title: 'Build sync', description: 'do it' });

		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		expect(r.created).toBe(1);
		expect(gh.createdCalls).toBe(1);
		expect(gh.issues.size).toBe(1);

		const mappings = await listMappings(db, projectId, REPO);
		expect(mappings.length).toBe(1);
		expect(mappings[0].external_id).toBe('100');
	});

	it('does NOT create a duplicate on re-sync — updates the same issue (DEDUP)', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		await createTask(db, { project: projectId, title: 'Build sync', description: 'do it' });

		await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		const r2 = await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });

		expect(r2.created).toBe(0);
		expect(r2.updated).toBe(1);
		expect(gh.createdCalls).toBe(1); // STILL one — never re-created
		expect(gh.issues.size).toBe(1);
		const mappings = await listMappings(db, projectId, REPO);
		expect(mappings.length).toBe(1); // exactly one mapping, not two
	});

	it('closes the issue when the task reaches a terminal status', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		const t = await createTask(db, { project: projectId, title: 'Ship', description: 'x' });
		await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		// ready → in_progress → done
		await setStatus(db, t.id, 'ready');
		await setStatus(db, t.id, 'in_progress');
		await setStatus(db, t.id, 'done');
		await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		const issue = [...gh.issues.values()][0];
		expect(issue.state).toBe('closed');
		expect(issue.labels.map((l) => l.name)).toContain('status:done');
	});

	it('LINKS to a pre-existing same-title issue instead of creating a duplicate', async () => {
		const gh = new FakeGitHub();
		gh.seedIssue({ number: 42, title: 'Pre-existing', url: `https://github.com/${REPO}/issues/42` });
		const adapter = new GitHubSyncAdapter({ client: gh });
		await createTask(db, { project: projectId, title: 'Pre-existing', description: 'x' });

		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		expect(r.linked).toBe(1);
		expect(r.created).toBe(0);
		expect(gh.createdCalls).toBe(0);
		const mappings = await listMappings(db, projectId, REPO);
		expect(mappings[0].external_id).toBe('42');
	});

	it('dryRun computes the plan but performs NO external mutations + writes no mapping', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		await createTask(db, { project: projectId, title: 'Dry', description: 'x' });
		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'push', dryRun: true });
		expect(r.created).toBe(1);
		expect(gh.createdCalls).toBe(0);
		expect((await listMappings(db, projectId, REPO)).length).toBe(0);
	});
});

describe('pull — issue → task, through the status state machine', () => {
	it('reflects a closed issue back onto a mapped task (in_progress → done)', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		const t = await createTask(db, { project: projectId, title: 'Roundtrip', description: 'x' });
		await setStatus(db, t.id, 'ready');
		await setStatus(db, t.id, 'in_progress');
		// Push to create the mapping + issue.
		await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		const issue = [...gh.issues.values()][0];
		// Simulate someone closing it on GitHub (clear the status label so open/closed decides).
		issue.state = 'closed';
		issue.labels = [{ name: 'atelier-task' }];

		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'pull' });
		expect(r.pulled).toBe(1);
		const after = await getTask(db, t.id);
		expect(after?.status).toBe('done');
	});

	it('SKIPS (does not force) an illegal transition', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		const t = await createTask(db, { project: projectId, title: 'NoForce', description: 'x' });
		await setStatus(db, t.id, 'ready');
		await setStatus(db, t.id, 'in_progress');
		await setStatus(db, t.id, 'done'); // terminal
		await adapter.sync(db, { projectId, cwd: CWD, direction: 'push' });
		const issue = [...gh.issues.values()][0];
		// Issue says "reopen / in_progress" but done is terminal — must NOT move.
		issue.state = 'open';
		issue.labels = [{ name: 'atelier-task' }, { name: 'status:in_progress' }];
		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'pull' });
		expect(r.pulled).toBe(0);
		expect(r.skipped).toBeGreaterThanOrEqual(1);
		expect((await getTask(db, t.id))?.status).toBe('done');
	});
});

describe('both — full reconcile records an analytics event', () => {
	it('a both-direction sync over a new task creates the issue and an agent_event', async () => {
		const gh = new FakeGitHub();
		const adapter = new GitHubSyncAdapter({ client: gh });
		await createTask(db, { project: projectId, title: 'Reconcile', description: 'x' });
		const r = await adapter.sync(db, { projectId, cwd: CWD, direction: 'both' });
		expect(r.created).toBe(1);
		expect(r.target).toBe(REPO);
		const [events] = await db.query<[Array<{ type: string }>]>(
			`SELECT type FROM agent_event WHERE type = 'completion';`
		);
		expect(events.length).toBeGreaterThanOrEqual(1);
	});
});
