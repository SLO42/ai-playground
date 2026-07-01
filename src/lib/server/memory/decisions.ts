// Brain view — recent architectural decisions reader (the `decision` table, m0023_pm §4.1b).
//
// A READ-ONLY projection of the architectural-decisions surface (title / context / rationale /
// status), newest-first, for the /brain "Decisions" section. This is a REAL data source — the
// `decision` table already carries operator/PM-authored architectural decisions (written by the
// projects PM layer); the Brain view merely surfaces the recent ones. No fabrication (F-008):
// honest empty [] when nothing has been recorded.
//
// F-013: `created_at` is a SurrealDB datetime — coerced to an ISO string here so a `load` never
// hands a raw SDK datetime to the client. F-020 #1: `created_at` is in the SELECT projection so
// the `ORDER BY created_at` idiom is legal. Boundary discipline (D-016): the LIMIT is a clamped
// integer literal (SurrealDB LIMIT does not bind a $param), never caller-controlled text.

import type { Db } from '../db/client';

/** One architectural decision, projected + serialization-safe for a SvelteKit `load` (F-013). */
export interface DecisionRow {
	id: string;
	title: string;
	/** The situation the decision addressed (option<string> → null when unset). */
	context: string | null;
	/** Why this call was made (option<string> → null when unset). */
	rationale: string | null;
	/** proposed | accepted | superseded | rejected (schema enum). */
	status: string;
	/** The owning project record id, or null (defensive — the field is required in schema). */
	project: string | null;
	/** ISO-8601 string, or null when absent (F-013 — never a raw SDK datetime). */
	createdAt: string | null;
}

/** Default number of recent decisions the Brain section surfaces. */
export const RECENT_DECISIONS_LIMIT = 8;

/** Clamp a caller limit to a safe positive integer literal for interpolation into LIMIT. */
function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return RECENT_DECISIONS_LIMIT;
	return Math.max(1, Math.min(50, Math.floor(limit)));
}

/** Coerce a possibly-record value (RecordId | string | {id}) to its string form, else null. */
function recordToString(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === 'string') return v;
	if (typeof v === 'object') {
		const asStr = (v as { toString?: () => string }).toString?.();
		if (asStr && asStr !== '[object Object]') return asStr;
		const inner = (v as { id?: unknown }).id;
		if (typeof inner === 'string') return inner;
	}
	return null;
}

/**
 * Coerce a SurrealDB 2.x datetime to a canonical ISO string, else null (F-013). The SDK returns a
 * non-POJO datetime whose `String(v)` is its RFC-3339 form — never pass that object to the client;
 * normalize through Date so the output is a plain, canonical ISO string (mirrors timeline.isoOrNull).
 */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	const s = String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalize one raw `decision` row into a serialization-safe DTO. */
function normDecision(row: Record<string, unknown>): DecisionRow {
	return {
		id: recordToString(row.id) ?? '',
		title: typeof row.title === 'string' ? row.title : '',
		context: typeof row.context === 'string' && row.context.length > 0 ? row.context : null,
		rationale:
			typeof row.rationale === 'string' && row.rationale.length > 0 ? row.rationale : null,
		status: typeof row.status === 'string' ? row.status : 'accepted',
		project: recordToString(row.project),
		createdAt: isoOrNull(row.created_at)
	};
}

/**
 * List the most recent architectural decisions across all projects, newest-first. Read-only; every
 * row traces to a real `decision` row (F-008). Returns [] honestly when none exist.
 */
export async function listRecentDecisions(
	db: Db,
	limit = RECENT_DECISIONS_LIMIT
): Promise<DecisionRow[]> {
	const n = clampLimit(limit);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, title, context, rationale, status, project, created_at FROM decision
		 ORDER BY created_at DESC LIMIT ${n};`
	);
	return (rows ?? []).map(normDecision);
}
