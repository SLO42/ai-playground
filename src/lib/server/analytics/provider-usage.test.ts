import { describe, it, expect } from 'vitest';
import { buildProviderUsage } from './provider-usage';
import type { Db } from '../db/client';

// MODEL-BENCHMARK-SPEC step 1 — the objective local-vs-cloud comparison rollup. Tested against a
// stub db that returns canned agent_event rows, so the load-bearing FOLD (GROUP BY provider) +
// honest empty state (F-008) are verified without a live SurrealDB.

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
