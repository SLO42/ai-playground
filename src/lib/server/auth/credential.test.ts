import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations, isApplied, type Migration } from '../db/migrate';
import { startTestDb, type TestDb } from '../db/testserver';
import { schemaMigrations } from '../db/schema';
import {
	hashPassword,
	verifyPassword,
	generateSignSecret,
	readCredential,
	credentialExists,
	setCredential,
	changePassword,
	deleteCredential
} from './credential';

const M0071 = schemaMigrations.find((m) => m.id === '0071_app_auth') as Migration;

describe('scrypt hash / verify (pure)', () => {
	it('verifies the correct password and rejects a wrong one', () => {
		const { hash, salt } = hashPassword('correct horse battery staple');
		expect(verifyPassword('correct horse battery staple', hash, salt)).toBe(true);
		expect(verifyPassword('wrong password', hash, salt)).toBe(false);
	});

	it('produces a different salt+hash for the same password each call', () => {
		const a = hashPassword('same');
		const b = hashPassword('same');
		expect(a.salt).not.toBe(b.salt);
		expect(a.hash).not.toBe(b.hash);
		// …but each still verifies its own.
		expect(verifyPassword('same', a.hash, a.salt)).toBe(true);
		expect(verifyPassword('same', b.hash, b.salt)).toBe(true);
	});

	it('a supplied salt reproduces the same hash (verification path)', () => {
		const { hash, salt } = hashPassword('pw');
		expect(hashPassword('pw', salt).hash).toBe(hash);
	});

	it('rejects empty inputs and malformed hex without throwing', () => {
		expect(verifyPassword('', 'aa', 'bb')).toBe(false);
		expect(verifyPassword('pw', '', 'bb')).toBe(false);
		expect(verifyPassword('pw', 'aa', '')).toBe(false);
		expect(verifyPassword('pw', 'zz', 'zz')).toBe(false); // non-hex → caught, false
	});

	it('sign secrets are 64 hex chars (32 bytes) and random', () => {
		const s1 = generateSignSecret();
		const s2 = generateSignSecret();
		expect(s1).toMatch(/^[0-9a-f]{64}$/);
		expect(s1).not.toBe(s2);
	});
});

describe('m0071 app_auth migration — idempotent (apply-twice + half-applied) [F-015]', () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await startTestDb();
	}, 60_000);

	afterAll(async () => {
		await tdb?.teardown();
	});

	async function freshDb(ns: string): Promise<Db> {
		return Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: ns,
			database: ns
		});
	}

	it('applies clean on a fresh DB and re-runs as a no-op', async () => {
		const db = await freshDb('auth_fresh');
		try {
			expect(await runMigrations(db, [M0071])).toEqual(['0071_app_auth']);
			expect(await isApplied(db, '0071_app_auth')).toBe(true);
			const info = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE app_auth;');
			expect(Object.keys(info[0].fields)).toEqual(
				expect.arrayContaining(['password_hash', 'password_salt', 'sign_secret', 'created_at', 'updated_at'])
			);
			expect(await runMigrations(db, [M0071])).toEqual([]); // ledger gate → no-op
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('recovers a half-applied bare table (OVERWRITE), then re-run is a no-op', async () => {
		const db = await freshDb('auth_wedge');
		try {
			// Reproduce the wedge: bare table exists, migration NOT recorded.
			await db.query('DEFINE TABLE app_auth SCHEMAFULL;');
			const before = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE app_auth;');
			expect(Object.keys(before[0].fields)).toHaveLength(0);
			expect(await isApplied(db, '0071_app_auth')).toBe(false);

			expect(await runMigrations(db, [M0071])).toEqual(['0071_app_auth']);
			const after = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE app_auth;');
			expect(Object.keys(after[0].fields)).toContain('password_hash');
			expect(await runMigrations(db, [M0071])).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});
});

describe('credential store CRUD (against a live table)', () => {
	let tdb: TestDb;
	let db: Db;

	beforeAll(async () => {
		tdb = await startTestDb();
		db = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: 'auth_crud',
			database: 'auth_crud'
		});
		await runMigrations(db, [M0071]);
	}, 60_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	it('reports no credential on a fresh table (honest absence)', async () => {
		expect(await readCredential(db)).toBeNull();
		expect(await credentialExists(db)).toBe(false);
	});

	it('setCredential stores a verifiable hash + a sign secret; datetimes are ISO (F-013)', async () => {
		const { signSecret } = await setCredential(db, 'hunter2hunter2');
		expect(signSecret).toMatch(/^[0-9a-f]{64}$/);

		const cred = await readCredential(db);
		expect(cred).not.toBeNull();
		expect(cred!.signSecret).toBe(signSecret);
		// Stored as a HASH — never the plaintext.
		expect(cred!.passwordHash).not.toContain('hunter2');
		expect(verifyPassword('hunter2hunter2', cred!.passwordHash, cred!.passwordSalt)).toBe(true);
		expect(verifyPassword('nope', cred!.passwordHash, cred!.passwordSalt)).toBe(false);
		// F-013: created_at/updated_at are ISO strings, not raw SDK datetimes.
		expect(typeof cred!.createdAt).toBe('string');
		expect(() => new Date(cred!.createdAt as string).toISOString()).not.toThrow();
		expect(await credentialExists(db)).toBe(true);
	});

	it('changePassword updates the hash but keeps the sign secret (cookie stays valid)', async () => {
		const before = await readCredential(db);
		await changePassword(db, 'newpassword123');
		const after = await readCredential(db);
		expect(after!.signSecret).toBe(before!.signSecret); // secret unchanged
		expect(verifyPassword('newpassword123', after!.passwordHash, after!.passwordSalt)).toBe(true);
		expect(verifyPassword('hunter2hunter2', after!.passwordHash, after!.passwordSalt)).toBe(false);
	});

	it('deleteCredential returns to the first-run (no-credential) state', async () => {
		await deleteCredential(db);
		expect(await readCredential(db)).toBeNull();
		expect(await credentialExists(db)).toBe(false);
	});
});
