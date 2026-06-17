// D-016 — record-id / table-name validation guard (SEC-006, the SurrealDB analog
// of D-008's "no string-interpolated shell").
//
// Rule: ALL values pass via SDK parameter binding ($param) — NEVER interpolated.
// ONLY validated table-names and record-ids may be interpolated into a query,
// and ONLY after passing the strict regex at this single chokepoint. This module
// IS that chokepoint; it errors loudly at the call site on any violation.
//
// Covers: RELATE endpoints (both edge record-ids), dynamic table-name selection
// (per-table vector search), and FTS (search terms are bound as $param, never
// interpolated — so they never reach this guard).

/** Table name: lowercase letters/digits/underscore, must start with a letter or underscore. */
const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

/** Record id: `<table>:<id>`, each part lowercase snake-case (KongCode pattern). */
const RECORD_ID_RE = /^[a-z_][a-z0-9_]*:[a-z0-9_]+$/;

/** Thrown when an identifier fails the D-016 validation guard. Fail loud. */
export class IdentifierError extends Error {
	override readonly name = 'IdentifierError';
	constructor(
		message: string,
		readonly value: unknown
	) {
		super(message);
	}
}

/**
 * Validate a table name before it may be interpolated into a query string.
 * @returns the name unchanged on success.
 * @throws {IdentifierError} on any non-conforming value.
 */
export function assertTableName(name: unknown): string {
	if (typeof name !== 'string' || !TABLE_RE.test(name)) {
		throw new IdentifierError(
			`Invalid table name for interpolation: ${JSON.stringify(name)} ` +
				`(must match ${TABLE_RE} — D-016). Use $param binding for values.`,
			name
		);
	}
	return name;
}

/**
 * Validate a record id (`table:id`) before it may be interpolated into a query.
 * @returns the id unchanged on success.
 * @throws {IdentifierError} on any non-conforming value.
 */
export function assertRecordId(id: unknown): string {
	if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
		throw new IdentifierError(
			`Invalid record id for interpolation: ${JSON.stringify(id)} ` +
				`(must match ${RECORD_ID_RE} — D-016). Use $param binding for values.`,
			id
		);
	}
	return id;
}

/**
 * Validate that a record id is well-formed AND belongs to a SPECIFIC table — the
 * project-scoped chokepoint (D-016 gap, BL-3 hardening). `assertRecordId` validates
 * the `table:id` SHAPE but not WHICH table, so a cross-type id (e.g. `role:x`) passes
 * the generic guard and would run a wrong-table lookup. Where a caller REQUIRES an id
 * of a given table (e.g. a projectId must be a `project:…`), use this: it runs
 * `assertRecordId` (shape) AND asserts the id's table-prefix equals `assertTableName(table)`,
 * throwing an IdentifierError that NAMES the expected-vs-actual table.
 *
 * Do NOT use this to narrow the generic `assertRecordId`/`link()` paths — those serve
 * many tables. This is the additive, table-scoped path for callers that demand one table.
 *
 * @returns the id unchanged on success.
 * @throws {IdentifierError} when the id is malformed OR its table-prefix ≠ `table`.
 */
export function assertRecordIdOfTable(id: unknown, table: string): string {
	const validTable = assertTableName(table); // the expected table must itself be valid.
	const validId = assertRecordId(id); // shape first — malformed ids fail here, named.
	const actualTable = validId.slice(0, validId.indexOf(':'));
	if (actualTable !== validTable) {
		throw new IdentifierError(
			`Record id ${JSON.stringify(validId)} is in table '${actualTable}', ` +
				`but a '${validTable}' record id is required here (D-016 table-scope guard).`,
			id
		);
	}
	return validId;
}

/**
 * Validate both endpoints of a RELATE edge (D-016 explicitly covers RELATE).
 * @returns the validated [from, to] pair.
 * @throws {IdentifierError} if either endpoint is malformed.
 */
export function assertEdgeId(from: unknown, to: unknown): [string, string] {
	return [assertRecordId(from), assertRecordId(to)];
}
