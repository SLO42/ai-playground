import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { READINESS_CHECKLIST } from '../../components/loops/readiness-core';
import {
	MaintenanceLoopEngine,
	maintenanceFireAllowed,
	seedMaintenanceLoops,
	setActiveMaintenanceEngine,
	DEFAULT_MAINTENANCE_SEEDS,
	MAINT_EVAL_REGRESSION,
	MAINT_RERANKER_EVAL,
	type MaintenanceAction,
	type MaintenanceRegistry
} from './maintenance';
import { evalRegressionAction, rerankerEvalAction } from './maintenance-actions';
import {
	upsertLoopManifest,
	setLoopChecklistItem,
	setLoopEnabled,
	setLoopOverride,
	getLoopManifest,
	listLoopManifest,
	reconcileLoops
} from './manifest';
import { getLoops, getLoopRuns } from './read';
import { RERANK_MIN_EXAMPLES } from '../memory/index';
import type { EvalReport, RerankProbe, RerankMetricSet } from '../memory/eval/harness';

// MAINTENANCE LOOP ENGINE — VERIFY (integration vs a LIVE throwaway SurrealDB).
//
// Proves the m0080 self-maintenance slice end-to-end against the REAL §4 schema:
//   (1) a due + enabled + readiness-green (or overridden) declared loop fires EXACTLY once per
//       matching minute (minute dedup) and writes an honest agent_event run-log row;
//   (2) every gate blocks honestly: disabled / not-ready / not-due / manual mode / unregistered;
//   (3) a THROWING action is absorbed (F-048 — never propagates) and recorded ok:false, and the
//       engine keeps firing afterwards;
//   (4) seeding is idempotent + never clobbers operator edits (double boot = no dupes);
//   (5) the /loops read model renders an ARMED maintenance loop as declared-and-running and an
//       unarmed one as declared-not-running (F-008), and surfaces the run history per loop;
//   (6) the two shipped actions behave honestly: reranker-eval no-ops below the training
//       thresholds ("labels still accruing"), trains + PROPOSES (notification, never a flip) at
//       thresholds when reranked ≥ baseline, and withholds the proposal on regression;
//       eval-regression persists a real EvalReport row WITHOUT polluting live memory (isolation).

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
	setActiveMaintenanceEngine(null);
	await db?.close();
	await tdb?.teardown();
});

beforeEach(async () => {
	setActiveMaintenanceEngine(null);
	await db.query(
		`DELETE loop; DELETE agent_event; DELETE retrieval_outcome; DELETE reranker_model;
		 DELETE notification; DELETE eval_report;`
	);
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────

const TEST_LOOP = 'maint:test-loop';

async function declareLoop(
	identifier: string,
	opts: { cadence?: string; ready?: boolean; enabled?: boolean; override?: boolean } = {}
): Promise<void> {
	await upsertLoopManifest(db, {
		identifier,
		kind: 'maintenance',
		label: `test ${identifier}`,
		cadence: opts.cadence ?? '*/5 * * * *'
	});
	if (opts.ready) {
		for (const item of READINESS_CHECKLIST) {
			await setLoopChecklistItem(db, identifier, item.id, true);
		}
	}
	if (opts.enabled === false) await setLoopEnabled(db, identifier, false);
	if (opts.override) await setLoopOverride(db, identifier, true, 'test override');
}

function countingAction(result: Partial<{ ok: boolean; summary: string }> = {}): {
	action: MaintenanceAction;
	calls: () => number;
} {
	let n = 0;
	return {
		action: async () => {
			n++;
			return { ok: result.ok ?? true, summary: result.summary ?? 'test ran' };
		},
		calls: () => n
	};
}

function registryOf(entries: Array<[string, MaintenanceAction]>): MaintenanceRegistry {
	return new Map(entries);
}

// A local-time instant at the given minute (the test cadence "*/5 * * * *" matches minutes % 5 == 0).
function atMinute(minute: number, second = 5): Date {
	return new Date(2026, 6, 1, 9, minute, second);
}

async function maintenanceEvents(): Promise<Array<{ detail: Record<string, unknown> }>> {
	const [rows] = await db.query<[Array<{ detail: Record<string, unknown> }>]>(
		`SELECT detail, at FROM agent_event WHERE type = 'maintenance' ORDER BY at ASC;`
	);
	return rows ?? [];
}

// ── (1)+(2) firing + gates ─────────────────────────────────────────────────────────────────────────

describe('MaintenanceLoopEngine — firing + minute dedup', () => {
	it('fires a due+enabled+ready loop exactly once per matching minute, then again next match', async () => {
		await declareLoop(TEST_LOOP, { ready: true });
		const { action, calls } = countingAction();
		const engine = new MaintenanceLoopEngine({
			db,
			mode: 'event',
			registry: registryOf([[TEST_LOOP, action]])
		});

		expect(await engine.tickOnce(atMinute(10, 5))).toBe(1);
		// Same cron minute, later second — the minute dedup absorbs it (one match = one firing).
		expect(await engine.tickOnce(atMinute(10, 40))).toBe(0);
		// Non-matching minute — not due.
		expect(await engine.tickOnce(atMinute(12))).toBe(0);
		// Next matching minute — fires again.
		expect(await engine.tickOnce(atMinute(15))).toBe(1);

		expect(calls()).toBe(2);
		expect(engine.runCount).toBe(2);
		expect(engine.faultCount).toBe(0);

		// The honest run log: one agent_event per firing, keyed by detail.loop.
		const events = await maintenanceEvents();
		expect(events).toHaveLength(2);
		expect(events[0].detail.loop).toBe(TEST_LOOP);
		expect(events[0].detail.ok).toBe(true);
		expect(events[0].detail.summary).toBe('test ran');
	});

	it('does NOT fire when disabled, not ready, not due, in manual mode, or unregistered', async () => {
		const { action, calls } = countingAction();
		const registry = registryOf([[TEST_LOOP, action]]);

		// Not ready (empty checklist, no override) — the arm gate blocks.
		await declareLoop(TEST_LOOP);
		const engine = new MaintenanceLoopEngine({ db, mode: 'event', registry });
		expect(await engine.tickOnce(atMinute(10))).toBe(0);

		// The operator's recorded override satisfies the gate (green-or-override — arm-gate policy).
		await setLoopOverride(db, TEST_LOOP, true, 'operator says go');
		expect(await engine.tickOnce(atMinute(15))).toBe(1);
		expect(calls()).toBe(1);

		// Kill switch: enabled=false is re-read per tick — the very next tick honors it (never cached).
		await setLoopEnabled(db, TEST_LOOP, false);
		expect(await engine.tickOnce(atMinute(20))).toBe(0);
		await setLoopEnabled(db, TEST_LOOP, true);
		expect(await engine.tickOnce(atMinute(25))).toBe(1);

		// Manual mode: no automatic fires of any kind (D-004), and start() arms no timer.
		const manual = new MaintenanceLoopEngine({ db, mode: 'manual', registry });
		manual.start();
		expect(manual.periodicArmed).toBe(false);
		expect(await manual.tickOnce(atMinute(30))).toBe(0);
		manual.stop();
		expect(maintenanceFireAllowed('manual')).toBe(false);
		expect(maintenanceFireAllowed('event')).toBe(true);
		expect(maintenanceFireAllowed('periodic')).toBe(true);

		// Unregistered identifier: declared row with no in-code action — skip, never invent behavior.
		await declareLoop('maint:unregistered', { ready: true });
		expect(await engine.tickOnce(atMinute(35))).toBe(1); // only TEST_LOOP fires
		expect(calls()).toBe(3);
	});

	it('absorbs a throwing action (F-048), records ok:false, and keeps running', async () => {
		await declareLoop(TEST_LOOP, { ready: true });
		let boom = true;
		const action: MaintenanceAction = async () => {
			if (boom) throw new Error('synthetic maintenance fault');
			return { ok: true, summary: 'recovered' };
		};
		const engine = new MaintenanceLoopEngine({
			db,
			mode: 'event',
			registry: registryOf([[TEST_LOOP, action]])
		});

		// The throw NEVER propagates off the tick — the drain-path lesson (F-048).
		await expect(engine.tickOnce(atMinute(10))).resolves.toBe(1);
		expect(engine.faultCount).toBe(1);

		let events = await maintenanceEvents();
		expect(events).toHaveLength(1);
		expect(events[0].detail.ok).toBe(false);
		expect(String(events[0].detail.summary)).toContain('synthetic maintenance fault');

		// The engine is alive: the next matching minute fires (and succeeds) normally.
		boom = false;
		expect(await engine.tickOnce(atMinute(15))).toBe(1);
		events = await maintenanceEvents();
		expect(events).toHaveLength(2);
		expect(events[1].detail.ok).toBe(true);
	});
});

// ── (4) seeding ────────────────────────────────────────────────────────────────────────────────────

describe('seedMaintenanceLoops — idempotent, non-clobbering', () => {
	it('declares the two shipped loops once; a double boot creates no dupes', async () => {
		expect(await seedMaintenanceLoops(db)).toBe(DEFAULT_MAINTENANCE_SEEDS.length);
		expect(await seedMaintenanceLoops(db)).toBe(0);

		const rows = (await listLoopManifest(db)).filter((r) => r.kind === 'maintenance');
		expect(rows).toHaveLength(2);
		const ids = rows.map((r) => r.identifier).sort();
		expect(ids).toEqual([MAINT_EVAL_REGRESSION, MAINT_RERANKER_EVAL].sort());
		for (const row of rows) {
			expect(row.projectId).toBeNull();
			expect(row.enabled).toBe(true);
			// Ships with an EMPTY checklist ⇒ readiness NOT green ⇒ declared but honestly inert.
			expect(Object.keys(row.checklist)).toHaveLength(0);
			expect(row.cadence).toBeTruthy();
		}
	});

	it('never clobbers an operator-edited row back to defaults', async () => {
		await seedMaintenanceLoops(db);
		await setLoopEnabled(db, MAINT_EVAL_REGRESSION, false);
		await setLoopChecklistItem(db, MAINT_RERANKER_EVAL, READINESS_CHECKLIST[0].id, true);

		expect(await seedMaintenanceLoops(db)).toBe(0);
		const evalRow = await getLoopManifest(db, MAINT_EVAL_REGRESSION);
		const rerankRow = await getLoopManifest(db, MAINT_RERANKER_EVAL);
		expect(evalRow?.enabled).toBe(false);
		expect(rerankRow?.checklist[READINESS_CHECKLIST[0].id]).toBe(true);
	});
});

// ── (5) the /loops read model — armed running view + run history ──────────────────────────────────

describe('loops read model — maintenance running view + run history', () => {
	const ORCH_CFG = { orchConfig: { mode: null, intervalMs: null } };

	it('renders an ARMED loop declared-and-running and an unarmed one declared-not-running', async () => {
		await declareLoop('maint:armed', { ready: true });
		await declareLoop('maint:inert'); // empty checklist — not armed
		const { action } = countingAction();
		const engine = new MaintenanceLoopEngine({
			db,
			mode: 'event',
			registry: registryOf([
				['maint:armed', action],
				['maint:inert', action]
			])
		});
		setActiveMaintenanceEngine(engine);

		const loops = await getLoops(db, ORCH_CFG);
		const armed = loops.find((l) => l.id === 'maint:armed');
		expect(armed).toBeDefined();
		expect(armed?.kind).toBe('maintenance');
		expect(armed?.scope).toBe('global');
		expect(armed?.nextFireAt).toBeTruthy(); // a parseable cron has a next fire in the horizon
		expect(loops.find((l) => l.id === 'maint:inert')).toBeUndefined();

		const reconciled = reconcileLoops(await listLoopManifest(db), loops);
		expect(reconciled.find((r) => r.identifier === 'maint:armed')?.status).toBe(
			'declared-and-running'
		);
		expect(reconciled.find((r) => r.identifier === 'maint:inert')?.status).toBe(
			'declared-not-running'
		);

		// No live engine (degraded boot) ⇒ no running maintenance cards at all (honest).
		setActiveMaintenanceEngine(null);
		const withoutEngine = await getLoops(db, ORCH_CFG);
		expect(withoutEngine.find((l) => l.kind === 'maintenance')).toBeUndefined();
	});

	it('surfaces each loop run history from its own run-log rows only', async () => {
		await declareLoop(TEST_LOOP, { ready: true });
		await declareLoop('maint:other', { ready: true });
		const a = countingAction({ summary: 'primary run summary' });
		const b = countingAction({ summary: 'other run summary' });
		const engine = new MaintenanceLoopEngine({
			db,
			mode: 'event',
			registry: registryOf([
				[TEST_LOOP, a.action],
				['maint:other', b.action]
			])
		});
		await engine.tickOnce(atMinute(10));

		const runs = await getLoopRuns(db, { id: TEST_LOOP, kind: 'maintenance' });
		expect(runs).toHaveLength(1);
		expect(runs[0].outcome).toBe('maintenance');
		expect(runs[0].at).toBeTruthy(); // ISO string, never a raw datetime (F-013)
		expect(runs[0].detailScreened).toContain('primary run summary');

		const otherRuns = await getLoopRuns(db, { id: 'maint:other', kind: 'maintenance' });
		expect(otherRuns).toHaveLength(1);
		expect(otherRuns[0].detailScreened).toContain('other run summary');
	});
});

// ── (6) the two shipped actions ────────────────────────────────────────────────────────────────────

const M0: RerankMetricSet = { precisionAt5: 0.5, recallAt5: 0.5, mrr: 0.5, ndcgAt5: 0.5 };

function fakeProbe(overrides: Partial<RerankProbe> = {}): RerankProbe {
	return {
		trained: true,
		nExamples: 20,
		weights: { cosine: 1, utility: 0.5, recency: 0.2, wasNeighbor: 0, bias: 0 },
		baseline: M0,
		reranked: { precisionAt5: 0.6, recallAt5: 0.55, mrr: 0.58, ndcgAt5: 0.58 },
		delta: { precisionAt5: 0.1, recallAt5: 0.05, mrr: 0.08, ndcgAt5: 0.08 },
		noRegression: true,
		...overrides
	};
}

async function seedLabeledOutcomes(pos: number, neg: number): Promise<void> {
	for (let i = 0; i < pos + neg; i++) {
		const utilized = i < pos;
		await db.query(
			`CREATE retrieval_outcome CONTENT {
				utilized: $u, cited: $u, score: $s,
				feat_cosine: $s, feat_utility: 0.3, feat_recency: 0.9
			};`,
			{ u: utilized, s: utilized ? 0.8 : 0.2 }
		);
	}
}

describe('maint:reranker-eval — threshold-gated, propose-only', () => {
	it('is an honest no-op while labels are still accruing (below thresholds)', async () => {
		const action = rerankerEvalAction({
			runProbe: async () => {
				throw new Error('probe must not run below thresholds');
			}
		});
		const res = await action({ db, now: new Date() });
		expect(res.ok).toBe(true);
		expect(res.summary).toContain(`labels still accruing: 0/${RERANK_MIN_EXAMPLES}`);

		const [models] = await db.query<[unknown[]]>(`SELECT * FROM reranker_model;`);
		expect(models).toHaveLength(0);
		const [notes] = await db.query<[unknown[]]>(`SELECT * FROM notification;`);
		expect(notes).toHaveLength(0);
	});

	it('at thresholds: trains from LIVE labels, persists the model, and PROPOSES via notification when reranked ≥ baseline', async () => {
		await seedLabeledOutcomes(12, 8);
		const action = rerankerEvalAction({ runProbe: async () => fakeProbe() });
		const res = await action({ db, now: new Date() });

		expect(res.ok).toBe(true);
		expect(res.summary).toContain('proposal notification written');
		expect(res.summary).toContain('propose-only');

		// The model persisted with the measured eval delta (behavior-neutral: RERANK_DEFAULT_ENABLED
		// stays false and this action never flips it — the operator decides).
		const [models] = await db.query<[Array<{ status: string; n_examples: number; eval_delta?: number }>]>(
			`SELECT status, n_examples, eval_delta FROM reranker_model;`
		);
		expect(models).toHaveLength(1);
		expect(models[0].status).toBe('active');
		expect(models[0].n_examples).toBe(20);
		expect(models[0].eval_delta).toBeCloseTo(0.08);

		// The PROPOSAL is a notification (the operator surface) — explicit that nothing was flipped.
		const [notes] = await db.query<[Array<{ message: string }>]>(`SELECT message FROM notification;`);
		expect(notes).toHaveLength(1);
		expect(notes[0].message).toContain('RERANK_DEFAULT_ENABLED');
		expect(notes[0].message).toContain('operator decision');
	});

	it('withholds the proposal when the reranked order regressed the baseline', async () => {
		await seedLabeledOutcomes(12, 8);
		const action = rerankerEvalAction({
			runProbe: async () =>
				fakeProbe({
					noRegression: false,
					delta: { precisionAt5: -0.1, recallAt5: 0, mrr: -0.02, ndcgAt5: -0.05 }
				})
		});
		const res = await action({ db, now: new Date() });
		expect(res.ok).toBe(true);
		expect(res.summary).toContain('no proposal');

		const [notes] = await db.query<[unknown[]]>(`SELECT * FROM notification;`);
		expect(notes).toHaveLength(0);
	});
});

describe('maint:eval-regression — persists the EvalReport', () => {
	function minimalReport(): EvalReport {
		return {
			corpus: { items: 1, queries: 1, embedder: 'lexical-test' },
			baseline: { weights: { cosine: 0.5, utility: 0.35, recency: 0.15 }, noveltyCut: 0.9, limit: 5 },
			weightSweep: [
				{
					label: 'baseline',
					weights: { cosine: 0.5, utility: 0.35, recency: 0.15 },
					noveltyCut: 0.9,
					limit: 5,
					perQuery: [],
					macro: {
						precisionAt3: 0.7,
						precisionAt5: 0.71,
						recallAt5: 0.72,
						mrr: 0.73,
						ndcgAt5: 0.74,
						dupSuppression: null
					}
				}
			],
			noveltySweep: [],
			budgetProbe: [],
			citeSignal: {
				perQuery: [],
				totalItems: 0,
				citeDirectiveCoverageAfter: 1,
				citeDirectiveCoverageBefore: 0,
				citeDirectiveLift: 1,
				citeIdParseRate: 1
			},
			rerankProbe: {
				trained: false,
				reason: 'cold start (fixture)',
				nExamples: 0,
				weights: null,
				baseline: M0,
				reranked: M0,
				delta: { precisionAt5: 0, recallAt5: 0, mrr: 0, ndcgAt5: 0 },
				noRegression: true
			},
			notes: ['fixture report']
		};
	}

	it('persists an eval_report row with the real headline metrics in the summary (injected report)', async () => {
		const action = evalRegressionAction({ runReport: async () => minimalReport() });
		const res = await action({ db, now: new Date() });
		expect(res.ok).toBe(true);
		expect(res.summary).toContain('nDCG@5 0.74');
		expect(res.summary).toContain('noRegression=true');

		const [rows] = await db.query<[Array<{ loop: string; embedder: string; report: EvalReport }>]>(
			`SELECT loop, embedder, report FROM eval_report;`
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].loop).toBe(MAINT_EVAL_REGRESSION);
		expect(rows[0].embedder).toBe('lexical-test');
		expect(rows[0].report.weightSweep[0].macro.ndcgAt5).toBe(0.74);
	});

	it(
		'REAL path: runs the §11 eval in a THROWAWAY DB and never pollutes live memory (isolation)',
		async () => {
			const countMemories = async (): Promise<number> => {
				const [rows] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM memory GROUP ALL;`
				);
				return rows.length ? Number(rows[0].c) : 0;
			};
			const countOutcomes = async (): Promise<number> => {
				const [rows] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM retrieval_outcome GROUP ALL;`
				);
				return rows.length ? Number(rows[0].c) : 0;
			};
			const memBefore = await countMemories();
			const outBefore = await countOutcomes();

			const action = evalRegressionAction(); // default = throwaway spawn + real runEval
			const res = await action({ db, now: new Date() });
			expect(res.ok).toBe(true);

			// The report LANDED on the live DB…
			const [rows] = await db.query<[Array<{ loop: string }>]>(`SELECT loop FROM eval_report;`);
			expect(rows).toHaveLength(1);
			// …but the harness's fixture memory + fabricated retrieval_outcome seeds did NOT
			// (they lived and died in the throwaway DB — F-008/D-030 isolation).
			expect(await countMemories()).toBe(memBefore);
			expect(await countOutcomes()).toBe(outBefore);
		},
		240_000
	);
});
