// Brain view — recent-decisions reader VERIFY.
//
// REAL-SURREAL (F-020: stubDb does NOT parse SurrealQL) — the ORDER BY created_at / LIMIT read runs
// against a live throwaway DB, proving the query parses, orders newest-first, coerces the SDK
// datetime to an ISO string (F-013), and returns an honest empty list on a cold table (F-008).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { listRecentDecisions, RECENT_DECISIONS_LIMIT } from './decisions';

describe('listRecentDecisions — live SurrealDB (F-020)', () => {
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
	}, 60_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown().catch(() => {});
	});

	beforeEach(async () => {
		await db.query('DELETE decision;');
	});

	async function seedDecision(
		title: string,
		opts: { at?: string; status?: string; rationale?: string; context?: string } = {}
	): Promise<void> {
		await db.query(
			`CREATE decision SET project=project:demo, title=$title,
			   ${opts.context ? 'context=$context,' : ''}
			   ${opts.rationale ? 'rationale=$rationale,' : ''}
			   status=$status,
			   created_at=${opts.at ? '$at' : 'time::now()'} RETURN NONE;`,
			{
				title,
				status: opts.status ?? 'accepted',
				...(opts.context ? { context: opts.context } : {}),
				...(opts.rationale ? { rationale: opts.rationale } : {}),
				...(opts.at ? { at: new Date(opts.at) } : {})
			}
		);
	}

	it('returns an honest empty list on a cold table (F-008)', async () => {
		expect(await listRecentDecisions(db)).toEqual([]);
	});

	it('orders decisions newest-first and coerces created_at to an ISO string (F-013)', async () => {
		await seedDecision('older call', { at: '2026-01-01T00:00:00Z' });
		await seedDecision('newest call', { at: '2026-03-01T00:00:00Z' });
		await seedDecision('middle call', { at: '2026-02-01T00:00:00Z' });

		const rows = await listRecentDecisions(db);
		expect(rows.map((r) => r.title)).toEqual(['newest call', 'middle call', 'older call']);
		// F-013: created_at is a serialization-safe ISO string, not a raw SDK datetime.
		expect(typeof rows[0].createdAt).toBe('string');
		expect(rows[0].createdAt).toBe(new Date('2026-03-01T00:00:00Z').toISOString());
	});

	it('surfaces title/status/rationale/context/project and honest nulls for unset fields', async () => {
		await seedDecision('vector DB is SurrealDB', {
			status: 'accepted',
			rationale: 'one swappable embedder seam; no second datastore',
			context: 'S3 cognitive layer'
		});
		await seedDecision('bare title only');

		const rows = await listRecentDecisions(db);
		const full = rows.find((r) => r.title === 'vector DB is SurrealDB');
		expect(full).toBeDefined();
		expect(full!.status).toBe('accepted');
		expect(full!.rationale).toContain('swappable embedder');
		expect(full!.context).toBe('S3 cognitive layer');
		expect(full!.project).toBe('project:demo');

		const bare = rows.find((r) => r.title === 'bare title only');
		expect(bare!.rationale).toBeNull();
		expect(bare!.context).toBeNull();
	});

	it('respects the limit (bounded read)', async () => {
		for (let i = 0; i < RECENT_DECISIONS_LIMIT + 4; i++) {
			await seedDecision(`decision ${i}`, { at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
		}
		const rows = await listRecentDecisions(db, 3);
		expect(rows).toHaveLength(3);
	});
});
