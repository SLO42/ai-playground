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
		expect(res).toEqual({ enforced: false, spent: 0, budget: 0, overrode: false });
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
