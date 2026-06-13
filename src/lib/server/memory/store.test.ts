import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { FakeEmbedder } from './embed';
import {
	storeMemory,
	storeMemories,
	extractAndStore,
	MemoryCandidateShapeError,
	MemoryProvenanceShapeError,
	type ExtractFn,
	type MemoryCandidate,
	type StoreOptions
} from './store';

// TASK (RT follow-up, wave-v2.2b-c deferral ledger) — the two D-026 sibling seams in store.ts,
// the same untrusted-extractor-input class T1 fixed in loop.ts runReviewFork, one module over.
// Against a LIVE throwaway SurrealDB with the real §4 schema (D-038 integration); the embedder is
// the deterministic FakeEmbedder (no Ollama in this sandbox); the extractor is the injected
// `extract` seam (a mock in a TEST is allowed, F-008).
//
// Two seams, both untrusted-extractor-output trust boundaries (D-026):
//   (1) PROVENANCE shape — storeMemory → link()/assertRecordId trusted c.project / c.session SHAPE.
//       isMemoryCandidate validates only `content`, so a non-string provenance field survives the
//       extract boundary. Must fail with a NAMED MemoryProvenanceShapeError at the store boundary,
//       BEFORE screen/embed/link — never a generic IdentifierError mid-pipeline, never silent omit.
//   (2) ARRAY + per-ELEMENT shape — extractAndStore: the injected extractor return's array wrapper
//       and per-element shape are untrusted. A non-array / null element / primitive element must
//       fail NAMED (MemoryCandidateShapeError) BEFORE the provenance spread — no partial write.
//
// D-038 proof obligations: a non-array, a null element, and a non-string provenance each yield a
// NAMED error with NO partial write (memory count unchanged across the throwing call).

let tdb: TestDb;
let db: Db;
let projectId: string;
let sessionId: string;
let opts: StoreOptions;

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
	const p = await createProject(db, { slug: 'store_demo', name: 'Store Demo', root_path: 'F:/code/store-demo' });
	projectId = p.id;
	sessionId = await makeSession();
	opts = { db, embedder: new FakeEmbedder() };
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

// ── happy path — a well-shaped candidate persists with string provenance stamped ──────
describe('storeMemory — happy path (well-shaped candidate)', () => {
	it('persists a candidate and stamps string project/session provenance', async () => {
		const out = await storeMemory(opts, {
			content: 'the build command is npm run build',
			project: projectId,
			session: sessionId
		});
		expect(out.persisted).toBe(true);
		expect(out.screenStatus).toBe('clean');
		const [rows] = await db.query<[Array<{ project: unknown; session: unknown; embedding: number[] }>]>(
			`SELECT project, session, embedding FROM $id;`,
			{ id: rid(out.id) }
		);
		expect(String(rows[0].project)).toBe(projectId);
		expect(String(rows[0].session)).toBe(sessionId);
		expect(rows[0].embedding).toHaveLength(1024);
	});

	it('omits absent provenance (undefined) without error — provenance is optional', async () => {
		const out = await storeMemory(opts, { content: 'SvelteKit 2 uses Svelte 5 runes' });
		expect(out.persisted).toBe(true);
		const [rows] = await db.query<[Array<{ project: unknown; session: unknown }>]>(
			`SELECT project, session FROM $id;`,
			{ id: rid(out.id) }
		);
		// Absent optionals are NONE (null) — never a fabricated value (F-008 / §6.1).
		expect(rows[0].project ?? null).toBeNull();
		expect(rows[0].session ?? null).toBeNull();
	});
});

// ── SEAM 1 — provenance shape (D-026 MemoryProvenanceShapeError) ───────────────────────
describe('SEAM 1 — storeMemory rejects a non-string PROVENANCE shape with a NAMED error (D-026)', () => {
	// REPRO (pre-fix): a TRUTHY non-string project (42 / {} / []) threw a generic D-016
	// IdentifierError deep in the CONTENT build (AFTER screen + embed); a FALSY non-string
	// (false / 0) was silently treated as absent by the `c.project ?` ternary and OMITTED.
	// Both are now a NAMED MemoryProvenanceShapeError raised at the store boundary, no write.

	it('a number project throws MemoryProvenanceShapeError BEFORE any write (no partial row)', async () => {
		const before = await countMemories();
		const bad = { content: 'ok', project: 42 } as unknown as MemoryCandidate;
		await expect(storeMemory(opts, bad)).rejects.toBeInstanceOf(MemoryProvenanceShapeError);
		await storeMemory(opts, bad).catch((err: MemoryProvenanceShapeError) => {
			expect(err.field).toBe('project');
			expect(err.received).toBe('number');
			expect(err.message).toContain('D-026');
		});
		expect(await countMemories()).toBe(before); // NO partial write
	});

	it('an object session throws MemoryProvenanceShapeError naming the `session` field', async () => {
		const bad = { content: 'ok', session: { table: 'session', id: 'x' } } as unknown as MemoryCandidate;
		await storeMemory(opts, bad).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(MemoryProvenanceShapeError);
				expect((err as MemoryProvenanceShapeError).field).toBe('session');
				expect((err as MemoryProvenanceShapeError).received).toBe('object');
			}
		);
	});

	it('a FALSY non-string provenance (false) ALSO throws NAMED — not silently omitted (F-008)', async () => {
		const before = await countMemories();
		const bad = { content: 'ok', project: false } as unknown as MemoryCandidate;
		await expect(storeMemory(opts, bad)).rejects.toBeInstanceOf(MemoryProvenanceShapeError);
		expect(await countMemories()).toBe(before); // not silently written without provenance
	});

	it('rejection happens BEFORE embed — the embedder is never called on a bad-provenance candidate', async () => {
		const spyEmbedder = new FakeEmbedder(); // FakeEmbedder counts its own .embed() calls
		const bad = { content: 'ok', project: ['array'] } as unknown as MemoryCandidate;
		await expect(storeMemory({ db, embedder: spyEmbedder }, bad)).rejects.toBeInstanceOf(MemoryProvenanceShapeError);
		expect(spyEmbedder.embedCalls).toBe(0); // boundary guard runs BEFORE screen/embed/link
	});

	it('storeMemories isolates a bad-provenance candidate (NAMED dropReason) without dropping the rest', async () => {
		const before = await countMemories();
		const out = await storeMemories(opts, [
			{ content: 'good one', project: projectId },
			{ content: 'bad provenance', project: 99 } as unknown as MemoryCandidate,
			{ content: 'good two' }
		]);
		expect(out[0].persisted).toBe(true);
		expect(out[1].persisted).toBe(false);
		expect(out[1].dropReason).toContain('MemoryProvenanceShapeError'); // attributed by NAME, not "insert-failed"
		expect(out[2].persisted).toBe(true);
		// Exactly the two good candidates were written — the bad one wrote nothing.
		expect(await countMemories()).toBe(before + 2);
	});
});

// ── SEAM 2 — array + per-element shape (D-026 MemoryCandidateShapeError) ───────────────
describe('SEAM 2 — extractAndStore shape-validates the untrusted extractor return (D-026)', () => {
	// REPRO (pre-fix): a non-array return threw `TypeError: candidates.map is not a function`; a
	// null element threw `TypeError: Cannot read properties of null (reading 'project')`; a
	// primitive element spread into a content-less garbage candidate (silent corruption). All
	// three now fail NAMED at the boundary, BEFORE the provenance spread — no partial write.

	const input = { turnText: 'a turn body' };

	it('a NON-ARRAY return throws MemoryCandidateShapeError with no partial write', async () => {
		const before = await countMemories();
		const badExtract = (async () => ({ not: 'an array' })) as unknown as ExtractFn;
		await expect(extractAndStore({ ...opts, extract: badExtract }, input)).rejects.toBeInstanceOf(
			MemoryCandidateShapeError
		);
		await extractAndStore({ ...opts, extract: badExtract }, input).catch((err: MemoryCandidateShapeError) => {
			expect(err.received).toBe('object');
			expect(err.elementIndex).toBeUndefined();
			expect(err.message).toContain('non-array');
		});
		expect(await countMemories()).toBe(before); // NO partial write
	});

	it('a null return (not just non-array object) is NAMED (received "null") — not "map is not a function"', async () => {
		const nullExtract = (async () => null) as unknown as ExtractFn;
		await extractAndStore({ ...opts, extract: nullExtract }, input).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(MemoryCandidateShapeError);
				expect((err as MemoryCandidateShapeError).received).toBe('null');
			}
		);
	});

	it('a NULL ELEMENT inside a valid array throws NAMED with its index — no partial write', async () => {
		const before = await countMemories();
		const badExtract = (async () => [{ content: 'good' }, null]) as unknown as ExtractFn;
		await extractAndStore({ ...opts, extract: badExtract }, input).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(MemoryCandidateShapeError);
				expect((err as MemoryCandidateShapeError).elementIndex).toBe(1);
				expect((err as MemoryCandidateShapeError).received).toBe('null');
			}
		);
		// The whole batch is rejected BEFORE any storeMemory call — the valid [0] never wrote.
		expect(await countMemories()).toBe(before);
	});

	it('a PRIMITIVE ELEMENT (number) throws NAMED — not silently spread into a content-less row', async () => {
		const before = await countMemories();
		const badExtract = (async () => [42]) as unknown as ExtractFn;
		await expect(extractAndStore({ ...opts, extract: badExtract }, input)).rejects.toBeInstanceOf(
			MemoryCandidateShapeError
		);
		await extractAndStore({ ...opts, extract: badExtract }, input).catch((err: MemoryCandidateShapeError) => {
			expect(err.elementIndex).toBe(0);
			expect(err.received).toBe('number');
		});
		expect(await countMemories()).toBe(before);
	});

	it('an object ELEMENT missing the string `content` field throws NAMED', async () => {
		const badExtract = (async () => [{ kind: 'semantic' }]) as unknown as ExtractFn;
		await extractAndStore({ ...opts, extract: badExtract }, input).then(
			() => {
				throw new Error('expected throw');
			},
			(err) => {
				expect(err).toBeInstanceOf(MemoryCandidateShapeError);
				expect((err as MemoryCandidateShapeError).elementIndex).toBe(0);
				expect((err as MemoryCandidateShapeError).received).toBe('object');
			}
		);
	});

	it('happy path — a valid array of well-shaped candidates stores and carries fork provenance', async () => {
		const extract: ExtractFn = async () => [{ content: 'reuse db/validate.ts at the boundary' }];
		const out = await extractAndStore(
			{ ...opts, extract },
			{ turnText: 'x', project: projectId, session: sessionId }
		);
		expect(out).toHaveLength(1);
		expect(out[0].persisted).toBe(true);
		const [rows] = await db.query<[Array<{ project: unknown; session: unknown }>]>(
			`SELECT project, session FROM $id;`,
			{ id: rid(out[0].id) }
		);
		expect(String(rows[0].project)).toBe(projectId);
		expect(String(rows[0].session)).toBe(sessionId);
	});

	it('shadow path — an empty array return writes nothing and returns []', async () => {
		const before = await countMemories();
		const empty: ExtractFn = async () => [];
		const out = await extractAndStore({ ...opts, extract: empty }, input);
		expect(out).toEqual([]);
		expect(await countMemories()).toBe(before);
	});
});

// ── helpers ────────────────────────────────────────────────────────────────────────
function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

async function countMemories(): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM memory GROUP ALL;`);
	return rows[0]?.c ?? 0;
}

async function makeSession(): Promise<string> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT {
		   kind: "task", model: { provider: "claude", model_id: "claude-opus-4-8" }, runtime: "claude-code"
		 } RETURN AFTER;`
	);
	return String(rows[0].id);
}
