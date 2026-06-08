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
 * Validate both endpoints of a RELATE edge (D-016 explicitly covers RELATE).
 * @returns the validated [from, to] pair.
 * @throws {IdentifierError} if either endpoint is malformed.
 */
export function assertEdgeId(from: unknown, to: unknown): [string, string] {
	return [assertRecordId(from), assertRecordId(to)];
}
