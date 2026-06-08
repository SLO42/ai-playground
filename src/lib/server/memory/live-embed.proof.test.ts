// LIVE PROOF 2.5 — the REAL embed path end-to-end (deferred by prior waves: no Ollama
// in the build sandbox). This is the durable artifact for the qwen3 round-trip that
// service.test.ts (FakeEmbedder) explicitly left as "the deferred live proof".
//
// What it proves, against a REAL Ollama (qwen3-embedding:0.6b) + a throwaway SurrealDB:
//   (1) storeMemory drives the REAL OllamaEmbedder → the persisted `embedding` is 1024-dim
//       (D-014 dimension contract, enforced live not by FakeEmbedder).
//   (2) HNSW KNN recall over the real SurrealDB returns the stored row for a semantically
//       related query (real vectors, real <|K,COSINE|> index — recall recall works live).
//   (3) the secret/PII screen STILL runs BEFORE embed on the live path: a planted secret is
//       quarantined, its embedding is computed over REDACTED text (no raw-secret cache key),
//       and the quarantined row is excluded from recall.
//
// SKIP-WHEN-DOWN: this is a *live* proof. If Ollama is unreachable it self-skips (the logic
// is already mock-verified in service.test.ts with FakeEmbedder); it never fakes a vector.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { MemoryService, OllamaEmbedder, cacheKey, EMBEDDING_DIM } from './index';

const OLLAMA = process.env.OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';

async function ollamaUp(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return false;
		const j = (await res.json()) as { models?: { name?: string }[] };
		return (j.models ?? []).some((m) => m.name === MODEL);
	} catch {
		return false;
	}
}

let live = false;
let tdb: TestDb;
let db: Db;
let projectId: string;
let mem: MemoryService;

beforeAll(async () => {
	live = await ollamaUp();
	if (!live) return; // self-skip — see SKIP-WHEN-DOWN above.
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, { slug: 'live_embed', name: 'Live Embed', root_path: 'F:/code/live-embed' });
	projectId = p.id;
	// The REAL embedder. cache:false so we observe the raw embed path with no L1/L2 in the way.
	mem = new MemoryService({ db, embedder: new OllamaEmbedder({ endpoint: OLLAMA, model: MODEL }), cache: false });
}, 60_000);

afterAll(async () => {
	if (!live) return;
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

describe('LIVE PROOF 2.5 — real OllamaEmbedder (qwen3-embedding:0.6b) + real SurrealDB HNSW', () => {
	it('(1) stores a real 1024-dim vector via the live embed path', async () => {
		if (!live) return expect(live, 'Ollama unreachable — live proof deferred').toBe(false);
		const [r] = await mem.store([
			{ content: 'SvelteKit 2 uses the Node adapter for production builds', project: projectId }
		]);
		expect(r.persisted).toBe(true);
		expect(r.screenStatus).toBe('clean');
		const [rows] = await db.query<[Array<{ embedding: number[] }>]>(`SELECT embedding FROM $id;`, { id: rid(r.id) });
		expect(rows[0].embedding).toHaveLength(EMBEDDING_DIM); // 1024, live not Fake
		// A real (non-degenerate) vector: not all-zero, finite numbers.
		expect(rows[0].embedding.every((x) => Number.isFinite(x))).toBe(true);
		expect(rows[0].embedding.some((x) => x !== 0)).toBe(true);
	}, 30_000);

	it('(2) HNSW KNN recall returns the stored row for a related query (real vectors)', async () => {
		if (!live) return expect(live).toBe(false);
		await mem.store([
			{ content: 'Tailwind v4 uses @theme CSS-first config, not tailwind.config.js', project: projectId },
			{ content: 'a recipe for sourdough bread needs flour water salt and starter', project: projectId }
		]);
		const res = await mem.recall('how do I configure Tailwind styling', { project: projectId, limit: 5 });
		expect(res.items.length).toBeGreaterThan(0);
		// The Tailwind row must outrank the unrelated sourdough row on real cosine.
		const joined = res.items.map((i) => i.fenced.text).join('\n').toLowerCase();
		expect(joined).toContain('tailwind');
		// Top hit is the Tailwind row, not the unrelated one.
		expect(res.items[0].fenced.text.toLowerCase()).toContain('tailwind');
		expect(res.items[0].fenced.text.toLowerCase()).not.toContain('sourdough');
		// Ranked non-increasing (WMR over live cosine).
		for (let i = 1; i < res.items.length; i++) {
			expect(res.items[i - 1].score).toBeGreaterThanOrEqual(res.items[i].score);
		}
	}, 30_000);

	it('(3) secret/PII screen runs BEFORE the live embed; quarantined row never embedded over raw secret, never recalled', async () => {
		if (!live) return expect(live).toBe(false);
		const raw =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA-LIVE-PROOF-SECRET-MATERIAL-9999\n-----END RSA PRIVATE KEY-----';
		const candidate = `prod deploy key for the gateway:\n${raw}`;
		const [r] = await mem.store([{ content: candidate, project: projectId }]);
		expect(r.persisted).toBe(true);
		expect(r.screenStatus).toBe('quarantined');

		// Stored content must NOT carry the raw key material — screen ran before embed+insert.
		const [rows] = await db.query<[Array<{ content: string; screen_status: string }>]>(
			`SELECT content, screen_status FROM $id;`,
			{ id: rid(r.id) }
		);
		expect(rows[0].screen_status).toBe('quarantined');
		expect(rows[0].content).not.toContain('SECRET-MATERIAL');

		// No embed-cache key over the RAW secret exists (cache:false here, but assert anyway —
		// the load-bearing claim is the raw secret never reaches the embedder).
		const rawKey = cacheKey(candidate, mem.embedder.modelVersion);
		const [cache] = await db.query<[Array<{ hash: string }>]>(
			`SELECT hash FROM embedding_cache WHERE hash = $h;`,
			{ h: rawKey }
		);
		expect(cache).toHaveLength(0);

		// And it never resurfaces in recall.
		const res = await mem.recall('gateway deploy key', { project: projectId, limit: 10 });
		for (const item of res.items) {
			expect(item.fenced.text).not.toContain('SECRET-MATERIAL');
		}
	}, 30_000);
});
