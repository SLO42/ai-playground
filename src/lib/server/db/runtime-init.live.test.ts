// LIVE PROOF (SF3-3) — the scoped least-privilege runtime signin, END TO END against a
// REAL SurrealDB binary: `provisionRuntimeUser` (root) → `SURREAL_RUNTIME_USER` /
// `SURREAL_RUNTIME_PASS` in the env → `initDbFromEnv` → `Db.connect({authLevel:'database'})`
// → a working, CONFINED runtime handle.
//
// WHY THIS FILE EXISTS: the SF2-1 builder verified this path with a THROWAWAY script that
// left nothing behind, so the seam most likely to rot silently (the DATABASE-level signin
// payload — `{namespace, database, username, password}`, which the ROOT path must NOT send)
// had no retained coverage. runtime-init.test.ts only exercises the PURE resolver; a stubDb
// cannot validate a signin at all. This is the real-binary half.
//
// HONEST SKIP (not a silent pass): the pinned 2.6.5 binary is required. When it is absent
// the whole suite reports SKIPPED with the reason in its name — it never reports green on
// zero assertions.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { Db, closeDb, getDb } from './client';
import { SURREAL_BINARY_PATH } from './provision';
import { startTestDb, type TestDb } from './testserver';
import { provisionRuntimeUser } from './provision-user';
import { initDbFromEnv, type DbEnv } from './runtime-init';

const HAS_BINARY = existsSync(SURREAL_BINARY_PATH);
const live = HAS_BINARY ? describe : describe.skip;
const SKIP_NOTE = HAS_BINARY ? '' : ` [SKIPPED — pinned SurrealDB binary missing at ${SURREAL_BINARY_PATH}]`;

let tdb: TestDb;
let root: Db;
const RUNTIME_USER = 'atelier_runtime';
const RUNTIME_PASS = 'sf3_scoped_pw_1234';

/** The env an operator ends up with after following db:up's handoff block. */
function scopedEnv(over: Partial<DbEnv> = {}): DbEnv {
	return {
		SURREAL_WS: tdb.wsUrl,
		SURREAL_NS: tdb.namespace,
		SURREAL_DB: tdb.database,
		SURREAL_RUNTIME_USER: RUNTIME_USER,
		SURREAL_RUNTIME_PASS: RUNTIME_PASS,
		...over
	};
}

live(`scoped runtime signin via initDbFromEnv (real binary)${SKIP_NOTE}`, () => {
	beforeAll(async () => {
		tdb = await startTestDb();
		root = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		// A product table so the scoped user has something to CRUD.
		await root.query('DEFINE TABLE widget SCHEMALESS;');
		await root.query("CREATE widget:seed SET name = 'seed';");
		const out = await provisionRuntimeUser(root, {
			username: RUNTIME_USER,
			password: RUNTIME_PASS
		});
		// Ground the fixture: if provisioning silently no-op'd, every assertion below
		// would be testing the wrong credential.
		expect(out).toMatchObject({ alreadyExisted: false, role: 'EDITOR', level: 'database' });
	}, 60_000);

	afterAll(async () => {
		await closeDb();
		await root?.close().catch(() => {});
		await tdb?.teardown();
	});

	// The singleton is process-wide; every case starts from a clean, unconnected state
	// so `initDbFromEnv`'s "already connected → success" short-circuit cannot mask a
	// failing connect.
	beforeEach(async () => {
		await closeDb();
	});

	describe('happy path', () => {
		it('connects the runtime singleton as the DATABASE-level user and queries', async () => {
			const res = await initDbFromEnv(scopedEnv());
			expect(res).toEqual({ connected: true });

			// The handle is REAL, not just constructed: read + write through it.
			const [rows] = await getDb().query<[Array<{ name: string }>]>(
				'SELECT name FROM widget ORDER BY name;'
			);
			expect(rows.map((r) => r.name)).toEqual(['seed']);
			await getDb().query("CREATE widget:scoped SET name = 'from_scoped_user';");
			const [after] = await getDb().query<[Array<{ name: string }>]>(
				'SELECT name FROM widget WHERE id = widget:scoped;'
			);
			expect(after[0]?.name).toBe('from_scoped_user');
		}, 30_000);

		it('is the SCOPED identity, not root — it cannot mint a user (no escalation)', async () => {
			await initDbFromEnv(scopedEnv());
			// EDITOR at DATABASE level cannot DEFINE USER at any level (verified 2.6.5).
			// If this ever SUCCEEDS the runtime silently reconnected as root and the whole
			// least-privilege seam is void — which is exactly the regression to catch.
			await expect(
				getDb().query("DEFINE USER escalated ON DATABASE PASSWORD 'x' ROLES OWNER;")
			).rejects.toThrow(/permission/i);
		}, 30_000);

		it('is idempotent — a second initDbFromEnv on a live singleton is a no-op success', async () => {
			expect(await initDbFromEnv(scopedEnv())).toEqual({ connected: true });
			// initDb() throws if the singleton exists; the seam must absorb that as success
			// (the interrupt/re-run contract), not surface a spurious disconnected state.
			expect(await initDbFromEnv(scopedEnv())).toEqual({ connected: true });
		}, 30_000);
	});

	describe('shadow paths', () => {
		it('nil env: no creds at all → honest reason, no throw, no connection', async () => {
			const res = await initDbFromEnv({ SURREAL_WS: tdb.wsUrl });
			expect(res.connected).toBe(false);
			expect(res.reason).toMatch(/SURREAL_USER \/ SURREAL_PASS not set/);
			expect(() => getDb()).toThrow(/not initialised/);
		}, 30_000);

		it('empty-string runtime password → refused as PARTIAL, never falls back to root', async () => {
			// The trap this guards: falling back would connect as root/root (which IS valid
			// on this server) and the operator would never learn the scoped user failed.
			const res = await initDbFromEnv(
				scopedEnv({ SURREAL_RUNTIME_PASS: '', SURREAL_USER: 'root', SURREAL_PASS: 'root' })
			);
			expect(res.connected).toBe(false);
			expect(res.reason).toMatch(/SURREAL_RUNTIME_USER and SURREAL_RUNTIME_PASS must both be set/);
			expect(() => getDb()).toThrow(/not initialised/);
		}, 30_000);

		it('upstream error: wrong runtime password → honest unreachable reason, degraded boot', async () => {
			const res = await initDbFromEnv(scopedEnv({ SURREAL_RUNTIME_PASS: 'not-the-password' }));
			expect(res.connected).toBe(false);
			expect(res.reason).toMatch(/cannot reach SurrealDB/);
			expect(() => getDb()).toThrow(/not initialised/);
		}, 30_000);

		it('upstream error: dead port → bounded connect timeout, never a hang (F-014)', async () => {
			const started = Date.now();
			// Port 1 on loopback: nothing listens, and the SDK alone would sit ~90s.
			const res = await initDbFromEnv(scopedEnv({ SURREAL_WS: 'ws://127.0.0.1:1/rpc' }));
			expect(res.connected).toBe(false);
			expect(res.reason).toMatch(/cannot reach SurrealDB/);
			expect(Date.now() - started).toBeLessThan(20_000);
		}, 30_000);
	});
});
