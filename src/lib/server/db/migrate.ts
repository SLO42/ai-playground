// Idempotent migration runner (TASK 0.b, D-006) with the MEMORY-SPEC §6 gotchas
// baked in so every downstream migration inherits them:
//
//   §6.2  option<T>-or-DEFAULT discipline — any boolean/enum read back on a
//         `RETURN AFTER` write MUST be `option<T>` or carry a concrete non-NONE
//         DEFAULT, never a bare typed field that can land in NONE (claim
//         starvation, §6.3). `defineFlagField()` enforces this at authoring time.
//   §6.4  idempotent migrations — one-time table-scan UPDATEs gated behind
//         `LET $c + IF $c > 0` so re-running is a no-op. `guardedScan()` emits
//         that wrapper; the runner also records applied migrations in `_migration`
//         and skips them on re-run.
//   §6.5  dedup_key VALUE backfill — a VALUE field only recomputes on write, so a
//         freshly-added VALUE field is NONE on existing rows until touched.
//         `backfillValueField()` emits the no-op touch-UPDATE.
//
// DDL runs ONLY under the provisioning/root connection (D-026c) — never the
// least-priv runtime user. The runner therefore takes its own root `Db`.

import { Db } from './client';
import { assertTableName } from './validate';

/** A single migration: a stable id (also its dedup/ordering key) + its statements. */
export interface Migration {
	/** Unique, stable, ordered id, e.g. `0001_core_tables`. Snake-case. */
	id: string;
	/** SurrealQL run inside one transaction. Authored with the §6 helpers below. */
	up: string;
}

const MIGRATION_TABLE = '_migration';

/** DDL that defines the migration-ledger table. Idempotent (OVERWRITE). */
function ledgerDdl(): string {
	// `applied_at` carries a concrete DEFAULT (never NONE — §6.2). dedup on `id`.
	return `
		DEFINE TABLE OVERWRITE ${MIGRATION_TABLE} SCHEMAFULL;
		DEFINE FIELD OVERWRITE id_str     ON ${MIGRATION_TABLE} TYPE string;
		DEFINE FIELD OVERWRITE applied_at ON ${MIGRATION_TABLE} TYPE datetime DEFAULT time::now();
		DEFINE INDEX OVERWRITE mig_id ON ${MIGRATION_TABLE} FIELDS id_str UNIQUE;
	`;
}

/**
 * Apply a list of migrations in order against a ROOT connection (D-026c: DDL is
 * root-only). Each migration runs in its own transaction and is recorded in
 * `_migration`; already-applied ids are skipped, so re-running is a no-op even
 * across process restarts. Returns the ids that were applied this run.
 */
export async function runMigrations(root: Db, migrations: Migration[]): Promise<string[]> {
	await root.query(ledgerDdl());

	const appliedRows = await root.query<[{ id_str: string }[]]>(
		`SELECT id_str FROM ${MIGRATION_TABLE};`
	);
	const already = new Set((appliedRows[0] ?? []).map((r) => r.id_str));

	const applied: string[] = [];
	for (const m of migrations) {
		if (already.has(m.id)) continue;
		// Each migration + its ledger insert in ONE transaction: a failed migration
		// never records itself as applied.
		const surql = `BEGIN;\n${m.up}\nCREATE ${MIGRATION_TABLE} SET id_str = $mig_id;\nCOMMIT;`;
		await root.query(surql, { mig_id: m.id });
		applied.push(m.id);
	}
	return applied;
}

/** True if a migration id is recorded as applied. */
export async function isApplied(root: Db, id: string): Promise<boolean> {
	const rows = await root.query<[{ id_str: string }[]]>(
		`SELECT id_str FROM ${MIGRATION_TABLE} WHERE id_str = $id;`,
		{ id }
	);
	return (rows[0] ?? []).length > 0;
}

// ── §6 gotcha helpers — authoring primitives for downstream migrations ───────

/**
 * §6.2 / §6.3 — define a boolean/enum field that is SAFE to read back on a
 * `RETURN AFTER` write. EITHER `option<T>` (legitimately absent on some rows) OR
 * a concrete non-NONE DEFAULT — never a bare typed field that can land in NONE
 * (which would silently never match a `WHERE field = …` claim → claim starvation).
 *
 * @param table   validated table name
 * @param field   field name
 * @param type    base type, e.g. 'bool' | 'string'
 * @param opts    EITHER `{ optional: true }` OR `{ default: <SurrealQL literal> }`
 */
export function defineFlagField(
	table: string,
	field: string,
	type: string,
	opts: { optional: true } | { default: string }
): string {
	const t = assertTableName(table);
	if ('optional' in opts) {
		return `DEFINE FIELD OVERWRITE ${field} ON ${t} TYPE option<${type}>;`;
	}
	if (opts.default === undefined || opts.default === null || `${opts.default}`.trim() === '') {
		throw new Error(
			`defineFlagField(${t}.${field}): a non-NONE DEFAULT is required when not optional (§6.2).`
		);
	}
	return `DEFINE FIELD OVERWRITE ${field} ON ${t} TYPE ${type} DEFAULT ${opts.default};`;
}

/**
 * §6.4 — wrap a one-time table-scan UPDATE so re-running the migration is a
 * no-op: only runs while there are still rows matching `whereUnmigrated`.
 * `update` is the body of an `UPDATE <table> SET …`; bind values via $param.
 *
 * @param table            validated table name
 * @param whereUnmigrated  predicate selecting not-yet-migrated rows
 * @param setClause        the `SET …` body to apply to those rows
 */
export function guardedScan(table: string, whereUnmigrated: string, setClause: string): string {
	const t = assertTableName(table);
	return (
		`LET $unmigrated = (SELECT count() AS n FROM ${t} WHERE ${whereUnmigrated} GROUP ALL)[0].n ?? 0;\n` +
		`IF $unmigrated > 0 { UPDATE ${t} SET ${setClause} WHERE ${whereUnmigrated}; };`
	);
}

/**
 * §6.5 — backfill a computed `VALUE` field on pre-existing rows. A VALUE field is
 * only (re)computed on write, so after adding it, existing rows hold NONE until
 * touched. This emits the idempotent no-op touch-UPDATE that forces recompute.
 * Guarded behind a count so it is itself a no-op once every row has the field.
 *
 * @param table  validated table name
 * @param field  the VALUE field that needs recomputing on existing rows
 */
export function backfillValueField(table: string, field: string): string {
	const t = assertTableName(table);
	// Touch only rows where the VALUE field is still NONE (un-backfilled).
	return (
		`LET $missing = (SELECT count() AS n FROM ${t} WHERE ${field} IS NONE GROUP ALL)[0].n ?? 0;\n` +
		`IF $missing > 0 { UPDATE ${t} SET _touch = time::now() WHERE ${field} IS NONE; };`
	);
}
