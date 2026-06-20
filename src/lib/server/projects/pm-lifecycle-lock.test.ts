import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import {
	acquireLifecycleLock,
	releaseLifecycleLock,
	STALE_LOCK_MS
} from './pm-lifecycle-lock';

// PM-LC-2 hardening VERIFY — the per-project in-flight lock against a REAL throwaway SurrealDB.
// Covers the four shadow paths of the lock primitive itself:
//   • happy path: acquire on a free lock returns held=true; a SECOND acquire while held is benign
//     (held=false, reason='already-running') — no throw, no second owner;
//   • release: only the HOLDER releases (nonce-scoped); after release the lock is re-acquirable;
//   • crash/SIGKILL (stale lock): a lock older than STALE_LOCK_MS is atomically TAKEN OVER by a later
//     tick (never wedges the project); a FRESH foreign lock is NOT seized;
//   • foreign release is a no-op (a different tick's release cannot clear our live lock).

let tdb: TestDb;
let db: Db;
let seq = 0;
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
	await db.query('DELETE pm_lifecycle_lock; DELETE project;').catch(() => {});
	const p = await createProject(db, {
		slug: `pmlock${++seq}`,
		name: 'Lock Host',
		root_path: 'F:/code/pmlock'
	});
	projectId = p.id;
});

/** Force the held lock's `at` back in time so it reads as stale (simulates a crashed holder). */
async function ageLockBeyondTtl(pid: string): Promise<void> {
	const idPart = pid.slice(pid.indexOf(':') + 1);
	const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
	await db.query(`UPDATE type::thing('pm_lifecycle_lock', $id) SET at = $old RETURN NONE;`, {
		id: idPart,
		old
	});
}

describe('acquireLifecycleLock — happy path + benign concurrent refusal', () => {
	it('acquires a free lock, then refuses a concurrent second acquire (benign, no throw)', async () => {
		const first = await acquireLifecycleLock(db, projectId);
		expect(first.held).toBe(true);
		expect(first.nonce).toBeTruthy();

		// A SECOND acquire while the first is held → benign already-running (NO throw, NO second owner).
		const second = await acquireLifecycleLock(db, projectId);
		expect(second.held).toBe(false);
		expect(second.reason).toBe('already-running');
		expect(second.nonce).not.toBe(first.nonce);
	});

	it('two PARALLEL acquires yield exactly ONE holder (no double-spend window)', async () => {
		const [a, b] = await Promise.all([
			acquireLifecycleLock(db, projectId),
			acquireLifecycleLock(db, projectId)
		]);
		const holders = [a, b].filter((r) => r.held);
		expect(holders).toHaveLength(1);
		const refused = [a, b].find((r) => !r.held);
		expect(refused?.reason).toBe('already-running');
	});

	// PMLH-1 regression — TRUE simultaneity. Under real parallelism SurrealDB's optimistic-transaction
	// layer non-deterministically returns the LOSER either `already exists` OR `Failed to commit
	// transaction due to a read or write conflict`. The original guard matched ONLY /already exists/ and
	// RE-THREW the conflict variant — a raw 500, and on the both-commit variant the exact double-spend
	// the lock exists to prevent. We loop several fresh-lock races so the conflict variant surfaces, and
	// assert the loser is ALWAYS benign ({held:false, reason:'already-running'}) and the generator-of-
	// truth — the holder — is acquired exactly ONCE per race (never twice, never thrown).
	it('many TRUE-parallel acquire races: loser is ALWAYS benign, never thrown, never a second holder', async () => {
		for (let i = 0; i < 12; i++) {
			await db.query('DELETE pm_lifecycle_lock;').catch(() => {});
			// Fire both with NO awaits in between so the two CREATEs reach the DB truly simultaneously —
			// this is what makes the read/write-conflict variant (not just the serialized already-exists)
			// reachable, which the timing-masked full-file run never exercised.
			const results = await Promise.allSettled([
				acquireLifecycleLock(db, projectId),
				acquireLifecycleLock(db, projectId)
			]);
			// NEVER thrown — every settle is fulfilled (the conflict variant must be absorbed, not re-thrown).
			const rejected = results.filter((r) => r.status === 'rejected');
			expect(rejected, `iter ${i}: an acquire threw instead of returning benign`).toHaveLength(0);
			const settled = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLifecycleLock>>>).value);
			const holders = settled.filter((r) => r.held);
			// Exactly ONE holder — the second submit must NOT acquire (no double real-spend).
			expect(holders, `iter ${i}: expected exactly one holder`).toHaveLength(1);
			const refused = settled.find((r) => !r.held);
			expect(refused?.reason, `iter ${i}: loser not benign already-running`).toBe('already-running');
		}
	});
});

describe('releaseLifecycleLock — holder-scoped, re-acquirable', () => {
	it('the holder releases; the lock is then re-acquirable', async () => {
		const first = await acquireLifecycleLock(db, projectId);
		expect(first.held).toBe(true);
		await releaseLifecycleLock(db, projectId, first.nonce);

		const again = await acquireLifecycleLock(db, projectId);
		expect(again.held).toBe(true);
	});

	it('a FOREIGN release (wrong nonce) does NOT clear a live lock', async () => {
		const first = await acquireLifecycleLock(db, projectId);
		expect(first.held).toBe(true);
		// A different tick's release with a non-matching nonce must be a no-op.
		await releaseLifecycleLock(db, projectId, 'some-other-nonce');
		const second = await acquireLifecycleLock(db, projectId);
		expect(second.held).toBe(false); // still held by `first` — the foreign release did nothing.
	});
});

describe('acquireLifecycleLock — stale takeover (CA-H4 — never wedge)', () => {
	it('a STALE lock (crashed holder) is atomically taken over by a later tick', async () => {
		const crashed = await acquireLifecycleLock(db, projectId);
		expect(crashed.held).toBe(true);
		// Simulate: the holder was SIGKILLed between acquire and release. Age the lock past the TTL.
		await ageLockBeyondTtl(projectId);

		const recovered = await acquireLifecycleLock(db, projectId);
		expect(recovered.held).toBe(true); // self-healed — the project is NOT permanently wedged.
		expect(recovered.nonce).not.toBe(crashed.nonce);

		// The crashed holder's stale release is now a no-op (a later tick owns the lock).
		await releaseLifecycleLock(db, projectId, crashed.nonce);
		const stillHeld = await acquireLifecycleLock(db, projectId);
		expect(stillHeld.held).toBe(false); // recovered tick still holds it (foreign release ignored).
	});

	it('two PARALLEL takeovers of a stale lock yield exactly ONE new holder', async () => {
		const crashed = await acquireLifecycleLock(db, projectId);
		expect(crashed.held).toBe(true);
		await ageLockBeyondTtl(projectId);

		const [a, b] = await Promise.all([
			acquireLifecycleLock(db, projectId),
			acquireLifecycleLock(db, projectId)
		]);
		const winners = [a, b].filter((r) => r.held);
		expect(winners).toHaveLength(1); // CAS — only one racer seizes the stale lock.
	});

	it('a FRESH foreign lock is NOT seized (only stale locks are taken over)', async () => {
		const live = await acquireLifecycleLock(db, projectId);
		expect(live.held).toBe(true);
		// No aging — the lock is fresh. A second acquire must be refused, not seized.
		const second = await acquireLifecycleLock(db, projectId);
		expect(second.held).toBe(false);
		expect(second.reason).toBe('already-running');
	});
});
