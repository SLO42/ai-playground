import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { writeAgentEvent } from './events';
import {
	tokensSpentSince,
	tokensSpentSinceForProject,
	enforceTokenBudget,
	normalizeTokenBudget,
	resolvePerProjectTokenBudget,
	isLocalProvider,
	__resetReservationsForTest,
	__setPerProjectBudgetForTest,
	TokenBudgetExceededError,
	budgetRefusalEnvelope,
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
	// Hermetic: pin the per-project ceiling to 0 (uncapped) so CG-2 tests that pass a `project` never
	// read the real config file / never engage CG-3. Each CG-3 test overrides this explicitly.
	__setPerProjectBudgetForTest(0);
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

// COST-GOVERNANCE-SPEC CG-3 — the OPTIONAL per-project token ceiling, proven against a LIVE SurrealDB.
// The counter reads the project link on the completion row DIRECTLY (events.ts writes it), so this is a
// real-surreal test of the actual per-project aggregate. Shadow paths covered: nil/empty project window,
// the 0-sentinel (uncapped), two-project isolation, global+per-project interaction (either refuses),
// override, the scoped governance event, and per-project concurrency reservation bucketing.
describe('CG-3 per-project token budget (real-surreal)', () => {
	let projectB: string;

	beforeAll(async () => {
		const p = await createProject(db, { slug: 'spendb', name: 'Spend Host B', root_path: 'F:/code/spendb' });
		projectB = p.id;
	}, 30_000);

	afterAll(async () => {
		await deleteProject(db, projectB).catch(() => {});
	});

	/** Seed one COMPLETION agent_event carrying tokens, attributed to a SPECIFIC project. */
	async function seedFor(project: string, tokensIn: number, tokensOut: number): Promise<string> {
		return writeAgentEvent(db, {
			type: 'completion',
			project,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn,
			tokensOut,
			detail: { ok: true, summary: 'seeded spend' }
		});
	}

	/** The most recent budget-governance event's detail (type=cancel, by=budget), or undefined. */
	async function lastBudgetEvent(): Promise<Record<string, unknown> | undefined> {
		const [rows] = await db.query<[Array<{ detail?: Record<string, unknown> }>]>(
			`SELECT detail FROM agent_event WHERE type = 'cancel';`
		);
		return (Array.isArray(rows) ? rows : []).map((r) => r.detail).find((d) => d?.by === 'budget');
	}

	describe('resolvePerProjectTokenBudget — the 0-sentinel + config/override seam', () => {
		it('an injected override wins; 0 clears to uncapped', () => {
			__setPerProjectBudgetForTest(750);
			expect(resolvePerProjectTokenBudget()).toBe(750);
			__setPerProjectBudgetForTest(0);
			expect(resolvePerProjectTokenBudget()).toBe(0);
		});

		it('null clears the override back to the config-file path (shipped default 0)', () => {
			__setPerProjectBudgetForTest(null);
			// config/orchestration.yaml ships perProjectTokenBudget: 0 (uncapped) — the honest default.
			expect(resolvePerProjectTokenBudget()).toBe(0);
			__setPerProjectBudgetForTest(0); // restore the hermetic pin for the rest of the suite
		});
	});

	describe('tokensSpentSinceForProject — per-project counter isolation', () => {
		it('empty project ⇒ 0 (honest, never fabricated)', async () => {
			expect(await tokensSpentSinceForProject(db, projectB)).toBe(0);
		});

		it('sums ONLY the given project’s completion rows (the other project is invisible to it)', async () => {
			await seedFor(projectId, 400, 100); // project A: 500
			await seedFor(projectB, 30, 20); // project B: 50
			expect(await tokensSpentSinceForProject(db, projectId)).toBe(500);
			expect(await tokensSpentSinceForProject(db, projectB)).toBe(50);
			// The GLOBAL counter sees both.
			expect(await tokensSpentSince(db)).toBe(550);
		});

		it('WINDOW BOUNDARY — a project’s old spend is excluded', async () => {
			const oldId = await seedFor(projectB, 1000, 1000); // 2000, aged out
			await db.query(`UPDATE type::thing($a) SET at = <datetime>$old;`, {
				a: oldId,
				old: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
			});
			await seedFor(projectB, 7, 3); // 10, in-window
			expect(await tokensSpentSinceForProject(db, projectB, SPEND_WINDOW_MS)).toBe(10);
		});
	});

	describe('enforcement — two-project isolation, interaction, override', () => {
		it('two projects, one AT its per-project budget ⇒ ITS background launch refuses; the OTHER is unaffected', async () => {
			__setPerProjectBudgetForTest(1000); // per-project ceiling
			await seedFor(projectId, 700, 500); // project A: 1200 ≥ 1000 → over
			await seedFor(projectB, 100, 50); // project B: 150 → well under
			// Global uncapped (budget:0) so ONLY the per-project ceiling can bite.
			await expect(
				enforceTokenBudget(db, { budget: 0, source: 'background', project: projectId })
			).rejects.toBeInstanceOf(TokenBudgetExceededError);
			// Project B proceeds — its own slice is under budget.
			const resB = await enforceTokenBudget(db, { budget: 0, source: 'background', project: projectB });
			expect(resB.enforced).toBe(true);
			resB.release();
			// The refusal event names the project scope + the breaching project.
			const ev = await lastBudgetEvent();
			expect(ev?.scope).toBe('project');
			expect(String(ev?.projectId)).toBe(projectId);
			expect(ev?.spent).toBe(1200);
			expect(ev?.budget).toBe(1000);
		});

		it('0-sentinel per-project ⇒ UNCAPPED: an over-spending project proceeds', async () => {
			__setPerProjectBudgetForTest(0); // per-project uncapped
			await seedFor(projectId, 9_999, 9_999); // huge spend on A
			const res = await enforceTokenBudget(db, { budget: 0, source: 'background', project: projectId });
			expect(res.enforced).toBe(false); // both ceilings uncapped ⇒ cheap no-op
			res.release();
		});

		it('GLOBAL uncapped + per-project ARMED ⇒ refuses on the per-project ceiling (scope:project)', async () => {
			__setPerProjectBudgetForTest(1000);
			await seedFor(projectId, 600, 600); // 1200 ≥ 1000
			const err = await enforceTokenBudget(db, {
				budget: 0,
				source: 'background',
				project: projectId
			}).catch((e) => e);
			expect(err).toBeInstanceOf(TokenBudgetExceededError);
			expect((err as TokenBudgetExceededError).scope).toBe('project');
			expect((err as TokenBudgetExceededError).projectId).toBe(projectId);
			expect((err as TokenBudgetExceededError).spent).toBe(1200);
		});

		it('per-project uncapped + GLOBAL armed ⇒ refuses on the GLOBAL ceiling (scope:global)', async () => {
			__setPerProjectBudgetForTest(0);
			await seedFor(projectId, 600, 600); // 1200 global ≥ 1000
			const err = await enforceTokenBudget(db, {
				budget: 1000,
				source: 'background',
				project: projectId
			}).catch((e) => e);
			expect(err).toBeInstanceOf(TokenBudgetExceededError);
			expect((err as TokenBudgetExceededError).scope).toBe('global');
			expect((err as TokenBudgetExceededError).projectId).toBeUndefined();
		});

		it('BOTH armed: a project under GLOBAL but over its PER-PROJECT slice still refuses (project scope)', async () => {
			__setPerProjectBudgetForTest(500);
			await seedFor(projectId, 400, 200); // A: 600 ≥ 500 per-project, but < 100_000 global
			await expect(
				enforceTokenBudget(db, { budget: 100_000, source: 'background', project: projectId })
			).rejects.toBeInstanceOf(TokenBudgetExceededError);
			const ev = await lastBudgetEvent();
			expect(ev?.scope).toBe('project');
		});

		it('BOTH armed, both UNDER ⇒ proceeds and reports the GLOBAL binding figures (CG-2 back-compat)', async () => {
			__setPerProjectBudgetForTest(100_000);
			await seedFor(projectId, 100, 100); // 200 both global + project
			const res = await enforceTokenBudget(db, { budget: 1000, source: 'background', project: projectId });
			expect(res.enforced).toBe(true);
			expect(res.spent).toBe(200); // global figure (global ceiling armed)
			expect(res.budget).toBe(1000);
			res.release();
		});

		it('per-project breach + OPERATOR override ⇒ proceeds (overrode:true) + emits an override event (scope:project)', async () => {
			__setPerProjectBudgetForTest(1000);
			await seedFor(projectId, 700, 500); // 1200 ≥ 1000
			const res = await enforceTokenBudget(db, {
				budget: 0,
				source: 'operator',
				override: true,
				project: projectId
			});
			expect(res.overrode).toBe(true);
			expect(res.spent).toBe(1200);
			const ev = await lastBudgetEvent();
			expect(ev?.decision).toBe('override');
			expect(ev?.scope).toBe('project');
			expect(String(ev?.projectId)).toBe(projectId);
		});
	});

	describe('per-project concurrency reservation bucketing', () => {
		it('N concurrent at-threshold launches on ONE project ⇒ at most 1 proceeds; a DIFFERENT project is unaffected', async () => {
			__setPerProjectBudgetForTest(1000);
			await seedFor(projectId, 999, 0); // A: 999, headroom for exactly one reservation
			// B has no spend at all — its own bucket must stay empty regardless of A's reservations.
			const N = 6;
			const aResults = await Promise.allSettled(
				Array.from({ length: N }, () =>
					enforceTokenBudget(db, { budget: 0, source: 'background', project: projectId })
				)
			);
			const aProceeded = aResults.filter((r) => r.status === 'fulfilled');
			const aParked = aResults.filter(
				(r) => r.status === 'rejected' && r.reason instanceof TokenBudgetExceededError
			);
			expect(aProceeded.length).toBeLessThanOrEqual(1);
			expect(aProceeded.length + aParked.length).toBe(N);
			// Project B (empty) proceeds — A's reservation lives in A's bucket, not B's.
			const resB = await enforceTokenBudget(db, { budget: 0, source: 'background', project: projectB });
			expect(resB.enforced).toBe(true);
			resB.release();
			// Release any A reservation that proceeded (hermetic).
			for (const r of aProceeded) if (r.status === 'fulfilled') r.value.release();
		});
	});
});

// CG2-2 — the HONEST, scope-aware 402 refusal envelope. Deferred finding: the launch/pmChat catch
// blocks hardcoded "daily token budget" even for a PER-PROJECT breach, mislabeling the operator's
// recourse. budgetRefusalEnvelope reads err.scope/err.projectId and renders the correct label. Pure
// (no db), so it unit-tests both scopes + the shadow paths directly.
describe('budgetRefusalEnvelope — scope-aware, honest labels (CG2-2)', () => {
	it('a PER-PROJECT breach names THIS project’s budget (not the daily one) + carries projectId', () => {
		const err = new TokenBudgetExceededError(1200, 1000, 'operator', 'project', 'project:acme');
		const env = budgetRefusalEnvelope(err, 'launch');
		expect(env.scope).toBe('project');
		expect(env.projectId).toBe('project:acme');
		expect(env.budgetExceeded).toBe(true);
		expect(env.spent).toBe(1200);
		expect(env.budget).toBe(1000);
		// The honest label: this project's budget is the constraint, spent BY this project.
		expect(env.error).toContain("this project's token budget");
		expect(env.error).toContain('spent by this project');
		expect(env.error).toContain('1200 of 1000 tokens');
		expect(env.error).toContain('Confirm to spend past it');
		// Never mislabel a project breach as the daily budget.
		expect(env.error).not.toContain('daily token budget');
		expect(env.error).not.toContain('across all projects');
	});

	it('a GLOBAL breach names the DAILY budget (spent across all projects) + omits projectId', () => {
		const err = new TokenBudgetExceededError(5000, 4000, 'background', 'global');
		const env = budgetRefusalEnvelope(err, 'launch');
		expect(env.scope).toBe('global');
		expect(env.projectId).toBeUndefined();
		expect(env.error).toContain('the daily token budget');
		expect(env.error).toContain('across all projects');
		expect(env.error).toContain('5000 of 4000 tokens');
		// Never mislabel a global breach as a per-project one.
		expect(env.error).not.toContain("this project's");
		expect(env.error).not.toContain('spent by this project');
	});

	it('the actionNoun personalizes the subject (launch vs PM turn) for each chokepoint', () => {
		const projErr = new TokenBudgetExceededError(1200, 1000, 'operator', 'project', 'project:acme');
		expect(budgetRefusalEnvelope(projErr, 'launch').error.startsWith('This launch would exceed')).toBe(true);
		expect(budgetRefusalEnvelope(projErr, 'PM turn').error.startsWith('This PM turn would exceed')).toBe(true);
	});

	it('SHADOW — a project-scoped error constructed WITHOUT a projectId omits projectId honestly (no undefined leak)', () => {
		// The error ctor only sets projectId when scope==='project' AND an id is given; the envelope must
		// mirror that (never emit projectId:undefined), and still render the project-scope label.
		const err = new TokenBudgetExceededError(1200, 1000, 'operator', 'project');
		const env = budgetRefusalEnvelope(err, 'launch');
		expect('projectId' in env).toBe(false);
		expect(env.scope).toBe('project');
		expect(env.error).toContain("this project's token budget");
	});
});
