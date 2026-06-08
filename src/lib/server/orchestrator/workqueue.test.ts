import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	claimNext,
	complete,
	countByStatus,
	enqueue,
	gcStale,
	pendingDepth,
	recoverHandoffs,
	spawnsSince,
	writeHandoff
} from './workqueue';

// TASK 2.2 — the background work_item claim queue (DATA-MODEL §4.12; D-021). Proven
// against the live throwaway DB: SELECT-then-claim-by-id (NOT UPDATE…ORDER BY), atomic
// single-winner claim under concurrency (S0), priority ordering, and dedup on the
// active window.

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
	const p = await createProject(db, { slug: 'wq', name: 'WQ Host', root_path: 'F:/code/wq' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** Wipe the queue between tests so dedup keys + counts don't leak across cases. */
async function clearQueue(): Promise<void> {
	await db.query(`DELETE work_item;`);
}

describe('work_item claim queue (DATA-MODEL §4.12; D-021)', () => {
	it('enqueue creates a pending row; claimNext claims it atomically', async () => {
		await clearQueue();
		const { id, enqueued } = await enqueue(db, {
			workType: 'task_run',
			payload: { taskId: 'task:1', projectId },
			projectId
		});
		expect(enqueued).toBe(true);
		expect(id).toMatch(/^work_item:/);
		expect(await countByStatus(db, 'pending')).toBe(1);

		const claimed = await claimNext(db, 'tok_a');
		expect(claimed).not.toBeNull();
		expect(claimed!.id).toBe(id);
		expect(claimed!.workType).toBe('task_run');
		expect(claimed!.payload.taskId).toBe('task:1');
		expect(claimed!.attempts).toBe(1);
		// Now processing, not pending.
		expect(await countByStatus(db, 'pending')).toBe(0);
		expect(await countByStatus(db, 'processing')).toBe(1);
	});

	it('claimNext returns null on an empty queue', async () => {
		await clearQueue();
		expect(await claimNext(db, 'tok_empty')).toBeNull();
	});

	it('claims in PRIORITY order (lower priority value = sooner)', async () => {
		await clearQueue();
		// Distinct payloads so dedup_key (work_type|session|status) doesn't collapse them
		// — these have no session, so we vary work_type to keep dedup keys distinct.
		await enqueue(db, { workType: 'low', payload: { n: 1 }, priority: 9 });
		await enqueue(db, { workType: 'high', payload: { n: 2 }, priority: 1 });
		await enqueue(db, { workType: 'mid', payload: { n: 3 }, priority: 5 });

		const a = await claimNext(db, 't1');
		const b = await claimNext(db, 't2');
		const c = await claimNext(db, 't3');
		expect([a!.priority, b!.priority, c!.priority]).toEqual([1, 5, 9]);
	});

	it('ATOMIC single-winner: N concurrent claims on ONE row → exactly one winner (S0)', async () => {
		await clearQueue();
		const { id } = await enqueue(db, { workType: 'task_run', payload: { only: true } });
		// Fire 8 concurrent claims (the S0 race shape). Exactly one must win the row.
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) => claimNext(db, `racer_${i}`))
		);
		const winners = results.filter((r) => r !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]!.id).toBe(id);
		// attempts incremented exactly once — only the winner's UPDATE matched the guard.
		expect(winners[0]!.attempts).toBe(1);
	});

	it('complete only succeeds for the lease holder (claim_token guard)', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'task_run', payload: { x: 1 } });
		const claimed = await claimNext(db, 'real_token');
		expect(claimed).not.toBeNull();
		// A stale worker with the wrong token cannot complete the row.
		expect(await complete(db, claimed!.id, 'wrong_token', 'done')).toBe(false);
		// The lease holder can.
		expect(await complete(db, claimed!.id, 'real_token', 'done')).toBe(true);
		expect(await countByStatus(db, 'done')).toBe(1);
	});

	it('dedup: re-enqueueing the same ACTIVE unit is a no-op (UNIQUE dedup_key)', async () => {
		await clearQueue();
		const sess = await db.query<[Array<{ id: unknown }>]>(
			`CREATE session CONTENT {
				kind: "task",
				runtime: "claude-code",
				model: { provider: "claude", model_id: "claude-opus-4-8" }
			} RETURN AFTER;`
		);
		const sessionId = String(sess[0][0].id);
		// Same work_type + session + pending status → same dedup_key.
		const first = await enqueue(db, { workType: 'extract', payload: { a: 1 }, sessionId });
		const second = await enqueue(db, { workType: 'extract', payload: { a: 2 }, sessionId });
		expect(first.enqueued).toBe(true);
		expect(second.enqueued).toBe(false); // dedup'd
		expect(await countByStatus(db, 'pending')).toBe(1);
	});
});

// ── TASK 2.15 — daily cap, GC, crash-safe handoff (D-021; ARCHITECTURE §2.2 line 384) ──
describe('work_item daily cap / GC / handoff (TASK 2.15; D-021)', () => {
	it('spawnsSince counts only CLAIMED items inside the rolling window', async () => {
		await clearQueue();
		// Three items with DISTINCT priorities so claim order is deterministic (a→b→c).
		await enqueue(db, { workType: 'a', payload: { n: 1 }, priority: 1 });
		await enqueue(db, { workType: 'b', payload: { n: 2 }, priority: 2 });
		await enqueue(db, { workType: 'c', payload: { n: 3 }, priority: 3 });
		expect(await spawnsSince(db)).toBe(0); // nothing claimed yet
		expect((await claimNext(db, 'cap_t1'))!.workType).toBe('a'); // lowest priority first
		expect((await claimNext(db, 'cap_t2'))!.workType).toBe('b');
		// Two claimed within the window → counted; the pending one (c) is not.
		expect(await spawnsSince(db)).toBe(2);
		// A tiny window (1ms) excludes claims made >1ms ago → effectively 0.
		await new Promise((r) => setTimeout(r, 5));
		expect(await spawnsSince(db, 1)).toBe(0);
		// work_type scoping isolates the count: only 'a' was claimed under that type.
		expect(await spawnsSince(db, undefined, 'a')).toBe(1);
		expect(await spawnsSince(db, undefined, 'c')).toBe(0); // c never claimed
	});

	it('gcStale DELETES aged terminal rows and RECOVERS crashed processing rows', async () => {
		await clearQueue();
		// One done row, one failed row, one fresh done row, one stuck processing row.
		const { id: doneId } = await enqueue(db, { workType: 'old_done', payload: {} });
		const cDone = await claimNext(db, 'g1');
		await complete(db, cDone!.id, 'g1', 'done');
		const { id: failId } = await enqueue(db, { workType: 'old_fail', payload: {} });
		const cFail = await claimNext(db, 'g2');
		await complete(db, cFail!.id, 'g2', 'failed');
		// Age both terminal rows past the 7d window by back-dating completed_at.
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
		await db.query(
			`UPDATE type::thing($a) SET completed_at = <datetime>$t;
			 UPDATE type::thing($b) SET completed_at = <datetime>$t;`,
			{ a: doneId, b: failId, t: old }
		);
		// A FRESH done row (just completed) must survive GC.
		await enqueue(db, { workType: 'fresh_done', payload: {} });
		const cFresh = await claimNext(db, 'g3');
		await complete(db, cFresh!.id, 'g3', 'done');
		// A stuck processing row (claimed, never completed), back-dated past the stuck window.
		await enqueue(db, { workType: 'stuck', payload: {} });
		const cStuck = await claimNext(db, 'g4');
		const stuckOld = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		await db.query(`UPDATE type::thing($s) SET claimed_at = <datetime>$t;`, {
			s: cStuck!.id,
			t: stuckOld
		});

		const res = await gcStale(db);
		expect(res.deletedTerminal).toBe(2); // the two aged terminal rows
		expect(res.recoveredStuck).toBe(1); // the stuck processing row
		// Fresh done survived; stuck row is back to pending+unclaimed (re-drainable).
		expect(await countByStatus(db, 'done')).toBe(1);
		const reclaim = await claimNext(db, 'g5');
		expect(reclaim).not.toBeNull();
		expect(reclaim!.workType).toBe('stuck');

		// Idempotent: a second GC with nothing newly stale is a no-op.
		const res2 = await gcStale(db);
		expect(res2.deletedTerminal).toBe(0);
	});

	it('writeHandoff is lease-guarded; recoverHandoffs surfaces mid-flight items', async () => {
		await clearQueue();
		await enqueue(db, { workType: 'resumable', payload: { step: 0 } });
		const claimed = await claimNext(db, 'holder');
		expect(claimed).not.toBeNull();
		// A stale worker with the wrong lease cannot write a handoff.
		expect(await writeHandoff(db, claimed!.id, 'not_holder', { step: 9 })).toBe(false);
		// The lease holder can write its crash-recovery handoff state synchronously.
		expect(await writeHandoff(db, claimed!.id, 'holder', { step: 3, note: 'paused' })).toBe(true);
		// A freshly-booted orchestrator surfaces the mid-flight item + its handoff.
		const rows = await recoverHandoffs(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(claimed!.id);
		expect(rows[0].handoff.step).toBe(3);
		expect(rows[0].handoff.note).toBe('paused');
		expect(rows[0].claimToken).toBe('holder');
	});

	it('pendingDepth reflects the unclaimed backlog (threshold-drain signal)', async () => {
		await clearQueue();
		expect(await pendingDepth(db)).toBe(0);
		await enqueue(db, { workType: 'x', payload: {} });
		await enqueue(db, { workType: 'y', payload: {} });
		expect(await pendingDepth(db)).toBe(2);
		await claimNext(db, 'pd');
		expect(await pendingDepth(db)).toBe(1); // one now processing
	});
});
