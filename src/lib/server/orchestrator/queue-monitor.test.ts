import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { enqueue, claimNext, complete } from './workqueue';
import {
	listWorkItems,
	getWorkItem,
	queueStats,
	DEFAULT_DAILY_CAP,
	DEFAULT_STUCK_MS
} from './queue-monitor';

// BL-9 — work-queue monitor READ-ONLY readers against a LIVE throwaway SurrealDB with the real
// §4.12 schema (work_item). Proves: stats aggregate correctly (depth/counts/cap-remaining/stale)
// incl. the empty queue; a processing item past the stuck window flags STALE (a DERIVED read —
// the GC is never invoked); pagination bounds hold; absent datetime → undefined (→ UI '—'). The
// listers/stats are pure SELECTs; we seed via enqueue/claim/complete + one raw CREATE for the
// aged-claim stale case. Shadow paths: empty queue, no-cursor, terminal-without-completed_at.

let tdb: TestDb;
let db: Db;

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

async function clearQueue(): Promise<void> {
	await db.query(`DELETE work_item;`);
}

describe('queueStats', () => {
	it('empty queue → all-zero honest stats (F-008)', async () => {
		await clearQueue();
		const s = await queueStats(db);
		expect(s.pendingDepth).toBe(0);
		expect(s.processing).toBe(0);
		expect(s.done).toBe(0);
		expect(s.failed).toBe(0);
		expect(s.spawnsToday).toBe(0);
		expect(s.staleCount).toBe(0);
		expect(s.dailyCap).toBe(DEFAULT_DAILY_CAP);
		expect(s.capRemaining).toBe(DEFAULT_DAILY_CAP);
		expect(s.throttled).toBe(false);
	});

	it('aggregates depth / processing / terminal counts + spawns-today against the cap', async () => {
		await clearQueue();
		// 2 pending (distinct dedup scope so both land), 1 claimed→processing, 1 claimed→done.
		await enqueue(db, { workType: 'review', payload: { a: 1 }, dedupScope: 'one' });
		await enqueue(db, { workType: 'review', payload: { a: 2 }, dedupScope: 'two' });
		const claimedA = await claimNext(db, 'tokA');
		expect(claimedA).not.toBeNull();
		await enqueue(db, { workType: 'task_run', payload: { t: 1 }, dedupScope: 'three' });
		const claimedB = await claimNext(db, 'tokB');
		await complete(db, claimedB!.id, 'tokB', 'done');

		const s = await queueStats(db);
		// 1 still pending+unclaimed, 1 processing (claimedA), 1 done.
		expect(s.pendingDepth).toBe(1);
		expect(s.processing).toBe(1);
		expect(s.done).toBe(1);
		// Both claims happened within the cap window → spawnsToday counts them.
		expect(s.spawnsToday).toBeGreaterThanOrEqual(2);
		expect(s.capRemaining).toBe(Math.max(0, DEFAULT_DAILY_CAP - s.spawnsToday));
	});

	it('throttled flips true when a tiny cap is exceeded (cap display honest)', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'maintenance', payload: {}, dedupScope: 'm' });
		await claimNext(db, 'tokM');
		const s = await queueStats(db, { dailyCap: 1 });
		expect(s.spawnsToday).toBeGreaterThanOrEqual(1);
		expect(s.throttled).toBe(true);
		expect(s.capRemaining).toBe(0);
	});

	it('flags a processing item past the stuck window as STALE — derived read, GC never invoked', async () => {
		await clearQueue();
		// Seed a processing row with an aged claim (older than the stuck window). Raw CREATE so we
		// control claimed_at directly — the monitor must DERIVE stale, not run the reaper.
		const oldIso = new Date(Date.now() - DEFAULT_STUCK_MS - 60_000).toISOString();
		await db.query(
			`CREATE work_item CONTENT { work_type: "review", payload: {}, status: "processing", claim_token: "stale-tok", attempts: 1, claimed_at: <datetime>$old, dedup_scope: "stale" };`,
			{ old: oldIso }
		);
		const s = await queueStats(db);
		expect(s.staleCount).toBe(1);
		expect(s.processing).toBe(1);
		// The row is still present + still processing — proving NO reap happened (read-only).
		const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM work_item WHERE status = "processing" GROUP ALL;`);
		expect(Number(rows?.[0]?.c ?? 0)).toBe(1);

		// And the active list marks it STALE.
		const active = await listWorkItems(db, { status: ['pending', 'processing'] });
		expect(active.find((i) => i.claimed)?.stale).toBe(true);
	});
});

describe('listWorkItems', () => {
	it('empty → [] (honest)', async () => {
		await clearQueue();
		expect(await listWorkItems(db)).toEqual([]);
	});

	it('filters by status; a pending row has enqueuedAt but no claimedAt/completedAt (absent → undefined)', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'review', payload: { x: 1 }, dedupScope: 'p' });
		const pending = await listWorkItems(db, { status: 'pending' });
		expect(pending.length).toBe(1);
		const row = pending[0];
		expect(row.status).toBe('pending');
		expect(typeof row.enqueuedAt).toBe('string');
		expect(row.enqueuedAt).not.toBe('undefined');
		expect(row.claimedAt).toBeUndefined();
		expect(row.completedAt).toBeUndefined();
		expect(row.durationMs).toBeUndefined();
		expect(row.claimed).toBe(false);
		expect(row.stale).toBe(false);
	});

	it('a completed item carries a terminal status + a computed duration', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'task_run', payload: { t: 9 }, dedupScope: 'c' });
		const c = await claimNext(db, 'tokC');
		await complete(db, c!.id, 'tokC', 'done');
		const done = await listWorkItems(db, { status: ['done', 'failed'] });
		expect(done.length).toBe(1);
		expect(done[0].status).toBe('done');
		expect(typeof done[0].completedAt).toBe('string');
		expect(done[0].durationMs).toBeGreaterThanOrEqual(0);
	});

	it('pagination bound holds: limit caps the row count and the before cursor narrows it', async () => {
		await clearQueue();
		// Three pending rows.
		for (const n of [1, 2, 3]) await enqueue(db, { workType: 'review', payload: { n }, dedupScope: `pg${n}` });
		const firstTwo = await listWorkItems(db, { status: 'pending', limit: 2 });
		expect(firstTwo.length).toBe(2);
		// before-cursor: rows enqueued strictly before the oldest of the first page.
		const cursor = firstTwo[firstTwo.length - 1].enqueuedAt!;
		const older = await listWorkItems(db, { status: 'pending', limit: 10, before: cursor });
		expect(older.every((r) => new Date(r.enqueuedAt!).getTime() < new Date(cursor).getTime())).toBe(true);
	});

	it('getWorkItem returns one row by id, or null for a missing id (shadow path)', async () => {
		await clearQueue();
		const { id } = await enqueue(db, { workType: 'review', payload: {}, dedupScope: 'g' });
		const got = await getWorkItem(db, id);
		expect(got?.id).toBe(id);
		const missing = await getWorkItem(db, 'work_item:doesnotexist');
		expect(missing).toBeNull();
	});
});
