import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { MemoryService, FakeEmbedder, RECALL_BUDGET, estimateTokens, FENCE_OPEN } from './index';

// MEMORY-SPEC §4.3 step 4 (tail-drop "before it reaches the prompt budget") — the RECALL
// INJECTED-SIZE BUDGET, applied AFTER the active-set filter + WMR ranking + novelty gate +
// lineage dedup, BEFORE fencing. This proves (against a REAL throwaway SurrealDB, real rows,
// FakeEmbedder for determinism — F-008 allows a mocked embedder, not fabricated product data):
//
//   (1) budget.maxItems = N returns EXACTLY the top-N by WMR score (the engine's own ranking),
//       in score order — the tail is dropped, never a lower-ranked item kept over a higher one.
//   (2) the quarantine exclusion (B6 active-set filter, upstream in SQL) STILL holds under a
//       tight budget — a tighter budget can only drop already-clean rows, never admit a
//       quarantined one.
//   (3) the token budget tail-drops the low-salience tail; the FIRST item is admitted even if
//       it alone exceeds the token cap (D-024 never-empty-on-large-top-hit), every subsequent
//       item is strictly gated.
//   (4) RECALL_BUDGET is a documented NULL-TUNABLE: passing budget:{} (both null) disables the
//       extra cull and falls back to the `limit` selection bound only.
//   (5) shadow paths: empty store ⇒ honest empty; budget larger than the candidate set is a
//       no-op; maxItems:0 ⇒ honest empty (not a crash).

let tdb: TestDb;
let db: Db;
let projectId: string;
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
	const p = await createProject(db, {
		slug: 'recall_budget',
		name: 'Recall Budget',
		root_path: 'F:/code/recall-budget'
	});
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder() });
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

const QUERY = 'how is the deploy pipeline configured for the dashboard';

// Eight clean, topically-varied rows so the ranker produces a stable strict-ish ordering and
// there are enough candidates for a budget to actually cut a tail.
const CLEAN_ROWS = [
	'the deploy pipeline builds the dashboard with the SvelteKit node adapter',
	'deploy: the dashboard is configured to run db:up before npm run dev',
	'the dashboard deploy uses Tailwind v4 with @theme CSS-first config',
	'pipeline config: SurrealDB starts on port 8000 and dev serves on 5173',
	'the deploy step runs npm run build then svelte-check with zero errors',
	'unrelated note: the cat sat on the mat in the afternoon sun',
	'unrelated: a grocery list with milk eggs bread and coffee beans',
	'unrelated trivia: the tallest mountain above sea level is Everest'
];

describe('§4.3 recall injected-size budget — top-N selection over real SurrealDB', () => {
	beforeAll(async () => {
		const res = await mem.store(CLEAN_ROWS.map((content) => ({ content, project: projectId })));
		// All eight clean rows persist (none hits a DO-NOT-CAPTURE / quarantine gate).
		expect(res.every((r) => r.persisted && r.screenStatus !== 'quarantined')).toBe(true);
	});

	it('exports RECALL_BUDGET as a documented null-tunable (not a locked inline constant)', () => {
		// The tunable is exported so B8 can re-validate it; the starting points are justified,
		// not magic. Both fields are independently nullable.
		expect(RECALL_BUDGET).toHaveProperty('maxItems');
		expect(RECALL_BUDGET).toHaveProperty('maxTokens');
		expect(RECALL_BUDGET.maxItems).toBe(6);
		expect(RECALL_BUDGET.maxTokens).toBe(1500);
	});

	it('Deliverable (1): budget.maxItems = N returns EXACTLY the top-N by score, in score order', async () => {
		// Ground truth: the full ranked order with NO extra item-cap and NO token-cap (large k).
		const full = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: null, maxTokens: null }
		});
		expect(full.items.length).toBeGreaterThanOrEqual(4); // enough candidates to cut a tail
		// Non-increasing score (the ranker output the budget must preserve).
		for (let i = 1; i < full.items.length; i++) {
			expect(full.items[i - 1].score).toBeGreaterThanOrEqual(full.items[i].score);
		}

		for (const n of [1, 2, 3]) {
			const capped = await mem.recall(QUERY, {
				project: projectId,
				k: 50,
				limit: 50,
				budget: { maxItems: n, maxTokens: null }
			});
			// EXACTLY N items …
			expect(capped.items.length).toBe(n);
			// … and they are EXACTLY the top-N of the ground-truth ranking, in the same order
			// (compared by row id — citationIds are re-assigned 1..N post-budget by design).
			expect(capped.items.map((i) => i.id)).toEqual(full.items.slice(0, n).map((i) => i.id));
			// Citation ids stay contiguous 1..N after the tail-drop.
			expect(capped.items.map((i) => i.citationId)).toEqual(
				Array.from({ length: n }, (_, i) => String(i + 1))
			);
			// Still fenced (§10) after budgeting.
			for (const it of capped.items) expect(it.fenced.text).toContain(FENCE_OPEN);
		}
	});

	it('Deliverable (3): the token budget tail-drops the low-salience tail; usedTokens stays within cap', async () => {
		// A tight token budget that admits only a couple of fenced blocks. Each fenced row here
		// is ~80-120 chars ⇒ ~20-30 tokens; cap of 60 admits ~2.
		const tight = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: null, maxTokens: 60 }
		});
		const full = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: null, maxTokens: null }
		});
		// The token cap dropped a tail.
		expect(tight.items.length).toBeGreaterThan(0);
		expect(tight.items.length).toBeLessThan(full.items.length);
		// The admitted set is a TOP-prefix of the ground truth (highest score kept first).
		expect(tight.items.map((i) => i.id)).toEqual(full.items.slice(0, tight.items.length).map((i) => i.id));
		// The summed fenced token cost respects the cap once the first item is in: the LAST
		// admitted item never pushed the running total over the cap unless it was the first.
		let used = 0;
		tight.items.forEach((it, i) => {
			const cost = estimateTokens(it.fenced.text);
			if (i === 0) used += cost; // first item exempt from the cap
			else {
				expect(used + cost).toBeLessThanOrEqual(60); // strictly gated thereafter
				used += cost;
			}
		});
	});

	it('Deliverable (3b/D-024): the FIRST item is admitted even when it alone exceeds the token cap (never empty on a large top hit)', async () => {
		// A cap of 1 token is smaller than any single fenced block. Fail-closed must NOT mean
		// "return nothing" — it means "return only the single highest-ranked item, drop the rest".
		const res = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: null, maxTokens: 1 }
		});
		expect(res.items.length).toBe(1);
		expect(estimateTokens(res.items[0].fenced.text)).toBeGreaterThan(1); // the single item alone is over-cap
	});

	it('Deliverable (4): budget:{} (both null) disables the extra cull — only the `limit` selection bound applies', async () => {
		// With both caps null and a small `limit`, the result is bounded by `limit`, not by the
		// RECALL_BUDGET defaults — proving the null-tunable truly disables the budget stage.
		const res = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 4,
			budget: { maxItems: null, maxTokens: null }
		});
		expect(res.items.length).toBe(4);
	});

	it('budget OFF by default (no `budget` opt) — only the `limit` selection bound applies (null-tunable rail)', async () => {
		// The null-tunable posture: a bare recall is NOT silently re-truncated by an engine-side
		// magic number. With no budget opt and a generous limit, all clean candidates surface.
		const res = await mem.recall(QUERY, { project: projectId, k: 50, limit: 50 });
		expect(res.items.length).toBe(CLEAN_ROWS.length); // all 8 clean rows, no extra cull
	});

	it('budget field fallback: a PRESENT object fills OMITTED fields from RECALL_BUDGET starting points', async () => {
		// `{ maxItems: 3 }` with maxTokens OMITTED ⇒ maxTokens falls back to the 1500 starting
		// point (loose here, so only the item cap bites) → exactly 3 items.
		const res = await mem.recall(QUERY, { project: projectId, k: 50, limit: 50, budget: { maxItems: 3 } });
		expect(res.items.length).toBe(3);
	});

	it('Deliverable (5/shadow): maxItems larger than the candidate set is a no-op; maxItems:0 returns honest empty', async () => {
		const all = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: 9999, maxTokens: null }
		});
		const none = await mem.recall(QUERY, {
			project: projectId,
			k: 50,
			limit: 50,
			budget: { maxItems: 0, maxTokens: null }
		});
		expect(all.items.length).toBeGreaterThan(0); // no-op cull
		expect(none.items.length).toBe(0); // honest empty, not a crash
		expect(none.contextText).toBe('');
	});
});

describe('§4.3 budget × quarantine — the active-set exclusion HOLDS under a tight budget (B6 upstream)', () => {
	let qProjectId: string;
	let qmem: MemoryService;

	// A high-confidence private-key block the screen QUARANTINES, with recall-friendly content
	// that ranks HIGH for the query — so a budget bug that re-admitted it would surface.
	const RAW_SECRET =
		'deploy pipeline signing key for the dashboard prod release\n' +
		'-----BEGIN RSA PRIVATE KEY-----\n' +
		'MIIEowIBAAKCAQEA_BUDGETLEAK_sentinel_keymaterial_must_never_escape\n' +
		'-----END RSA PRIVATE KEY-----';
	const SENTINEL = '_BUDGETLEAK_sentinel_keymaterial_must_never_escape';
	const Q_QUERY = 'deploy pipeline signing key for the dashboard prod release';

	beforeAll(async () => {
		const p = await createProject(db, {
			slug: 'recall_budget_q',
			name: 'Recall Budget Quarantine',
			root_path: 'F:/code/recall-budget-q'
		});
		qProjectId = p.id;
		qmem = new MemoryService({ db, embedder: new FakeEmbedder() });
		// One clean control on-theme + the quarantined secret. The secret is the strongest
		// lexical match for Q_QUERY, so if it could ever be recalled it would rank first.
		const res = await qmem.store([
			{ content: 'deploy pipeline: signing-key rotation policy is documented (control)', project: qProjectId },
			{ content: RAW_SECRET, project: qProjectId }
		]);
		expect(res[1].screenStatus).toBe('quarantined');
	});

	afterAll(async () => {
		if (qProjectId) await deleteProject(db, qProjectId).catch(() => {});
	});

	it('Deliverable (2): under maxItems:1 the single returned item is the CLEAN control, never the quarantined secret', async () => {
		// Tightest possible item budget. The active-set filter ran upstream in SQL, so the
		// quarantined row was never a candidate; the budget then keeps the top clean item.
		const res = await qmem.recall(Q_QUERY, {
			project: qProjectId,
			k: 50,
			limit: 50,
			budget: { maxItems: 1, maxTokens: null }
		});
		expect(res.items.length).toBe(1);
		expect(res.items[0].fenced.text).toContain('(control)');
		expect(res.items[0].fenced.text).not.toContain(SENTINEL);
		expect(res.contextText).not.toContain(SENTINEL);
	});

	it('Deliverable (2b): under a 1-token budget the secret STILL never appears (first-item exemption admits the CLEAN row)', async () => {
		const res = await qmem.recall(Q_QUERY, {
			project: qProjectId,
			k: 50,
			limit: 50,
			budget: { maxItems: null, maxTokens: 1 }
		});
		expect(res.items.length).toBe(1);
		expect(res.items[0].fenced.text).not.toContain(SENTINEL);
		expect(res.items.map((i) => i.fenced.text).join('\n')).toContain('(control)');
	});
});
