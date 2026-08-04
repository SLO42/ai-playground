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
import { __setPricingForTest, activityLabel } from '../analytics/events';
import {
	tokensSpentSince,
	__setBudgetForTest,
	__setPerProjectBudgetForTest,
	__resetReservationsForTest
} from '../analytics/spend-budget';
import { OllamaProvider, type Provider, type StreamChunk, type Usage } from '../providers';
import {
	providerToLlmFn,
	resolveConciergeTurnUsage,
	fetchWithSignal,
	__setConciergeLlmTimeoutForTest
} from './wire';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A provider that STALLS mid-stream — the shape that reproduces CG-3-1. It emits `text` (optionally),
 * then holds for `holdMs` (long enough for the turn's wall-clock bound to win the race), and only then
 * either throws or emits its `done` usage leg. So the turn is aborted with real tokens already spent
 * and no usage report — exactly the un-metered-cloud-spend case.
 */
function stallingProvider(opts: {
	text?: string;
	holdMs: number;
	thenThrow?: boolean;
	usageBeforeStall?: Usage;
	usageAtEnd?: Usage;
}): Provider {
	return {
		name: 'stalling',
		async *stream(): AsyncIterable<StreamChunk> {
			if (opts.text) yield { type: 'text', text: opts.text };
			if (opts.usageBeforeStall) yield { type: 'done', usage: opts.usageBeforeStall };
			await sleep(opts.holdMs);
			if (opts.thenThrow) throw new Error('provider socket died mid-stream');
			yield { type: 'done', usage: opts.usageAtEnd ?? { input: 999_999, output: 999_999 } };
		},
		async health() {
			return { provider: 'stalling', up: true };
		}
	};
}

/** A provider that throws IMMEDIATELY after some output — the non-timeout error path. */
function throwingProvider(text: string): Provider {
	return {
		name: 'throwing',
		async *stream(): AsyncIterable<StreamChunk> {
			if (text) yield { type: 'text', text };
			throw new Error('provider rejected the request');
		},
		async health() {
			return { provider: 'throwing', up: true };
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
			'gpt-oss:20b': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
			// CG-3-1 fixtures — one model id per abort case so `ORDER BY at DESC LIMIT 1` can never
			// read back a neighbouring test's row on a coarse timestamp tie.
			'cg3-timeout-partial': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-timeout-silent': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-midstream-throw': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-measured-then-throw': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-no-double': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-late-throw': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg3-local-abort': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
			// CG-4-1 / CG-4-2 fixtures — one model id per cancellation case, same reason as above.
			'cg4-abort-midstream': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg4-abort-silent': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg4-normal': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg4-wedged': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg4-signal-success': { inputUsdPerMtok: 5, outputUsdPerMtok: 25 },
			'cg4-ollama-hang': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
			'cg4-local-uncapped': { inputUsdPerMtok: 0, outputUsdPerMtok: 0 }
		}
	});
	// Uncapped budget so the gate never refuses this suite's turns (we assert metering, not the gate).
	__setBudgetForTest(0);
	__setPerProjectBudgetForTest(0);
	__resetReservationsForTest();
}, 90_000);

afterAll(async () => {
	__setConciergeLlmTimeoutForTest(null);
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

// ── CG-3-1 / CG-3-2 — the ABORT paths (cost-governance-2 red-team deferral) ────────────────────
//
// CG-3-1: meterConciergeTurn fired ONLY on the Promise.race SUCCESS branch, so a CLOUD turn that
// consumed real tokens and then TIMED OUT (30s) or threw mid-stream was NEVER metered — the exact
// un-metered-cloud-spend class CG-2-1 closed, surviving on the error path. These tests drive the real
// providerToLlmFn against a live SurrealDB with the wall-clock bound shrunk to milliseconds, and prove:
//   • an aborted turn IS metered, and its (estimated) spend reaches the budget counter;
//   • an estimated row is DISTINGUISHABLE from a measured one — in the data (detail.estimated /
//     estimate_basis / estimate_note) and in the label every activity feed renders (detail.summary);
//   • a measured usage leg still wins on an error path (we never downgrade real numbers to a guess);
//   • an aborted LOCAL turn stays an honest $0;
//   • exactly ONE completion row per turn, even when the stream resolves or throws long after the abort.
// CG-3-2: the detached `collect` IIFE that outlives the lost race records its late fault as a persisted
// agent_event, not an unhandled rejection and not a console-only line.

/** Count concierge completion rows for one model id (the no-double-meter assertion). */
async function conciergeRowCount(modelId: string): Promise<number> {
	const [rows] = await db.query<[Array<{ n: number }>]>(
		`SELECT count() AS n FROM agent_event
		   WHERE type = 'completion' AND detail.source = 'concierge' AND model.model_id = $mid
		 GROUP ALL;`,
		{ mid: modelId }
	);
	return rows?.[0]?.n ?? 0;
}

/** The most recent concierge ERROR row for a model id (CG-3-2's late-fault surface). */
async function latestConciergeErrorRow(modelId: string): Promise<Record<string, unknown> | undefined> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT detail, model, tokens_in, cost_usd, at FROM agent_event
		   WHERE type = 'error' AND detail.source = 'concierge' AND model.model_id = $mid
		 ORDER BY at DESC LIMIT 1;`,
		{ mid: modelId }
	);
	return rows?.[0];
}

/** Poll a reader until it returns a row or the bound elapses (the late fault is fire-and-forget). */
async function waitForRow<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = await read();
		if (row) return row;
		if (Date.now() > deadline) return undefined;
		await sleep(25);
	}
}

describe('CG-3-1 — an ABORTED concierge turn is still metered, honestly (real-surreal)', () => {
	it('a CLOUD turn that TIMES OUT mid-stream meters an ESTIMATED row whose spend reaches the budget', async () => {
		__setConciergeLlmTimeoutForTest(40);
		const before = await tokensSpentSince(db);
		const llm = providerToLlmFn(
			stallingProvider({ text: 'partial advice that never finished', holdMs: 400 }),
			db,
			'claude',
			'cg3-timeout-partial',
			'opus'
		);
		// The turn still REJECTS (the caller's honest "model unavailable" reply depends on it).
		await expect(llm({ system: 'sys', user: 'a question' })).rejects.toThrow(/exceeded 40ms/);

		const row = await latestConciergeRow('cg3-timeout-partial');
		expect(row).toBeDefined();
		const detail = row!.detail as Record<string, unknown>;
		// METERED — the whole point of the finding.
		expect(typeof row!.tokens_in).toBe('number');
		expect(typeof row!.tokens_out).toBe('number');
		expect((row!.tokens_in as number) + (row!.tokens_out as number)).toBeGreaterThan(0);
		// Distinguishable AS AN ESTIMATE, in the data…
		expect(detail.estimated).toBe(true);
		expect(detail.estimate_basis).toBe('partial-stream');
		expect(String(detail.estimate_note)).toMatch(/ESTIMATED, not measured/);
		expect(detail.outcome).toBe('timeout');
		expect(detail.ok).toBe(false);
		expect(String(detail.error)).toMatch(/exceeded 40ms/);
		// …and in the label every activity feed renders. This is not a string-shape guess: the row's
		// PERSISTED detail is pushed through the REAL analytics/events.ts activityLabel — the one
		// function home/index.ts, loops/read.ts and notifications/repo.ts each call to build the line an
		// operator actually reads — so the measured-vs-estimated distinction is proven to survive to the UI.
		expect(String(detail.summary)).toMatch(/TIMED OUT/);
		const feedLabel = activityLabel(detail, 200);
		expect(feedLabel).toMatch(/TIMED OUT/);
		expect(feedLabel).toMatch(/spend ESTIMATED, not measured/);
		// The spend now FEEDS the budget counter (it was invisible before the fix).
		const after = await tokensSpentSince(db);
		expect(after - before).toBe((row!.tokens_in as number) + (row!.tokens_out as number));
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('a turn that aborts with NO output read back meters a labelled WORST-CASE cap (never nothing)', async () => {
		__setConciergeLlmTimeoutForTest(30);
		const llm = providerToLlmFn(
			stallingProvider({ holdMs: 400 }),
			db,
			'claude',
			'cg3-timeout-silent',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 30ms/);

		const row = await latestConciergeRow('cg3-timeout-silent');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.estimated).toBe(true);
		expect(detail.estimate_basis).toBe('worst-case-cap');
		// The output leg is the turn's hard cap — an UPPER bound, said so in words.
		expect(row!.tokens_out).toBe(1024);
		expect(String(detail.estimate_note)).toMatch(/UPPER bound/);
		expect(typeof row!.cost_usd).toBe('number');
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('a turn that THROWS mid-stream (no timeout) is metered as an error, not silently dropped', async () => {
		const before = await tokensSpentSince(db);
		const llm = providerToLlmFn(throwingProvider('some tokens burned'), db, 'claude', 'cg3-midstream-throw', 'opus');
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/rejected the request/);

		const row = await latestConciergeRow('cg3-midstream-throw');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.outcome).toBe('error');
		expect(detail.estimated).toBe(true);
		expect(detail.estimate_basis).toBe('partial-stream');
		expect(String(detail.summary)).toMatch(/FAILED mid-stream/);
		expect(String(detail.error)).toMatch(/rejected the request/);
		expect(await tokensSpentSince(db)).toBeGreaterThan(before);
	}, 20_000);

	it('a MEASURED usage leg still wins on the error path — real numbers are never downgraded to a guess', async () => {
		__setConciergeLlmTimeoutForTest(40);
		const llm = providerToLlmFn(
			stallingProvider({ text: 'hi', holdMs: 400, usageBeforeStall: { input: 123, output: 45 } }),
			db,
			'claude',
			'cg3-measured-then-throw',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 40ms/);

		const row = await latestConciergeRow('cg3-measured-then-throw');
		const detail = row!.detail as Record<string, unknown>;
		expect(row!.tokens_in).toBe(123);
		expect(row!.tokens_out).toBe(45);
		expect(detail.estimated).toBe(false);
		expect(detail.estimate_basis).toBe('measured-usage');
		expect(String(detail.summary)).toMatch(/spend measured from the provider usage report/);
		// 123 in / 45 out @ $5/$25 per Mtok = 0.000615 + 0.001125.
		expect(row!.cost_usd).toBeCloseTo(0.00174, 9);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('an aborted LOCAL turn stays an HONEST $0 — estimated tokens, genuinely free', async () => {
		__setConciergeLlmTimeoutForTest(30);
		const llm = providerToLlmFn(
			stallingProvider({ text: 'local partial', holdMs: 400 }),
			db,
			'ollama',
			'cg3-local-abort',
			'local'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 30ms/);

		const row = await latestConciergeRow('cg3-local-abort');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.estimated).toBe(true);
		expect((row!.tokens_in as number) + (row!.tokens_out as number)).toBeGreaterThan(0);
		// Priced at 0/0 ⇒ a GENUINE 0, not a fabricated charge and not a fabricated unknown.
		expect(row!.cost_usd).toBe(0);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('meters EXACTLY ONCE even when the stream completes long AFTER the turn timed out', async () => {
		__setConciergeLlmTimeoutForTest(30);
		expect(await conciergeRowCount('cg3-no-double')).toBe(0);
		const llm = providerToLlmFn(
			stallingProvider({ text: 'slow', holdMs: 250, usageAtEnd: { input: 4242, output: 4242 } }),
			db,
			'claude',
			'cg3-no-double',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 30ms/);
		// Let the abandoned stream finish and (wrongly) try to meter again.
		await sleep(500);
		expect(await conciergeRowCount('cg3-no-double')).toBe(1);
		// And the one row is the ESTIMATE, not the late 8484-token usage leg.
		const row = await latestConciergeRow('cg3-no-double');
		expect(row!.tokens_out).not.toBe(4242);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);
});

describe('CG-3-2 — a stream fault raised AFTER the timeout is RECORDED, not unhandled (real-surreal)', () => {
	it('persists an agent_event error row for the late fault, carrying no extra spend', async () => {
		__setConciergeLlmTimeoutForTest(30);
		const llm = providerToLlmFn(
			stallingProvider({ text: 'partial', holdMs: 200, thenThrow: true }),
			db,
			'claude',
			'cg3-late-throw',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 30ms/);

		const row = await waitForRow(() => latestConciergeErrorRow('cg3-late-throw'));
		expect(row).toBeDefined();
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.phase).toBe('post-timeout-stream');
		expect(String(detail.error)).toMatch(/socket died mid-stream/);
		expect(String(detail.summary)).toMatch(/AFTER the turn had already timed out/);
		// The fault row is observability ONLY — the spend was already accounted for by the estimate.
		expect(row!.tokens_in === undefined || row!.tokens_in === null).toBe(true);
		expect(row!.cost_usd === undefined || row!.cost_usd === null).toBe(true);
		// Still exactly one completion row for the turn (the late fault did not re-meter).
		expect(await conciergeRowCount('cg3-late-throw')).toBe(1);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);
});

describe('resolveConciergeTurnUsage — the four paths (happy · nil · empty · upstream error)', () => {
	const timedOut = { kind: 'timeout' as const, error: 'exceeded 30ms' };

	it('HAPPY: a reported usage leg is metered as MEASURED, whatever the outcome', () => {
		const chunks: StreamChunk[] = [{ type: 'text', text: 'hi' }, { type: 'done', usage: { input: 7, output: 3 } }];
		expect(resolveConciergeTurnUsage(chunks, 40, { kind: 'ok' })).toEqual({
			tokensIn: 7,
			tokensOut: 3,
			estimated: false,
			basis: 'measured-usage'
		});
		expect(resolveConciergeTurnUsage(chunks, 40, timedOut).basis).toBe('measured-usage');
	});

	it('NIL input: a null/undefined chunk list never throws — it degrades to the worst-case cap', () => {
		for (const nil of [null, undefined]) {
			const u = resolveConciergeTurnUsage(nil, 400, timedOut);
			expect(u.estimated).toBe(true);
			expect(u.basis).toBe('worst-case-cap');
			expect(u.tokensIn).toBe(100);
			expect(u.tokensOut).toBe(1024);
		}
	});

	it('EMPTY input: a success with no usage leg meters NO tokens (honest NONE, never a fake $0)', () => {
		expect(resolveConciergeTurnUsage([], 40, { kind: 'ok' })).toEqual({ estimated: false, basis: 'none' });
		// And a zero-length prompt on the abort path estimates 0 input rather than inventing one.
		expect(resolveConciergeTurnUsage([], 0, timedOut).tokensIn).toBe(0);
	});

	it('UPSTREAM ERROR: partial output estimates a labelled LOWER bound from what actually arrived', () => {
		const u = resolveConciergeTurnUsage(
			[{ type: 'text', text: 'abcdefgh' }],
			40,
			{ kind: 'error', error: 'socket died' }
		);
		expect(u).toMatchObject({ tokensIn: 10, tokensOut: 2, estimated: true, basis: 'partial-stream' });
		expect(u.note).toMatch(/LOWER bound/);
	});
});

// ── CG-4-2 — the worst-case cap only claims to be a ceiling when the provider enforces it ─────────
//
// The deferral's LOW finding: buildConciergeLlm constructs OllamaProvider WITHOUT any max-output
// option (OllamaOptions is `{ endpoint, model, fetchImpl }` — the adapter has no such field), so the
// 1024-token worst-case-cap charge is NOT an upper bound on a local turn, even though the note said
// "the turn cannot have produced more than the cap". Cost-harmless ($0 local) but a wrong number
// dressed as a guarantee. The cap is now threaded with an `enforced` flag and the row says which.

describe('CG-4-2 — worst-case-cap honesty: a cap the provider does not enforce is not a ceiling', () => {
	const timedOut = { kind: 'timeout' as const, error: 'exceeded 30ms' };

	it('ENFORCED (cloud, built with maxTokens): the charge is labelled an UPPER bound', () => {
		const u = resolveConciergeTurnUsage([], 400, timedOut, { tokens: 1024, enforced: true });
		expect(u).toMatchObject({ basis: 'worst-case-cap', tokensOut: 1024, capEnforced: true });
		expect(u.note).toMatch(/UPPER bound/);
		expect(u.note).toMatch(/cap IS enforced/);
	});

	it('UNENFORCED (local Ollama, no max-output option): the charge is labelled NOMINAL, not a ceiling', () => {
		const u = resolveConciergeTurnUsage([], 400, timedOut, { tokens: 1024, enforced: false });
		// Still charged — metering zero would be the worse lie — but never called an upper bound.
		expect(u).toMatchObject({ basis: 'worst-case-cap', tokensOut: 1024, capEnforced: false });
		expect(u.note).toMatch(/NOT enforced/);
		expect(u.note).toMatch(/NOMINAL charge, not an upper bound/);
		expect(u.note).not.toMatch(/UPPER bound/);
		expect(u.note).toMatch(/true output count for this turn is unknown/);
	});

	it('OMITTED cap (nil shadow path): defaults to the enforced assumption, never throws', () => {
		const u = resolveConciergeTurnUsage([], 400, timedOut);
		expect(u).toMatchObject({ basis: 'worst-case-cap', tokensOut: 1024, capEnforced: true });
	});

	it('the flag never appears on a basis where no cap was charged (measured / partial / none)', () => {
		expect(resolveConciergeTurnUsage([{ type: 'done', usage: { input: 1, output: 2 } }], 4, timedOut).capEnforced)
			.toBeUndefined();
		expect(resolveConciergeTurnUsage([{ type: 'text', text: 'x' }], 4, timedOut).capEnforced).toBeUndefined();
		expect(resolveConciergeTurnUsage([], 4, { kind: 'ok' }).capEnforced).toBeUndefined();
	});

	it('an UNENFORCED-cap turn persists output_cap_enforced:false on the metered row (real-surreal)', async () => {
		__setConciergeLlmTimeoutForTest(30);
		const llm = providerToLlmFn(
			stallingProvider({ holdMs: 300 }),
			db,
			'ollama',
			'cg4-local-uncapped',
			'local',
			{ outputCap: { tokens: 1024, enforced: false } }
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 30ms/);

		const row = await latestConciergeRow('cg4-local-uncapped');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.estimate_basis).toBe('worst-case-cap');
		expect(detail.output_cap_enforced).toBe(false);
		expect(String(detail.estimate_note)).toMatch(/NOMINAL charge, not an upper bound/);
		// Local is still a genuine $0 — the honesty fix changes the LABEL, not the price.
		expect(row!.cost_usd).toBe(0);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);
});

// ── CG-4-1 — the drain is CANCELLABLE (the deferral-sweep DS-2 MEDIUM) ────────────────────────────
//
// THE DEFECT: the concierge LLM stream was drained by a detached `collect` IIFE with NO
// AbortController. When the wall-clock bound won the race the underlying stream was never cancelled:
// a wedged provider left a SUSPENDED async generator (its `finally` never running), a promise that
// NEVER SETTLED, and the retained `chunks` buffer — for the process lifetime. The old code even said
// so ("deliberately not cancellable"), which is now false and has been corrected.
//
// THE VERIFICATION THAT MATTERS: cancelling must not cost us the CG-3-1 partial-usage meter. An
// aborted turn that silently drops its meter row trades a leak for a fabricated $0 (F-008). So every
// cancellation case below asserts EXACTLY ONE completion row carrying the turn's partial usage, and
// the finalization is asserted by observing the generator's own `finally` run — not by the weaker
// "the promise settled".

/** A provider whose generator NEVER ENDS on its own, with an observable `finally`.
 *  Under the old (uncancellable) drain this generator is never finalized and `chunks` grows without
 *  bound; under the fix, `iter.return()` finalizes it at the next suspension point. The `maxYields`
 *  safety stop exists ONLY so a regression fails the assertions instead of wedging the test runner. */
function endlessProvider(opts: {
	text?: string;
	chunkMs: number;
	maxYields?: number;
	state: { finalized: boolean; yields: number };
}): Provider {
	const max = opts.maxYields ?? 300;
	return {
		name: 'endless',
		async *stream(): AsyncIterable<StreamChunk> {
			try {
				if (opts.text) {
					opts.state.yields++;
					yield { type: 'text', text: opts.text };
				}
				while (opts.state.yields < max) {
					await sleep(opts.chunkMs);
					opts.state.yields++;
					yield { type: 'text', text: '.' };
				}
			} finally {
				opts.state.finalized = true;
			}
		},
		async health() {
			return { provider: 'endless', up: true };
		}
	};
}

/** A provider that WEDGES: it awaits a promise that never settles and ignores any signal. The worst
 *  case the finding names — it can only be escaped by the drain refusing to keep waiting. */
function wedgedProvider(text?: string): Provider {
	return {
		name: 'wedged',
		async *stream(): AsyncIterable<StreamChunk> {
			if (text) yield { type: 'text', text };
			await new Promise<never>(() => {});
			yield { type: 'done' };
		},
		async health() {
			return { provider: 'wedged', up: true };
		}
	};
}

/** Poll a predicate until true or the bound elapses; returns whether it became true. */
async function waitUntil(pred: () => boolean, timeoutMs = 1_500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (pred()) return true;
		if (Date.now() > deadline) return false;
		await sleep(10);
	}
}

describe('CG-4-1 — an aborted concierge turn CANCELS its stream, and still meters exactly once', () => {
	it('ABORT MID-STREAM: the generator is FINALIZED (its finally runs) and one partial-usage row is metered', async () => {
		__setConciergeLlmTimeoutForTest(60);
		const state = { finalized: false, yields: 0 };
		const llm = providerToLlmFn(
			endlessProvider({ text: 'streaming advice', chunkMs: 10, state }),
			db,
			'claude',
			'cg4-abort-midstream',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 60ms/);

		// THE regression assertion: the generator's own `finally` runs. Before the fix it never did —
		// the stream was abandoned mid-flight and stayed suspended for the process lifetime.
		expect(await waitUntil(() => state.finalized)).toBe(true);
		// …and it stopped PULLING: the endless source never reached its safety stop.
		const yieldsAtFinalize = state.yields;
		await sleep(200);
		expect(state.yields).toBe(yieldsAtFinalize);
		expect(state.yields).toBeLessThan(300);

		// The CG-3-1 meter still fires EXACTLY ONCE, with the partial usage — not silently dropped.
		expect(await conciergeRowCount('cg4-abort-midstream')).toBe(1);
		const row = await latestConciergeRow('cg4-abort-midstream');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.outcome).toBe('timeout');
		expect(detail.estimated).toBe(true);
		expect(detail.estimate_basis).toBe('partial-stream');
		expect((row!.tokens_in as number) + (row!.tokens_out as number)).toBeGreaterThan(0);
		expect(typeof row!.cost_usd).toBe('number');
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('ABORT BEFORE ANY CHUNK: the generator is finalized and one worst-case-cap row is metered', async () => {
		__setConciergeLlmTimeoutForTest(25);
		const state = { finalized: false, yields: 0 };
		// No leading text and a 10ms cadence ⇒ the 25ms bound can win before the first chunk lands.
		const llm = providerToLlmFn(
			endlessProvider({ chunkMs: 200, state }),
			db,
			'claude',
			'cg4-abort-silent',
			'opus'
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 25ms/);

		expect(state.yields).toBe(0);
		expect(await waitUntil(() => state.finalized)).toBe(true);
		expect(await conciergeRowCount('cg4-abort-silent')).toBe(1);
		const row = await latestConciergeRow('cg4-abort-silent');
		const detail = row!.detail as Record<string, unknown>;
		expect(detail.estimate_basis).toBe('worst-case-cap');
		expect(detail.output_cap_enforced).toBe(true);
		expect(row!.tokens_out).toBe(1024);
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('WEDGED provider that ignores the signal: the turn still REJECTS promptly and meters once', async () => {
		// The pathological case. The drain races every read against cancellation, so the caller is
		// released on the turn's bound even though the generator can never be resumed.
		__setConciergeLlmTimeoutForTest(40);
		const startedAt = Date.now();
		const llm = providerToLlmFn(wedgedProvider('a little output'), db, 'claude', 'cg4-wedged', 'opus');
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 40ms/);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(await conciergeRowCount('cg4-wedged')).toBe(1);
		const detail = (await latestConciergeRow('cg4-wedged'))!.detail as Record<string, unknown>;
		expect(detail.outcome).toBe('timeout');
		expect(detail.estimate_basis).toBe('partial-stream');
		// A self-inflicted teardown is NOT a provider fault — no late-fault error row may appear.
		await sleep(150);
		expect(await latestConciergeErrorRow('cg4-wedged')).toBeUndefined();
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);

	it('NORMAL COMPLETION still meters exactly once and records no cancellation fault', async () => {
		const llm = providerToLlmFn(
			fakeProvider('a complete answer', { input: 11, output: 7 }),
			db,
			'claude',
			'cg4-normal',
			'opus'
		);
		expect(await llm({ system: 'sys', user: 'q' })).toBe('a complete answer');
		expect(await conciergeRowCount('cg4-normal')).toBe(1);
		const row = await latestConciergeRow('cg4-normal');
		expect(row!.tokens_in).toBe(11);
		expect(row!.tokens_out).toBe(7);
		expect((row!.detail as Record<string, unknown>).estimated).toBe(false);
		// The end-of-turn abort fires on the success path too; it must stay a silent no-op.
		await sleep(150);
		expect(await latestConciergeErrorRow('cg4-normal')).toBeUndefined();
	}, 20_000);

	it('the FACTORY shape receives the turn signal and it is ABORTED when the turn ends (success too)', async () => {
		const seen: AbortSignal[] = [];
		const llm = providerToLlmFn(
			(signal) => {
				seen.push(signal);
				return fakeProvider('factory answer', { input: 3, output: 4 });
			},
			db,
			'claude',
			'cg4-signal-success',
			'opus'
		);
		expect(await llm({ system: 'sys', user: 'q' })).toBe('factory answer');
		expect(seen).toHaveLength(1);
		expect(seen[0].aborted).toBe(true);

		// A SECOND turn gets its OWN controller — one turn's teardown can never cancel another's.
		await llm({ system: 'sys', user: 'q2' });
		expect(seen).toHaveLength(2);
		expect(seen[1]).not.toBe(seen[0]);
	}, 20_000);

	it('UPSTREAM ERROR — a THROWING factory rejects honestly and leaks NO budget reservation', async () => {
		// The shadow path the per-turn factory introduces: building the adapter can now fail (e.g.
		// OllamaProvider rejects a `/v1` endpoint). That construction is deliberately hoisted ABOVE the
		// budget gate, because a throw between "take a reservation" and the try/finally that releases it
		// would leak the reservation for its whole TTL and wrongly park the NEXT turn.
		//
		// Observed, not asserted on internals: with the daily budget pinned one token above current
		// spend, a turn proceeds while zero reservations are in flight and is REFUSED while one is. So a
		// subsequent turn succeeding is proof the failed one released (here: never took) its reservation.
		__resetReservationsForTest();
		const spent = await tokensSpentSince(db);
		__setBudgetForTest(spent + 1);
		try {
			const boom = providerToLlmFn(
				() => {
					throw new Error('adapter construction failed');
				},
				db,
				'claude',
				'cg4-normal',
				'opus'
			);
			await expect(boom({ system: 'sys', user: 'q' })).rejects.toThrow(/adapter construction failed/);

			// Nothing ran, so nothing may be metered — a construction fault is not spend.
			expect(await conciergeRowCount('cg4-normal')).toBe(1); // still just the earlier normal turn

			// The next cloud turn must still pass the gate. It cannot if a reservation leaked.
			const next = providerToLlmFn(
				fakeProvider('still allowed', { input: 1, output: 1 }),
				db,
				'claude',
				'cg4-signal-success',
				'opus'
			);
			await expect(next({ system: 'sys', user: 'q' })).resolves.toBe('still allowed');
		} finally {
			__setBudgetForTest(0);
			__resetReservationsForTest();
		}
	}, 20_000);

	it('END-TO-END through a REAL adapter: the turn signal reaches OllamaProvider\'s fetch and aborts it', async () => {
		// Proves the whole chain the fix adds — factory → fetchWithSignal → OllamaProvider → fetch —
		// without needing a live Ollama (the local model may well not be running; this exercises the
		// adapter's real code path against an injected transport that hangs until cancelled).
		__setConciergeLlmTimeoutForTest(40);
		let sawSignal: AbortSignal | undefined;
		const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			sawSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('This operation was aborted', 'AbortError')),
					{ once: true }
				);
			});
		}) as typeof fetch;

		const llm = providerToLlmFn(
			(signal) =>
				new OllamaProvider({
					endpoint: 'http://127.0.0.1:11434',
					model: 'gpt-oss:20b',
					fetchImpl: fetchWithSignal(signal, hangingFetch)
				}),
			db,
			'ollama',
			'cg4-ollama-hang',
			'local',
			{ outputCap: { tokens: 1024, enforced: false } }
		);
		await expect(llm({ system: 'sys', user: 'q' })).rejects.toThrow(/exceeded 40ms/);

		expect(sawSignal).toBeDefined();
		expect(sawSignal!.aborted).toBe(true);
		// Metered once, honestly, and the aborted fetch is NOT reported as a provider failing late.
		expect(await conciergeRowCount('cg4-ollama-hang')).toBe(1);
		await sleep(200);
		expect(await latestConciergeErrorRow('cg4-ollama-hang')).toBeUndefined();
		__setConciergeLlmTimeoutForTest(null);
	}, 20_000);
});

describe('fetchWithSignal — the seam that carries cancellation to the socket (4 paths)', () => {
	const stubResponse = (): Response => new Response('ok');

	it('HAPPY: a request with an init object carries the signal', async () => {
		const ctrl = new AbortController();
		let got: RequestInit | undefined;
		const base = ((_u: RequestInfo | URL, init?: RequestInit) => {
			got = init;
			return Promise.resolve(stubResponse());
		}) as typeof fetch;
		await fetchWithSignal(ctrl.signal, base)('http://x/api', { method: 'POST', body: '{}' });
		expect(got!.signal).toBe(ctrl.signal);
		// The caller's own init is preserved, not replaced.
		expect(got!.method).toBe('POST');
		expect(got!.body).toBe('{}');
	});

	it('NIL init (a bare GET): the signal is still attached', async () => {
		const ctrl = new AbortController();
		let got: RequestInit | undefined;
		const base = ((_u: RequestInfo | URL, init?: RequestInit) => {
			got = init;
			return Promise.resolve(stubResponse());
		}) as typeof fetch;
		await fetchWithSignal(ctrl.signal, base)('http://x/api/tags');
		expect(got!.signal).toBe(ctrl.signal);
	});

	it('CONFLICT: an init that already has a signal is COMBINED, so neither source is dropped', async () => {
		const turn = new AbortController();
		const caller = new AbortController();
		let got: RequestInit | undefined;
		const base = ((_u: RequestInfo | URL, init?: RequestInit) => {
			got = init;
			return Promise.resolve(stubResponse());
		}) as typeof fetch;
		await fetchWithSignal(turn.signal, base)('http://x', { signal: caller.signal });
		expect(got!.signal).not.toBe(caller.signal);
		expect(got!.signal!.aborted).toBe(false);
		// Either source can cancel the combined signal.
		turn.abort();
		expect(got!.signal!.aborted).toBe(true);
	});

	it('UPSTREAM ERROR: a rejecting transport propagates unchanged (no swallowing)', async () => {
		const ctrl = new AbortController();
		const base = (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;
		await expect(fetchWithSignal(ctrl.signal, base)('http://x')).rejects.toThrow(/connection refused/);
	});
});
