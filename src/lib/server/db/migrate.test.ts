import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from './client';
import {
	runMigrations,
	isApplied,
	defineFlagField,
	guardedScan,
	backfillValueField,
	type Migration
} from './migrate';
import { startTestDb, type TestDb } from './testserver';

// TASK 0.b VERIFY (migrate half): schema applies to a throwaway test DB
// (namespace dropped per run); migrations are idempotent (re-run = no-op); the
// MEMORY-SPEC §6 gotcha helpers produce safe DDL.

let tdb: TestDb;
let root: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	root = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
}, 60_000);

afterAll(async () => {
	await root?.close().catch(() => {});
	await tdb?.teardown();
});

describe('runMigrations — idempotent application (§6.4)', () => {
	const migrations: Migration[] = [
		{
			id: '0001_widget',
			up: `
				DEFINE TABLE OVERWRITE widget SCHEMAFULL;
				DEFINE FIELD OVERWRITE name ON widget TYPE string;
				${defineFlagField('widget', 'active', 'bool', { default: 'true' })}
				CREATE widget SET name = 'a';
				CREATE widget SET name = 'b';
			`
		}
	];

	it('applies a migration and records it', async () => {
		const applied = await runMigrations(root, migrations);
		expect(applied).toEqual(['0001_widget']);
		expect(await isApplied(root, '0001_widget')).toBe(true);

		const rows = await root.query<[{ n: number }[]]>(
			'SELECT count() AS n FROM widget GROUP ALL;'
		);
		expect(rows[0][0].n).toBe(2);
	});

	it('re-running is a no-op (does not re-create rows)', async () => {
		const applied = await runMigrations(root, migrations);
		expect(applied).toEqual([]); // nothing new applied

		const rows = await root.query<[{ n: number }[]]>(
			'SELECT count() AS n FROM widget GROUP ALL;'
		);
		expect(rows[0][0].n).toBe(2); // still 2, not 4
	});

	it('applies only the new migration when the list grows', async () => {
		const grown: Migration[] = [
			...migrations,
			{
				id: '0002_gadget',
				up: `DEFINE TABLE OVERWRITE gadget SCHEMAFULL; DEFINE FIELD OVERWRITE k ON gadget TYPE string;`
			}
		];
		const applied = await runMigrations(root, grown);
		expect(applied).toEqual(['0002_gadget']);
	});
});

describe('defineFlagField (§6.2 / §6.3 — no bare-NONE boolean)', () => {
	it('emits option<T> when optional', () => {
		expect(defineFlagField('memory', 'surfaceable', 'bool', { optional: true })).toMatch(
			/TYPE option<bool>/
		);
	});

	it('emits a concrete DEFAULT when not optional', () => {
		expect(defineFlagField('memory', 'surfaceable', 'bool', { default: 'false' })).toMatch(
			/TYPE bool DEFAULT false/
		);
	});

	it('refuses an empty default (would land in NONE → claim starvation)', () => {
		expect(() => defineFlagField('memory', 'x', 'bool', { default: '' })).toThrow(/non-NONE/i);
	});

	it('a field defined with a DEFAULT never lands in NONE on insert', async () => {
		await root.query(`
			DEFINE TABLE OVERWRITE flagrow SCHEMAFULL;
			${defineFlagField('flagrow', 'claimed', 'bool', { default: 'false' })}
		`);
		await root.query('CREATE flagrow SET id = flagrow:one;');
		// A RETURN-AFTER claim must MATCH the defaulted-false row (no starvation).
		const claimed = await root.query<[{ id: unknown }[]]>(
			'UPDATE flagrow SET claimed = true WHERE claimed = false RETURN AFTER;'
		);
		expect(claimed[0].length).toBe(1);
	});
});

describe('guardedScan (§6.4) + backfillValueField (§6.5)', () => {
	it('guardedScan is a no-op once no unmigrated rows remain', async () => {
		await root.query(`
			DEFINE TABLE OVERWRITE scanrow SCHEMAFULL;
			DEFINE FIELD OVERWRITE n ON scanrow TYPE option<int>;
			CREATE scanrow:a;
			CREATE scanrow:b;
		`);
		const scan = guardedScan('scanrow', 'n IS NONE', 'n = 1');
		await root.query(scan); // first run: sets n=1 on both
		await root.query(scan); // second run: no unmigrated rows → no-op
		const rows = await root.query<[{ n: number }[]]>('SELECT n FROM scanrow;');
		expect(rows[0].every((r) => r.n === 1)).toBe(true);
	});

	it('backfillValueField recomputes a VALUE field on pre-existing rows', async () => {
		// Create rows BEFORE the VALUE field exists → they hold NONE for it.
		await root.query(`
			DEFINE TABLE OVERWRITE vrow SCHEMAFULL;
			DEFINE FIELD OVERWRITE grp ON vrow TYPE string;
			CREATE vrow:a SET grp = 'g1';
			CREATE vrow:b SET grp = 'g2';
		`);
		// Now add the computed VALUE field + a touch column for the backfill.
		await root.query(`
			DEFINE FIELD OVERWRITE _touch    ON vrow TYPE option<datetime>;
			DEFINE FIELD OVERWRITE dedup_key ON vrow VALUE string::concat(grp, ':k');
		`);
		// Pre-existing rows still hold NONE until touched.
		const before = await root.query<[{ dedup_key: string | null }[]]>(
			'SELECT dedup_key FROM vrow WHERE dedup_key IS NONE;'
		);
		expect(before[0].length).toBe(2);

		await root.query(backfillValueField('vrow', 'dedup_key'));

		const after = await root.query<[{ dedup_key: string | null }[]]>(
			'SELECT dedup_key FROM vrow WHERE dedup_key IS NONE;'
		);
		expect(after[0].length).toBe(0); // all backfilled
		const all = await root.query<[{ dedup_key: string }[]]>('SELECT dedup_key FROM vrow;');
		expect(all[0].map((r) => r.dedup_key).sort()).toEqual(['g1:k', 'g2:k']);
	});
});
