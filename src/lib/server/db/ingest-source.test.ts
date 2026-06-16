import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from './client';
import { runMigrations } from './migrate';
import { schemaMigrations } from './schema';
import { startTestDb, fixtureVector, type TestDb } from './testserver';

// BL-6 CANNIBALIZE-SPEC §6 VERIFY (migration half, F-015): m0042 ingest_source +
// m0043 memory provenance/utilization apply to a throwaway DB, are IDEMPOTENT
// (apply-twice = no-op via the _migration ledger), survive a HALF-APPLIED state
// (re-defining over a partial apply is a no-op — every DEFINE is OVERWRITE), and
// the additive memory fields never reset existing rows.

let tdb: TestDb;
let root: Db;

interface InfoForTable {
	fields: Record<string, string>;
	indexes: Record<string, string>;
}

async function infoForTable(table: string): Promise<InfoForTable> {
	const res = await root.query<[InfoForTable]>(`INFO FOR TABLE ${table};`);
	return res[0];
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
	await runMigrations(root, schemaMigrations);
}, 60_000);

afterAll(async () => {
	await root?.close().catch(() => {});
	await tdb?.teardown();
});

describe('m0042 ingest_source — table + schema (CANNIBALIZE-SPEC §6)', () => {
	it('defines the ingest_source table with all §6 fields + the status index', async () => {
		const info = await infoForTable('ingest_source');
		for (const f of ['kind', 'ref', 'intent', 'license', 'status', 'finding_count', 'created_at', 'completed_at']) {
			expect(info.fields[f], `field ${f} should be defined`).toBeTruthy();
		}
		expect(info.indexes['ingest_source_status']).toBeTruthy();
	});

	it('kind ASSERT accepts the four enum values and rejects others', async () => {
		for (const kind of ['url', 'repo', 'file', 'text']) {
			const rows = await root.query<[{ id: unknown }[]]>(
				`CREATE ingest_source SET kind = $k, ref = "r", intent = "i" RETURN AFTER;`,
				{ k: kind }
			);
			expect(rows[0].length).toBe(1);
		}
		await expect(
			root.query(`CREATE ingest_source SET kind = "bogus", ref = "r", intent = "i";`)
		).rejects.toThrow();
	});

	it('status defaults to "capturing" and finding_count to 0 (non-NONE §6.2) on RETURN AFTER', async () => {
		const rows = await root.query<[{ status: string; finding_count: number; completed_at: unknown }[]]>(
			`CREATE ingest_source SET kind = "text", ref = "r", intent = "i" RETURN AFTER;`
		);
		expect(rows[0][0].status).toBe('capturing');
		expect(rows[0][0].finding_count).toBe(0);
		// completed_at is option<datetime> — absent (NONE) until terminal, never str(undefined) (F-013).
		expect(rows[0][0].completed_at == null).toBe(true);
	});

	it('status ASSERT rejects an out-of-enum status', async () => {
		await expect(
			root.query(`CREATE ingest_source SET kind = "url", ref = "r", intent = "i", status = "weird";`)
		).rejects.toThrow();
	});

	// m0045 (CB2 red-team hardening) widened the status ASSERT with the NEW neutral terminal
	// 'dropped' (all-noise run, no secret) — distinct from the security 'quarantined' (F-008).
	it('m0045: status ASSERT accepts the NEW "dropped" terminal (and still all prior values)', async () => {
		for (const status of ['capturing', 'distilling', 'ingesting', 'done', 'failed', 'quarantined', 'dropped']) {
			const rows = await root.query<[{ id: unknown }[]]>(
				`CREATE ingest_source SET kind = "text", ref = "r", intent = "i", status = $s RETURN AFTER;`,
				{ s: status }
			);
			expect(rows[0].length, `status ${status} should be accepted`).toBe(1);
		}
	});
});

describe('m0043 memory provenance/utilization — additive, no row reset (F-015)', () => {
	it('adds provenance / applied_count / last_applied_at + the provenance index to memory', async () => {
		const info = await infoForTable('memory');
		expect(info.fields['provenance']).toBeTruthy();
		expect(info.fields['applied_count']).toBeTruthy();
		expect(info.fields['last_applied_at']).toBeTruthy();
		expect(info.indexes['memory_by_provenance']).toBeTruthy();
	});

	it('a non-ingested memory row leaves provenance/last_applied_at NONE and applied_count at DEFAULT 0', async () => {
		const rows = await root.query<[{ applied_count: number; provenance: unknown; last_applied_at: unknown }[]]>(
			`CREATE memory SET content = "c", embedding = $e, namespace = "n" RETURN AFTER;`,
			{ e: fixtureVector(1) }
		);
		expect(rows[0][0].applied_count).toBe(0);
		expect(rows[0][0].provenance == null).toBe(true);
		expect(rows[0][0].last_applied_at == null).toBe(true);
	});

	it('an ingested memory links provenance and the utilization increment is non-NONE (mark-applied loop)', async () => {
		const src = await root.query<[{ id: unknown }[]]>(
			`CREATE ingest_source SET kind = "url", ref = "https://example.com", intent = "i" RETURN AFTER;`
		);
		const srcId = String(src[0][0].id);
		const mem = await root.query<[{ id: unknown }[]]>(
			`CREATE memory SET content = "finding", embedding = $e, namespace = "n", provenance = type::thing("ingest_source", $sid) RETURN AFTER;`,
			{ e: fixtureVector(2), sid: srcId.split(':')[1] }
		);
		const memId = String(mem[0][0].id);
		// RETURN-AFTER increment must MATCH (applied_count never NONE → no starvation, §6.2).
		const inc = await root.query<[{ applied_count: number }[]]>(
			`UPDATE type::thing("memory", $mid) SET applied_count += 1, last_applied_at = time::now() RETURN AFTER;`,
			{ mid: memId.split(':')[1] }
		);
		expect(inc[0][0].applied_count).toBe(1);
	});
});

describe('idempotency + half-applied recovery (F-015)', () => {
	it('apply-twice is a no-op (ledger skips already-applied)', async () => {
		const applied = await runMigrations(root, schemaMigrations);
		expect(applied).toEqual([]); // every migration already applied
	});

	it('recovers from a HALF-APPLIED m0042 — re-defining the table/fields over a partial state is a no-op', async () => {
		// Simulate a partial apply: the table exists but a field/index never landed and the
		// migration was NEVER recorded in _migration (the F-015 wedge scenario).
		await root.query(`
			REMOVE TABLE IF EXISTS ingest_source_halfapplied;
			DEFINE TABLE OVERWRITE ingest_source_halfapplied SCHEMAFULL;
			DEFINE FIELD OVERWRITE kind ON ingest_source_halfapplied TYPE string;
		`);
		// Now run the FULL m0042 body against this half-applied table name — OVERWRITE makes
		// every statement a safe redefine (no "already exists" wedge, the m0025 class).
		const fullBody = `
			DEFINE TABLE OVERWRITE ingest_source_halfapplied SCHEMAFULL;
			DEFINE FIELD OVERWRITE kind   ON ingest_source_halfapplied TYPE string
				ASSERT $value IN ["url","repo","file","text"];
			DEFINE FIELD OVERWRITE ref    ON ingest_source_halfapplied TYPE string;
			DEFINE FIELD OVERWRITE intent ON ingest_source_halfapplied TYPE string;
			DEFINE FIELD OVERWRITE status ON ingest_source_halfapplied TYPE string DEFAULT "capturing"
				ASSERT $value IN ["capturing","distilling","ingesting","done","failed","quarantined"];
			DEFINE FIELD OVERWRITE finding_count ON ingest_source_halfapplied TYPE int DEFAULT 0;
		`;
		// Applies cleanly over the half-applied state (no throw), and again (idempotent).
		await expect(root.query(fullBody)).resolves.toBeTruthy();
		await expect(root.query(fullBody)).resolves.toBeTruthy();
		const info = await infoForTable('ingest_source_halfapplied');
		expect(info.fields['status']).toBeTruthy();
		expect(info.fields['finding_count']).toBeTruthy();
		await root.query(`REMOVE TABLE IF EXISTS ingest_source_halfapplied;`);
	});
});
