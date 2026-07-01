import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { MemoryService } from './index';
import { LexicalEmbedder } from './eval/embedder';
import {
	trainReranker,
	scoreFeatures,
	applyRerank,
	labelFor,
	loadTrainingExamples,
	loadActiveWeights,
	saveWeights,
	trainAndPersist,
	RERANK_MIN_EXAMPLES,
	RERANK_MIN_PER_CLASS,
	RERANK_DEFAULT_ENABLED,
	type LabeledExample,
	type RerankFeatures,
	type RerankWeights
} from './rerank';

// S2 learned reranker (COGNITIVE-ARCHITECTURE §5) — unit + integration.
//
// Proves: (1) pure scorer/trainer — cold-start → null (passthrough), two-class → learns to rank
// high-utilization items up, deterministic; (2) labelFor verdict override; (3) the DB round-trip
// — feature-bearing outcome rows load as training examples, weights persist + reload, prior active
// retires; (4) recall() wiring — reranker OFF/cold-start passes through the baseline WMR order
// (F-008 honest), reranker ON with weights re-orders the SAME candidate set toward utilization.

function feat(cosine: number, utility: number, recency = 0, wasNeighbor = 0): RerankFeatures {
	return { cosine, utility, recency, wasNeighbor };
}

describe('rerank — pure scorer + trainer', () => {
	it('cold start (< RERANK_MIN_EXAMPLES) ⇒ null (recall passes through baseline)', () => {
		const few: LabeledExample[] = Array.from({ length: RERANK_MIN_EXAMPLES - 1 }, (_, i) => ({
			features: feat(0.5, i % 2 ? 0.8 : 0.1),
			label: i % 2
		}));
		expect(trainReranker(few)).toBeNull();
	});

	it('single-class label set ⇒ null (cannot learn a boundary)', () => {
		const allPos: LabeledExample[] = Array.from({ length: RERANK_MIN_EXAMPLES + 5 }, () => ({
			features: feat(0.6, 0.5),
			label: 1
		}));
		expect(trainReranker(allPos)).toBeNull();
		// Exactly at the per-class floor minus one on the negative side ⇒ still null.
		const skewed: LabeledExample[] = [
			...Array.from({ length: RERANK_MIN_EXAMPLES }, () => ({ features: feat(0.6, 0.9), label: 1 })),
			...Array.from({ length: RERANK_MIN_PER_CLASS - 1 }, () => ({ features: feat(0.6, 0.1), label: 0 }))
		];
		expect(trainReranker(skewed)).toBeNull();
	});

	it('learns to rank HIGH-utilization items above low-utilization ones', () => {
		// A separable set: label 1 ⇔ high utility, label 0 ⇔ low utility (cosine held ~constant).
		const examples: LabeledExample[] = [];
		for (let i = 0; i < 30; i++) examples.push({ features: feat(0.5, 0.9), label: 1 });
		for (let i = 0; i < 30; i++) examples.push({ features: feat(0.5, 0.05), label: 0 });
		const w = trainReranker(examples);
		expect(w).not.toBeNull();
		// The learned model must score a high-utility candidate above a low-utility one.
		const hi = scoreFeatures(feat(0.5, 0.9), w!);
		const lo = scoreFeatures(feat(0.5, 0.05), w!);
		expect(hi).toBeGreaterThan(lo);
		// Utility carried the signal ⇒ its learned weight is positive.
		expect(w!.utility).toBeGreaterThan(0);
	});

	it('is deterministic — same examples ⇒ byte-identical weights (no RNG)', () => {
		const examples: LabeledExample[] = [];
		for (let i = 0; i < 20; i++) examples.push({ features: feat(0.8, 0.7), label: 1 });
		for (let i = 0; i < 20; i++) examples.push({ features: feat(0.2, 0.1), label: 0 });
		expect(trainReranker(examples)).toEqual(trainReranker(examples));
	});

	it('applyRerank re-orders toward the higher learned score without mutating the input', () => {
		const w: RerankWeights = { cosine: 0, utility: 1, recency: 0, wasNeighbor: 0, bias: 0 };
		const cands = [
			{ id: 'a', f: feat(0.9, 0.1) },
			{ id: 'b', f: feat(0.3, 0.9) }
		];
		const before = [...cands];
		const out = applyRerank(cands, (c) => c.f, w);
		expect(out.map((c) => c.id)).toEqual(['b', 'a']); // utility-weighted ⇒ b first
		expect(cands).toEqual(before); // input untouched
	});

	it('labelFor: llm_relevance verdict overrides the implicit utilized signal', () => {
		expect(labelFor(false, 'helpful')).toBe(1);
		expect(labelFor(false, 'pin')).toBe(1);
		expect(labelFor(true, 'irrelevant')).toBe(0);
		expect(labelFor(true, 'outdated')).toBe(0);
		expect(labelFor(true, null)).toBe(1); // no verdict ⇒ fall back to utilized
		expect(labelFor(false, undefined)).toBe(0);
	});
});

describe('rerank — DB pipeline (feature extraction + weight persistence)', () => {
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
		mem = new MemoryService({ db, embedder: new LexicalEmbedder() });
	}, 60_000);

	afterAll(async () => {
		await db?.close();
		await tdb?.teardown();
	});

	function link(id: string): StringRecordId {
		return new StringRecordId(assertRecordId(id));
	}

	it('loadTrainingExamples reads feature-bearing rows, skips NONE-feature rows', async () => {
		const [m] = await mem.store([{ content: 'a memory for reranker training example rows' }]);
		expect(m.id).toBeTruthy();
		// A pre-m0075-style row with NO feat_* — must be SKIPPED by the trainer loader.
		await db.query(
			`CREATE retrieval_outcome CONTENT { memory: $mem, cited: false, utilized: true, was_neighbor: false, score: 0.5 };`,
			{ mem: link(m.id!) }
		);
		// A feature-bearing row — must be INCLUDED.
		await db.query(
			`CREATE retrieval_outcome CONTENT { memory: $mem, cited: true, utilized: true, was_neighbor: false, score: 0.7, feat_cosine: 0.7, feat_utility: 0.4, feat_recency: 0.2 };`,
			{ mem: link(m.id!) }
		);
		const examples = await loadTrainingExamples(db);
		expect(examples.length).toBe(1);
		expect(examples[0].features).toEqual({ cosine: 0.7, utility: 0.4, recency: 0.2, wasNeighbor: 0 });
		expect(examples[0].label).toBe(1);
	});

	it('saveWeights + loadActiveWeights round-trip; a new model retires the prior active', async () => {
		const w1: RerankWeights = { cosine: 0.5, utility: 0.3, recency: 0.1, wasNeighbor: -0.2, bias: 0.05 };
		await saveWeights(db, w1, { nExamples: 42, evalDelta: 0.01 });
		const back = await loadActiveWeights(db);
		expect(back).toEqual(w1);

		const w2: RerankWeights = { cosine: 0.9, utility: 0.1, recency: 0, wasNeighbor: 0, bias: 0 };
		await saveWeights(db, w2, { nExamples: 99 });
		// Only the newest active model resolves (prior one retired).
		expect(await loadActiveWeights(db)).toEqual(w2);
		const [actives] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM reranker_model WHERE status = "active" GROUP ALL;`
		);
		expect(Number(actives[0].c)).toBe(1);
	});

	it('loadActiveWeights ⇒ null when no model has been trained (cold start honest)', async () => {
		// A fresh throwaway ns proves the honest null; retire all here to simulate it.
		await db.query(`UPDATE reranker_model SET status = "retired";`);
		expect(await loadActiveWeights(db)).toBeNull();
	});

	it('trainAndPersist reports an honest cold-start reason and persists nothing', async () => {
		await db.query(`DELETE reranker_model; DELETE retrieval_outcome;`);
		const res = await trainAndPersist(db);
		expect(res.weights).toBeNull();
		expect(res.persisted).toBe(false);
		expect(res.reason).toMatch(/cold start/);
		expect(await loadActiveWeights(db)).toBeNull();
	});
});

describe('rerank — recall() wiring (baseline preserved, cold-start passthrough)', () => {
	let tdb: TestDb;
	let db: Db;
	let mem: MemoryService;
	let hiCosId: string;
	let hiUtilId: string;

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
		mem = new MemoryService({ db, embedder: new LexicalEmbedder() });

		// A: lexically MATCHES the query (high cosine), no utilization.
		const [a] = await mem.store([{ content: 'svelte 5 runes reactive state dollar-state derived effect' }]);
		// B: DISJOINT vocab (low cosine to the query) but high utilization signal.
		const [b] = await mem.store([{ content: 'gateway binds loopback only port security policy openclaw' }]);
		hiCosId = a.id!;
		hiUtilId = b.id!;
		// Seed utilized outcome rows for B so its historical-utility term is high.
		for (let i = 0; i < 6; i++) {
			await db.query(
				`CREATE retrieval_outcome CONTENT { memory: $mem, cited: true, utilized: true, was_neighbor: false, score: 0.4 };`,
				{ mem: new StringRecordId(assertRecordId(hiUtilId)) }
			);
		}
	}, 60_000);

	afterAll(async () => {
		await db?.close();
		await tdb?.teardown();
	});

	const QUERY = 'how do svelte 5 runes reactive state work';

	it('RERANK_DEFAULT_ENABLED is OFF (ships off by default)', () => {
		expect(RERANK_DEFAULT_ENABLED).toBe(false);
	});

	it('baseline (rerank off): the high-cosine item ranks first; reranked flag is false', async () => {
		const res = await mem.recall(QUERY, { limit: 6 });
		expect(res.reranked).toBe(false);
		expect(res.items[0].id).toBe(hiCosId);
	});

	it('rerank ON but no active weights ⇒ cold-start passthrough (baseline order, reranked false)', async () => {
		const res = await mem.recall(QUERY, { limit: 6, rerank: true });
		expect(res.reranked).toBe(false); // no model trained yet ⇒ honest passthrough
		expect(res.items[0].id).toBe(hiCosId);
	});

	it('rerank ON with utility-heavy weights ⇒ re-orders the SAME set toward the utilized item', async () => {
		const weights: RerankWeights = { cosine: 0, utility: 10, recency: 0, wasNeighbor: 0, bias: 0 };
		const res = await mem.recall(QUERY, { limit: 6, rerank: true, rerankWeights: weights });
		expect(res.reranked).toBe(true);
		// The high-utilization (low-cosine) item is now first — the learned score re-ordered it up.
		expect(res.items[0].id).toBe(hiUtilId);
		// Both items are still present — the reranker RE-ORDERS the candidate set, never drops it.
		expect(res.items.map((i) => i.id)).toContain(hiCosId);
	});

	it('recordOutcomes persists the recall-time feature breakdown (feat_*) for training', async () => {
		const recalled = await mem.recall(QUERY, { limit: 6 });
		await mem.recordOutcomes({ responseText: `using [#1]`, injected: recalled.items });
		const [rows] = await db.query<[Array<{ feat_cosine: number; feat_utility: number; feat_recency: number }>]>(
			`SELECT feat_cosine, feat_utility, feat_recency FROM retrieval_outcome
			  WHERE feat_cosine IS NOT NONE LIMIT 5;`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const r of rows) {
			expect(typeof r.feat_cosine).toBe('number');
			expect(typeof r.feat_utility).toBe('number');
			expect(typeof r.feat_recency).toBe('number');
		}
	});
});
