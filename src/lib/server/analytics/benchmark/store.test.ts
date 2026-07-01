import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { schemaMigrations } from '../../db/schema';
import { startTestDb, type TestDb } from '../../db/testserver';
import { foldJudged, isoOrNull, buildJudgedComparison, type RawVerdictRow } from './store';
import { runJudgeBatch } from './index';
import type { JudgeModel } from './judge';

// MODEL-BENCHMARK-SPEC step 3 VERIFY — the pure fold groups verdicts by provider with an honest
// empty state and coerces datetimes to ISO (F-013), and the DB pipeline (gather → judge → store →
// comparison) round-trips real rows (F-008). The judge model is a deterministic stub (no network).

describe('isoOrNull (F-013)', () => {
	it('coerces a JS Date and a Surreal-DateTime-like to ISO; null when absent', () => {
		const d = new Date('2026-07-01T12:00:00.000Z');
		expect(isoOrNull(d)).toBe('2026-07-01T12:00:00.000Z');
		expect(isoOrNull({ toISOString: () => '2026-07-01T12:00:00.000Z' })).toBe(
			'2026-07-01T12:00:00.000Z'
		);
		expect(isoOrNull(null)).toBeNull();
		expect(isoOrNull(undefined)).toBeNull();
	});
});

describe('foldJudged (pure)', () => {
	it('honest empty for no rows', () => {
		expect(foldJudged([])).toEqual([]);
	});

	it('groups by provider; averages SCORED only, counts insufficient separately', () => {
		const rows: RawVerdictRow[] = [
			{ session: 'session:a', provider: 'claude', dimension: 'confidence', status: 'scored', score: 0.8, judged_at: '2026-07-01T10:00:00Z' },
			{ session: 'session:b', provider: 'claude', dimension: 'confidence', status: 'scored', score: 0.6, judged_at: '2026-07-01T11:00:00Z' },
			{ session: 'session:a', provider: 'claude', dimension: 'thinking_consistency', status: 'scored', score: 0.9, judged_at: '2026-07-01T10:00:00Z' },
			{ session: 'session:c', provider: 'ollama', dimension: 'thinking_consistency', status: 'insufficient_data', score: null, judged_at: '2026-07-01T09:00:00Z' }
		];
		const out = foldJudged(rows);
		const claude = out.find((p) => p.provider === 'claude')!;
		const ollama = out.find((p) => p.provider === 'ollama')!;
		expect(claude.sessionsJudged).toBe(2);
		const conf = claude.dimensions.find((d) => d.dimension === 'confidence')!;
		expect(conf.avgScore).toBe(0.7); // (0.8 + 0.6) / 2
		expect(conf.scored).toBe(2);
		expect(claude.lastJudgedAt).toBe('2026-07-01T11:00:00Z');
		// Ollama thinking is insufficient — NOT averaged into a score (F-008).
		const tc = ollama.dimensions.find((d) => d.dimension === 'thinking_consistency')!;
		expect(tc.avgScore).toBeNull();
		expect(tc.insufficient).toBe(1);
		expect(tc.scored).toBe(0);
	});
});

describe('benchmark pipeline (DB round-trip)', () => {
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
		// Seed one local (ollama) driven session with a transcript + thinking + done outcome.
		await db.query(`CREATE session:ollama1 CONTENT {
			kind: 'task',
			model: { provider: 'ollama', model_id: 'gpt-oss:20b' },
			status: 'done',
			runtime: 'ollama',
			started_at: time::now()
		};`);
		await db.query(`CREATE message CONTENT { session: session:ollama1, role: 'tool', kind: 'tool_use', seq: 0, content: 'Read src/x.ts' };`);
		await db.query(`CREATE message CONTENT { session: session:ollama1, role: 'assistant', kind: 'thinking', seq: 1, content: 'I will read before asserting' };`);
		await db.query(`CREATE message CONTENT { session: session:ollama1, role: 'assistant', kind: 'assistant_text', seq: 2, content: 'x is defined as 1, verified.' };`);
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	it('honest empty comparison before any judging', async () => {
		expect(await buildJudgedComparison(db, { windowDays: 2 })).toEqual([]);
	});

	it('judges a bounded batch, stores verdicts, and surfaces them grouped by provider', async () => {
		const stub: JudgeModel = async () =>
			JSON.stringify({
				confidence: { score: 0.7, rationale: 'calibrated vs done outcome' },
				reasoning_quality: { score: 0.6, rationale: 'coherent' },
				fact_checking: { score: 0.8, rationale: 'read before asserting' },
				thinking_consistency: { score: 0.75, rationale: 'consistent intent' }
			});

		const result = await runJudgeBatch(db, {
			model: stub,
			judge: { provider: 'claude', modelId: 'claude-sonnet-4-x' },
			limit: 50, // requested high — must be bounded internally
			windowDays: 2
		});
		expect(result.judged).toBe(1);
		expect(result.limit).toBeLessThanOrEqual(20); // the on-demand trigger is bounded

		const cmp = await buildJudgedComparison(db, { windowDays: 2 });
		expect(cmp).toHaveLength(1);
		const ollama = cmp[0];
		expect(ollama.provider).toBe('ollama');
		expect(ollama.sessionsJudged).toBe(1);
		const conf = ollama.dimensions.find((d) => d.dimension === 'confidence')!;
		expect(conf.avgScore).toBe(0.7);
		// F-013: judged_at came back as an ISO string, not a raw SDK datetime.
		expect(typeof ollama.lastJudgedAt).toBe('string');
		expect(ollama.lastJudgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('re-judging replaces (idempotent) rather than duplicating verdicts', async () => {
		const stub: JudgeModel = async () =>
			JSON.stringify({
				confidence: { score: 0.4, rationale: 're-scored' },
				reasoning_quality: { score: 0.4, rationale: 're-scored' },
				fact_checking: { score: 0.4, rationale: 're-scored' },
				thinking_consistency: { score: 0.4, rationale: 're-scored' }
			});
		await runJudgeBatch(db, {
			model: stub,
			judge: { provider: 'claude', modelId: 'claude-sonnet-4-x' },
			limit: 5,
			windowDays: 2
		});
		const [rows] = await db.query<[unknown[]]>(
			'SELECT id FROM benchmark_verdict WHERE session = session:ollama1;'
		);
		expect(rows?.length).toBe(4); // one row per dimension, not 8
		const cmp = await buildJudgedComparison(db, { windowDays: 2 });
		const conf = cmp[0].dimensions.find((d) => d.dimension === 'confidence')!;
		expect(conf.avgScore).toBe(0.4); // reflects the re-judge, not the prior 0.7
	});
});
