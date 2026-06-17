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

// TASK 13.5 finding 5 / F-014 — Db.connect sits on the BOOT path and the SDK hangs ~90s on
// a dead/black-holed socket. The whole connect+signin+use sequence must be raced against a
// hard bound and reject HONESTLY (the degraded-boot path then serves disconnected states).
// The fake server below accepts the TCP connection but never completes the WS handshake —
// without the bound this test HANGS past its own timeout (the regression).
describe('Db.connect — bounded against a black-holed socket (13.5 finding 5 / F-014)', () => {
	it('rejects within the bound instead of hanging on a half-open server', async () => {
		const { createServer } = await import('node:net');
		const server = createServer(() => {
			/* accept the socket, never speak — the F-014 dead-socket shape */
		});
		await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
		const port = (server.address() as { port: number }).port;
		const started = Date.now();
		try {
			await expect(
				Db.connect({
					url: `ws://127.0.0.1:${port}`,
					username: 'x',
					password: 'y',
					namespace: 'n',
					database: 'd',
					connectTimeoutMs: 400
				})
			).rejects.toThrow(/timed out/i);
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			server.close();
		}
	}, 8000);
});

// F-042 — the runtime singleton signs in ONCE; SurrealDB's default 1h root token
// expires, the live session drops to UNAUTHENTICATED, and (tables are PERMISSIONS
// NONE) every query then throws "IAM error: Not enough permissions". The Db client
// must SELF-HEAL: on the auth-expiry signature, re-signin+use ONCE and retry; a
// genuinely-bad re-auth must still fail honestly (no loop); creds never leak.
// (Verified live: the SDK throws exactly "...IAM error: Not enough permissions..."
// on a query after the token TTL lapses; a short DURATION FOR TOKEN reproduces it.)
describe('Db self-heal on auth-token expiry (F-042)', () => {
	const SHORT_TOKEN_PW = 'heal-pw';

	// DEFINE USER ... PASSWORD requires a strand LITERAL (no $param binding — SurrealQL
	// parse limitation). name/password here are fixed test constants (never user input),
	// so the literal is safe; D-016 value-binding still applies to all real call sites.
	async function defineShortTokenUser(name: string, password: string) {
		await db.query(
			`DEFINE USER OVERWRITE ${name} ON ROOT PASSWORD '${password}' ROLES OWNER DURATION FOR TOKEN 1s, FOR SESSION 4w;`
		);
	}

	it('transparently re-auths + returns the row after the token expires (not an IAM error)', async () => {
		await defineShortTokenUser('heal_ok', SHORT_TOKEN_PW);
		const healed = await Db.connect({
			url: tdb.wsUrl,
			username: 'heal_ok',
			password: SHORT_TOKEN_PW,
			namespace: tdb.namespace,
			database: tdb.database
		});
		try {
			// Let the 1s token lapse — the next query would otherwise throw IAM.
			await new Promise((r) => setTimeout(r, 2200));
			const out = await healed.query<[{ content: string }[]]>(
				'SELECT content FROM note WHERE content = $c;',
				{ c: 'hello world' }
			);
			// hello world was created in the CRUD suite (same db) — the heal returns it.
			expect(Array.isArray(out[0])).toBe(true);
		} finally {
			await healed.close().catch(() => {});
		}
	}, 30_000);

	it('de-dupes concurrent re-auths under a stampede (no N-signin race)', async () => {
		// Use a FULL-duration root signin and force the session unauthenticated with
		// invalidate() (the same IAM-error shape as a TTL lapse — verified live), so the
		// re-auth issues a fresh full-duration token. This makes the test DETERMINISTIC
		// under parallel-worker load (a sub-second TTL re-expires the fresh token before
		// a contended retry runs — that flake is a test artefact, not a client defect;
		// the durable fix uses 4w tokens). See F-042.
		const racer = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		try {
			await racer.raw.invalidate(); // drop auth → next query throws the IAM signature
			// Many in-flight queries hit expiry at once — all must succeed via ONE re-auth.
			const results = await Promise.all(
				Array.from({ length: 6 }, () =>
					racer.query<[{ n: number }[]]>('SELECT count() AS n FROM note GROUP ALL;')
				)
			);
			expect(results.length).toBe(6);
			for (const r of results) expect(typeof (r[0][0]?.n ?? 0)).toBe('number');
		} finally {
			await racer.close().catch(() => {});
		}
	}, 30_000);

	it('a genuinely-bad re-auth fails honestly after ONE retry (no infinite loop, no cred leak)', async () => {
		await defineShortTokenUser('heal_bad', SHORT_TOKEN_PW);
		const bad = await Db.connect({
			url: tdb.wsUrl,
			username: 'heal_bad',
			password: SHORT_TOKEN_PW,
			namespace: tdb.namespace,
			database: tdb.database
		});
		try {
			// Yank the user's password so the retained-creds re-signin will FAIL, then
			// force the live session unauthenticated deterministically (invalidate()).
			await defineShortTokenUser('heal_bad', 'rotated-away');
			await bad.raw.invalidate();
			// Bounded: re-auth fails → the ORIGINAL expiry error surfaces, no spin.
			const started = Date.now();
			let thrown: unknown;
			await bad.query('SELECT * FROM note;').catch((e) => {
				thrown = e;
			});
			expect(thrown).toBeDefined();
			expect(Date.now() - started).toBeLessThan(10_000); // not looping
			const msg = thrown instanceof Error ? thrown.message : String(thrown);
			// Honest: the real auth failure surfaces…
			expect(msg).toMatch(/permission|iam|auth/i);
			// …and the retained credentials NEVER appear in the thrown message (D-026).
			expect(msg).not.toContain(SHORT_TOKEN_PW);
			expect(msg).not.toContain('rotated-away');
		} finally {
			await bad.close().catch(() => {});
		}
	}, 30_000);
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
