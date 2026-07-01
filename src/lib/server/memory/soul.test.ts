// Stage S4 VERIFY — soul/identity derivation + maturity graduation.
//
// Two layers:
//   1. PURE unit tests (no DB) — the derivation is deterministic: metrics → maturity ladder →
//      self-model → concierge block. Cold brain → honest nascent (no fabrication, F-008).
//   2. A REAL-SURREAL integration test (F-020: stubDb does NOT parse SurrealQL) — the on-read
//      aggregation (count() GROUP ALL + ORDER BY … LIMIT) runs against a live throwaway DB, proving
//      the queries parse/execute, screened rows are excluded, and dominant concepts rank correctly.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	computeCompetence,
	deriveMaturityStage,
	deriveSoul,
	formatSoulBlock,
	loadSoul,
	readSoulMetrics,
	readDominantConcepts,
	readLearnedValues,
	MIN_COMPETENCE_SAMPLE,
	type SoulMetrics
} from './soul';

const COLD: SoulMetrics = {
	concepts: 0,
	corrections: 0,
	causalChains: 0,
	sessions: 0,
	retrievalOutcomes: 0,
	utilizedOutcomes: 0
};

function metrics(over: Partial<SoulMetrics>): SoulMetrics {
	return { ...COLD, ...over };
}

// ── 1. PURE derivation ────────────────────────────────────────────────────────────────────

describe('computeCompetence — honest null under the min sample', () => {
	it('is null when the outcome sample is below MIN_COMPETENCE_SAMPLE', () => {
		expect(computeCompetence(metrics({ retrievalOutcomes: 5, utilizedOutcomes: 5 }))).toBeNull();
	});
	it('is the utilization rate at/above the min sample', () => {
		const m = metrics({ retrievalOutcomes: MIN_COMPETENCE_SAMPLE, utilizedOutcomes: 18 });
		expect(computeCompetence(m)).toBeCloseTo(18 / MIN_COMPETENCE_SAMPLE, 5);
	});
});

describe('deriveMaturityStage — graduates on measurable thresholds', () => {
	it('a cold brain is nascent', () => {
		expect(deriveMaturityStage(COLD).stage).toBe('nascent');
	});

	it('a partially-populated brain (missing one gate) stays nascent', () => {
		// meets concepts/corrections/causal but only 9 sessions (< 10) → not yet developing.
		const m = metrics({ concepts: 8, corrections: 2, causalChains: 4, sessions: 9 });
		expect(deriveMaturityStage(m).stage).toBe('nascent');
	});

	it('graduates to developing when all four volume gates pass', () => {
		const m = metrics({ concepts: 5, corrections: 1, causalChains: 3, sessions: 10 });
		expect(deriveMaturityStage(m).stage).toBe('developing');
	});

	it('a big-but-incompetent brain does NOT reach established (quality gate blocks it)', () => {
		// all volume gates pass, but utilization 10/25 = 40% < 0.85 → stays developing.
		const m = metrics({ concepts: 30, corrections: 6, causalChains: 12, sessions: 60, retrievalOutcomes: 25, utilizedOutcomes: 10 });
		expect(deriveMaturityStage(m).stage).toBe('developing');
	});

	it('reaches established when volume gates AND the competence quality gate pass', () => {
		const m = metrics({ concepts: 30, corrections: 6, causalChains: 12, sessions: 60, retrievalOutcomes: 40, utilizedOutcomes: 36 });
		expect(deriveMaturityStage(m).stage).toBe('established');
	});
});

describe('deriveSoul — projects real rows into the self-model (no fabrication)', () => {
	it('a cold brain yields an honest nascent model — empty knows-about/values', () => {
		const soul = deriveSoul({ metrics: COLD, dominantConcepts: [], learnedValues: [] });
		expect(soul.maturityStage).toBe('nascent');
		expect(soul.nascent).toBe(true);
		expect(soul.knowsAbout).toEqual([]);
		expect(soul.values).toEqual([]);
		expect(soul.competence).toBeNull();
		expect(soul.summary).toContain('nascent');
		expect(soul.summary).toContain('insufficient');
	});

	it('surfaces the dominant concept and turns a correction into a learned value', () => {
		const soul = deriveSoul({
			metrics: metrics({ concepts: 5, corrections: 1, causalChains: 3, sessions: 10 }),
			dominantConcepts: [
				{ label: 'living memory scene', importance: 9, stability: 0.9, accessCount: 5 },
				{ label: 'heartbeat loop', importance: 7, stability: 0.6, accessCount: 2 }
			],
			learnedValues: [{ text: 'never return a raw SDK datetime from a load (F-013)', importance: 9 }]
		});
		expect(soul.maturityStage).toBe('developing');
		expect(soul.knowsAbout[0]).toBe('living memory scene');
		expect(soul.values[0]).toContain('raw SDK datetime');
		expect(soul.summary).toContain('developing');
	});

	it('caps knows-about + values to the bounded limits', () => {
		const soul = deriveSoul({
			metrics: metrics({ concepts: 30, corrections: 10, causalChains: 12, sessions: 60 }),
			dominantConcepts: Array.from({ length: 10 }, (_, i) => ({ label: `c${i}`, importance: 10 - i, stability: 0.5, accessCount: 0 })),
			learnedValues: Array.from({ length: 10 }, (_, i) => ({ text: `v${i}`, importance: 10 - i }))
		});
		expect(soul.knowsAbout.length).toBeLessThanOrEqual(5);
		expect(soul.values.length).toBeLessThanOrEqual(3);
	});
});

describe('formatSoulBlock — bounded, screened; omits on a cold brain', () => {
	it('returns null for a cold brain (the concierge omits the block honestly)', () => {
		const soul = deriveSoul({ metrics: COLD, dominantConcepts: [], learnedValues: [] });
		expect(formatSoulBlock(soul)).toBeNull();
	});

	it('renders a concise identity block once the brain has signal', () => {
		const soul = deriveSoul({
			metrics: metrics({ concepts: 5, corrections: 1, causalChains: 3, sessions: 10 }),
			dominantConcepts: [{ label: 'memory scene', importance: 9, stability: 0.9, accessCount: 5 }],
			learnedValues: [{ text: 'idempotent additive migrations only (F-015)', importance: 9 }]
		});
		const block = formatSoulBlock(soul);
		expect(block).not.toBeNull();
		expect(block).toContain('Maturity: developing');
		expect(block).toContain('Knows about: memory scene');
		expect(block).toContain('Learned values');
		expect(block).toContain('idempotent additive migrations');
	});
});

// ── 2. REAL-SURREAL aggregation (F-020) ────────────────────────────────────────────────────

describe('soul on-read aggregation — live SurrealDB (F-020)', () => {
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
		await db.query('DELETE concept; DELETE memory; DELETE causal_chain; DELETE session; DELETE retrieval_outcome;');
	});

	async function seedConcept(label: string, importance: number, screen = 'clean'): Promise<void> {
		await db.query(
			`CREATE concept SET label=$label, summary="", namespace="default",
			   embedding=array::repeat(0.0, 1024), importance=$imp, stability=0.5, access_count=0,
			   status="active", screen_status=$screen RETURN NONE;`,
			{ label, imp: importance, screen }
		);
	}
	async function seedMemory(content: string, importance: number, category?: string): Promise<void> {
		await db.query(
			`CREATE memory SET content=$c, kind="semantic", namespace=$ns, scope="project",
			   embedding=array::repeat(0.0, 1024), importance=$imp, status="active", screen_status="clean"
			   ${category ? ', category=$cat' : ''} RETURN NONE;`,
			{ c: content, imp: importance, ns: content.slice(0, 12), ...(category ? { cat: category } : {}) }
		);
	}
	async function seedCausal(i: number): Promise<void> {
		await db.query(
			`CREATE causal_chain SET trigger=$t, outcome=$o, kind="fix", success=true, confidence=0.8 RETURN NONE;`,
			{ t: `trigger ${i}`, o: `outcome ${i}` }
		);
	}
	async function seedSession(): Promise<void> {
		await db.query(
			`CREATE session SET kind="discussion", model={ provider: "test", model_id: "m" }, runtime="claude-code", status="done" RETURN NONE;`
		);
	}
	async function seedOutcome(utilized: boolean): Promise<void> {
		await db.query(`CREATE retrieval_outcome SET utilized=$u, score=0.5 RETURN NONE;`, { u: utilized });
	}

	it('readSoulMetrics counts live rows and EXCLUDES quarantined / non-correction rows', async () => {
		await seedConcept('alpha', 9);
		await seedConcept('beta', 7);
		await seedConcept('poisoned', 8, 'quarantined'); // excluded (D-026)
		await seedMemory('never delete memory (D-015)', 9, 'correction');
		await seedMemory('a plain observed fact', 5); // NOT a correction → excluded from corrections
		await seedCausal(1);
		await seedOutcome(true);
		await seedOutcome(false);

		const m = await readSoulMetrics(db);
		expect(m.concepts).toBe(2); // quarantined excluded
		expect(m.corrections).toBe(1); // plain memory excluded
		expect(m.causalChains).toBe(1);
		expect(m.retrievalOutcomes).toBe(2);
		expect(m.utilizedOutcomes).toBe(1);
	});

	it('readDominantConcepts ranks by importance and excludes quarantined', async () => {
		await seedConcept('low', 3);
		await seedConcept('high', 9);
		await seedConcept('mid', 6);
		await seedConcept('poisoned', 10, 'quarantined');
		const dom = await readDominantConcepts(db, 5);
		expect(dom.map((d) => d.label)).toEqual(['high', 'mid', 'low']);
	});

	it('readLearnedValues returns corrections ordered by importance', async () => {
		await seedMemory('minor correction', 6, 'correction');
		await seedMemory('major correction', 9, 'correction');
		await seedMemory('not a correction', 8);
		const vals = await readLearnedValues(db, 5);
		expect(vals.map((v) => v.text)).toEqual(['major correction', 'minor correction']);
	});

	it('loadSoul derives an honest DEVELOPING model from a modestly-seeded live brain', async () => {
		for (const [label, imp] of [['living memory scene', 9], ['heartbeat loop', 7], ['concept graph', 6], ['retrieval telemetry', 5], ['screen-before-embed', 4]] as const) {
			await seedConcept(label, imp);
		}
		await seedMemory('idempotent additive migrations only (F-015)', 9, 'correction');
		for (let i = 0; i < 3; i++) await seedCausal(i);
		for (let i = 0; i < 10; i++) await seedSession();

		const soul = await loadSoul(db);
		expect(soul.maturityStage).toBe('developing');
		expect(soul.knowsAbout[0]).toBe('living memory scene');
		expect(soul.values[0]).toContain('idempotent additive migrations');
		expect(formatSoulBlock(soul)).toContain('Maturity: developing');
	});

	it('loadSoul on an EMPTY live brain is honestly nascent (no fabrication, F-008)', async () => {
		const soul = await loadSoul(db);
		expect(soul.maturityStage).toBe('nascent');
		expect(soul.knowsAbout).toEqual([]);
		expect(soul.values).toEqual([]);
		expect(formatSoulBlock(soul)).toBeNull();
	});
});
