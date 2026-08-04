import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, initDb, getDb, closeDb, isAuthExpiredError } from './client';
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
	// `tokenDuration` is a SurrealQL duration literal, defaulted to the sub-second TTL used to
	// PROVOKE an expiry; pass a long one to re-issue the same user a token that cannot lapse.
	async function defineShortTokenUser(name: string, password: string, tokenDuration = '1s') {
		await db.query(
			`DEFINE USER OVERWRITE ${name} ON ROOT PASSWORD '${password}' ROLES OWNER DURATION FOR TOKEN ${tokenDuration}, FOR SESSION 4w;`
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
			// WIDEN THE USER'S TOKEN TTL BEFORE THE HEALING QUERY (the same mid-test DEFINE USER
			// OVERWRITE technique the bad-re-auth case below uses to rotate a password). The token
			// already MINTED stays expired, so the real TTL-lapse trigger this test exists to cover
			// is untouched — but the re-signin `runQuery` performs now mints a 4w token instead of
			// another 1s one.
			//
			// WHY: `runQuery` (client.ts) re-auths ONCE and retries ONCE, and on retry failure
			// rethrows the ORIGINAL expiry error. With a 1s TTL on BOTH tokens, any scheduling gap
			// >1s between the re-signin and the retry re-expires the FRESH token, the retry throws
			// IAM again, and the test fails with the very error it asserts against — a false RED
			// that indicts the client for a test artefact. That is load-dependent, so it stayed
			// hidden until the suite grew a second real-SurrealDB live server and 8-way fork
			// contention pushed the gap past 1s. The sibling stampede case below already documents
			// this exact class ("a sub-second TTL re-expires the fresh token before a contended
			// retry runs — that flake is a test artefact, not a client defect"); this is the one
			// case that was never converted. Now deterministic under any load.
			// 1h, NOT 4w: the SDK arms a token-refresh timer from this duration, and 4w
			// (2_419_200_000ms) overflows setTimeout's signed-32-bit limit — node clamps it to 1ms
			// and emits TimeoutOverflowWarning, i.e. a timer that fires immediately and churns. 1h
			// is SurrealDB's own default token TTL (see this block's header) and is four orders of
			// magnitude beyond any scheduling gap, so it is deterministic without the overflow.
			await defineShortTokenUser('heal_ok', SHORT_TOKEN_PW, '1h');
			// PROVE THE HEAL IS STILL EXERCISED (guard against a vacuous green). Widening the
			// user's TTL must NOT revive the token already minted — a SurrealDB token is a signed
			// JWT whose `exp` is fixed at mint time, so re-DEFINEing the user cannot retroactively
			// extend it. If that ever stopped holding, the session would still be authenticated,
			// the guarded query below would succeed WITHOUT healing, and this test would pass while
			// asserting nothing. So assert the precondition directly, through the RAW handle (which
			// has no re-auth wrapper): it must still fail with the expiry signature.
			await expect(healed.raw.query('SELECT content FROM note LIMIT 1;')).rejects.toThrow(
				/Not enough permissions/
			);
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

// SF2-2 — wording-contract unit test. After the SF2-1 credential flip the runtime signs
// in as a DATABASE-level EDITOR, so a GENUINE authorization denial (the role lacking a
// capability) must NOT be mistaken for token expiry and enter the F-042 re-auth/retry —
// re-signing in cannot grant a capability the role does not have, and under the live-sub
// probe it would churn as a re-signin loop. The literal strings below are captured LIVE
// vs the pinned 2.6.5 binary (see provision-user.test.ts for the behavioral proof that
// these are the exact shapes the SDK throws): expiry is WRAPPED ("There was a problem with
// the database: …"), a bare authz denial is NOT.
describe('isAuthExpiredError — expiry vs authorization-denied (SF2-2)', () => {
	// EXPIRY (heal): dropped/anon session hits a PERMISSIONS-NONE table → wrapped runtime error.
	const EXPIRY = [
		'There was a problem with the database: IAM error: Not enough permissions to perform this action',
		'The token has expired',
		'There was a problem with authentication: Not authenticated',
		'Invalid token supplied'
	];
	// AUTHZ DENIAL (surface honestly, no re-auth): valid session, role lacks the capability.
	const AUTHZ = [
		'IAM error: Not enough permissions to perform this action', // bare — DEFINE USER / INFO FOR ROOT / cross-db
		'IAM error: Not enough permissions'
	];

	for (const m of EXPIRY) {
		it(`treats as expiry (heals): ${m.slice(0, 48)}…`, () => {
			expect(isAuthExpiredError(new Error(m))).toBe(true);
		});
	}
	for (const m of AUTHZ) {
		it(`does NOT treat a bare authz denial as expiry: ${m.slice(0, 48)}…`, () => {
			expect(isAuthExpiredError(new Error(m))).toBe(false);
		});
	}
	it('handles string and null/undefined error shapes without matching (shadow paths)', () => {
		expect(isAuthExpiredError('IAM error: Not enough permissions to perform this action')).toBe(false);
		expect(
			isAuthExpiredError('There was a problem with the database: IAM error: Not enough permissions')
		).toBe(true);
		expect(isAuthExpiredError(null)).toBe(false);
		expect(isAuthExpiredError(undefined)).toBe(false);
		expect(isAuthExpiredError({})).toBe(false);
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
