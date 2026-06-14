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
	MemoryCandidateFieldError,
	type ExtractFn,
	type MemoryCandidate,
	type StoreOptions
} from './store';

// TASK (wave-v2.2b-e, error-learning architectural-smell escalation) — close the ENTIRE
// untrusted-extractor-output shape class in store.ts in ONE structural move. Prior waves guarded
// SOME fields (content, then project/session); the red-team immediately reproduced the SAME class on
// the NEXT schema field (kind/tags/importance) as a generic SurrealDB type error at CREATE. The fix
// is the LAYER: `assertCandidateShape` validates the FULL `memory` schema contract ONCE at the store
// boundary, raising ONE named MemoryCandidateFieldError. Against a LIVE throwaway SurrealDB with the
// real §4 schema (D-038 integration); the embedder is the deterministic FakeEmbedder (no Ollama in
// this sandbox); the extractor is the injected `extract` seam (a mock in a TEST is allowed, F-008).
//
// Two seams, both untrusted-extractor-output trust boundaries (D-026):
//   (1) FULL candidate shape — storeMemory → assertCandidateShape validates EVERY schema-constrained
//       LLM-authored field (content/project/session/kind/namespace/key/tags/source/importance). A
//       malformed value in ANY of them must fail with a NAMED MemoryCandidateFieldError at the store
//       boundary, BEFORE screen/embed/link/CREATE — never a generic SurrealDB type error at CREATE,
//       never a silent omit (F-008). The class is CLOSED, not the next field.
//   (2) ARRAY + per-ELEMENT shape — extractAndStore: the injected extractor return's array wrapper
//       and per-element shape are untrusted. A non-array / null element / primitive element must
//       fail NAMED (MemoryCandidateShapeError) BEFORE the provenance spread — no partial write.
//
// D-038 proof obligations: a malformed value in EACH schema-constrained field yields its NAMED error
// with countMemories() unchanged, and a fully-valid candidate still stores.

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

// ── SEAM 1 — FULL candidate shape (D-026 MemoryCandidateFieldError), the CLOSED class ──
describe('SEAM 1 — storeMemory rejects a malformed value in ANY schema-constrained field (D-026)', () => {
	// REPRO (pre-fix, the recurring class): a TRUTHY non-string project threw a generic D-016
	// IdentifierError deep in the CONTENT build; a FALSY non-string was silently OMITTED; and the
	// red-team's NEXT-field probes (kind=42, tags=non-array, importance="hot") reached CREATE and
	// died as a generic SurrealDB type error ("Found 42 for field kind … expected a string").
	// All now fail with ONE NAMED MemoryCandidateFieldError at the store boundary, no write.

	// ── per-field regression matrix: malformed value in EACH schema-constrained field → NAMED
	//    MemoryCandidateFieldError, countMemories() unchanged (the D-038 "class is CLOSED" proof) ──
	const malformed: Array<{ name: string; field: string; received: string; candidate: unknown }> = [
		{ name: 'content (number, not a string)', field: 'content', received: 'number', candidate: { content: 42 } },
		{ name: 'content (empty string)', field: 'content', received: 'empty string', candidate: { content: '   ' } },
		{ name: 'project (number)', field: 'project', received: 'number', candidate: { content: 'ok', project: 42 } },
		{ name: 'project (FALSY non-string false — not silently omitted, F-008)', field: 'project', received: 'boolean', candidate: { content: 'ok', project: false } },
		{ name: 'session (object)', field: 'session', received: 'object', candidate: { content: 'ok', session: { table: 's', id: 'x' } } },
		{ name: 'kind (number — the red-team repro)', field: 'kind', received: 'number', candidate: { content: 'ok', kind: 42 } },
		{ name: 'kind (string outside the ASSERT set)', field: 'kind', received: '"wisdom"', candidate: { content: 'ok', kind: 'wisdom' } },
		{ name: 'namespace (number)', field: 'namespace', received: 'number', candidate: { content: 'ok', namespace: 7 } },
		{ name: 'namespace (empty string)', field: 'namespace', received: 'empty string', candidate: { content: 'ok', namespace: '' } },
		{ name: 'key (number)', field: 'key', received: 'number', candidate: { content: 'ok', key: 7 } },
		{ name: 'source (object)', field: 'source', received: 'object', candidate: { content: 'ok', source: {} } },
		{ name: 'tags (non-array string — the red-team repro)', field: 'tags', received: 'string', candidate: { content: 'ok', tags: 'a,b' } },
		{ name: 'tags (array with a non-string element)', field: 'tags[1]', received: 'number', candidate: { content: 'ok', tags: ['a', 2] } },
		{ name: 'importance (string — the red-team repro)', field: 'importance', received: 'string', candidate: { content: 'ok', importance: 'hot' } },
		{ name: 'importance (NaN)', field: 'importance', received: 'number', candidate: { content: 'ok', importance: NaN } },
		{ name: 'importance (out of [0,10] range)', field: 'importance', received: '99', candidate: { content: 'ok', importance: 99 } }
	];

	for (const m of malformed) {
		it(`rejects malformed ${m.name} with a NAMED error (field=${m.field}), no partial write`, async () => {
			const before = await countMemories();
			const bad = m.candidate as unknown as MemoryCandidate;
			await expect(storeMemory(opts, bad)).rejects.toBeInstanceOf(MemoryCandidateFieldError);
			await storeMemory(opts, bad).catch((err: MemoryCandidateFieldError) => {
				expect(err).toBeInstanceOf(MemoryCandidateFieldError);
				expect(err.field).toBe(m.field);
				expect(err.received).toBe(m.received);
				expect(err.message).toContain('D-026');
			});
			expect(await countMemories()).toBe(before); // NO partial write — the class is CLOSED
		});
	}

	it('rejection happens BEFORE embed — the embedder is never called on a malformed candidate', async () => {
		const spyEmbedder = new FakeEmbedder(); // FakeEmbedder counts its own .embed() calls
		const bad = { content: 'ok', tags: 'not-an-array' } as unknown as MemoryCandidate;
		await expect(storeMemory({ db, embedder: spyEmbedder }, bad)).rejects.toBeInstanceOf(MemoryCandidateFieldError);
		expect(spyEmbedder.embedCalls).toBe(0); // boundary guard runs BEFORE screen/embed/link
	});

	it('a fully-valid candidate with EVERY constrained field set still stores', async () => {
		const before = await countMemories();
		const out = await storeMemory(opts, {
			content: 'use $param binding at the SurrealDB boundary',
			project: projectId,
			session: sessionId,
			kind: 'procedural',
			namespace: 'rules',
			key: `k_${Date.now()}`,
			tags: ['db', 'boundary'],
			source: 'extractor',
			importance: 8
		});
		expect(out.persisted).toBe(true);
		expect(await countMemories()).toBe(before + 1);
	});

	it('storeMemories isolates a malformed candidate (NAMED dropReason) without dropping the rest', async () => {
		const before = await countMemories();
		const out = await storeMemories(opts, [
			{ content: 'good one', project: projectId },
			{ content: 'bad kind', kind: 42 } as unknown as MemoryCandidate,
			{ content: 'good two' }
		]);
		expect(out[0].persisted).toBe(true);
		expect(out[1].persisted).toBe(false);
		expect(out[1].dropReason).toContain('MemoryCandidateFieldError'); // attributed by NAME, not "insert-failed"
		expect(out[2].persisted).toBe(true);
		// Exactly the two good candidates were written — the bad one wrote nothing.
		expect(await countMemories()).toBe(before + 2);
	});

	it('a SurrealDB CREATE error reason is sanitized — no `memory:<id>` record id leaks into the audit drop reason', async () => {
		// Force an insert-time failure (UNIQUE dedup clash) so the captured SurrealDB message can carry
		// the un-persisted row's internal `memory:<id>`; the dropReason must redact it (field name only).
		const ns = 'dropreason_probe';
		const key = `dup_${Date.now()}`;
		const first = await storeMemory(opts, { content: 'first', namespace: ns, key });
		expect(first.persisted).toBe(true);
		const out = await storeMemories(opts, [{ content: 'dup', namespace: ns, key }]);
		expect(out[0].persisted).toBe(false);
		// Whatever the underlying message, the audit reason must carry NO raw record id — any
		// `memory:<token>` must have been redacted to the literal sentinel `memory:<redacted>`.
		const reason = out[0].dropReason ?? '';
		expect(reason.replace(/memory:<redacted>/g, '')).not.toMatch(/\bmemory:[A-Za-z0-9_⟨⟩-]+/);
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
