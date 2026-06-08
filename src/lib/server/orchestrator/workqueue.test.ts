import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { claimNext, complete, countByStatus, enqueue } from './workqueue';

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
