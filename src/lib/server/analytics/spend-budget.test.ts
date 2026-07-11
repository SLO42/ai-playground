import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { writeAgentEvent } from './events';
import {
	tokensSpentSince,
	enforceTokenBudget,
	normalizeTokenBudget,
	isLocalProvider,
	__resetReservationsForTest,
	TokenBudgetExceededError,
	SPEND_WINDOW_MS
} from './spend-budget';

// COST-GOVERNANCE-SPEC CG-2 — the global rolling-24h TOKEN budget, proven against a LIVE throwaway
// SurrealDB (F-020: a real-surreal test that parses the actual counter query). Shadow paths covered:
// nil/empty window (no rows → 0), old spend outside the window (ignored), non-completion rows
// (ignored), the 0-sentinel (uncapped), refuse vs override, and the emitted governance event.

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
	const p = await createProject(db, { slug: 'spend', name: 'Spend Host', root_path: 'F:/code/spend' });
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await deleteProject(db, projectId).catch(() => {});
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE agent_event;`);
	// Hermetic: clear the in-process concurrency reservation counter between tests.
	__resetReservationsForTest();
});

/** Seed one COMPLETION agent_event carrying tokens (the durable spend row). Returns its id. */
async function seedCompletion(tokensIn: number, tokensOut: number): Promise<string> {
	return writeAgentEvent(db, {
		type: 'completion',
		project: projectId,
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		tokensIn,
		tokensOut,
		detail: { ok: true, summary: 'seeded spend' }
	});
}

describe('normalizeTokenBudget — the 0-sentinel + shadow inputs', () => {
	it('0 / undefined / null / negative / NaN / Infinity ⇒ 0 (uncapped); a positive value floors', () => {
		expect(normalizeTokenBudget(0)).toBe(0);
		expect(normalizeTokenBudget(undefined)).toBe(0);
		expect(normalizeTokenBudget(null)).toBe(0);
		expect(normalizeTokenBudget(-5)).toBe(0);
		expect(normalizeTokenBudget(Number.NaN)).toBe(0);
		expect(normalizeTokenBudget(Number.POSITIVE_INFINITY)).toBe(0);
		expect(normalizeTokenBudget(1000)).toBe(1000);
		expect(normalizeTokenBudget(1000.9)).toBe(1000);
	});
});

describe('tokensSpentSince — the durable, restart-proof counter (real-surreal)', () => {
	it('empty window ⇒ 0 (honest, never a fabricated value)', async () => {
		expect(await tokensSpentSince(db)).toBe(0);
	});

	it('sums tokens_in + tokens_out over completion rows in the window', async () => {
		await seedCompletion(100, 50);
		await seedCompletion(200, 25);
		expect(await tokensSpentSince(db)).toBe(375);
	});

	it('IGNORES non-completion rows (spawn/error carry no spend)', async () => {
		await seedCompletion(100, 100);
		await writeAgentEvent(db, { type: 'spawn', project: projectId, detail: { intent: 'code-write' } });
		await writeAgentEvent(db, { type: 'error', project: projectId, detail: { error: 'boom' } });
		// Only the completion's 200 tokens count.
		expect(await tokensSpentSince(db)).toBe(200);
	});

	it('WINDOW BOUNDARY — spend older than the window is excluded', async () => {
		const oldId = await seedCompletion(1000, 1000); // 2000 tokens, but we age it out
		// Age the row's durable `at` anchor to 25h ago (outside the 24h window).
		await db.query(`UPDATE type::thing($a) SET at = <datetime>$old;`, {
			a: oldId,
			old: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
		});
		await seedCompletion(10, 5); // 15 tokens, in-window
		expect(await tokensSpentSince(db, SPEND_WINDOW_MS)).toBe(15);
	});

	it('RESTART-SURVIVAL — the count is derived only from durable rows, so a fresh read reproduces it', async () => {
		await seedCompletion(300, 200);
		const first = await tokensSpentSince(db);
		// A fresh connection to the SAME store (what a restarted process sees) computes the same sum —
		// there is no in-memory counter to lose.
		const db2 = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		try {
			expect(await tokensSpentSince(db2)).toBe(first);
			expect(first).toBe(500);
		} finally {
			await db2.close().catch(() => {});
		}
	});
});

/** Count the budget-governance events with a given decision (type=cancel, by=budget). */
async function countBudgetEvents(decision: 'refused' | 'override'): Promise<number> {
	const [rows] = await db.query<[Array<{ detail?: { by?: string; decision?: string } }>]>(
		`SELECT detail FROM agent_event WHERE type = 'cancel';`
	);
	return (Array.isArray(rows) ? rows : []).filter(
		(r) => r.detail?.by === 'budget' && r.detail?.decision === decision
	).length;
}

describe('enforceTokenBudget — refuse / override / 0-sentinel (real-surreal)', () => {
	it('0-sentinel ⇒ UNCAPPED: proceeds even with spend present, runs no query, writes no event', async () => {
		await seedCompletion(9_999, 9_999);
		const res = await enforceTokenBudget(db, { budget: 0, source: 'background' });
		expect(res).toMatchObject({ enforced: false, spent: 0, budget: 0, overrode: false });
		expect(typeof res.release).toBe('function');
		expect(await countBudgetEvents('refused')).toBe(0);
		expect(await countBudgetEvents('override')).toBe(0);
	});

	it('UNDER budget ⇒ proceeds normally, no event', async () => {
		await seedCompletion(100, 100); // 200 spent
		const res = await enforceTokenBudget(db, { budget: 1000, source: 'background' });
		expect(res.enforced).toBe(true);
		expect(res.spent).toBe(200);
		expect(res.overrode).toBe(false);
		expect(await countBudgetEvents('refused')).toBe(0);
	});

	it('AT/OVER budget + BACKGROUND (no override) ⇒ throws TokenBudgetExceededError + emits a refused event', async () => {
		await seedCompletion(600, 600); // 1200 spent ≥ 1000 budget
		await expect(
			enforceTokenBudget(db, { budget: 1000, source: 'background', project: projectId })
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
		// The named event is written with the honest numbers.
		expect(await countBudgetEvents('refused')).toBe(1);
		expect(await countBudgetEvents('override')).toBe(0);
		const [rows] = await db.query<[Array<{ detail?: Record<string, unknown> }>]>(
			`SELECT detail FROM agent_event WHERE type = 'cancel';`
		);
		const ev = (rows as Array<{ detail?: Record<string, unknown> }>).find((r) => r.detail?.by === 'budget');
		expect(ev?.detail?.spent).toBe(1200);
		expect(ev?.detail?.budget).toBe(1000);
		expect(ev?.detail?.source).toBe('background');
	});

	it('AT/OVER budget + OPERATOR override ⇒ proceeds (overrode:true) + emits an override event', async () => {
		await seedCompletion(600, 600); // 1200 ≥ 1000
		const res = await enforceTokenBudget(db, {
			budget: 1000,
			source: 'operator',
			override: true,
			project: projectId
		});
		expect(res.overrode).toBe(true);
		expect(res.enforced).toBe(true);
		expect(res.spent).toBe(1200);
		expect(await countBudgetEvents('override')).toBe(1);
		expect(await countBudgetEvents('refused')).toBe(0);
	});

	it('exactly AT budget (spent == budget) refuses — the boundary is inclusive', async () => {
		await seedCompletion(500, 500); // exactly 1000
		await expect(
			enforceTokenBudget(db, { budget: 1000, source: 'background' })
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
	});
});

describe('isLocalProvider + LOCAL/$0 exemption (deferred finding cost-governance-1a #2)', () => {
	it('classifies ollama/local as local; cloud/absent are NOT local', () => {
		expect(isLocalProvider('ollama')).toBe(true);
		expect(isLocalProvider('local')).toBe(true);
		expect(isLocalProvider('OLLAMA')).toBe(true); // case-insensitive
		expect(isLocalProvider(' local ')).toBe(true); // trimmed
		expect(isLocalProvider('claude')).toBe(false);
		expect(isLocalProvider(undefined)).toBe(false); // absent ⇒ gated default (safe)
		expect(isLocalProvider('')).toBe(false);
	});

	it('a LOCAL provider is EXEMPT: proceeds over budget WITHOUT throwing, and writes no refusal event', async () => {
		await seedCompletion(5_000, 5_000); // 10_000 spent — far over a tiny budget
		const res = await enforceTokenBudget(db, {
			budget: 1000,
			source: 'concierge',
			provider: 'ollama',
			project: projectId
		});
		// Exempt: not gated (enforced:false), no throw, no reservation-relevant state.
		expect(res.enforced).toBe(false);
		expect(res.overrode).toBe(false);
		expect(typeof res.release).toBe('function');
		expect(await countBudgetEvents('refused')).toBe(0);
	});

	it('a CLOUD provider over budget is still GATED (refuses) — the exemption is local-only', async () => {
		await seedCompletion(600, 600); // 1200 ≥ 1000
		await expect(
			enforceTokenBudget(db, { budget: 1000, source: 'concierge', provider: 'claude', project: projectId })
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
	});
});

describe('concurrency-overshoot guard — serialized read+decide + reservation (deferred finding cost-governance-1a #1)', () => {
	it('N CONCURRENT at-threshold launches ⇒ at MOST 1 proceeds (the rest park)', async () => {
		// Seed measured spend one token below budget: the first launch is under budget, but once it
		// reserves, every concurrent sibling sees spent+reservation ≥ budget and must park.
		await seedCompletion(999, 0); // 999 spent, budget 1000 ⇒ headroom for exactly one reservation
		const N = 8;
		const results = await Promise.allSettled(
			Array.from({ length: N }, () =>
				enforceTokenBudget(db, { budget: 1000, source: 'background', project: projectId })
			)
		);
		const proceeded = results.filter((r) => r.status === 'fulfilled');
		const parked = results.filter(
			(r) => r.status === 'rejected' && r.reason instanceof TokenBudgetExceededError
		);
		expect(proceeded.length).toBeLessThanOrEqual(1);
		expect(proceeded.length + parked.length).toBe(N); // every call resolved to proceed-or-park (no crash)
	});

	it('releasing a reservation frees the headroom for the next launch (no permanent leak)', async () => {
		await seedCompletion(999, 0); // 999 spent, budget 1000
		const first = await enforceTokenBudget(db, { budget: 1000, source: 'background' });
		expect(first.enforced).toBe(true); // proceeded + reserved the single headroom slot
		// With the reservation still held, a second launch parks (spent 999 + reserved 1 ≥ 1000).
		await expect(
			enforceTokenBudget(db, { budget: 1000, source: 'background' })
		).rejects.toBeInstanceOf(TokenBudgetExceededError);
		// Release the first reservation → the headroom is free again → the next launch proceeds.
		first.release();
		const third = await enforceTokenBudget(db, { budget: 1000, source: 'background' });
		expect(third.enforced).toBe(true);
	});

	it('far below the ceiling, the +1/launch reservation does NOT block normal concurrency', async () => {
		await seedCompletion(10, 0); // 10 spent, huge budget ⇒ plenty of headroom
		const N = 8;
		const results = await Promise.allSettled(
			Array.from({ length: N }, () =>
				enforceTokenBudget(db, { budget: 1_000_000, source: 'background' })
			)
		);
		expect(results.every((r) => r.status === 'fulfilled')).toBe(true); // all proceed — no false parking
	});
});
