import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { writeAgentEvent } from './events';
import {
	foldDaily,
	detectAnomalies,
	buildReportSummary,
	buildTierUsage,
	buildShellMetrics,
	type DailyRollup
} from './rollup';

// TASK 2.4 VERIFY (part 2) — daily rollups + anomaly flags computed from REAL rows.
// The pure folds (foldDaily/detectAnomalies) are unit-tested in isolation; the DB-backed
// builders are tested against the live throwaway DB so we prove no fabrication (F-008):
// an unpriced run yields null cost, never a dressed-up 0.

describe('foldDaily (pure)', () => {
	it('buckets events per UTC day with counts, tokens, error rate', () => {
		const days = foldDaily([
			{ type: 'spawn', at: '2026-06-01T01:00:00Z' },
			{ type: 'completion', at: '2026-06-01T02:00:00Z', tokens_in: 100, tokens_out: 40, duration_ms: 1000 },
			{ type: 'error', at: '2026-06-01T03:00:00Z' },
			{ type: 'spawn', at: '2026-06-02T01:00:00Z' },
			{ type: 'completion', at: '2026-06-02T02:00:00Z', tokens_in: 50, tokens_out: 10, duration_ms: 3000 }
		]);
		expect(days.length).toBe(2);
		const d1 = days[0];
		expect(d1.day).toBe('2026-06-01');
		expect(d1.spawns).toBe(1);
		expect(d1.completions).toBe(1);
		expect(d1.errors).toBe(1);
		expect(d1.tokensIn).toBe(100);
		expect(d1.errorRate).toBeCloseTo(0.5, 5); // 1 error / (1 completion + 1 error)
		expect(d1.avgDurationMs).toBe(1000);
		expect(days[1].avgDurationMs).toBe(3000);
	});

	it('leaves cost null when no row carried a priced cost (F-008)', () => {
		const days = foldDaily([{ type: 'completion', at: '2026-06-01T00:00:00Z', tokens_in: 1 }]);
		expect(days[0].costUsd).toBeNull();
	});

	it('sums cost only across priced rows', () => {
		const days = foldDaily([
			{ type: 'completion', at: '2026-06-01T00:00:00Z', cost_usd: 0.1 },
			{ type: 'completion', at: '2026-06-01T01:00:00Z' }, // unpriced — not counted
			{ type: 'completion', at: '2026-06-01T02:00:00Z', cost_usd: 0.2 }
		]);
		expect(days[0].costUsd).toBeCloseTo(0.3, 5);
	});
});

describe('detectAnomalies (pure — trend-aware)', () => {
	function day(over: Partial<DailyRollup>): DailyRollup {
		return {
			day: '2026-06-01',
			spawns: 5,
			completions: 5,
			errors: 0,
			escalations: 0,
			tokensIn: 0,
			tokensOut: 0,
			costUsd: null,
			avgDurationMs: null,
			errorRate: 0,
			...over
		};
	}

	it('flags an error-spike against the trailing baseline', () => {
		const days = [
			day({ day: '2026-06-01', errorRate: 0.0 }),
			day({ day: '2026-06-02', errorRate: 0.0 }),
			day({ day: '2026-06-03', errorRate: 0.8, errors: 8, completions: 2 })
		];
		const flags = detectAnomalies(days);
		const spike = flags.find((f) => f.kind === 'error-spike');
		expect(spike).toBeTruthy();
		expect(spike!.day).toBe('2026-06-03');
		expect(spike!.message).toContain('%');
	});

	it('flags a cost-spike only when costs are priced', () => {
		const days = [
			day({ day: '2026-06-01', costUsd: 1.0 }),
			day({ day: '2026-06-02', costUsd: 1.0 }),
			day({ day: '2026-06-03', costUsd: 5.0 })
		];
		const spike = detectAnomalies(days).find((f) => f.kind === 'cost-spike');
		expect(spike).toBeTruthy();
		expect(spike!.value).toBe(5.0);
	});

	it('does not flag cost when costs are null (no fabrication)', () => {
		const days = [day({ day: '2026-06-01' }), day({ day: '2026-06-02' })];
		expect(detectAnomalies(days).some((f) => f.kind === 'cost-spike')).toBe(false);
	});

	it('flags a no-activity day surrounded by activity', () => {
		const days = [
			day({ day: '2026-06-01', spawns: 5 }),
			day({ day: '2026-06-02', spawns: 0, completions: 0, errors: 0 }),
			day({ day: '2026-06-03', spawns: 5 })
		];
		expect(detectAnomalies(days).some((f) => f.kind === 'no-activity')).toBe(true);
	});

	it('the first day never spikes (no baseline)', () => {
		const days = [day({ day: '2026-06-01', errorRate: 1.0, errors: 5, completions: 0 })];
		expect(detectAnomalies(days).some((f) => f.kind === 'error-spike')).toBe(false);
	});
});

describe('buildReportSummary / buildTierUsage (DB-backed; F-008)', () => {
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
		const p = await createProject(db, { slug: 'rep', name: 'Report Host', root_path: 'F:/code/rep' });
		projectId = p.id;
		// Seed a handful of REAL agent_event rows (today's window).
		await writeAgentEvent(db, {
			type: 'spawn',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' }
		});
		await writeAgentEvent(db, {
			type: 'completion',
			project: projectId,
			model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
			tokensIn: 200,
			tokensOut: 80,
			durationMs: 5000,
			costUsd: 0.05
		});
		await writeAgentEvent(db, { type: 'error', project: projectId });
	}, 90_000);

	afterAll(async () => {
		await deleteProject(db, projectId).catch(() => {});
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	it('summarizes real rows into a daily rollup with totals', async () => {
		const summary = await buildReportSummary(db, { projectId, windowDays: 2 });
		expect(summary.days.length).toBeGreaterThanOrEqual(1);
		expect(summary.totals.spawns).toBe(1);
		expect(summary.totals.completions).toBe(1);
		expect(summary.totals.errors).toBe(1);
		expect(summary.totals.tokensIn).toBe(200);
		expect(summary.totals.costUsd).toBeCloseTo(0.05, 5);
	});

	it('rolls usage up per tier from real rows', async () => {
		const usage = await buildTierUsage(db, { windowDays: 2 });
		const opus = usage.find((u) => u.tier === 'opus');
		expect(opus).toBeTruthy();
		expect(opus!.provider).toBe('claude');
		expect(opus!.runs).toBe(1); // one spawn
		expect(opus!.tokensIn).toBe(200);
		expect(opus!.costUsd).toBeCloseTo(0.05, 5);
	});

	// TASK 7.1 — shell tickers: real counts, no fabrication (F-008).
	it('builds shell metrics from real rows (today tokens/cost, running agents)', async () => {
		const m = await buildShellMetrics(db);
		// Seeded completion carried 200 in + 80 out = 280 tokens, priced at $0.05.
		expect(m.tokensToday).toBe(280);
		expect(m.costToday).toBeCloseTo(0.05, 5);
		// No `session` rows were seeded → honest zero running agents (not a fake number).
		expect(m.runningAgents).toBe(0);
	});

	it('leaves cost null when no priced run exists today (no fake $0)', async () => {
		// Fresh isolated DB in the same namespace: only an UNPRICED spawn → tokens 0,
		// cost stays null (F-008 — never a fabricated $0).
		const fresh = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: `shell_unpriced_${Date.now()}`
		});
		await runMigrations(fresh, schemaMigrations);
		await writeAgentEvent(fresh, { type: 'spawn' });
		const m = await buildShellMetrics(fresh);
		expect(m.tokensToday).toBe(0);
		expect(m.costToday).toBeNull(); // F-008: never a fabricated $0
		expect(m.runningAgents).toBe(0);
		await fresh.close().catch(() => {});
	});
});
