import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, getDb, closeDb } from './client';
import { IdentifierError } from './validate';
import { startTestDb, fixtureVector, type TestDb } from './testserver';

// TASK 0.b VERIFY (client half): a ws:// connection singleton + guarded query
// helper; CRUD + KNN + transaction pass against a throwaway test DB.

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
	// Minimal schema for CRUD + KNN (HNSW exactly per S0 — no M0).
	await db.query(`
		DEFINE TABLE note SCHEMAFULL;
		DEFINE FIELD content   ON note TYPE string;
		DEFINE FIELD embedding ON note TYPE array<float>;
		DEFINE INDEX note_vec ON note FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;
	`);
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await closeDb().catch(() => {});
	await tdb?.teardown();
});

describe('Db.connect — ws:// over loopback', () => {
	it('connected to the per-run namespace/database', () => {
		expect(db.namespace).toBe(tdb.namespace);
		expect(db.database).toBe('main');
		expect(tdb.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
	});
});

describe('CRUD via guarded query ($param binding only)', () => {
	it('creates, reads, updates, and deletes a row with bound values', async () => {
		const created = await db.query<[{ id: unknown }[]]>(
			'CREATE note SET content = $c, embedding = $e;',
			{ c: 'hello world', e: fixtureVector(1) }
		);
		const id = created[0][0].id;
		expect(id).toBeDefined();

		const read = await db.query<[{ content: string }[]]>(
			'SELECT content FROM note WHERE content = $c;',
			{ c: 'hello world' }
		);
		expect(read[0][0].content).toBe('hello world');

		await db.query('UPDATE $id SET content = $c;', { id, c: 'updated' });
		const reread = await db.query<[{ content: string }[]]>('SELECT content FROM $id;', { id });
		expect(reread[0][0].content).toBe('updated');

		await db.query('DELETE $id;', { id });
		const gone = await db.query<[{ n: number }[]]>(
			'SELECT count() AS n FROM note WHERE id = $id GROUP ALL;',
			{ id }
		);
		expect((gone[0][0]?.n ?? 0)).toBe(0);
	});
});

describe('KNN over the HNSW index (fixture 1024-dim vectors)', () => {
	it('returns the K nearest rows ranked by distance', async () => {
		// Seed a small corpus of fixture vectors.
		for (let i = 0; i < 6; i++) {
			await db.query('CREATE note SET content = $c, embedding = $e;', {
				c: `vec-${i}`,
				e: fixtureVector(100 + i)
			});
		}
		// Query nearest to one of the seeded vectors — it should rank itself top.
		const target = fixtureVector(103);
		const knn = await db.query<[{ content: string; dist: number }[]]>(
			'SELECT content, vector::distance::knn() AS dist FROM note WHERE embedding <|3,40|> $q ORDER BY dist;',
			{ q: target }
		);
		const rows = knn[0];
		expect(rows.length).toBe(3);
		expect(typeof rows[0].dist).toBe('number');
		expect(rows[0].content).toBe('vec-3'); // exact match → distance ~0, ranks first
	});
});

describe('transactions (BEGIN/COMMIT and CANCEL rollback)', () => {
	it('COMMIT persists; CANCEL rolls back', async () => {
		const before =
			(await db.query<[{ n: number }[]]>('SELECT count() AS n FROM note GROUP ALL;'))[0][0]?.n ??
			0;

		// CANCELled transaction must not persist.
		await db
			.query('BEGIN; CREATE note SET content = $c, embedding = $e; CANCEL;', {
				c: 'rolled-back',
				e: fixtureVector(9)
			})
			.catch(() => {});
		const afterCancel =
			(await db.query<[{ n: number }[]]>('SELECT count() AS n FROM note GROUP ALL;'))[0][0]?.n ??
			0;
		expect(afterCancel).toBe(before);

		// COMMITted transaction persists.
		await db.query('BEGIN; CREATE note SET content = $c, embedding = $e; COMMIT;', {
			c: 'committed',
			e: fixtureVector(10)
		});
		const afterCommit =
			(await db.query<[{ n: number }[]]>('SELECT count() AS n FROM note GROUP ALL;'))[0][0]?.n ??
			0;
		expect(afterCommit).toBe(before + 1);
	});
});

describe('D-016 guard at the query boundary', () => {
	it('queryTable rejects an unvalidated table name (no injection)', async () => {
		await expect(
			db.queryTable('note; REMOVE TABLE note', (t) => `SELECT * FROM ${t};`)
		).rejects.toBeInstanceOf(IdentifierError);
	});

	it('queryTable runs with a validated table name', async () => {
		const out = await db.queryTable<[{ n: number }[]]>(
			'note',
			(t) => `SELECT count() AS n FROM ${t} GROUP ALL;`
		);
		expect(typeof (out[0][0]?.n ?? 0)).toBe('number');
	});

	it('relate rejects a malformed endpoint record-id', async () => {
		await expect(db.relate('note:a', 'links', 'not a record id')).rejects.toBeInstanceOf(
			IdentifierError
		);
	});
});

describe('process-wide singleton', () => {
	it('initDb / getDb / closeDb lifecycle', async () => {
		const s = await initDb({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		expect(getDb()).toBe(s);
		await expect(
			initDb({
				url: tdb.wsUrl,
				username: tdb.root.username,
				password: tdb.root.password,
				namespace: tdb.namespace,
				database: tdb.database
			})
		).rejects.toThrow(/already initialised/i);
		await closeDb();
		expect(() => getDb()).toThrow(/not initialised/i);
	});
});
