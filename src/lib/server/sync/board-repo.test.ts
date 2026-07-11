// SYN-2 (SYNC-SPEC §3) — the board-sync CONFIG + incident store, direct coverage vs a REAL
// throwaway SurrealDB (the real board_sync_config + sync_incident tables; migration m0025).
//
// A stubDb would not parse the SET/UPDATE/ORDER BY SurrealQL (F-020) nor surface the F-013
// datetime→ISO coercion, so this suite runs against a live server. What it pins:
//   • getBoardConfig → null when none (shadow: empty).
//   • saveBoardConfig create/update — idempotent (one row), SET overwrites the mapping wholesale
//     (removed keys do NOT linger), boardNumber option<int> round-trips + clears to undefined.
//   • a config re-save PRESERVES the last-run status fields (never wipes run history).
//   • recordBoardSyncResult — ok clears a stale last_error (→ undefined), error sets it.
//   • datetime fields normalize to ISO strings (F-013); mapping filters non-string values.
//   • recordSyncIncident + listSyncIncidents — newest-first, limit clamp, honest empty.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import {
	getBoardConfig,
	saveBoardConfig,
	recordBoardSyncResult,
	recordSyncIncident,
	listSyncIncidents
} from './board-repo';

const CWD = 'F:/code/boardrepotest';

let tdb: TestDb;
let db: Db;
let projectId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

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
		.query('DELETE sync_incident; DELETE board_sync_config; DELETE project;')
		.catch(() => {});
	const p = await createProject(db, {
		slug: 'boardrepotest',
		name: 'Board Repo Host',
		root_path: CWD,
		repo_url: 'https://github.com/octo/boardrepotest'
	});
	projectId = p.id;
});

describe('getBoardConfig', () => {
	it('returns null when no config has been saved (shadow: empty)', async () => {
		expect(await getBoardConfig(db, projectId)).toBeNull();
	});
});

describe('saveBoardConfig', () => {
	it('creates a config and round-trips enabled/boardNumber/mapping + ISO created_at (F-013)', async () => {
		const saved = await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo', in_progress: 'In Progress', done: 'Done' }
		});
		expect(saved.enabled).toBe(true);
		expect(saved.boardNumber).toBe(3);
		expect(saved.mapping).toEqual({ ready: 'Todo', in_progress: 'In Progress', done: 'Done' });
		expect(isIso(saved.created_at)).toBe(true);

		const got = await getBoardConfig(db, projectId);
		expect(got?.mapping).toEqual({ ready: 'Todo', in_progress: 'In Progress', done: 'Done' });
		expect(got?.boardNumber).toBe(3);
		expect(got?.enabled).toBe(true);
	});

	it('is idempotent (one row) and SET-overwrites the mapping — removed keys do NOT linger', async () => {
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo', in_progress: 'In Progress', done: 'Done' }
		});
		const updated = await saveBoardConfig(db, {
			project: projectId,
			enabled: false,
			boardNumber: 5,
			mapping: { ready: 'Backlog' } // in_progress/done dropped
		});
		expect(updated.enabled).toBe(false);
		expect(updated.boardNumber).toBe(5);
		// SET (not MERGE): the map is replaced wholesale, not deep-merged.
		expect(updated.mapping).toEqual({ ready: 'Backlog' });

		// Exactly one row exists (upsert, never a duplicate).
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			'SELECT id FROM board_sync_config WHERE project = $p;',
			{ p: new StringRecordId(projectId) }
		);
		expect(rows.length).toBe(1);
	});

	it('clears boardNumber to undefined when absent on update (option<int> → NONE, never NULL)', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 7, mapping: {} });
		const cleared = await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			mapping: { ready: 'Todo' }
		});
		expect(cleared.boardNumber).toBeUndefined();
		const got = await getBoardConfig(db, projectId);
		expect(got?.boardNumber).toBeUndefined();
	});

	it('PRESERVES the last-run status fields across a config re-save (history is not wiped)', async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 3, mapping: {} });
		await recordBoardSyncResult(db, projectId, { status: 'ok' });
		const afterRun = await getBoardConfig(db, projectId);
		expect(afterRun?.lastStatus).toBe('ok');
		expect(isIso(afterRun?.lastSynced)).toBe(true);

		// Re-saving the mapping must NOT touch last_synced/last_status/last_error.
		await saveBoardConfig(db, {
			project: projectId,
			enabled: true,
			boardNumber: 3,
			mapping: { ready: 'Todo' }
		});
		const preserved = await getBoardConfig(db, projectId);
		expect(preserved?.lastStatus).toBe('ok');
		expect(preserved?.lastSynced).toBe(afterRun?.lastSynced);
		expect(preserved?.mapping).toEqual({ ready: 'Todo' });
	});

	it('filters non-string mapping values on read (defensive norm; FLEXIBLE object)', async () => {
		// A raw row with a mixed mapping (the FLEXIBLE object accepts it at the DB level).
		await db.query('CREATE board_sync_config CONTENT $c;', {
			c: {
				project: new StringRecordId(projectId),
				enabled: true,
				mapping: { ready: 'Todo', bogus: 42, nested: { x: 1 } }
			}
		});
		const got = await getBoardConfig(db, projectId);
		expect(got?.mapping).toEqual({ ready: 'Todo' });
	});
});

describe('recordBoardSyncResult', () => {
	beforeEach(async () => {
		await saveBoardConfig(db, { project: projectId, enabled: true, boardNumber: 3, mapping: {} });
	});

	it('records an error (last_status=error + last_error set) then clears it on the next ok run', async () => {
		await recordBoardSyncResult(db, projectId, { status: 'error', error: 'board #3 not found' });
		const failed = await getBoardConfig(db, projectId);
		expect(failed?.lastStatus).toBe('error');
		expect(failed?.lastError).toBe('board #3 not found');
		expect(isIso(failed?.lastSynced)).toBe(true);

		await recordBoardSyncResult(db, projectId, { status: 'ok' });
		const ok = await getBoardConfig(db, projectId);
		expect(ok?.lastStatus).toBe('ok');
		// last_error is option<string>: a clean run clears it to NONE → undefined (never "undefined").
		expect(ok?.lastError).toBeUndefined();
	});

	it('defaults a missing error message to "unknown error" (no NULL, no empty)', async () => {
		await recordBoardSyncResult(db, projectId, { status: 'error' });
		const got = await getBoardConfig(db, projectId);
		expect(got?.lastError).toBe('unknown error');
	});
});

describe('recordSyncIncident + listSyncIncidents', () => {
	it('returns [] when a project has no incidents (shadow: empty)', async () => {
		expect(await listSyncIncidents(db, projectId)).toEqual([]);
	});

	it('records an incident and normalizes its fields (adapter/message/ISO at)', async () => {
		const row = await recordSyncIncident(db, {
			project: projectId,
			adapter: 'github-board',
			message: 'board unavailable'
		});
		expect(row.adapter).toBe('github-board');
		expect(row.message).toBe('board unavailable');
		expect(isIso(row.at)).toBe(true);
	});

	it('lists incidents newest-first and honors the limit clamp', async () => {
		await recordSyncIncident(db, { project: projectId, adapter: 'a', message: 'first' });
		await sleep(5);
		await recordSyncIncident(db, { project: projectId, adapter: 'b', message: 'second' });
		await sleep(5);
		await recordSyncIncident(db, { project: projectId, adapter: 'c', message: 'third' });

		const all = await listSyncIncidents(db, projectId);
		expect(all.map((i) => i.message)).toEqual(['third', 'second', 'first']);

		const capped = await listSyncIncidents(db, projectId, 2);
		expect(capped.map((i) => i.message)).toEqual(['third', 'second']);
	});

	it('scopes incidents to the given project (no cross-project bleed)', async () => {
		const other = await createProject(db, {
			slug: 'otherboardhost',
			name: 'Other',
			root_path: '/tmp/other',
			repo_url: 'https://github.com/octo/other'
		});
		await recordSyncIncident(db, { project: projectId, adapter: 'a', message: 'mine' });
		await recordSyncIncident(db, { project: other.id, adapter: 'b', message: 'theirs' });
		const mine = await listSyncIncidents(db, projectId);
		expect(mine.map((i) => i.message)).toEqual(['mine']);
	});
});
