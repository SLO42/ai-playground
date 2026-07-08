import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from './client';
import {
	provisionRuntimeUser,
	ProvisioningError,
	DEFAULT_RUNTIME_USERNAME
} from './provision-user';
import { startTestDb, type TestDb } from './testserver';

// DBR-1 / SEC-4 — the scoped least-privilege runtime user. REAL-surreal only (F-020):
// a stubDb cannot validate DEFINE USER semantics or the role grant matrix. Every
// assertion runs against the pinned 2.6.5 binary via startTestDb.

let tdb: TestDb;
let root: Db;

/** Connect as the scoped runtime user (DATABASE auth level — DBR-1). */
function connectScoped(username: string, password: string): Promise<Db> {
	return Db.connect({
		url: tdb.wsUrl,
		username,
		password,
		namespace: tdb.namespace,
		database: tdb.database,
		authLevel: 'database'
	});
}

beforeAll(async () => {
	tdb = await startTestDb();
	root = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	// A product table for the CRUD half of the grant matrix.
	await root.query('DEFINE TABLE widget SCHEMALESS;');
	await root.query("CREATE widget:seed SET name = 'seed';");
}, 60_000);

afterAll(async () => {
	await root?.close().catch(() => {});
	await tdb?.teardown();
});

describe('provisionRuntimeUser — DEFINE USER (DBR-1)', () => {
	it('defines a DATABASE-level EDITOR the scoped user can sign in as', async () => {
		const out = await provisionRuntimeUser(root, {
			username: 'rt_login',
			password: 'login_pw_123'
		});
		expect(out).toMatchObject({
			username: 'rt_login',
			generated: false,
			alreadyExisted: false,
			role: 'EDITOR',
			level: 'database'
		});
		const scoped = await connectScoped('rt_login', 'login_pw_123');
		try {
			const rows = await scoped.query<[{ name: string }[]]>('SELECT name FROM widget:seed;');
			expect(rows[0][0].name).toBe('seed');
		} finally {
			await scoped.close();
		}
	});

	it('generates a quote-free crypto password when none is supplied (returned, connectable)', async () => {
		const out = await provisionRuntimeUser(root, { username: 'rt_gen' });
		expect(out.generated).toBe(true);
		// base64url only → always safe inside the SurrealQL string literal.
		expect(out.password).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(out.password.length).toBeGreaterThanOrEqual(40);
		const scoped = await connectScoped('rt_gen', out.password);
		try {
			await expect(scoped.query('SELECT count() FROM widget GROUP ALL;')).resolves.toBeDefined();
		} finally {
			await scoped.close();
		}
	});

	it('defaults the username to DEFAULT_RUNTIME_USERNAME', async () => {
		const out = await provisionRuntimeUser(root, { password: 'def_pw_123' });
		expect(out.username).toBe(DEFAULT_RUNTIME_USERNAME);
	});
});

describe('provisionRuntimeUser — idempotent apply-twice (F-015 discipline)', () => {
	it('re-run is a no-op and does NOT reset the existing password', async () => {
		// First provisioning sets the authoritative password.
		await provisionRuntimeUser(root, { username: 'rt_idem', password: 'first_pw_111' });
		// Second provisioning with a DIFFERENT password — IF NOT EXISTS ⇒ ignored, and the
		// helper reports it honestly (no fabricated password, F-008).
		const second = await provisionRuntimeUser(root, {
			username: 'rt_idem',
			password: 'second_pw_222'
		});
		expect(second).toMatchObject({ username: 'rt_idem', alreadyExisted: true, password: '' });

		// The ORIGINAL password still authenticates…
		const asFirst = await connectScoped('rt_idem', 'first_pw_111');
		await asFirst.close();

		// …and the second password does NOT (password was never reset — verified 2.6.5).
		await expect(connectScoped('rt_idem', 'second_pw_222')).rejects.toThrow();
	});

	it('a single DEFINE USER is atomic — the interrupt/half-applied analog is the IF NOT EXISTS re-run', async () => {
		// A migration can die between statements; a single idempotent DEFINE USER cannot
		// leave a half-user. Re-running over an already-defined user is the recovery path
		// and must simply succeed (no throw, no duplicate).
		await provisionRuntimeUser(root, { username: 'rt_reapply', password: 'reapply_pw_1' });
		await expect(
			provisionRuntimeUser(root, { username: 'rt_reapply', password: 'reapply_pw_1' })
		).resolves.toMatchObject({ username: 'rt_reapply' });
	});
});

describe('scoped-user grant matrix — CRUD yes / admin no (SEC-4, verified vs 2.6.5)', () => {
	let scoped: Db;
	beforeAll(async () => {
		await provisionRuntimeUser(root, { username: 'rt_grant', password: 'grant_pw_123' });
		scoped = await connectScoped('rt_grant', 'grant_pw_123');
	});
	afterAll(async () => {
		await scoped?.close().catch(() => {});
	});

	it('CAN do full record CRUD on a product table', async () => {
		await expect(scoped.query('SELECT * FROM widget;')).resolves.toBeDefined();
		const created = await scoped.query<[{ id: unknown }[]]>("CREATE widget SET name = 'byRuntime';");
		expect(created[0][0].id).toBeDefined();
		await expect(scoped.query("UPDATE widget:seed SET name = 'upd';")).resolves.toBeDefined();
		await expect(scoped.query("DELETE widget:seed;")).resolves.toBeDefined();
		// Re-seed for other suites' independence (order-agnostic).
		await root.query("CREATE widget:seed SET name = 'seed';");
	});

	it('CANNOT escalate: DEFINE USER is denied at every level', async () => {
		await expect(
			scoped.query("DEFINE USER backdoor ON DATABASE PASSWORD 'x' ROLES OWNER;")
		).rejects.toThrow(/permission|iam/i);
		await expect(
			scoped.query("DEFINE USER backdoor ON ROOT PASSWORD 'x' ROLES OWNER;")
		).rejects.toThrow(/permission|iam/i);
	});

	it('CANNOT reach root or namespace admin', async () => {
		await expect(scoped.query('INFO FOR ROOT;')).rejects.toThrow(/permission|iam/i);
		await expect(scoped.query('INFO FOR NS;')).rejects.toThrow(/permission|iam/i);
	});

	it('DOCUMENTED limitation: EDITOR retains table DDL within its own database', async () => {
		// SurrealDB 2.x has no role that grants record-CRUD but denies table DDL — this
		// asserts the ACTUAL grant honestly (F-008) rather than a false "DDL denied". The
		// security-relevant boundaries (no DEFINE USER escalation, no cross-db/root reach)
		// hold above; this is the residual documented in provision-user.ts. If a future
		// SurrealDB tightens EDITOR to deny this, the test flags it as a chance to narrow.
		await expect(scoped.query('DEFINE TABLE editor_made SCHEMALESS;')).resolves.toBeDefined();
	});
});

describe('scoped-user F-042 self-heal (single-flight re-signin, DATABASE level)', () => {
	it('transparently re-auths the scoped user after the session drops, then returns rows', async () => {
		await provisionRuntimeUser(root, { username: 'rt_heal', password: 'heal_pw_123' });
		const scoped = await connectScoped('rt_heal', 'heal_pw_123');
		try {
			// Force the live session unauthenticated (same IAM-error shape as a token lapse).
			await scoped.raw.invalidate();
			// Many in-flight queries hit the drop at once — all heal via ONE re-signin that
			// MUST use the DATABASE-level payload (ns/db in signin) for the scoped user.
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					scoped.query<[{ n: number }[]]>('SELECT count() AS n FROM widget GROUP ALL;')
				)
			);
			expect(results.length).toBe(5);
			for (const r of results) expect(typeof (r[0][0]?.n ?? 0)).toBe('number');
		} finally {
			await scoped.close();
		}
	}, 30_000);
});

describe('provisionRuntimeUser — input validation (shadow paths)', () => {
	it('rejects an invalid username (cannot be $param-bound)', async () => {
		await expect(
			provisionRuntimeUser(root, { username: 'bad name; DROP', password: 'p_123' })
		).rejects.toBeInstanceOf(ProvisioningError);
	});

	it('rejects an unsafe password and NEVER leaks it in the error (D-026)', async () => {
		const unsafe = "abc'def";
		let thrown: unknown;
		await provisionRuntimeUser(root, { username: 'rt_unsafe', password: unsafe }).catch((e) => {
			thrown = e;
		});
		expect(thrown).toBeInstanceOf(ProvisioningError);
		expect((thrown as Error).message).not.toContain(unsafe);
	});

	it('treats an empty-string password as absent → generates one', async () => {
		const out = await provisionRuntimeUser(root, { username: 'rt_empty', password: '' });
		expect(out.generated).toBe(true);
	});
});
