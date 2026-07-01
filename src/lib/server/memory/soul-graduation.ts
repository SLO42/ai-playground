// Stage S4 — soul GRADUATION HISTORY (provenance/timeline over the compute-on-read self-model).
//
// soul.ts derives Atelier's CURRENT `maturity_stage` on read (nascent/developing/established) but
// keeps NO record of WHEN it graduated. This module is the additive provenance layer: a small
// `soul_graduation` table (m0078) that records one row each time the derived stage CROSSES a
// boundary, with the metric SNAPSHOT at that moment. `/brain` (and later the scene scrubber) reads
// it as a growth timeline — the identity's history, not just its current frame ("Atelier feels
// ALIVE").
//
// THE RECORDER SEAM (fail-open, F-014/F-048). `recordGraduationIfChanged` runs on the heartbeat's
// FAST-tier drain (orchestrator #runReviewItem, right AFTER runReviewFork grows the brain — the
// natural periodic "did the stage change?" pass; NOT a new daemon). It is DEDUP-SAFE: it compares
// the freshly-derived stage to the LAST recorded `to_stage` (or the `nascent` baseline when none)
// and appends EXACTLY ONE row only on a change — re-running at the same stage is a no-op. It is
// FAIL-OPEN by contract: ANY DB fault (or a dedup/unique collision from a concurrent twin, F-048)
// is absorbed to a null return — a brain-history write must NEVER crash the drain loop.
//
// HONEST both ways (F-008): an upward promotion AND a (rare) downward regression are recorded as the
// truth — the field is `from_stage`→`to_stage`, whichever direction. F-013: `graduated_at` is coerced
// to an ISO string in the reader normalizer (never a raw SDK datetime out of a load). F-020 #1: every
// ORDER BY field is in the SELECT projection.

import type { Db } from '../db/client';
import { readSoulMetrics, deriveMaturityStage, computeCompetence, type MaturityStage } from './soul';

/** The baseline stage assumed when no graduation has ever been recorded (a fresh/cold identity). */
export const BASELINE_STAGE: MaturityStage = 'nascent';

/**
 * The soul SUBJECT for the Atelier global brain (the only subject written/read THIS build). Rows are
 * subject-keyed from the start so a future PM-soul build writes `project:<id>` subjects + derives
 * project-scoped souls with zero schema change (m0078). The dedup guard + reads are per-subject.
 */
export const ATELIER_SUBJECT = 'atelier';

/** Default number of graduation events the /brain timeline surfaces (newest-first, bounded). */
export const GRADUATION_TIMELINE_LIMIT = 12;

/** One recorded graduation event, projected + serialization-safe for a SvelteKit `load` (F-013). */
export interface GraduationRow {
	id: string;
	/** WHOSE identity graduated — "atelier" (global) or "project:<id>" (a PM soul, future). */
	subject: string;
	/** The stage graduated FROM (the prior recorded stage, or the nascent baseline). */
	fromStage: string;
	/** The stage graduated TO (the derived stage at record time). */
	toStage: string;
	/** Metric snapshot at graduation — all live counts (F-008). */
	concepts: number;
	corrections: number;
	causalChains: number;
	sessions: number;
	/** Recall competence in [0,1] at graduation, or null when the sample was too small. */
	competence: number | null;
	/** ISO-8601 string, or null when absent (F-013 — never a raw SDK datetime). */
	graduatedAt: string | null;
}

/** The event {@link recordGraduationIfChanged} appends (a subset — what the caller/audit needs). */
export interface RecordedGraduation {
	subject: string;
	fromStage: MaturityStage;
	toStage: MaturityStage;
}

/** Clamp a caller limit to a safe positive integer literal for interpolation into LIMIT (D-016). */
function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return GRADUATION_TIMELINE_LIMIT;
	return Math.max(1, Math.min(100, Math.floor(limit)));
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
 * Coerce a SurrealDB 2.x datetime to a canonical ISO string, else null (F-013). Mirrors
 * decisions.isoOrNull / timeline.isoOrNull — never hand a raw SDK datetime to the client.
 */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	const s = String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toInt(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** Normalize one raw `soul_graduation` row into a serialization-safe DTO. */
function normGraduation(row: Record<string, unknown>): GraduationRow {
	return {
		id: recordToString(row.id) ?? '',
		subject: typeof row.subject === 'string' ? row.subject : ATELIER_SUBJECT,
		fromStage: typeof row.from_stage === 'string' ? row.from_stage : '',
		toStage: typeof row.to_stage === 'string' ? row.to_stage : '',
		concepts: toInt(row.concepts),
		corrections: toInt(row.corrections),
		causalChains: toInt(row.causal_chains),
		sessions: toInt(row.sessions),
		competence: typeof row.competence === 'number' && Number.isFinite(row.competence) ? row.competence : null,
		graduatedAt: isoOrNull(row.graduated_at)
	};
}

/**
 * The stage of the MOST RECENT recorded graduation FOR `subject` (its `to_stage`), or null when the
 * subject has never graduated. `graduated_at` is in the projection so the `ORDER BY graduated_at`
 * idiom is legal (F-020 #1); the subject is bound via $param (D-016 boundary discipline).
 */
export async function readLatestGraduationStage(
	db: Db,
	subject: string = ATELIER_SUBJECT
): Promise<MaturityStage | null> {
	const [rows] = await db.query<[Array<{ to_stage?: unknown; graduated_at?: unknown }>]>(
		`SELECT to_stage, graduated_at FROM soul_graduation
		   WHERE subject = $subject ORDER BY graduated_at DESC LIMIT 1;`,
		{ subject }
	);
	const s = rows?.[0]?.to_stage;
	return typeof s === 'string' ? (s as MaturityStage) : null;
}

/**
 * List recent graduation events for `subject`, NEWEST-FIRST (F-020 #1: `graduated_at` is in the
 * projection). Read-only; every row traces to a real recorded transition (F-008). Returns []
 * honestly when the subject has never graduated. THIS build reads only the atelier subject.
 */
export async function listGraduations(
	db: Db,
	subject: string = ATELIER_SUBJECT,
	limit = GRADUATION_TIMELINE_LIMIT
): Promise<GraduationRow[]> {
	const n = clampLimit(limit);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, subject, from_stage, to_stage, concepts, corrections, causal_chains, sessions, competence, graduated_at
		   FROM soul_graduation
		   WHERE subject = $subject
		 ORDER BY graduated_at DESC LIMIT ${n};`,
		{ subject }
	);
	return (rows ?? []).map(normGraduation);
}

/**
 * THE RECORDER (heartbeat fast-tier seam). Derive the CURRENT maturity stage from the live brain,
 * compare to the last recorded `to_stage` FOR `subject` (or the {@link BASELINE_STAGE} nascent
 * baseline when the subject has no history), and append EXACTLY ONE `soul_graduation` row iff the
 * stage CHANGED. Returns the recorded transition, or null when nothing changed (or on any absorbed
 * fault). `subject` is the storage key and `project` is the metric SCOPE: omit both for the ATELIER
 * global soul; pass a project id (see {@link recordProjectGraduationIfChanged}) for a per-PM soul,
 * which derives from THAT project's slice of the brain (readSoulMetrics(db, project)) — never global.
 *
 * IDEMPOTENT + DEDUP-SAFE (PER-SUBJECT): the last-recorded-stage guard is scoped to `subject`, so
 * re-running the pass at the same stage records nothing and an atelier graduation never collides
 * with a future PM graduation. FAIL-OPEN (F-014/F-048): this function NEVER throws — a DB fault
 * (unreachable DB, a concurrent twin's dedup/unique collision) is absorbed to a null return so a
 * brain-history write can never crash the drain loop. HONEST direction (F-008): a downward
 * regression is recorded too.
 */
export async function recordGraduationIfChanged(
	db: Db,
	subject: string = ATELIER_SUBJECT,
	project?: string
): Promise<RecordedGraduation | null> {
	try {
		const metrics = await readSoulMetrics(db, project);
		const { stage } = deriveMaturityStage(metrics);
		const last = (await readLatestGraduationStage(db, subject)) ?? BASELINE_STAGE;
		if (stage === last) return null; // no boundary crossed → nothing to record

		const competence = computeCompetence(metrics); // number | null
		const content: Record<string, unknown> = {
			subject,
			from_stage: last,
			to_stage: stage,
			concepts: metrics.concepts,
			corrections: metrics.corrections,
			causal_chains: metrics.causalChains,
			sessions: metrics.sessions
			// competence set below only when known (option<float> → NONE when the sample is too small)
		};
		if (competence !== null) content.competence = competence;

		await db.query(`CREATE soul_graduation CONTENT $content RETURN NONE;`, { content });
		return { subject, fromStage: last, toStage: stage };
	} catch {
		// FAIL-OPEN (F-014/F-048): a history write must never crash the heartbeat. A concurrent twin
		// that recorded the SAME transition first (or any DB fault) is absorbed as a silent no-op —
		// the next pass re-checks against the now-current last stage and stays consistent.
		return null;
	}
}

/**
 * The soul SUBJECT key for a project's PM identity. The project record id ("project:<slug>") IS the
 * key — it is unique per project, already distinct from {@link ATELIER_SUBJECT} ("atelier"), and
 * needs no transform. Centralized so the recorder and every reader derive the SAME key from a
 * project id (no drift between the write seam and the project-page read).
 */
export function projectSubject(projectId: string): string {
	return projectId;
}

/**
 * Record a PROJECT's PM-soul graduation if its project-scoped maturity stage crossed a boundary.
 * Thin wrapper over {@link recordGraduationIfChanged}: the subject is the project record id
 * ({@link projectSubject}) and the metric scope is that same project — so the derived stage is the
 * project's own (per-PM identity), never the global Atelier stage. Same fail-open + per-subject
 * dedup contract; returns null when the stage is unchanged or a fault is absorbed.
 */
export async function recordProjectGraduationIfChanged(
	db: Db,
	projectId: string
): Promise<RecordedGraduation | null> {
	return recordGraduationIfChanged(db, projectSubject(projectId), projectId);
}
