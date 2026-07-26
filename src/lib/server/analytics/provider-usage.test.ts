import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildProviderUsage } from './provider-usage';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';

// MODEL-BENCHMARK-SPEC step 1 — the objective local-vs-cloud comparison rollup.
//   1. STUB tests — the load-bearing FOLD (GROUP BY provider) + honest empty (F-008), fast, no DB.
//   2. A REAL-SURREAL test (F-020) — the stub NEVER parses SurrealQL, so the `ORDER BY at` idiom bug
//      (8905482: ordering by a field not in the projection → "Missing order idiom" parse error) was
//      invisible to it. This layer runs the ACTUAL query against a live throwaway DB, so any future
//      ORDER BY / GROUP BY idiom gap in buildProviderUsage fails the suite, not a live /reports page.

function stubDb(rows: unknown[]): Db {
	return { query: async () => [rows] } as unknown as Db;
}

describe('buildProviderUsage — GROUP BY provider (MODEL-BENCHMARK-SPEC step 1)', () => {
	it('returns an HONEST empty array when there are no rows (F-008)', async () => {
		const out = await buildProviderUsage(stubDb([]));
		expect(out).toEqual([]);
	});

	it('folds runs/sessions/tokens per provider and buckets an unset provider as "unknown"', async () => {
		const rows = [
			{ provider: 'ollama', session: 'session:a', type: 'spawn', tokens_in: 100, tokens_out: 50, duration_ms: 2000 },
			{ provider: 'ollama', session: 'session:a', type: 'completion', tokens_in: 0, tokens_out: 0, duration_ms: 4000 },
			{ provider: 'ollama', session: 'session:b', type: 'spawn', tokens_in: 20, tokens_out: 10 },
			{ provider: 'claude', session: 'session:c', type: 'spawn', tokens_in: 500, tokens_out: 200, cost_usd: 0.03, duration_ms: 1000 },
			{ provider: 'claude', session: 'session:c', type: 'completion', cost_usd: 0.01, parent: 'agent_event:x' },
			{ provider: null, session: 'session:d', type: 'error' }
		];
		const out = await buildProviderUsage(stubDb(rows));

		const ollama = out.find((p) => p.provider === 'ollama');
		const claude = out.find((p) => p.provider === 'claude');
		const unknown = out.find((p) => p.provider === 'unknown');

		expect(ollama).toBeDefined();
		expect(ollama).toMatchObject({
			sessions: 2, // session:a + session:b
			runs: 2,
			completions: 1,
			tokensIn: 120,
			tokensOut: 60,
			costUsd: null, // never priced ⇒ null, never a fake $0 (F-008)
			avgDurationMs: 3000 // mean of 2000 + 4000
		});

		expect(claude).toMatchObject({
			sessions: 1,
			runs: 1,
			completions: 1,
			costUsd: 0.04, // summed priced rows
			childSpawns: 1 // one row carried a parent_event_id
		});

		expect(unknown).toMatchObject({ provider: 'unknown', errors: 1, runs: 0 });
	});

	it('sorts providers by runs (busiest first)', async () => {
		const rows = [
			{ provider: 'claude', session: 'session:1', type: 'spawn' },
			{ provider: 'ollama', session: 'session:2', type: 'spawn' },
			{ provider: 'ollama', session: 'session:3', type: 'spawn' }
		];
		const out = await buildProviderUsage(stubDb(rows));
		expect(out.map((p) => p.provider)).toEqual(['ollama', 'claude']);
	});
});

// ── REAL-SURREAL (F-020: the ORDER BY at idiom actually executes) ──────────────────────────
describe('buildProviderUsage — live SurrealDB (F-020)', () => {
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
		await db.query('DELETE agent_event;');
	});

	interface SeedEvent {
		provider?: string | null;
		session?: string;
		type: string;
		tokens_in?: number;
		tokens_out?: number;
		cost_usd?: number;
		duration_ms?: number;
		parent?: string;
	}

	/** Seed one real agent_event row (SCHEMAFULL). session/model use safe inline literals (test-only). */
	async function seedEvent(e: SeedEvent): Promise<void> {
		const parts = [`type="${e.type}"`];
		if ('provider' in e) {
			parts.push(e.provider == null ? `model={ model_id: "m" }` : `model={ provider: "${e.provider}", model_id: "m" }`);
		}
		if (e.session) parts.push(`session=${e.session}`);
		for (const k of ['tokens_in', 'tokens_out', 'cost_usd', 'duration_ms'] as const) {
			if (e[k] != null) parts.push(`${k}=${e[k]}`);
		}
		if (e.parent) parts.push(`parent_event_id="${e.parent}"`);
		await db.query(`CREATE agent_event SET ${parts.join(', ')} RETURN NONE;`);
	}

	it('the ORDER BY at query PARSES + folds real rows per provider (would catch an idiom regression)', async () => {
		await seedEvent({ provider: 'ollama', session: 'session:a', type: 'spawn', tokens_in: 100, tokens_out: 50, duration_ms: 2000 });
		await seedEvent({ provider: 'ollama', session: 'session:a', type: 'completion', duration_ms: 4000 });
		await seedEvent({ provider: 'ollama', session: 'session:b', type: 'spawn', tokens_in: 20, tokens_out: 10 });
		await seedEvent({ provider: 'claude', session: 'session:c', type: 'spawn', tokens_in: 500, tokens_out: 200, cost_usd: 0.03, duration_ms: 1000 });
		await seedEvent({ provider: 'claude', session: 'session:c', type: 'completion', cost_usd: 0.01, parent: 'agent_event:x' });
		await seedEvent({ provider: null, session: 'session:d', type: 'error' });

		const out = await buildProviderUsage(db);
		const ollama = out.find((p) => p.provider === 'ollama');
		const claude = out.find((p) => p.provider === 'claude');
		const unknown = out.find((p) => p.provider === 'unknown');

		expect(ollama).toMatchObject({
			sessions: 2,
			runs: 2,
			completions: 1,
			tokensIn: 120,
			tokensOut: 60,
			costUsd: null, // never priced ⇒ null, never a fake $0 (F-008)
			avgDurationMs: 3000
		});
		expect(claude).toMatchObject({ sessions: 1, runs: 1, completions: 1, costUsd: 0.04, childSpawns: 1 });
		expect(unknown).toMatchObject({ provider: 'unknown', errors: 1, runs: 0 });
		// busiest-first ordering holds over the live rows.
		expect(out.map((p) => p.provider)).toEqual(['ollama', 'claude', 'unknown']);
	});

	it('HONEST empty when the window has no rows (F-008)', async () => {
		expect(await buildProviderUsage(db)).toEqual([]);
	});

	// COMPLETION-LEDGER Wave A — the local-vs-cloud comparison is only fair if the operator can see
	// how COMPLETE each side's cost is. A cloud provider whose rows are mostly unpriced looks cheap.
	it('carries the spend-provenance legs per provider through the REAL projection (F-020)', async () => {
		// cloud: 1 priced, 1 metered-but-unpriced, 1 priced+ESTIMATED (the DS-2 detail shape).
		await seedEvent({ provider: 'claude', session: 'session:p1', type: 'completion', tokens_in: 100, tokens_out: 20, cost_usd: 0.02 });
		await seedEvent({ provider: 'claude', session: 'session:p1', type: 'completion', tokens_in: 100, tokens_out: 20 });
		await db.query(
			`CREATE agent_event SET type="completion", model={ provider: "claude", model_id: "m" },
			   session=session:p1, tokens_in=50, tokens_out=10, cost_usd=0.5,
			   detail={ estimated: true, estimate_basis: "worst-case-cap" } RETURN NONE;`
		);
		// local: a genuine explicit $0 — a MEASUREMENT, so it must count as PRICED, not as a gap.
		await seedEvent({ provider: 'ollama', session: 'session:p2', type: 'completion', tokens_in: 900, tokens_out: 100, cost_usd: 0 });
		// a bare spawn at each provider — token-less, so never a coverage gap.
		await seedEvent({ provider: 'claude', session: 'session:p1', type: 'spawn' });
		await seedEvent({ provider: 'ollama', session: 'session:p2', type: 'spawn' });

		const out = await buildProviderUsage(db);
		const claude = out.find((p) => p.provider === 'claude')!;
		const ollama = out.find((p) => p.provider === 'ollama')!;

		expect(claude.pricedRowCount).toBe(2);
		expect(claude.unpricedRowCount).toBe(1); // the gap that made cloud look cheaper than it is
		expect(claude.estimatedRowCount).toBe(1); // `detail` really came back from SurrealDB
		expect(claude.spendEstimatedUsd).toBeCloseTo(0.5, 6);

		// Local is genuinely free: fully priced, nothing estimated — no false caveat on the free side.
		expect(ollama.pricedRowCount).toBe(1);
		expect(ollama.unpricedRowCount).toBe(0);
		expect(ollama.estimatedRowCount).toBe(0);
		expect(ollama.costUsd).toBe(0);
	});
});
