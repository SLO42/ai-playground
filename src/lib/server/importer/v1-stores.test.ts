import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { FakeEmbedder, EMBEDDING_DIM } from '../memory/embed';
import {
	importGraphState,
	importSwarmMemory,
	importSwarmMemoryFromDb,
	mapSwarmKind,
	mapEdgeKind,
	parseSwarmEmbedding,
	swarmMemoryDedupKey,
	type SwarmMemoryRow,
	type V1GraphState
} from './v1-stores';

// TASK 2.9 VERIFY (IMPLEMENTATION-PLAN §2.9 / DATA-MODEL §6 migration map rows
// `.swarm/memory.db` and `graph-state.json`): the remaining v1 stores import
// IDEMPOTENTLY, and an embedding with dim≠1024 is RE-EMBEDDED to 1024 before insert.
// Verified against a throwaway DB + the FakeEmbedder seam (no live model — F-008).

// A swarm `memory_entries` row carrying a 384-dim embedding (the REAL v1 case: the
// on-disk .swarm/memory.db has 25 rows, all 384-dim). The importer must NOT trust this
// vector — it re-embeds the content to 1024 before insert.
const SWARM_ROWS: SwarmMemoryRow[] = [
	{
		id: 'entry_1772734423668_wnpre',
		key: 'review-2026-03-05',
		namespace: 'reviews',
		content: 'Dashboard review on 2026-03-05. Build PASS.',
		type: 'semantic',
		embedding: JSON.stringify(new Array(384).fill(0.01)),
		embedding_dimensions: 384,
		tags: JSON.stringify(['review', 'dashboard'])
	},
	{
		// a v1 `working` kind — not in the v2 vocab; must be remapped, original kept as tag
		id: 'entry_2',
		key: 'scratch-note',
		namespace: 'default',
		content: 'A working-memory scratch note.',
		type: 'working',
		embedding: null,
		embedding_dimensions: null,
		tags: null
	}
];

const GRAPH: V1GraphState = {
	version: 1,
	nodes: {
		'mem-a': { id: 'mem-a', category: 'claude-memory', confidence: 0.5, accessCount: 0 },
		'mem-b': { id: 'mem-b', category: 'claude-memory', confidence: 0.5, accessCount: 0 },
		'mem-c': { id: 'mem-c', category: 'concept' }
	},
	edges: [
		{ sourceId: 'mem-a', targetId: 'mem-b', type: 'temporal', weight: 0.5 },
		{ sourceId: 'mem-b', targetId: 'mem-c', type: 'supports', weight: 0.9 },
		// dangling target → skipped (no node)
		{ sourceId: 'mem-a', targetId: 'mem-missing', type: 'temporal', weight: 0.1 }
	]
};

let tdb: TestDb;
let db: Db;
const embedder = new FakeEmbedder('fake-1024:test');

async function countMemory(ns: string): Promise<number> {
	const [rows] = await db.query<[{ c: number }[]]>(
		'SELECT count() AS c FROM memory WHERE namespace = $ns GROUP ALL;',
		{ ns }
	);
	return rows.length ? rows[0].c : 0;
}
async function countEntities(type: string): Promise<number> {
	const [rows] = await db.query<[{ c: number }[]]>(
		'SELECT count() AS c FROM entity WHERE type = $t GROUP ALL;',
		{ t: type }
	);
	return rows.length ? rows[0].c : 0;
}
async function countEdges(): Promise<number> {
	const [rows] = await db.query<[{ c: number }[]]>('SELECT count() AS c FROM references GROUP ALL;');
	return rows.length ? rows[0].c : 0;
}

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('v1-stores — pure mappers', () => {
	it('maps v1 swarm kinds onto the v2 memory.kind vocab', () => {
		expect(mapSwarmKind('semantic')).toBe('semantic');
		expect(mapSwarmKind('episodic')).toBe('episodic');
		expect(mapSwarmKind('procedural')).toBe('procedural');
		expect(mapSwarmKind('working')).toBe('procedural');
		expect(mapSwarmKind('pattern')).toBe('semantic');
		expect(mapSwarmKind(undefined)).toBe('semantic');
	});

	it('maps v1 graph edge types onto the references.kind ASSERT vocab', () => {
		expect(mapEdgeKind('supports')).toBe('supports');
		expect(mapEdgeKind('contradicts')).toBe('contradicts');
		expect(mapEdgeKind('mentions')).toBe('mentions');
		expect(mapEdgeKind('derived_from')).toBe('derived_from');
		// unknown v1 types (e.g. claude-flow's "temporal") fall back to relates_to
		expect(mapEdgeKind('temporal')).toBe('relates_to');
		expect(mapEdgeKind(undefined)).toBe('relates_to');
	});

	it('parses a JSON-string embedding and reports a dim mismatch', () => {
		const ok = parseSwarmEmbedding(JSON.stringify([1, 2, 3]));
		expect(ok).toEqual([1, 2, 3]);
		expect(parseSwarmEmbedding(null)).toBeNull();
		expect(parseSwarmEmbedding('not-json')).toBeNull();
	});

	it('derives a deterministic swarm dedup key', () => {
		const a = swarmMemoryDedupKey('reviews', 'review-2026-03-05');
		expect(a).toBe(swarmMemoryDedupKey('reviews', 'review-2026-03-05'));
		expect(a).not.toBe(swarmMemoryDedupKey('reviews', 'other'));
	});
});

describe('v1-stores — .swarm/memory.db → memory (RE-EMBED if dim≠1024)', () => {
	it('re-embeds a 384-dim row to 1024 before insert', async () => {
		const before = embedder.embedCalls;
		const res = await importSwarmMemory({ db, embedder }, SWARM_ROWS);
		expect(res.imported).toBe(2);
		// Both rows re-embedded: the 384-dim one (mismatch) AND the null-embedding one.
		expect(res.reEmbedded).toBe(2);
		expect(embedder.embedCalls).toBe(before + 2);

		const [rows] = await db.query<
			[Array<{ embedding: number[]; kind: string; tags: string[]; source: string }>]
		>('SELECT embedding, kind, tags, source FROM memory WHERE namespace = $ns;', {
			ns: 'reviews'
		});
		expect(rows.length).toBe(1);
		// The persisted vector is 1024-dim — NOT the original 384.
		expect(rows[0].embedding.length).toBe(EMBEDDING_DIM);
		expect(rows[0].kind).toBe('semantic');
		expect(rows[0].source).toBe('swarm-memory');
	});

	it('remaps a v1 `working` kind and keeps the original as a tag', async () => {
		const [rows] = await db.query<[Array<{ kind: string; tags: string[] }>]>(
			'SELECT kind, tags FROM memory WHERE namespace = "default" AND key = "swarm:scratch-note";'
		);
		expect(rows.length).toBe(1);
		expect(rows[0].kind).toBe('procedural');
		expect(rows[0].tags).toContain('v1-kind:working');
	});

	it('re-importing the SAME swarm rows produces no duplicate rows (idempotent)', async () => {
		const reviewsBefore = await countMemory('reviews');
		const defaultBefore = await countMemory('default');
		const res = await importSwarmMemory({ db, embedder }, SWARM_ROWS);
		// All rows already present → none newly imported.
		expect(res.imported).toBe(0);
		expect(res.skipped).toBe(2);
		expect(await countMemory('reviews')).toBe(reviewsBefore);
		expect(await countMemory('default')).toBe(defaultBefore);
	});
});

// D-026 / wave-v2.2b-e — storeMemory's WIDENED throwing surface (assertCandidateShape now
// throws a named MemoryCandidateFieldError on empty/whitespace content + any malformed
// schema-constrained field). The importer calls storeMemory ONE row at a time, so an
// un-isolated throw would abort the WHOLE migration on a single junk legacy row. v1's
// `.swarm/memory.db` schema is `content TEXT NOT NULL` — which PERMITS the empty string —
// so a real legacy DB can contain an empty-content row the v2 non-empty contract rejects.
// SUCCESS BAR: the junk row is ISOLATED (counted in `dropped`), the VALID rows in the SAME
// batch still import, and the import does NOT throw (no batch-abort, F-008 honest counts).
describe('v1-stores — a malformed legacy row is ISOLATED, never aborts the batch (D-026)', () => {
	it('an empty/whitespace-content row is dropped while the valid rows in the same batch import', async () => {
		const rows: SwarmMemoryRow[] = [
			{ id: 'iso_good_1', key: 'iso-good-1', namespace: 'isolate', content: 'A durable fact about widgets.', type: 'semantic' },
			// empty after trim — v1 `content TEXT NOT NULL` permits '   '; v2 non-empty rejects it.
			{ id: 'iso_empty', key: 'iso-empty', namespace: 'isolate', content: '   ', type: 'semantic' },
			{ id: 'iso_good_2', key: 'iso-good-2', namespace: 'isolate', content: 'Another durable fact.', type: 'episodic' }
		];

		// MUST NOT throw — the bad row is isolated, not fatal.
		const res = await importSwarmMemory({ db, embedder }, rows);
		expect(res.imported).toBe(2); // both valid rows persisted
		expect(res.dropped).toBe(1); // the empty-content row counted as a named drop

		// Live read-back (F-008): the two valid rows are really in the DB; the junk one is not.
		expect(await countMemory('isolate')).toBe(2);
		const [present] = await db.query<[Array<{ key: string }>]>(
			'SELECT key FROM memory WHERE namespace = "isolate";'
		);
		const keys = present.map((r) => r.key).sort();
		expect(keys).toEqual(['swarm:iso-good-1', 'swarm:iso-good-2']);
	});

	it('a malformed non-content field (e.g. empty-after-trim) is also isolated, valid rows survive', async () => {
		// Empty-string content is the schema-constrained field most reachable from real v1 data;
		// prove a second now-rejected shape in the SAME batch ALSO isolates rather than aborting.
		const rows: SwarmMemoryRow[] = [
			{ id: 'iso2_good', key: 'iso2-good', namespace: 'isolate2', content: 'Valid content survives.', type: 'semantic' },
			{ id: 'iso2_bad', key: 'iso2-bad', namespace: 'isolate2', content: '', type: 'semantic' }
		];
		const res = await importSwarmMemory({ db, embedder }, rows);
		expect(res.imported).toBe(1);
		expect(res.dropped).toBe(1);
		expect(await countMemory('isolate2')).toBe(1);
	});

	it('a REAL fault (not a candidate rejection) still propagates — failures are not swallowed (F-008)', async () => {
		// A throwing embedder is a genuine infra fault, NOT a malformed candidate. It must NOT be
		// absorbed into the per-row drop path — it propagates so the import surfaces the failure.
		const boomEmbedder = {
			embed: () => Promise.reject(new Error('embedder offline'))
		} as unknown as typeof embedder;
		const rows: SwarmMemoryRow[] = [
			{ id: 'iso3', key: 'iso3', namespace: 'isolate3', content: 'Triggers a real embedder fault.', type: 'semantic' }
		];
		await expect(importSwarmMemory({ db, embedder: boomEmbedder }, rows)).rejects.toThrow('embedder offline');
	});
});

describe('v1-stores — graph-state.json → entity + references', () => {
	it('imports nodes as entities and edges as references (mapped kind)', async () => {
		const res = await importGraphState(db, GRAPH);
		expect(res.entities).toBe(3);
		// 2 valid edges; the dangling one (mem-missing) is skipped.
		expect(res.edges).toBe(2);
		expect(res.skippedEdges).toBe(1);

		const [edges] = await db.query<[Array<{ kind: string }>]>('SELECT kind FROM references;');
		const kinds = edges.map((e) => e.kind).sort();
		// "temporal" → relates_to; "supports" → supports.
		expect(kinds).toEqual(['relates_to', 'supports']);
		expect(await countEntities('graph-node')).toBe(3);
	});

	it('re-importing the SAME graph is idempotent (no twin nodes or edges)', async () => {
		const e = await countEntities('graph-node');
		const r = await countEdges();
		const res = await importGraphState(db, GRAPH);
		expect(res.entities).toBe(3);
		expect(res.edges).toBe(0); // edges already exist
		expect(await countEntities('graph-node')).toBe(e);
		expect(await countEdges()).toBe(r);
	});
});

describe('v1-stores — filesystem edge reads a real node:sqlite memory.db', () => {
	it('reads memory_entries from a sqlite file and re-embeds to 1024', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'swarm-import-'));
		const dbPath = join(dir, 'memory.db');
		const sq = new DatabaseSync(dbPath);
		sq.exec(`CREATE TABLE memory_entries (
			id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default',
			content TEXT NOT NULL, type TEXT, embedding TEXT, embedding_model TEXT,
			embedding_dimensions INTEGER, tags TEXT, metadata TEXT, owner_id TEXT,
			created_at INTEGER, updated_at INTEGER, status TEXT DEFAULT 'active'
		);`);
		sq.prepare(
			`INSERT INTO memory_entries (id,key,namespace,content,type,embedding,embedding_dimensions,tags,status)
			 VALUES (?,?,?,?,?,?,?,?,?)`
		).run(
			'fs_1',
			'fs-note',
			'fsns',
			'A filesystem-read swarm note.',
			'semantic',
			JSON.stringify(new Array(384).fill(0.02)),
			384,
			JSON.stringify(['fs']),
			'active'
		);
		sq.close();
		try {
			const res = await importSwarmMemoryFromDb({ db, embedder }, dbPath);
			expect(res.imported).toBe(1);
			expect(res.reEmbedded).toBe(1);
			const [rows] = await db.query<[Array<{ embedding: number[] }>]>(
				'SELECT embedding FROM memory WHERE namespace = "fsns";'
			);
			expect(rows[0].embedding.length).toBe(EMBEDDING_DIM);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads a graph-state.json from disk (filesystem edge)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'graph-import-'));
		const path = join(dir, 'graph-state.json');
		const g: V1GraphState = {
			version: 1,
			nodes: { 'fs-node': { id: 'fs-node', category: 'fs' } },
			edges: []
		};
		writeFileSync(path, JSON.stringify(g), 'utf8');
		try {
			const { importGraphStateFromFile } = await import('./v1-stores');
			const res = await importGraphStateFromFile(db, path);
			expect(res.entities).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// TASK 13.5 finding 3 — mirror of the bridge.ts audit: the derived graph edge id is
// interpolated into SurrealQL, so it must pass the D-016 chokepoint (assertRecordId).
// Source-level audit (the digest id always validates, so behavior cannot distinguish);
// FAILS if the chokepoint call is removed from the interpolation site.
describe('relateUnique — D-016 chokepoint on the interpolated edge id (13.5 finding 3)', () => {
	it('passes graphEdgeId() output through assertRecordId before interpolation', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const src = readFileSync(fileURLToPath(new URL('./v1-stores.ts', import.meta.url)), 'utf8');
		expect(src).toMatch(/assertRecordId\(graphEdgeId\(/);
		expect(src).not.toMatch(/const eid = graphEdgeId\(/);
	});
});
