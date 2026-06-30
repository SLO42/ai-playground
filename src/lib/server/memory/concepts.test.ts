// Stage S3 VERIFY — concept graph CRUD + embedding-dedup + edges + screen-before-embed +
// supersedes, proven against a live throwaway SurrealDB. Plus an m0073-specific idempotency
// proof (apply-twice + over a half-applied bare `concept` table, F-015).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { FakeEmbedder } from './embed';
import {
	storeConcept,
	storeConcepts,
	ConceptCandidateError,
	CONCEPT_DEDUP_COSINE,
	type ConceptStoreOptions
} from './concepts';
import { makeWriteSurface, runReviewFork } from './loop';

let tdb: TestDb;
let db: Db;
let opts: ConceptStoreOptions;

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
	opts = { db, embedder: new FakeEmbedder() };
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown().catch(() => {});
});

beforeEach(async () => {
	await db.query('DELETE concept_edge; DELETE concept; DELETE memory; DELETE session;');
});

async function seedMemory(content: string): Promise<string> {
	const [r] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE memory SET content=$c, kind="semantic", namespace="default", scope="project",
		   embedding=array::repeat(0.0, 1024), importance=5.0, status="active", screen_status="clean" RETURN AFTER;`,
		{ c: content }
	);
	return String(r[0].id);
}

describe('storeConcept — screen-before-embed + CREATE', () => {
	it('persists a fresh concept with a 1024-dim embedding over the SCREENED body', async () => {
		const out = await storeConcept(opts, { label: 'screen-before-embed', summary: 'screen content before it is embedded' });
		expect(out.persisted).toBe(true);
		expect(out.deduped).toBe(false);
		const [rows] = await db.query<[Array<{ embedding: number[]; label: string; namespace: string; screen_status: string }>]>(
			`SELECT embedding, label, namespace, screen_status FROM $id;`,
			{ id: new StringRecordId(out.id) }
		);
		expect(rows[0].embedding).toHaveLength(1024); // 1024-dim via the existing embed path (D-014)
		expect(rows[0].namespace).toBe('default'); // ALWAYS set (F-020 — dedup_key VALUE never sees NONE)
		expect(rows[0].screen_status).toBe('clean');
	});

	it('REDACTS a secret in the summary before embed (raw key never stored)', async () => {
		const out = await storeConcept(opts, { label: 'api wiring', summary: 'use the key sk-ant-abcd1234efgh5678 for auth' });
		expect(out.persisted).toBe(true);
		expect(out.screenStatus).toBe('redacted');
		const [rows] = await db.query<[Array<{ summary: string }>]>(`SELECT summary FROM $id;`, { id: new StringRecordId(out.id) });
		expect(rows[0].summary).not.toContain('sk-ant-abcd1234efgh5678');
		expect(rows[0].summary).toContain('[REDACTED');
	});

	it('does NOT persist a concept whose summary quarantines (poisoned concept never lands)', async () => {
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
		const out = await storeConcept(opts, { label: 'leaked key', summary: pem });
		expect(out.persisted).toBe(false);
		expect(out.screenStatus).toBe('quarantined');
		const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM concept;`);
		expect(rows).toHaveLength(0);
	});

	it('rejects a malformed candidate at the boundary (D-026 named error, no row written)', async () => {
		await expect(storeConcept(opts, { label: '', summary: 'x' })).rejects.toBeInstanceOf(ConceptCandidateError);
		await expect(storeConcept(opts, { label: 'ok', summary: 42 as unknown as string })).rejects.toBeInstanceOf(ConceptCandidateError);
	});
});

describe('storeConcept — embedding dedup (reinforce, do not twin)', () => {
	it('a near-duplicate REINFORCES the existing concept instead of creating a twin', async () => {
		const a = await storeConcept(opts, { label: 'idempotent migrations', summary: 'every migration must be idempotent' });
		const b = await storeConcept(opts, { label: 'idempotent migrations', summary: 'every migration must be idempotent' });
		expect(b.deduped).toBe(true);
		expect(b.id).toBe(a.id); // same concept — no twin minted
		const [rows] = await db.query<[Array<{ id: unknown; access_count: number }>]>(`SELECT id, access_count FROM concept;`);
		expect(rows).toHaveLength(1);
		expect(rows[0].access_count).toBe(1); // bumped on the re-observation
	});

	it('a DISTINCT concept (cosine below the cut) creates a new node', async () => {
		await storeConcept(opts, { label: 'svelte 5 runes', summary: 'use $state and $derived not stores' });
		const b = await storeConcept(opts, { label: 'surrealdb hnsw', summary: 'vector index is 1024-dim cosine' });
		expect(b.deduped).toBe(false);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM concept;`);
		expect(rows).toHaveLength(2);
		expect(CONCEPT_DEDUP_COSINE).toBeGreaterThan(0.9);
	});
});

describe('concept edges — extracted-from (about_concept) + supersedes', () => {
	it('writes an about_concept edge from each extracted-from source memory', async () => {
		const mem = await seedMemory('the build command is npm run build');
		const out = await storeConcept(opts, { label: 'build command', summary: 'npm run build', extractedFrom: [mem] });
		const [edges] = await db.query<[Array<{ in: unknown; out: unknown; kind: string }>]>(
			`SELECT in, out, kind FROM concept_edge;`
		);
		expect(edges).toHaveLength(1);
		expect(edges[0].kind).toBe('about_concept');
		expect(String(edges[0].in)).toBe(mem); // memory → concept (the scene's "extracted-from")
		expect(String(edges[0].out)).toBe(out.id);
	});

	it('a superseding concept marks the older concept superseded + writes a supersedes edge', async () => {
		const old = await storeConcept(opts, { label: 'old decision', summary: 'use approach X' });
		const neu = await storeConcept(opts, { label: 'new decision', summary: 'use approach Y instead', supersedes: old.id });
		const [edges] = await db.query<[Array<{ kind: string; in: unknown; out: unknown }>]>(
			`SELECT kind, in, out FROM concept_edge WHERE kind = "supersedes";`
		);
		expect(edges).toHaveLength(1);
		expect(String(edges[0].in)).toBe(neu.id);
		expect(String(edges[0].out)).toBe(old.id);
		const [rows] = await db.query<[Array<{ status: string; superseded_by: unknown }>]>(
			`SELECT status, superseded_by FROM $id;`,
			{ id: new StringRecordId(old.id) }
		);
		expect(rows[0].status).toBe('superseded');
		expect(String(rows[0].superseded_by)).toBe(neu.id);
	});
});

describe('storeConcepts batch — per-item fallback isolation', () => {
	it('one bad candidate never drops the rest', async () => {
		const out = await storeConcepts(opts, [
			{ label: 'good a', summary: 'first' },
			{ label: '', summary: 'bad — empty label' },
			{ label: 'good b', summary: 'second' }
		]);
		expect(out).toHaveLength(3);
		expect(out[0].persisted).toBe(true);
		expect(out[1].persisted).toBe(false);
		expect(out[2].persisted).toBe(true);
	});
});

describe('runReviewFork — S3 concept mine path on the loop', () => {
	it('mines concepts from a turn through the write surface (screen-before-embed + dedup)', async () => {
		const surface = makeWriteSurface(db, new FakeEmbedder());
		const out = await runReviewFork({
			payload: { kind: 'memory', turnText: 'a turn that teaches a durable concept' },
			surface,
			extract: async () => [],
			extractConcepts: async () => [{ label: 'loop concept', summary: 'extracted on the heartbeat loop' }]
		});
		expect(out.conceptCandidates).toBe(1);
		expect(out.concepts).toHaveLength(1);
		expect(out.concepts[0].persisted).toBe(true);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM concept;`);
		expect(rows).toHaveLength(1);
	});
});

// ── m0073 idempotency (F-015) — apply-twice + over a half-applied bare table ────────────
describe('m0073 concept_graph — idempotent over fresh + half-applied state', () => {
	it('applies the full schema TWICE against a fresh DB (re-run = no-op) and the concept index exists', async () => {
		const t2 = await startTestDb();
		const d2 = await Db.connect({ url: t2.wsUrl, username: t2.root.username, password: t2.root.password, namespace: t2.namespace, database: t2.database });
		try {
			await runMigrations(d2, schemaMigrations);
			const second = await runMigrations(d2, schemaMigrations); // re-run applies nothing new
			expect(second).toEqual([]);
			const [idx] = await d2.query<[{ indexes: Record<string, unknown> }]>(`INFO FOR TABLE concept;`);
			expect(Object.keys(idx.indexes)).toContain('concept_vec');
			expect(Object.keys(idx.indexes)).toContain('concept_dedup');
		} finally {
			await d2.close().catch(() => {});
			await t2.teardown().catch(() => {});
		}
	}, 60_000);

	it('RECOVERS a half-applied bare `concept` table (OVERWRITE re-defines, fields land)', async () => {
		const t3 = await startTestDb();
		const d3 = await Db.connect({ url: t3.wsUrl, username: t3.root.username, password: t3.root.password, namespace: t3.namespace, database: t3.database });
		try {
			// Reproduce a half-applied state: a BARE concept table exists (no fields/index).
			await d3.query('DEFINE TABLE concept SCHEMAFULL;');
			await runMigrations(d3, schemaMigrations); // must apply cleanly OVER the half-applied table
			const [info] = await d3.query<[{ fields: Record<string, unknown> }]>(`INFO FOR TABLE concept;`);
			expect(Object.keys(info.fields)).toContain('embedding');
			expect(Object.keys(info.fields)).toContain('stability');
			// A concept now stores cleanly through the recovered schema.
			const out = await storeConcept({ db: d3, embedder: new FakeEmbedder() }, { label: 'recovered', summary: 'after half-applied' });
			expect(out.persisted).toBe(true);
		} finally {
			await d3.close().catch(() => {});
			await t3.teardown().catch(() => {});
		}
	}, 60_000);
});
