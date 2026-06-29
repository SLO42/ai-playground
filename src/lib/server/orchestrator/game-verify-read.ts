// GAME-VERIFY read-side — surface the persisted verdict in the project command-center (GV-4,
// spec: docs/GAME-VERIFY-SPEC.md §"Orchestrator integration", last bullet: "Surfaced in the project
// command-center: the verdict + screened log tail (operator visibility)").
//
// GV-3 (game-verify-step.ts) PERSISTS each run as an `agent_event` (type='completion',
// detail.reason='game-verify', linked to the project + session). This is the READER that the
// /projects/[id] loader calls to show the latest verdict(s). It is DISPLAY-ONLY: the logTail /
// stackTraces in the persisted detail were ALREADY screened by the runner (GV-2, D-026) before
// they were written — this reader NEVER re-fetches a raw log and NEVER re-screens; it normalizes
// the stored POJO into a plain, serializable shape and hands it to the UI.
//
// DISCIPLINE:
//   • F-013: the agent_event `at` datetime is coerced to an ISO string (never a raw SDK datetime,
//     never str(undefined)) — absent ⇒ null ⇒ the UI renders '—'.
//   • F-008 honest states: the persisted outcome is read faithfully; a missing/unknown outcome is
//     surfaced as 'unknown' (a neutral state), NEVER coerced to a fabricated 'pass'. Booleans/counts
//     default to their honest zero/false, not an invented value.
//   • SHADOW PATHS: nil detail, an empty detail object, and a malformed/legacy row all normalize to
//     an honest verdict row (unknown outcome, zero counts, empty arrays) rather than throwing.
//   • D-016: the projectId is validated at the boundary and bound as a StringRecordId (a true record
//     link), never interpolated.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { GameVerifyOutcome } from './game-verify';

/** The honest read-side outcome — the persisted GameVerifyOutcome, plus 'unknown' for a
 *  missing/legacy/malformed row (F-008 — an absent outcome is never read as a pass). */
export type GameVerifyVerdictOutcome = GameVerifyOutcome | 'unknown';

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<GameVerifyOutcome>([
	'pass',
	'errors',
	'not_ready',
	'crashed',
	'timeout'
]);

/** One persisted game-verify verdict, normalized for the command-center surface (plain + serializable). */
export interface GameVerifyVerdictRow {
	/** The agent_event id — the stable #each key. */
	id: string;
	/** When the verdict was persisted (ISO string), or null when absent/unparseable (F-013). */
	at: string | null;
	/** The honest outcome (pass | errors | not_ready | crashed | timeout | unknown). */
	outcome: GameVerifyVerdictOutcome;
	/** The ready_pattern was seen. */
	ready: boolean;
	/** A success/load pattern matched. */
	loaded: boolean;
	/** Total error-pattern matches. */
	errorCount: number;
	/** Per-pattern match counts (success + error), keyed by the raw pattern source. */
	byPattern: Record<string, number>;
	/** First N lines after each error class — ALREADY screened by the runner (D-026); display-only. */
	stackTraces: string[];
	/** A short tail of the log — ALREADY screened by the runner (D-026); '' when none. */
	logTail: string;
	/** Honest human-readable reason (config/env note), or null when absent. */
	note: string | null;
	/** Deploy steps that copied an artifact (source→target), for operator visibility. */
	deployed: { source: string; target: string }[];
	/** The mod task this verdict was for, or null. */
	taskId: string | null;
}

/** Coerce a (possibly SurrealDB-datetime) value to a clean ISO string, or null (F-013). */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	const t = new Date(String(v)).getTime();
	return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Honest int coercion: a finite non-negative integer, else 0 (never NaN/negative/fabricated). */
function intOrZero(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Normalize the stored detail.by_pattern object → a clean Record<string, number> (drops junk). */
function normByPattern(v: unknown): Record<string, number> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
	const out: Record<string, number> = {};
	for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
		out[k] = intOrZero(raw);
	}
	return out;
}

/** Normalize a stored string[] (stack traces) → only the string entries (defensive). */
function normStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string');
}

/** Normalize the stored deployed[] → {source,target}[] (drops malformed entries). */
function normDeployed(v: unknown): { source: string; target: string }[] {
	if (!Array.isArray(v)) return [];
	const out: { source: string; target: string }[] = [];
	for (const entry of v) {
		if (entry && typeof entry === 'object') {
			const e = entry as Record<string, unknown>;
			if (typeof e.source === 'string' && typeof e.target === 'string') {
				out.push({ source: e.source, target: e.target });
			}
		}
	}
	return out;
}

/** Turn one persisted agent_event row into an honest, serializable verdict row (shadow-path safe). */
function normVerdictRow(r: Record<string, unknown>): GameVerifyVerdictRow {
	const d = (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>;
	const rawOutcome = typeof d.outcome === 'string' ? d.outcome : '';
	const outcome: GameVerifyVerdictOutcome = KNOWN_OUTCOMES.has(rawOutcome)
		? (rawOutcome as GameVerifyOutcome)
		: 'unknown';
	const note = typeof d.note === 'string' && d.note.trim() ? d.note : null;
	return {
		id: String(r.id),
		at: isoOrNull(r.at),
		outcome,
		ready: d.ready === true,
		loaded: d.loaded === true,
		errorCount: intOrZero(d.error_count),
		byPattern: normByPattern(d.by_pattern),
		stackTraces: normStringArray(d.stack_traces),
		logTail: typeof d.log_tail === 'string' ? d.log_tail : '',
		note,
		deployed: normDeployed(d.deployed),
		taskId: d.taskId == null ? null : String(d.taskId)
	};
}

/**
 * List the latest persisted game-verify verdicts for a project, newest first (default 5).
 *
 * Reads the GV-3-persisted `agent_event` rows (type='completion', detail.reason='game-verify').
 * Returns `[]` when the project has never run a game-verify (the honest "not yet run" / "not
 * configured" empty — the loader distinguishes the two via the project's `game_verify` config).
 * DISPLAY-ONLY: the verdict's logTail / stackTraces were screened by the runner before persistence
 * (D-026) — this NEVER re-fetches a raw log. The `at` datetime is ISO-coerced (F-013).
 */
export async function listGameVerifyVerdicts(
	db: Db,
	projectId: string,
	limit = 5
): Promise<GameVerifyVerdictRow[]> {
	const project = new StringRecordId(assertRecordId(projectId));
	const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, detail, at
		   FROM agent_event
		   WHERE project = $project AND type = 'completion' AND detail.reason = 'game-verify'
		   ORDER BY at DESC
		   LIMIT $lim;`,
		{ project, lim }
	);
	return (rows ?? []).map(normVerdictRow);
}
