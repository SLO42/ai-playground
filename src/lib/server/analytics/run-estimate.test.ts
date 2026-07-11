import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
	estimateCeremonyRun,
	estimateLoopRun,
	toEstimateDisplay,
	type RunSpendEstimate
} from './run-estimate';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';

// COST-GOVERNANCE-SPEC CG-4 — the recent-window per-source spend estimator.
//   1. UNIT tests — the pure FOLD (toEstimate via the display) + the display copy: history → value,
//      empty → '—', unpriced → tokens-only. No DB.
//   2. REAL-SURREAL tests (F-020) — a stubDb never parses the `session IN (SELECT VALUE session FROM
//      interview_run …)` ceremony join or the project-scoped filter or the `math::sum(IF …)` priced
//      count. This layer seeds real sessions / interview_runs / agent_events and runs the ACTUAL
//      queries against a live throwaway DB, so any future idiom gap fails the suite, not a live confirm.

// ── UNIT — the display copy (F-008: labelled estimate, honest '—', tokens-only) ────────────────────
describe('toEstimateDisplay — honest copy (CG-4)', () => {
	it("renders '—' + 'no history yet' when the estimate is null (F-008)", () => {
		const d = toEstimateDisplay(null);
		expect(d.hasHistory).toBe(false);
		expect(d.label).toBe('—');
		expect(d.note).toBe('no history yet');
	});

	it('renders tokens + $ + the sample size when priced history exists', () => {
		const est: RunSpendEstimate = { avgTokens: 12345, avgUsd: 0.21, sampleSize: 4, pricedSampleSize: 4 };
		const d = toEstimateDisplay(est);
		expect(d.hasHistory).toBe(true);
		expect(d.label).toBe('~12,345 tokens (~$0.21) per run');
		expect(d.note).toBe('estimated from 4 recent runs');
	});

	it('renders tokens-only (no fabricated $0) when NO sampled row was priced (F-008)', () => {
		const est: RunSpendEstimate = { avgTokens: 900, avgUsd: null, sampleSize: 1, pricedSampleSize: 0 };
		const d = toEstimateDisplay(est);
		expect(d.label).toBe('~900 tokens per run');
		expect(d.note).toBe('estimated from 1 recent run · tokens only — model unpriced');
	});

	it('uses the unit label for the loop surface (driven session)', () => {
		const est: RunSpendEstimate = { avgTokens: 5000, avgUsd: 1.05, sampleSize: 2, pricedSampleSize: 2 };
		expect(toEstimateDisplay(est, 'driven session').label).toBe('~5,000 tokens (~$1.05) per driven session');
	});

	it('sub-$0.10 costs render 4dp (a real cost never rounds to $0.00)', () => {
		const est: RunSpendEstimate = { avgTokens: 100, avgUsd: 0.0123, sampleSize: 3, pricedSampleSize: 3 };
		expect(toEstimateDisplay(est).label).toBe('~100 tokens (~$0.0123) per run');
	});

	it('a genuine local $0 average reads $0.00 (priced, not unknown)', () => {
		const est: RunSpendEstimate = { avgTokens: 800, avgUsd: 0, sampleSize: 2, pricedSampleSize: 2 };
		expect(toEstimateDisplay(est).label).toBe('~800 tokens (~$0.00) per run');
	});
});

// ── REAL-SURREAL (F-020) ───────────────────────────────────────────────────────────────────────
describe('estimateCeremonyRun / estimateLoopRun — live SurrealDB (F-020)', () => {
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
		await db.query('DELETE agent_event; DELETE interview_run; DELETE session; DELETE role; DELETE role_version;');
	});

	/** Seed a real session row (SCHEMAFULL: kind + model required; project optional). */
	async function seedSession(id: string, project?: string): Promise<void> {
		const parts = [`kind="task"`, `model={ provider: "claude", model_id: "m" }`];
		if (project) parts.push(`project=${project}`);
		await db.query(`CREATE ${id} SET ${parts.join(', ')} RETURN NONE;`);
	}

	/** Seed a minimal interview_run linking a candidate session (only the fields the estimator reads). */
	async function seedInterviewRun(id: string, session: string): Promise<void> {
		await db.query(
			`CREATE ${id} SET role=role:r, role_version=role_version:rv, prompt_sha="s", tier="opus",
			   provider="claude", model_id="claude-opus-4-8", fixture_set_sha="f", session=${session} RETURN NONE;`
		);
	}

	interface SeedEvent {
		session?: string;
		project?: string;
		type?: string;
		tokens_in?: number;
		tokens_out?: number;
		cost_usd?: number;
		/** ISO offset back from now (ms) for the durable `at` anchor; default now. */
		agoMs?: number;
	}

	async function seedEvent(e: SeedEvent): Promise<void> {
		const parts = [`type="${e.type ?? 'completion'}"`];
		if (e.session) parts.push(`session=${e.session}`);
		if (e.project) parts.push(`project=${e.project}`);
		for (const k of ['tokens_in', 'tokens_out', 'cost_usd'] as const) {
			if (e[k] != null) parts.push(`${k}=${e[k]}`);
		}
		if (e.agoMs != null) parts.push(`at=<datetime>"${new Date(Date.now() - e.agoMs).toISOString()}"`);
		await db.query(`CREATE agent_event SET ${parts.join(', ')} RETURN NONE;`);
	}

	it('CEREMONY: averages tokens + $ over interview_run sessions only (join is real)', async () => {
		await seedSession('session:c1');
		await seedSession('session:c2');
		await seedSession('session:other', 'project:alpha'); // NOT an interview_run session
		await seedInterviewRun('interview_run:i1', 'session:c1');
		await seedInterviewRun('interview_run:i2', 'session:c2');

		await seedEvent({ session: 'session:c1', tokens_in: 1000, tokens_out: 200, cost_usd: 0.06 });
		await seedEvent({ session: 'session:c2', tokens_in: 2000, tokens_out: 800, cost_usd: 0.14 });
		// A non-ceremony completion must NOT pollute the ceremony average.
		await seedEvent({ session: 'session:other', project: 'project:alpha', tokens_in: 999999, tokens_out: 999999, cost_usd: 9 });
		// A spawn (not completion) on a ceremony session must be ignored.
		await seedEvent({ session: 'session:c1', type: 'spawn', tokens_in: 5, tokens_out: 5 });

		const est = await estimateCeremonyRun(db);
		expect(est).not.toBeNull();
		// (1200 + 2800) / 2 = 2000 tokens; (0.06 + 0.14) / 2 = 0.10 usd.
		expect(est!.avgTokens).toBe(2000);
		expect(est!.avgUsd).toBeCloseTo(0.1, 6);
		expect(est!.sampleSize).toBe(2);
		expect(est!.pricedSampleSize).toBe(2);
	});

	it('CEREMONY: unpriced completions → tokens only, avgUsd null (F-008)', async () => {
		await seedSession('session:c1');
		await seedInterviewRun('interview_run:i1', 'session:c1');
		await seedEvent({ session: 'session:c1', tokens_in: 400, tokens_out: 100 }); // no cost_usd
		const est = await estimateCeremonyRun(db);
		expect(est).not.toBeNull();
		expect(est!.avgTokens).toBe(500);
		expect(est!.avgUsd).toBeNull();
		expect(est!.pricedSampleSize).toBe(0);
	});

	it('CEREMONY: honest null when there is no ceremony history (F-008 → UI shows —)', async () => {
		// A project completion exists but NO interview_run — ceremony must stay empty.
		await seedSession('session:x', 'project:alpha');
		await seedEvent({ session: 'session:x', project: 'project:alpha', tokens_in: 10, tokens_out: 10, cost_usd: 0.01 });
		expect(await estimateCeremonyRun(db)).toBeNull();
	});

	it('CEREMONY: rows outside the window are excluded (durable at anchor)', async () => {
		await seedSession('session:c1');
		await seedInterviewRun('interview_run:i1', 'session:c1');
		await seedEvent({ session: 'session:c1', tokens_in: 400, tokens_out: 100, cost_usd: 0.02, agoMs: 40 * 24 * 60 * 60 * 1000 });
		// 30-day default window excludes the 40-day-old row → honest null.
		expect(await estimateCeremonyRun(db)).toBeNull();
	});

	it('LOOP: averages the project completions, ignoring other projects + non-completions', async () => {
		await seedSession('session:a1', 'project:alpha');
		await seedSession('session:a2', 'project:alpha');
		await seedSession('session:b1', 'project:beta');

		await seedEvent({ session: 'session:a1', project: 'project:alpha', tokens_in: 300, tokens_out: 100, cost_usd: 0.02 });
		await seedEvent({ session: 'session:a2', project: 'project:alpha', tokens_in: 500, tokens_out: 100, cost_usd: 0.04 });
		await seedEvent({ session: 'session:b1', project: 'project:beta', tokens_in: 99999, tokens_out: 1, cost_usd: 5 });
		await seedEvent({ session: 'session:a1', project: 'project:alpha', type: 'spawn', tokens_in: 7, tokens_out: 7 });

		const est = await estimateLoopRun(db, 'project:alpha');
		expect(est).not.toBeNull();
		// (400 + 600) / 2 = 500 tokens; (0.02 + 0.04) / 2 = 0.03 usd.
		expect(est!.avgTokens).toBe(500);
		expect(est!.avgUsd).toBeCloseTo(0.03, 6);
		expect(est!.sampleSize).toBe(2);
	});

	it('LOOP: honest null for a project with no completion history (F-008 → UI shows —)', async () => {
		expect(await estimateLoopRun(db, 'project:empty')).toBeNull();
	});
});
