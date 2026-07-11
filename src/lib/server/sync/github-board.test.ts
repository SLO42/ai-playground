import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createTask } from '../tasks/repo';
import { GitHubBoardSyncAdapter } from './github-board';
import {
	saveBoardConfig,
	getBoardConfig,
	listSyncIncidents
} from './board-repo';
import type { GitHubBoardClient, BoardInfo, BoardItem } from './gh-client';

// TASK 11.4 VERIFY (D-038) — the board adapter's FULL reconcile logic runs against a REAL
// throwaway SurrealDB (the real board_sync_config + task_sync + sync_incident tables) with a
// FAKE board client standing in for the gh Projects API (a fake in a TEST is allowed; no
// fabricated PRODUCT data). The live gh-board round-trip is the documented deferred proof.

const CWD = 'F:/code/boardtest';
const REPO = 'octo/boardtest';

/** A fake GitHub Projects board: columns + the items added to it. */
class FakeBoard implements GitHubBoardClient {
	board: BoardInfo | null = {
		projectId: 'PVT_board1',
		statusFieldId: 'FIELD_status',
		columns: [
			{ id: 'opt_todo', name: 'Todo' },
			{ id: 'opt_doing', name: 'In Progress' },
			{ id: 'opt_done', name: 'Done' }
		]
	};
	added: string[] = [];
	statusSet: Array<{ itemId: string; optionId: string }> = [];
	#next = 1;

	async resolveBoard(): Promise<BoardInfo | null> {
		return this.board;
	}
	async addIssueToBoard(_boardId: string, issueUrl: string): Promise<BoardItem> {
		this.added.push(issueUrl);
		return { itemId: `ITEM_${this.#next++}` };
	}
	async setItemStatus(
		_boardId: string,
		itemId: string,
		_statusFieldId: string,
		optionId: string
	): Promise<void> {
		this.statusSet.push({ itemId, optionId });
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
	await db
		.query(
			'DELETE sync_incident; DELETE board_sync_config; DELETE task_sync; DELETE task; DELETE project;'
		)
		.catch(() => {});
	const p = await createProject(db, {
		slug: 'boardtest',
		name: 'Board Host',
		root_path: CWD,
		repo_url: `https://github.com/${REPO}`
	});
	projectId = p.id;
});

/** Seed a task + its task_sync mapping (the board item is anchored on the issue). */
async function seedMappedTask(title: string, status: 'ready' | 'in_progress' | 'done', issueNo: number) {
	const t = await createTask(db, { project: projectId, title, description: '', status });
	await db.query(`CREATE task_sync CONTENT $c;`, {
		c: {
			task: new StringRecordId(t.id),
			project: new StringRecordId(projectId),
			provider: 'github',
			repo: REPO,
			external_id: String(issueNo),
			external_url: `https://github.com/${REPO}/issues/${issueNo}`,
			direction: 'push'
		}
	});
	return t;
}

describe('board config repo', () => {
	it('upserts one config per project (idempotent) and round-trips the mapping', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo', in_progress: 'In Progress', done: 'Done' }
		});
		// A second save is an UPDATE, not a duplicate.
		const updated = await saveBoardConfig(db, {
			project: projectId,
			enabled: false,
			boardNumber: 3,
			mapping: { ready: 'Todo' }
		});
		expect(updated.enabled).toBe(false);
		const got = await getBoardConfig(db, projectId);
		expect(got?.mapping).toEqual({ ready: 'Todo' });
		expect(got?.boardNumber).toBe(3);
		// created_at is an ISO string (F-013).
		expect(typeof got?.created_at).toBe('string');
	});
});

describe('GitHubBoardSyncAdapter.probe', () => {
	it('is unavailable when disabled', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: false, mapping: {} });
		const cfg = await getBoardConfig(db, projectId);
		const adapter = new GitHubBoardSyncAdapter({ client: new FakeBoard() });
		const p = await adapter.probe({ cwd: CWD, repo: REPO, config: cfg });
		expect(p.available).toBe(false);
		expect(p.reason).toMatch(/not enabled/i);
	});

	it('is available with an enabled config + a resolvable board + a Status field', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 3, mapping: {} });
		const cfg = await getBoardConfig(db, projectId);
		const adapter = new GitHubBoardSyncAdapter({ client: new FakeBoard() });
		const p = await adapter.probe({ cwd: CWD, repo: REPO, config: cfg });
		expect(p.available).toBe(true);
		expect(p.target).toMatch(/board #3/);
	});

	it('is unavailable (honest) when the board has no Status field', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 3, mapping: {} });
		const cfg = await getBoardConfig(db, projectId);
		const fake = new FakeBoard();
		fake.board = { projectId: 'PVT', statusFieldId: null, columns: [] };
		const adapter = new GitHubBoardSyncAdapter({ client: fake });
		const p = await adapter.probe({ cwd: CWD, repo: REPO, config: cfg });
		expect(p.available).toBe(false);
		expect(p.reason).toMatch(/Status/);
	});
});

describe('GitHubBoardSyncAdapter.sync (one-way push)', () => {
	it('pushes each mapped task to its column + records an ok run', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo', in_progress: 'In Progress', done: 'Done' }
		});
		await seedMappedTask('Task A', 'ready', 101);
		await seedMappedTask('Task B', 'in_progress', 102);

		const fake = new FakeBoard();
		const adapter = new GitHubBoardSyncAdapter({ client: fake });
		const res = await adapter.sync(db, { projectId, cwd: CWD, direction: 'push', repo: REPO, dryRun: false });

		expect(res.updated).toBe(2);
		expect(res.errors).toHaveLength(0);
		expect(fake.added).toHaveLength(2);
		// The right columns were set (ready→Todo, in_progress→In Progress).
		expect(fake.statusSet.map((s) => s.optionId).sort()).toEqual(['opt_doing', 'opt_todo']);

		const cfg = await getBoardConfig(db, projectId);
		expect(cfg?.lastStatus).toBe('ok');
		expect(cfg?.lastSynced).toBeTruthy();
	});

	it('skips a task whose status is unmapped (honest, not an error)', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo' } // in_progress is intentionally unmapped
		});
		await seedMappedTask('Mapped', 'ready', 201);
		await seedMappedTask('Unmapped', 'in_progress', 202);

		const fake = new FakeBoard();
		const res = await new GitHubBoardSyncAdapter({ client: fake }).sync(db, {
			projectId,
			cwd: CWD,
			direction: 'push',
			repo: REPO,
			dryRun: false
		});
		expect(res.updated).toBe(1);
		expect(res.skipped).toBe(1);
	});

	it('skips a task with no issue mapping (the issue sync must run first)', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo' }
		});
		// A task with NO task_sync row.
		await createTask(db, { project: projectId, title: 'No issue', description: '', status: 'ready' });

		const res = await new GitHubBoardSyncAdapter({ client: new FakeBoard() }).sync(db, {
			projectId,
			cwd: CWD,
			direction: 'push',
			repo: REPO,
			dryRun: false
		});
		expect(res.updated).toBe(0);
		expect(res.skipped).toBe(1);
	});

	it('records a sync_incident (never silent) when the board is unresolvable', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 9, mapping: { ready: 'Todo' } });
		await seedMappedTask('T', 'ready', 301);
		const fake = new FakeBoard();
		fake.board = null; // board not found

		const res = await new GitHubBoardSyncAdapter({ client: fake }).sync(db, {
			projectId,
			cwd: CWD,
			direction: 'push',
			repo: REPO,
			dryRun: false
		});
		expect(res.errors.length).toBeGreaterThan(0);
		const cfg = await getBoardConfig(db, projectId);
		expect(cfg?.lastStatus).toBe('error');
		const incidents = await listSyncIncidents(db, projectId);
		expect(incidents.length).toBe(1);
		expect(incidents[0].adapter).toBe('github-board');
	});

	it('a column-name mismatch is a per-item error, not a crash', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Nonexistent Column' }
		});
		await seedMappedTask('T', 'ready', 401);
		const res = await new GitHubBoardSyncAdapter({ client: new FakeBoard() }).sync(db, {
			projectId,
			cwd: CWD,
			direction: 'push',
			repo: REPO,
			dryRun: false
		});
		expect(res.errors.length).toBe(1);
		expect(res.errors[0]).toMatch(/no column named/i);
	});
});
