// CG-2-1 VERIFY (real-surreal) — the concierge Stage-2 provider turn is METERED.
//
// Regression cover for the cost-governance-1b red-team finding: providerToLlmFn ran a real provider
// turn but wrote NO agent_event completion row, so a CLOUD concierge turn's spend was never counted
// (tokensSpentSince never saw it) and the budget gate meant to bound it could never trip from
// concierge usage. This suite drives the ACTUAL providerToLlmFn against a live throwaway SurrealDB and
// proves the honest metering contract end-to-end:
//   • a CLOUD turn writes ONE completion row carrying the observed tokens + a real computed cost_usd,
//     and that spend feeds the budget counter (tokensSpentSince rises by exactly the turn's tokens);
//   • a LOCAL (Ollama, $0) turn writes a completion row priced at a GENUINE 0 — never a fabricated
//     charge, never refused, but honestly recorded (F-008);
//   • a stream with NO usage leg meters tokens NONE → cost_usd stays NULL (never a fabricated 0);
//   • the turn is metered EXACTLY ONCE (no double-meter).
//
// Real-surreal (F-020): every assertion reads the row back from the live DB, so the write + the CG-1
// pricing chokepoint round-trip as real values a stubDb could not prove. A deterministic pricing map is
// injected so the test never depends on config/pricing.yaml contents.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { __setPricingForTest } from '../analytics/events';
import {
	tokensSpentSince,
	__setBudgetForTest,
	__setPerProjectBudgetForTest,
	__resetReservationsForTest
} from '../analytics/spend-budget';
import type { Provider, StreamChunk, Usage } from '../providers';
import { providerToLlmFn } from './wire';

/** A deterministic fake provider: yields the given text, then a `done` chunk with (or without) usage. */
function fakeProvider(text: string, usage: Usage | undefined): Provider {
	return {
		name: 'fake',
		async *stream(): AsyncIterable<StreamChunk> {
			if (text) yield { type: 'text', text };
			yield usage ? { type: 'done', usage } : { type: 'done' };
		},
		async health() {
			return { provider: 'fake', up: true };
		}
	};
}

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
	__setPricingForTest({
		models: {
			'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'gpt-oss:20b': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 }
		}
	});
	// Uncapped budget so the gate never refuses this suite's turns (we assert metering, not the gate).
	__setBudgetForTest(0);
	__setPerProjectBudgetForTest(0);
	__resetReservationsForTest();
}, 90_000);

afterAll(async () => {
	__setPricingForTest(null);
	__setBudgetForTest(null);
	__setPerProjectBudgetForTest(null);
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** Read back the most recent concierge completion row for a given model id. `at` is in the projection
 *  because SurrealDB requires an ORDER BY idiom to be a selected field (F-020). */
async function latestConciergeRow(modelId: string): Promise<Record<string, unknown> | undefined> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT cost_usd, tokens_in, tokens_out, model, detail, at FROM agent_event
		   WHERE type = 'completion' AND detail.source = 'concierge' AND model.model_id = $mid
		 ORDER BY at DESC LIMIT 1;`,
		{ mid: modelId }
	);
	return rows?.[0];
}

describe('CG-2-1 — the concierge Stage-2 turn is metered (real-surreal)', () => {
	it('a CLOUD turn writes ONE completion row with a real cost that feeds the budget', async () => {
		const before = await tokensSpentSince(db);
		const llm = providerToLlmFn(
			fakeProvider('cloud advice', { input: 200, output: 80 }),
			db,
			'claude',
			'claude-opus-4-8',
			'opus'
		);
		const text = await llm({ system: 'sys', user: 'usr' });
		expect(text).toBe('cloud advice');

		const row = await latestConciergeRow('claude-opus-4-8');
		expect(row).toBeDefined();
		expect(row!.tokens_in).toBe(200);
		expect(row!.tokens_out).toBe(80);
		// 200 in / 80 out @ opus ($5/$25 per Mtok) = 0.001 + 0.002 = 0.003.
		expect(row!.cost_usd).toBeCloseTo(0.003, 9);

		// The spend FEEDS the budget counter (the whole point of the finding): +280 tokens.
		const after = await tokensSpentSince(db);
		expect(after - before).toBe(280);
	});

	it('a LOCAL ($0) turn records an HONEST 0 — metered, never refused, never a fabricated charge', async () => {
		const llm = providerToLlmFn(
			fakeProvider('local advice', { input: 5000, output: 5000 }),
			db,
			'ollama',
			'gpt-oss:20b',
			'local'
		);
		const text = await llm({ system: 'sys', user: 'usr' });
		expect(text).toBe('local advice');

		const row = await latestConciergeRow('gpt-oss:20b');
		expect(row).toBeDefined();
		expect(row!.tokens_in).toBe(5000);
		expect(row!.tokens_out).toBe(5000);
		// gpt-oss:20b is priced at 0/0 → a GENUINE 0 (recorded as 0, NOT null — a real $0, not unknown).
		expect(row!.cost_usd).toBe(0);
	});

	it('a stream with NO usage leg meters tokens NONE → cost_usd stays NULL (never a fabricated 0)', async () => {
		const llm = providerToLlmFn(
			fakeProvider('no-usage advice', undefined),
			db,
			'claude',
			'claude-opus-4-8',
			'opus'
		);
		const before = await tokensSpentSince(db);
		const text = await llm({ system: 'sys', user: 'usr' });
		expect(text).toBe('no-usage advice');

		// The most recent opus concierge row is now the no-usage one — tokens omitted, cost NULL.
		const row = await latestConciergeRow('claude-opus-4-8');
		expect(row!.tokens_in === undefined || row!.tokens_in === null).toBe(true);
		expect(row!.cost_usd === undefined || row!.cost_usd === null).toBe(true);
		// No tokens ⇒ the budget counter does not move for this turn.
		const after = await tokensSpentSince(db);
		expect(after - before).toBe(0);
	});

	it('meters EXACTLY ONE completion row per turn (no double-meter)', async () => {
		const [beforeRows] = await db.query<[Array<{ n: number }>]>(
			`SELECT count() AS n FROM agent_event WHERE type = 'completion' AND detail.source = 'concierge' GROUP ALL;`
		);
		const beforeCount = beforeRows?.[0]?.n ?? 0;
		const llm = providerToLlmFn(
			fakeProvider('once', { input: 10, output: 10 }),
			db,
			'claude',
			'claude-opus-4-8',
			'opus'
		);
		await llm({ system: 'sys', user: 'usr' });
		const [afterRows] = await db.query<[Array<{ n: number }>]>(
			`SELECT count() AS n FROM agent_event WHERE type = 'completion' AND detail.source = 'concierge' GROUP ALL;`
		);
		const afterCount = afterRows?.[0]?.n ?? 0;
		expect(afterCount - beforeCount).toBe(1);
	});
});
