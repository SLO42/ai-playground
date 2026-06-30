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

	// ── TASK 16.6 — m0033 memory.session provenance: the F-015 discipline pair. ──
	// (Apply-twice over a FRESH db is covered by the 'applies the full schema TWICE'
	// case above, which now includes 0033.)

	it('m0033 applies over the HALF-APPLIED state (field+index defined, migration unrecorded) and round-trips the session link', async () => {
		const db = await freshDb('mig_memsess_wedge');
		try {
			// The wedge: the DEFINEs ran but the ledger insert never landed.
			await db.query('DEFINE TABLE memory SCHEMAFULL;');
			await db.query('DEFINE FIELD session ON memory TYPE option<record<session>>;');
			await db.query('DEFINE INDEX memory_by_session ON memory FIELDS session;');
			expect(await isApplied(db, '0033_memory_session_provenance')).toBe(false);

			const applied = await runMigrations(db, schemaMigrations);
			expect(applied).toContain('0033_memory_session_provenance');
			expect(await isApplied(db, '0033_memory_session_provenance')).toBe(true);

			// Round-trip: a session-bearing memory keeps the link; a session-less row
			// reads back absent (honest absence — the D-029 filter's NONE branch).
			await db.query(
				`CREATE session:memhost CONTENT { kind: "interview", model: { provider: "x", model_id: "y" }, runtime: "claude-code" };`
			);
			// Unit vectors at the indexed 1024-dim (the HNSW index rejects other shapes).
			const v1 = new Array(1024).fill(0);
			v1[0] = 1;
			const v2 = new Array(1024).fill(0);
			v2[1] = 1;
			await db.query(
				`CREATE memory:withsess SET content = "c", namespace = "default", embedding = $v1, session = session:memhost;
				 CREATE memory:nosess   SET content = "c2", namespace = "default", embedding = $v2;`,
				{ v1, v2 }
			);
			const rows = await db.query<[Array<{ session?: unknown }>, Array<{ session?: unknown }>]>(
				'SELECT session FROM memory:withsess; SELECT session FROM memory:nosess;'
			);
			expect(String(rows[0][0].session)).toBe('session:memhost');
			expect(rows[1][0].session ?? null).toBeNull();

			// Re-run is still a clean no-op (apply-twice over the recovered state).
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('m0070 session.specialist: applies over a half-applied session table; legacy→NONE, new round-trips', async () => {
		const db = await freshDb('mig_specialist_wedge');
		try {
			// Half-applied wedge: a session table that exists WITHOUT the specialist field (the
			// pre-m0070 shape). A legacy row was written before the field existed.
			await db.query('DEFINE TABLE session SCHEMAFULL;');
			await db.query('DEFINE FIELD kind ON session TYPE string;');
			await db.query('CREATE session:legacy SET kind = "task";');
			const before = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE session;');
			expect(Object.keys(before[0].fields)).not.toContain('specialist');

			// The full schema applies cleanly OVER the half-applied table (OVERWRITE recovers it).
			await runMigrations(db, schemaMigrations);
			const after = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE session;');
			expect(Object.keys(after[0].fields)).toContain('specialist');

			// Legacy row reads back NONE (option<string>, never a fabricated value — F-008).
			const legacy = await db.query<[Array<{ specialist: unknown }>]>(
				'SELECT specialist FROM session:legacy;'
			);
			expect(legacy[0][0].specialist ?? null).toBeNull();

			// A new row with specialist SET round-trips the value.
			await db.query(
				`CREATE session:withspec CONTENT {
					kind: "task",
					model: { provider: "anthropic", model_id: "claude-opus-4-8" },
					specialist: "atelier-developer"
				};`
			);
			const withSpec = await db.query<[Array<{ specialist: unknown }>]>(
				'SELECT specialist FROM session:withspec;'
			);
			expect(String(withSpec[0][0].specialist)).toBe('atelier-developer');

			// Apply-twice over the recovered state is still a clean no-op.
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
		} finally {
			await db.close().catch(() => {});
		}
	});

	it('m0072 loop manifest: applies over a half-applied bare `loop` table; row round-trips', async () => {
		const db = await freshDb('mig_loop_wedge');
		try {
			// Half-applied wedge: the `loop` table exists but is BARE (fields:{}), migration unrecorded.
			await db.query('DEFINE TABLE loop SCHEMAFULL;');
			const before = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE loop;');
			expect(Object.keys(before[0].fields)).toHaveLength(0); // bare — the wedge
			expect(await isApplied(db, '0072_loop_manifest')).toBe(false);

			// The full schema applies cleanly OVER the half-applied table (OVERWRITE recovers it).
			const applied = await runMigrations(db, schemaMigrations);
			expect(applied).toContain('0072_loop_manifest');

			const after = await db.query<[{ fields: Record<string, string> }]>('INFO FOR TABLE loop;');
			for (const f of ['identifier', 'kind', 'label', 'phase', 'enabled', 'checklist', 'override', 'created_at', 'updated_at']) {
				expect(Object.keys(after[0].fields)).toContain(f);
			}
			const idx = await db.query<[{ indexes: Record<string, string> }]>('INFO FOR TABLE loop;');
			expect(Object.keys(idx[0].indexes)).toContain('loop_by_identifier');
			expect(await isApplied(db, '0072_loop_manifest')).toBe(true);

			// A GLOBAL loop row (project NULL) round-trips: phase defaults L1, enabled true, override false,
			// checklist defaults to {} (readiness not green), and the datetime DEFAULTs land.
			await db.query(
				`CREATE loop CONTENT { identifier: 'orch:drain', kind: 'orchestrator', label: 'Orchestrator drain' };`
			);
			const rows = await db.query<[Array<{ phase: string; enabled: boolean; override: boolean; checklist: unknown; created_at: unknown; project: unknown }>]>(
				`SELECT phase, enabled, override, checklist, created_at, project FROM loop WHERE identifier = 'orch:drain';`
			);
			expect(rows[0][0].phase).toBe('L1');
			expect(rows[0][0].enabled).toBe(true);
			expect(rows[0][0].override).toBe(false);
			expect(rows[0][0].checklist).toEqual({});
			expect(rows[0][0].created_at).toBeTruthy();
			expect(rows[0][0].project ?? null).toBeNull();

			// The UNIQUE identifier index rejects a duplicate declare.
			await expect(
				db.query(`CREATE loop CONTENT { identifier: 'orch:drain', kind: 'orchestrator', label: 'dup' };`)
			).rejects.toThrow();

			// Apply-twice over the recovered state is a clean no-op.
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

	// ── PMA — m0058 pm.auto_publish_preauthorized: the F-015 BACKFILL discipline. ──
	// LIVE-VERIFIED failure that made the backfill necessary: a `DEFINE FIELD ... TYPE bool DEFAULT false`
	// does NOT backfill EXISTING rows — the column is NONE on any pm row written before the field existed.
	// Because the type is a NON-OPTIONAL bool, SurrealDB then REJECTS any later UPDATE/MERGE of that row
	// ("Found NONE for field ... expected a bool"), so every arm/disarm or auto-publish toggle on a
	// pre-existing PM threw. m0058 therefore backfills BOTH boolean PM flags (auto_publish_preauthorized
	// AND the m0057 autonomous field, which shipped with the same latent gap) to false where NONE. This
	// reproduces a pm row carrying the NONE flags (the pre-field shape) and asserts m0058 makes the row
	// writable again — the exact gap the fresh-DB sweep above cannot see (a fresh DB never has NONE flags).
	it('m0058 BACKFILLS NONE pm boolean flags so a pre-field pm row is writable again (F-015/F-013)', async () => {
		const db = await freshDb('mig_pm_flags');
		try {
			// Reproduce the pre-field shape: define pm with the bool flags but seed a row with them NONE
			// (mirrors a pm row written before m0057/m0058 added the columns). The non-optional bool type
			// is what makes a later write fail until the backfill lands.
			await db.query('DEFINE TABLE project SCHEMAFULL; DEFINE FIELD slug ON project TYPE string;');
			await db.query('CREATE project:flagwedge SET slug = "flagwedge";');
			await db.query(`
				DEFINE TABLE pm SCHEMAFULL;
				DEFINE FIELD project ON pm TYPE option<record<project>>;
				DEFINE FIELD name ON pm TYPE option<string>;
				DEFINE FIELD authority ON pm TYPE option<string>;
				DEFINE FIELD autonomous ON pm TYPE option<bool>;
				DEFINE FIELD auto_publish_preauthorized ON pm TYPE option<bool>;
			`);
			// A row with BOTH flags NONE (never set) — the exact pre-field state.
			await db.query('CREATE pm:flagrow SET project = project:flagwedge, name = "Vesper", authority = "act";');
			const before = await db.query<[{ autonomous: unknown; auto_publish_preauthorized: unknown }[]]>(
				'SELECT autonomous, auto_publish_preauthorized FROM pm:flagrow;'
			);
			expect(before[0][0].autonomous ?? null).toBeNull();
			expect(before[0][0].auto_publish_preauthorized ?? null).toBeNull();

			// The full schema applies (m0057 + m0058 redefine the fields as non-optional bool and m0058
			// backfills the NONE rows in the SAME write so the row re-validates clean).
			await runMigrations(db, schemaMigrations);
			expect(await isApplied(db, '0058_pm_auto_publish')).toBe(true);

			const after = await db.query<[{ autonomous: boolean; auto_publish_preauthorized: boolean }[]]>(
				'SELECT autonomous, auto_publish_preauthorized FROM pm:flagrow;'
			);
			expect(after[0][0].autonomous).toBe(false); // backfilled, never NONE
			expect(after[0][0].auto_publish_preauthorized).toBe(false);

			// The bug this fixes: a write to the (now backfilled) row SUCCEEDS where it previously threw
			// "Found NONE for field ... expected a bool". This is the actual arm path.
			await db.query('UPDATE pm:flagrow MERGE { autonomous: true };');
			const armed = await db.query<[{ autonomous: boolean; auto_publish_preauthorized: boolean }[]]>(
				'SELECT autonomous, auto_publish_preauthorized FROM pm:flagrow;'
			);
			expect(armed[0][0].autonomous).toBe(true);
			expect(armed[0][0].auto_publish_preauthorized).toBe(false); // untouched flag preserved

			// Re-run is a clean no-op AND idempotent: the backfill's `WHERE … IS NONE` matches nothing
			// now, so it never clobbers the real `autonomous: true` we just set.
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
			const stable = await db.query<[{ autonomous: boolean }[]]>('SELECT autonomous FROM pm:flagrow;');
			expect(stable[0][0].autonomous).toBe(true); // a second apply did NOT reset the operator's value
		} finally {
			await db.close().catch(() => {});
		}
	});

	// ── RC-2 — m0062 pm.repo_create_preauthorized: the SAME F-015 BACKFILL discipline as m0058. ──
	// A non-optional `bool DEFAULT false` does not backfill EXISTING rows → the flag is NONE on any pm row
	// written before m0062, and a later UPDATE/MERGE then throws "Found NONE for field … expected a bool".
	// m0062 backfills the flag to false where NONE (idempotent `WHERE … IS NONE`). This reproduces a pre-
	// field pm row and asserts m0062 makes it writable again + the backfill never clobbers a real value.
	it('m0062 BACKFILLS NONE pm.repo_create_preauthorized so a pre-field pm row is writable again (F-015)', async () => {
		const db = await freshDb('mig_pm_repo_consent');
		try {
			await db.query('DEFINE TABLE project SCHEMAFULL; DEFINE FIELD slug ON project TYPE string;');
			await db.query('CREATE project:rcwedge SET slug = "rcwedge";');
			await db.query(`
				DEFINE TABLE pm SCHEMAFULL;
				DEFINE FIELD project ON pm TYPE option<record<project>>;
				DEFINE FIELD name ON pm TYPE option<string>;
				DEFINE FIELD authority ON pm TYPE option<string>;
				DEFINE FIELD repo_create_preauthorized ON pm TYPE option<bool>;
			`);
			// A row with the flag NONE (never set) — the exact pre-field state.
			await db.query('CREATE pm:rcrow SET project = project:rcwedge, name = "Vesper", authority = "act";');
			const before = await db.query<[{ repo_create_preauthorized: unknown }[]]>(
				'SELECT repo_create_preauthorized FROM pm:rcrow;'
			);
			expect(before[0][0].repo_create_preauthorized ?? null).toBeNull();

			await runMigrations(db, schemaMigrations);
			expect(await isApplied(db, '0062_pm_repo_create_preauthorized')).toBe(true);

			const after = await db.query<[{ repo_create_preauthorized: boolean }[]]>(
				'SELECT repo_create_preauthorized FROM pm:rcrow;'
			);
			expect(after[0][0].repo_create_preauthorized).toBe(false); // backfilled, never NONE

			// The bug this fixes: a write to the backfilled row SUCCEEDS where it previously threw.
			await db.query('UPDATE pm:rcrow MERGE { repo_create_preauthorized: true };');
			const set = await db.query<[{ repo_create_preauthorized: boolean }[]]>(
				'SELECT repo_create_preauthorized FROM pm:rcrow;'
			);
			expect(set[0][0].repo_create_preauthorized).toBe(true);

			// Re-run is a clean no-op AND idempotent — the backfill does not reset the operator's value.
			expect(await runMigrations(db, schemaMigrations)).toEqual([]);
			const stable = await db.query<[{ repo_create_preauthorized: boolean }[]]>(
				'SELECT repo_create_preauthorized FROM pm:rcrow;'
			);
			expect(stable[0][0].repo_create_preauthorized).toBe(true);
		} finally {
			await db.close().catch(() => {});
		}
	});
});
