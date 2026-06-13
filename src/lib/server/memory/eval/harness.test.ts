import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { schemaMigrations } from '../../db/schema';
import { startTestDb, type TestDb } from '../../db/testserver';
import { MemoryService, WMR_WEIGHTS, NOVELTY_COSINE_CUT, RECALL_BUDGET } from '../index';
import { LexicalEmbedder, tokenize } from './embedder';
import { CORPUS, QUERIES, dupFamilies } from './corpus';
import { runEval, formatReport, rankRefs, type Weights } from './harness';
import {
	precisionAtK,
	recallAtK,
	reciprocalRank,
	ndcgAtK,
	dupSuppressionRate,
	relevantCount,
	mean,
	round
} from './metrics';

// MEMORY-SPEC §11 re-validation harness — VERIFY (integration vs a LIVE throwaway SurrealDB).
//
// Proves the harness is a TRUSTWORTHY MEASUREMENT instrument and a SCOPE-LOCKED one:
//   (1) it runs end-to-end against the real §4 schema and emits a complete report;
//   (2) it MUTATES NOTHING — WMR_WEIGHTS / NOVELTY_COSINE_CUT / RECALL_BUDGET are byte-equal
//       before and after, and the memory row count is unchanged (no prune, D-030/D-015);
//   (3) the LexicalEmbedder gives a real similarity signal (related > unrelated cosine), so
//       the recall numbers MEAN something — and the spec-default weights actually retrieve
//       the labeled-relevant items (baseline P@5/recall are well above chance);
//   (4) the novelty gate measurably suppresses the planted near-dup family;
//   (5) metric shadow paths: empty ranking, empty relevance, no-family query.

let tdb: TestDb;
let db: Db;
let mem: MemoryService;

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
	// LexicalEmbedder so cosine carries lexical/semantic overlap (FakeEmbedder would not).
	mem = new MemoryService({ db, embedder: new LexicalEmbedder() });
}, 60_000);

afterAll(async () => {
	await db?.close();
	await tdb?.teardown();
});

async function countMemories(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM memory GROUP ALL;`);
	return rows.length ? Number(rows[0].c) : 0;
}

describe('LexicalEmbedder — semantics-bearing eval signal', () => {
	it('scores lexically-related text higher than unrelated text', async () => {
		const emb = new LexicalEmbedder();
		const a = await emb.embed('the dashboard deploy pipeline builds with the node adapter');
		const related = await emb.embed('dashboard deploy pipeline node adapter build config');
		const unrelated = await emb.embed('the cat sat on the mat in the afternoon sun');
		const cos = (x: number[], y: number[]) => x.reduce((s, xi, i) => s + xi * y[i], 0);
		expect(cos(a, related)).toBeGreaterThan(cos(a, unrelated));
		expect(cos(a, related)).toBeGreaterThan(0.5);
		// After stopword stripping, content-word-disjoint text scores ~0 (no shared dims).
		expect(Math.abs(cos(a, unrelated))).toBeLessThan(0.1);
	});

	it('is deterministic and unit-normalized (cache + HNSW safe)', async () => {
		const emb = new LexicalEmbedder();
		const v1 = await emb.embed('svelte 5 runes reactive state');
		const v2 = await emb.embed('svelte 5 runes reactive state');
		expect(v1).toEqual(v2);
		const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
		expect(norm).toBeCloseTo(1, 6);
	});

	it('never returns a zero vector for empty/punctuation-only text', async () => {
		const emb = new LexicalEmbedder();
		const v = await emb.embed('!!! ??? ...');
		expect(tokenize('!!! ??? ...')).toHaveLength(0);
		const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
		expect(norm).toBeCloseTo(1, 6);
	});
});

describe('metrics — pure ranking-quality functions + shadow paths', () => {
	const rel = { a: 2, b: 1, c: 2 };
	it('precision/recall/mrr/ndcg on a known ranking', () => {
		const ranked = ['a', 'x', 'b', 'y', 'c'];
		expect(precisionAtK(ranked, rel, 3)).toBeCloseTo(2 / 3, 6);
		expect(recallAtK(ranked, rel, 5)).toBeCloseTo(1, 6);
		expect(reciprocalRank(ranked, rel)).toBeCloseTo(1, 6); // 'a' is first
		expect(ndcgAtK(ranked, rel, 5)).toBeGreaterThan(0);
		expect(ndcgAtK(ranked, rel, 5)).toBeLessThanOrEqual(1);
	});
	it('empty ranking ⇒ 0 precision/mrr, 0 recall (relevant exist), never NaN', () => {
		expect(precisionAtK([], rel, 5)).toBe(0);
		expect(recallAtK([], rel, 5)).toBe(0);
		expect(reciprocalRank([], rel)).toBe(0);
		expect(Number.isNaN(ndcgAtK([], rel, 5))).toBe(false);
	});
	it('empty relevance map ⇒ recall/ndcg defined as 1, precision 0', () => {
		expect(recallAtK(['a', 'b'], {}, 5)).toBe(1);
		expect(ndcgAtK(['a', 'b'], {}, 5)).toBe(1);
		expect(precisionAtK(['a', 'b'], {}, 5)).toBe(0);
		expect(relevantCount({})).toBe(0);
	});
	it('refs absent from the map count as grade 0', () => {
		expect(precisionAtK(['x', 'y', 'z'], rel, 3)).toBe(0);
	});
	it('mean guards the empty case; round is stable', () => {
		expect(mean([])).toBe(0);
		expect(mean([1, 2, 3])).toBe(2);
		expect(round(0.123456, 3)).toBe(0.123);
	});
	it('dupSuppressionRate: full suppression ⇒ 1, leak ⇒ <1, no family ⇒ null', () => {
		const fams = { f: ['d1', 'd2', 'd3'] };
		const cands = ['d1', 'd2', 'd3', 'other'];
		expect(dupSuppressionRate(cands, ['d1', 'other'], fams)).toBe(1); // only one survived
		expect(dupSuppressionRate(cands, ['d1', 'd2'], fams)).toBe(0); // two leaked
		expect(dupSuppressionRate(['only-one', 'x'], ['only-one'], fams)).toBeNull(); // <2 in pool
	});
});

describe('rankRefs / scoreVariant — read-only re-ranking', () => {
	it('novelty gate at a lower cut drops more near-dups', () => {
		// Two near-identical embeddings (cosine ~0.96) + one distinct (orthogonal).
		const sim = 0.96;
		const e1 = Array(8).fill(0); e1[0] = 1;
		const e2 = Array(8).fill(0); e2[0] = sim; e2[1] = Math.sqrt(1 - sim ** 2);
		const e3 = Array(8).fill(0); e3[4] = 1;
		const cands = [
			{ ref: 'p1', id: 'm:1', content: 'x', embedding: e1, cosine: 0.9, utility: 0, recency: 0 },
			{ ref: 'p2', id: 'm:2', content: 'y', embedding: e2, cosine: 0.89, utility: 0, recency: 0 },
			{ ref: 'p3', id: 'm:3', content: 'z', embedding: e3, cosine: 0.5, utility: 0, recency: 0 }
		];
		const w: Weights = { cosine: 1, utility: 0, recency: 0 };
		const loose = rankRefs(cands, w, 0.98, 5).finalRefs; // cut ABOVE 0.96 ⇒ keep both
		const tight = rankRefs(cands, w, 0.95, 5).finalRefs; // cut BELOW 0.96 ⇒ drop the dup
		expect(loose).toContain('p2');
		expect(tight).not.toContain('p2');
	});
});

describe('runEval — live integration, MEASUREMENT ONLY', () => {
	let weightsBefore: typeof WMR_WEIGHTS;
	let cutBefore: number;
	let budgetBefore: { maxItems: number | null; maxTokens: number | null };
	let countBefore: number;
	let report: Awaited<ReturnType<typeof runEval>>;

	beforeAll(async () => {
		weightsBefore = { ...WMR_WEIGHTS };
		cutBefore = NOVELTY_COSINE_CUT;
		budgetBefore = { ...RECALL_BUDGET };
		report = await runEval(mem);
		countBefore = await countMemories();
	}, 120_000);

	it('seeds the full corpus and emits a complete report', () => {
		expect(report.corpus.items).toBe(CORPUS.length);
		expect(report.corpus.queries).toBe(QUERIES.length);
		expect(report.weightSweep.length).toBeGreaterThanOrEqual(5);
		expect(report.noveltySweep.length).toBeGreaterThanOrEqual(5);
		expect(report.budgetProbe.length).toBe(3);
		// Print the evidence artifact into the test log (the measured-numbers deliverable).
		console.log('\n' + formatReport(report) + '\n');
	});

	it('did NOT mutate any §11 default (D-030 ranking-only — weights/cut/budget unchanged)', () => {
		expect(WMR_WEIGHTS).toEqual(weightsBefore);
		expect(NOVELTY_COSINE_CUT).toBe(cutBefore);
		expect(RECALL_BUDGET).toEqual(budgetBefore);
	});

	it('did NOT prune any memory (rows persist — archive-never-delete, D-015)', async () => {
		// Every clean corpus item persisted; nothing was archived/deleted by the harness.
		expect(countBefore).toBe(CORPUS.length);
		expect(await countMemories()).toBe(CORPUS.length);
	});

	it('the spec-default weights actually retrieve labeled-relevant items (above chance)', () => {
		const baseline = report.weightSweep.find((v) => v.label.startsWith('baseline'));
		expect(baseline).toBeDefined();
		// With a real similarity signal, the documented weights should land relevant items
		// at the top — meaningfully above the ~0.1 chance rate for this corpus.
		expect(baseline!.macro.precisionAt5).toBeGreaterThan(0.3);
		expect(baseline!.macro.recallAt5).toBeGreaterThan(0.5);
		expect(baseline!.macro.ndcgAt5).toBeGreaterThan(0.5);
	});

	it('measures novelty-gate suppression as a function of the cut (the §4.6 re-validation finding)', () => {
		const fams = dupFamilies();
		expect(fams['gateway-loopback'].length).toBe(4);
		// The gateway query has all 4 near-dups as candidates; suppression is MEASURABLE.
		const baseline = report.weightSweep.find((v) => v.label.startsWith('baseline'))!;
		const gwDefault = baseline.perQuery.find((m) => m.queryId === 'q-gateway')!;
		expect(gwDefault.dupSuppression).not.toBeNull();
		// MEASURED FINDING (recorded, not asserted as "correct"): on this corpus the near-dup
		// paraphrases sit at cosine ~0.83–0.91, BELOW the spec §4.6 default cut of 0.97 — so the
		// DEFAULT cut does NOT collapse them. The harness surfaces exactly this so B8 can lower
		// the cut. We assert the harness REPORTS a number (0..1), not a particular value.
		expect(gwDefault.dupSuppression!).toBeGreaterThanOrEqual(0);
		expect(gwDefault.dupSuppression!).toBeLessThanOrEqual(1);
		// A TIGHTER cut DOES suppress — proves the gate works and the sweep can find a better cut.
		const tight = report.noveltySweep.find((v) => v.noveltyCut === 0.85)!;
		const gwTight = tight.perQuery.find((m) => m.queryId === 'q-gateway')!;
		expect(gwTight.dupSuppression).not.toBeNull();
		expect(gwTight.dupSuppression!).toBeGreaterThan(gwDefault.dupSuppression!);
	});

	it('the budget probe tail-drops live recall without ever exceeding the cap', () => {
		const off = report.budgetProbe.find((p) => p.label.startsWith('budget OFF'))!;
		const tight = report.budgetProbe.find((p) => p.label.startsWith('tight'))!;
		const offItems = off.perQuery.reduce((s, q) => s + q.items, 0);
		const tightItems = tight.perQuery.reduce((s, q) => s + q.items, 0);
		// A tight item cap can only ever drop items vs OFF, never add.
		expect(tightItems).toBeLessThanOrEqual(offItems);
		for (const q of tight.perQuery) expect(q.items).toBeLessThanOrEqual(3);
	});
});
