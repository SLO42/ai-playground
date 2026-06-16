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
	it('empty queue → all-zero honest stats, UNCAPPED by default (F-008 — the boot reality)', async () => {
		await clearQueue();
		const s = await queueStats(db);
		expect(s.pendingDepth).toBe(0);
		expect(s.processing).toBe(0);
		expect(s.done).toBe(0);
		expect(s.failed).toBe(0);
		expect(s.spawnsToday).toBe(0);
		expect(s.staleCount).toBe(0);
		// No dailyCap is wired (boot.ts passes none) ⇒ honest uncapped surface: no denominator,
		// no throttle, no remaining count. NEVER a fabricated /N (F-008).
		expect(s.capped).toBe(false);
		expect(s.throttled).toBe(false);
		expect(s.dailyCap).toBeUndefined();
		expect(s.capRemaining).toBeUndefined();
	});

	it('UNCAPPED never throttles even when spawnsToday is high (no fabricated cap)', async () => {
		await clearQueue();
		// Drain several items so spawnsToday is well above any plausible old default (50).
		for (let n = 0; n < 4; n++) {
			await enqueue(db, { workType: 'review', payload: { n }, dedupScope: `u${n}` });
			const c = await claimNext(db, `tokU${n}`);
			await complete(db, c!.id, `tokU${n}`, 'done');
		}
		const s = await queueStats(db); // no dailyCap
		expect(s.spawnsToday).toBeGreaterThanOrEqual(4);
		expect(s.capped).toBe(false);
		expect(s.throttled).toBe(false);
		expect(s.dailyCap).toBeUndefined();
		expect(s.capRemaining).toBeUndefined();
	});

	it('a 0/negative/NaN cap is treated as UNCAPPED (matches orchestrator dailySpawnCap>0 gate)', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'maintenance', payload: {}, dedupScope: 'z' });
		await claimNext(db, 'tokZ');
		for (const bad of [0, -5, Number.NaN]) {
			const s = await queueStats(db, { dailyCap: bad });
			expect(s.capped).toBe(false);
			expect(s.throttled).toBe(false);
			expect(s.dailyCap).toBeUndefined();
			expect(s.capRemaining).toBeUndefined();
		}
	});

	it('aggregates depth / processing / terminal counts + spawns-today (uncapped default)', async () => {
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
		expect(s.capped).toBe(false);
	});

	it('WHEN a real cap is supplied: spawnsToday/cap + throttled boundary (just under / at / over)', async () => {
		await clearQueue();
		// Drain exactly 2 spawns.
		await enqueue(db, { workType: 'maintenance', payload: {}, dedupScope: 'b1' });
		await claimNext(db, 'tokB1');
		await enqueue(db, { workType: 'maintenance', payload: {}, dedupScope: 'b2' });
		await claimNext(db, 'tokB2');

		// JUST UNDER the cap (cap 3, 2 spawned): capped, not throttled, 1 remaining.
		const under = await queueStats(db, { dailyCap: 3 });
		expect(under.spawnsToday).toBe(2);
		expect(under.capped).toBe(true);
		expect(under.dailyCap).toBe(3);
		expect(under.capRemaining).toBe(1);
		expect(under.throttled).toBe(false);

		// AT the cap (cap 2, 2 spawned): throttled true, 0 remaining.
		const at = await queueStats(db, { dailyCap: 2 });
		expect(at.capped).toBe(true);
		expect(at.capRemaining).toBe(0);
		expect(at.throttled).toBe(true);

		// OVER the cap (cap 1, 2 spawned): throttled true, remaining floored at 0.
		const over = await queueStats(db, { dailyCap: 1 });
		expect(over.capped).toBe(true);
		expect(over.capRemaining).toBe(0);
		expect(over.throttled).toBe(true);
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
		// SurrealDB stamps created_at at 100ns precision (`...32.3589883Z`); three enqueues in a
		// tight loop share the same MILLISECOND, so `new Date(iso).getTime()` (ms-truncated)
		// collapses their order. The cursor preserves full precision, so compare the ISO STRINGS
		// lexicographically (fixed-width zero-padded UTC ⇒ string order == chronological order) —
		// proving the SQL `< <datetime>$before` filter narrowed to strictly-earlier rows.
		expect(older.length).toBeGreaterThan(0);
		expect(older.every((r) => r.enqueuedAt! < cursor)).toBe(true);
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

describe('read-only invariant (spec §2.1/§6.3)', () => {
	it('queueStats + listWorkItems mutate NOTHING — even over rows the GC would reap', async () => {
		await clearQueue();
		// A stale `processing` row (gcStale WOULD reset it → pending) and an aged terminal row
		// (gcStale WOULD delete it). If any reader invoked the reaper, these would change.
		const staleClaim = new Date(Date.now() - DEFAULT_STUCK_MS - 60_000).toISOString();
		const oldTerminal = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		await db.query(
			`CREATE work_item CONTENT { work_type: "review", payload: {}, status: "processing", claim_token: "stale-tok", attempts: 1, claimed_at: <datetime>$sc, dedup_scope: "ro-stale" };
			 CREATE work_item CONTENT { work_type: "task_run", payload: {}, status: "done", attempts: 1, completed_at: <datetime>$ot, dedup_scope: "ro-done" };`,
			{ sc: staleClaim, ot: oldTerminal }
		);
		const before = await snapshot();

		// Exercise every read path the monitor uses.
		await queueStats(db);
		await listWorkItems(db, { status: ['pending', 'processing'] });
		await listWorkItems(db, { status: ['done', 'failed'] });

		const after = await snapshot();
		// Exact same rows, ids, statuses, claim tokens — proving no enqueue/claim/complete/gc ran.
		expect(after).toEqual(before);
		expect(before.length).toBe(2);
	});

	/** Stable snapshot of the whole queue (id+status+claim_token), sorted, for an equality diff. */
	async function snapshot(): Promise<Array<{ id: string; status: string; claim: string }>> {
		const [rows] = await db.query<[Array<{ id: unknown; status: string; claim_token: unknown }>]>(
			`SELECT id, status, claim_token FROM work_item;`
		);
		return (rows ?? [])
			.map((r) => ({ id: String(r.id), status: r.status, claim: r.claim_token == null ? '' : String(r.claim_token) }))
			.sort((a, b) => a.id.localeCompare(b.id));
	}
});
