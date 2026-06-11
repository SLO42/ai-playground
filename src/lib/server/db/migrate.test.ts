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
import { schemaMigrations } from './schema';

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

// TASK 11.4-FIX — the real schema migrations must be idempotent over BOTH a fresh DB
// and the HALF-APPLIED state that wedged the live `db:up` (m0025 once created `pm_review`
// with fields:{} but was never recorded → "table already exists" on every subsequent run).
// Each sub-test gets its OWN throwaway namespace/database so they cannot interfere.
describe('schemaMigrations — idempotent over fresh + half-applied state (11.4-FIX)', () => {
	let tdb2: TestDb;

	beforeAll(async () => {
		tdb2 = await startTestDb();
	}, 60_000);

	afterAll(async () => {
		await tdb2?.teardown();
	});

	async function freshDb(ns: string) {
		const db = await Db.connect({
			url: tdb2.wsUrl,
			username: tdb2.root.username,
			password: tdb2.root.password,
			namespace: ns,
			database: ns
		});
		return db;
	}

	it('applies the full schema TWICE against a fresh DB with no error (re-run = no-op)', async () => {
		const db = await freshDb('mig_fresh');
		try {
			const first = await runMigrations(db, schemaMigrations);
			expect(first).toEqual(schemaMigrations.map((m) => m.id)); // all applied once

			const second = await runMigrations(db, schemaMigrations);
			expect(second).toEqual([]); // ledger gate → nothing re-applied, no throw

			// m0025's tables landed with their FIELD definitions (not the bare fields:{} state).
			const info = await db.query<[{ fields: Record<string, string> }]>(
				'INFO FOR TABLE pm_review;'
			);
			expect(Object.keys(info[0].fields)).toContain('created_at');
			expect(await isApplied(db, '0025_pm_review_board')).toBe(true);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('RECOVERS the half-applied wedge: bare pm_review table, then full migrations apply clean', async () => {
		const db = await freshDb('mig_wedge');
		try {
			// Reproduce the exact half-applied state: the table exists but is BARE (fields:{}),
			// and 0025 was NEVER recorded as applied (migrate.ts only records on a clean run).
			await db.query('DEFINE TABLE pm_review SCHEMAFULL;');
			const before = await db.query<[{ fields: Record<string, string> }]>(
				'INFO FOR TABLE pm_review;'
			);
			expect(Object.keys(before[0].fields)).toHaveLength(0); // bare — the wedge
			expect(await isApplied(db, '0025_pm_review_board')).toBe(false);

			// The full schema must apply cleanly OVER the half-applied table (OVERWRITE recovers it).
			const applied = await runMigrations(db, schemaMigrations);
			expect(applied).toContain('0025_pm_review_board');

			// The bare table now carries its real field definitions + the migration is recorded.
			const after = await db.query<[{ fields: Record<string, string> }]>(
				'INFO FOR TABLE pm_review;'
			);
			expect(Object.keys(after[0].fields)).toContain('created_at');
			expect(Object.keys(after[0].fields)).toContain('trigger');
			expect(await isApplied(db, '0025_pm_review_board')).toBe(true);

			// And a re-run is still a clean no-op.
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('recovers half-applied pm_review rows: backfills the salvageable, deletes the corrupt (F-008)', async () => {
		const db = await freshDb('mig_backfill');
		try {
			// Stand up the table WITH its fields but WITHOUT the created_at DEFAULT — the exact
			// recoverable shape an addPmReview row was left in (project + summary + counts set,
			// created_at relied on the DEFAULT the bare table dropped → NONE).
			await db.query('DEFINE TABLE project SCHEMAFULL;');
			await db.query('DEFINE FIELD slug ON project TYPE string;');
			await db.query('CREATE project:wedge SET slug = "wedge";');
			await db.query(`
				DEFINE TABLE pm_review SCHEMAFULL;
				DEFINE FIELD project ON pm_review TYPE option<record<project>>;
				DEFINE FIELD trigger ON pm_review TYPE option<string>;
				DEFINE FIELD summary ON pm_review TYPE option<string>;
				DEFINE FIELD tasks_examined ON pm_review TYPE option<int>;
			`);
			// (b) RECOVERABLE: complete addPmReview-shape row, only created_at missing.
			await db.query(
				'CREATE pm_review:salvage SET project = project:wedge, summary = "real pass", trigger = "periodic", tasks_examined = 3;'
			);
			// (a) UNSALVAGEABLE: an id-only row (the fields:{} state dropped all columns on write).
			await db.query('CREATE pm_review:corrupt;');

			const before = await db.query<[{ n: number }[]]>(
				'SELECT count() AS n FROM pm_review GROUP ALL;'
			);
			expect(before[0][0].n).toBe(2);

			await runMigrations(db, schemaMigrations);

			// The corrupt id-only row is gone (DELETEd, not fabricated); the salvageable row stays.
			const ids = await db.query<[{ id: string }[]]>('SELECT id FROM pm_review;');
			const idStrs = ids[0].map((r) => String(r.id));
			expect(idStrs).toContain('pm_review:salvage');
			expect(idStrs).not.toContain('pm_review:corrupt');

			// The salvageable row was backfilled: created_at present, prior values preserved.
			const fixed = await db.query<[{ created_at: unknown }[]]>(
				'SELECT created_at FROM pm_review WHERE created_at IS NONE;'
			);
			expect(fixed[0].length).toBe(0);
			const salvaged = await db.query<[{ tasks_examined: number; trigger: string }[]]>(
				'SELECT tasks_examined, trigger FROM pm_review:salvage;'
			);
			expect(salvaged[0][0].tasks_examined).toBe(3); // preserved, not reset to the default
			expect(salvaged[0][0].trigger).toBe('periodic');
		} finally {
			await db.close().catch(() => {});
		}
	});

	// ── TASK 16.1 — m0029 pm identity: the F-015 discipline pair for the new table. ──
	// (Apply-twice over a FRESH db is covered by the 'applies the full schema TWICE' case
	// above, which includes 0029; these cover the half-applied states specifically.)

	it('m0029 RECOVERS a half-applied bare `pm` table (OVERWRITE re-defines, ledger records)', async () => {
		const db = await freshDb('mig_pm_wedge');
		try {
			// The exact F-015 wedge shape: table exists bare (fields:{}), migration unrecorded.
			await db.query('DEFINE TABLE pm SCHEMAFULL;');
			const before = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE pm;');
			expect(Object.keys(before[0].fields)).toHaveLength(0);
			expect(await isApplied(db, '0029_pm_identity')).toBe(false);

			const applied = await runMigrations(db, schemaMigrations);
			expect(applied).toContain('0029_pm_identity');

			const after = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE pm;');
			for (const f of ['project', 'name', 'charter', 'persona', 'cadence', 'cadence_offset', 'authority', 'created_at']) {
				expect(Object.keys(after[0].fields)).toContain(f);
			}
			const info = await db.query<[{ indexes: Record<string, string> }]>('INFO FOR TABLE pm;');
			expect(Object.keys(info[0].indexes)).toContain('pm_by_project');
			expect(await isApplied(db, '0029_pm_identity')).toBe(true);

			// Re-run is a clean no-op (apply-twice over the recovered state).
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});

	// ── TASK 16.2 — m0030 pm_review.provenance: the F-015 discipline pair. ──
	// (Apply-twice over a FRESH db is covered by the 'applies the full schema TWICE'
	// case above, which now includes 0030.)

	it('m0030 applies over the HALF-APPLIED state (field already defined, migration unrecorded) and round-trips provenance', async () => {
		const db = await freshDb('mig_prov_wedge');
		try {
			// The wedge shape for a field-only migration: the DEFINE ran but the ledger
			// insert never landed (the runner records only on a clean full run).
			await db.query('DEFINE TABLE pm_review SCHEMAFULL;');
			await db.query('DEFINE FIELD provenance ON pm_review FLEXIBLE TYPE option<object>;');
			expect(await isApplied(db, '0030_pm_review_provenance')).toBe(false);

			const applied = await runMigrations(db, schemaMigrations);
			expect(applied).toContain('0030_pm_review_provenance');
			expect(await isApplied(db, '0030_pm_review_provenance')).toBe(true);

			// Round-trip: a provenance-bearing row keeps its nested object intact, and a
			// row WITHOUT provenance reads back absent (honest absence, never {}).
			await db.query('CREATE project:provhost SET slug = "provhost", name = "P", root_path = "F:/x";');
			await db.query(
				`CREATE pm_review:withprov SET project = project:provhost, summary = "s", trigger = "event",
					provenance = { kind: 'finding', evidence: ['security_finding:a'], authority: 'act', detail: { findings: 1 } };`
			);
			await db.query('CREATE pm_review:noprov SET project = project:provhost, summary = "s2";');
			const rows = await db.query<
				[{ provenance?: { kind: string; evidence: string[] } }[], { provenance?: unknown }[]]
			>('SELECT provenance FROM pm_review:withprov; SELECT provenance FROM pm_review:noprov;');
			expect(rows[0][0].provenance?.kind).toBe('finding');
			expect(rows[0][0].provenance?.evidence).toEqual(['security_finding:a']);
			expect(rows[1][0].provenance ?? null).toBeNull();

			// Re-run is still a clean no-op (apply-twice over the recovered state).
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('m0029 recovers half-applied pm ROWS: backfills authority/created_at, deletes id-only corruption', async () => {
		const db = await freshDb('mig_pm_backfill');
		try {
			// Stand the table up WITHOUT the DEFAULTs (the bare-table write shape).
			await db.query('DEFINE TABLE project SCHEMAFULL;');
			await db.query('DEFINE FIELD slug ON project TYPE string;');
			await db.query('CREATE project:pmwedge SET slug = "pmwedge";');
			await db.query(`
				DEFINE TABLE pm SCHEMAFULL;
				DEFINE FIELD project ON pm TYPE option<record<project>>;
				DEFINE FIELD name    ON pm TYPE option<string>;
				DEFINE FIELD charter ON pm TYPE option<string>;
				DEFINE FIELD authority ON pm TYPE option<string>;
			`);
			// (b) RECOVERABLE: project + name (+ charter) set; DEFAULT-bearing columns missing.
			await db.query(
				'CREATE pm:salvage SET project = project:pmwedge, name = "Vesper", charter = "ship the wedge";'
			);
			// (a) UNSALVAGEABLE: an id-only row (fields:{} dropped every column on write).
			await db.query('CREATE pm:corrupt;');

			await runMigrations(db, schemaMigrations);

			const ids = await db.query<[{ id: string }[]]>('SELECT id FROM pm;');
			const idStrs = ids[0].map((r) => String(r.id));
			expect(idStrs).toContain('pm:salvage');
			expect(idStrs).not.toContain('pm:corrupt'); // deleted, never fabricated

			const fixed = await db.query<
				[{ authority: string; created_at: unknown; charter: string; name: string }[]]
			>('SELECT * FROM pm:salvage;');
			expect(fixed[0][0].authority).toBe('act'); // backfilled to the PM-SPEC §4 default
			expect(fixed[0][0].created_at).toBeTruthy(); // backfilled, row re-validates clean
			expect(fixed[0][0].name).toBe('Vesper'); // preserved
			expect(fixed[0][0].charter).toBe('ship the wedge'); // preserved
		} finally {
			await db.close().catch(() => {});
		}
	});
});
