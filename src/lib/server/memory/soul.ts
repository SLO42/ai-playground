// Stage S4 — soul / identity graduation (COGNITIVE-ARCHITECTURE §5, laqrumcode PATTERN as a
// LAYER over the existing brain; F-008, D-026).
//
// The "soul" is Atelier's SELF-MODEL — but a DERIVED one, computed from the rows it has actually
// accumulated, never an authored persona. Three honest ingredients:
//   • what it KNOWS ABOUT     — the dominant `concept` rows (S3, m0073), by importance/stability/access.
//   • what it has LEARNED     — corrections-as-memory (`memory.category = "correction"`, m0073): the
//                               values/scars, "what NOT to do".
//   • how COMPETENT it is      — a recall-quality signal from `retrieval_outcome` (utilization rate).
// plus experience VOLUME (concepts / corrections / causal chains / sessions). A `maturity_stage`
// graduates on MEASURABLE count thresholds over those rows — nothing is asserted the brain doesn't
// back. A cold/empty brain yields an honest "nascent — insufficient history", NEVER an invented
// personality (F-008).
//
// PERSISTENCE — compute-on-read, NO migration (justified). The soul is a pure PROJECTION of live
// brain rows: a handful of `count()` reads + two small `ORDER BY … LIMIT` selects. Computing it on
// read is cheap, ALWAYS current (zero staleness — a persisted snapshot would drift from the live
// brain), and sidesteps F-013 (no datetime out of a load) and F-015 (no migration) entirely. A
// persisted `soul`/`maturity_stage` HISTORY table (graduation-event provenance + a scene timeline)
// is a clean additive follow-up, deferred — the concierge (the only consumer today) needs only the
// CURRENT self-model at turn time.
//
// D-026: only screen_status="clean" rows are read (a quarantined concept/correction never enters the
// self-model); the ASSEMBLED block is re-screened before it leaves the process (belt + suspenders).
// Boundary discipline (D-016): every value via $param; counts read defensively (empty GROUP ALL → 0).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from './screen';

// Bind a project id as a StringRecordId so the SDK serializes it as a true record link (matching the
// `option<record<project>>` column type) — a bare string would not equal a record link. D-016: the
// id flows through assertRecordId first. Mirrors atelier/timeline.ts and memory/recall.ts.
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── The derived self-model + the maturity ladder ─────────────────────────────────────────

/** The maturity ladder — a small ORDINAL of graduation stages, lowest → highest. */
export type MaturityStage = 'nascent' | 'developing' | 'established';

/** The measurable brain-volume counts the soul + maturity ladder are derived from (all live rows). */
export interface SoulMetrics {
	/** active + clean `concept` rows (what Atelier knows about). */
	concepts: number;
	/** active + clean correction memories (`memory.category = "correction"`) — learned values. */
	corrections: number;
	/** `causal_chain` rows — internalized cause→effect. */
	causalChains: number;
	/** `session` rows — operating experience volume. */
	sessions: number;
	/** total `retrieval_outcome` rows — the competence-signal sample size. */
	retrievalOutcomes: number;
	/** `retrieval_outcome` rows where the recalled item was actually utilized (competence numerator). */
	utilizedOutcomes: number;
}

/** A dominant concept the self-model "knows about" (a projection of a `concept` row). */
export interface DominantConcept {
	label: string;
	importance: number;
	stability: number;
	accessCount: number;
}

/** A learned value/scar (a projection of a correction `memory` row). */
export interface LearnedValue {
	/** The (already-screened) correction body, excerpted for the self-model. */
	text: string;
	importance: number;
}

/** One maturity-gate outcome — a named, measurable threshold + whether the live counts pass it. */
export interface MaturityGateResult {
	gate: string;
	pass: boolean;
	detail: string;
}

/** The full derived self-model handed to the concierge (all fields trace to real rows; F-008). */
export interface SoulModel {
	maturityStage: MaturityStage;
	/** Convenience: the brain has no accumulated identity yet (stage === 'nascent'). */
	nascent: boolean;
	/** Dominant concept labels — what Atelier knows about. */
	knowsAbout: string[];
	/** Learned-value excerpts — what it learned NOT to do. */
	values: string[];
	/** Recall competence in [0,1] (utilization rate), or null when the outcome sample is too small. */
	competence: number | null;
	/** The raw honest counts the model is derived from. */
	experience: SoulMetrics;
	/** Per-gate evidence for the NEXT stage (provenance — surfaced in a brain panel / report). */
	gates: MaturityGateResult[];
	/** A one-line honest self-description composed deterministically from the counts. */
	summary: string;
}

// ── Thresholds (documented, tunable) — laqrumcode-shaped: 7 volume gates + 1 quality gate ──
//
// Deliberately MODEST for an early brain and honest: the live brain will most likely compute
// "nascent" today, and the identity RICHENS automatically as the heartbeat accrues concepts /
// corrections / causal chains / sessions. Each gate is a single measurable count (AND-combined
// per stage — a brain rich in only ONE dimension is not yet a rounded identity).

/** DEVELOPING — has begun to accumulate a genuine cross-dimensional identity (4 volume gates). */
export const DEVELOPING_GATES = {
	concepts: 5,
	corrections: 1,
	causalChains: 3,
	sessions: 10
} as const;

/** ESTABLISHED — a settled, load-bearing identity (3 more volume gates + 1 quality gate). */
export const ESTABLISHED_GATES = {
	concepts: 25,
	corrections: 5,
	sessions: 50,
	/** Recall must actually WORK: utilization rate over a real sample (prevents "big but incompetent"). */
	competence: 0.85
} as const;

/** Min `retrieval_outcome` sample before a competence number is trustworthy (else competence = null). */
export const MIN_COMPETENCE_SAMPLE = 20;

/** How many dominant concepts / learned values the self-model surfaces (bounds the concierge block). */
export const SOUL_KNOWS_ABOUT_LIMIT = 5;
export const SOUL_VALUES_LIMIT = 3;
/** Max characters of a correction body carried into the self-model (bounded). */
const VALUE_EXCERPT_MAX = 110;

/**
 * Recall competence in [0,1] — the fraction of retrieval outcomes that were utilized. Returns null
 * (HONEST "unknown", F-008) when the sample is below {@link MIN_COMPETENCE_SAMPLE} — a competence
 * number off 2 outcomes would be noise, not a signal.
 */
export function computeCompetence(m: SoulMetrics): number | null {
	if (m.retrievalOutcomes < MIN_COMPETENCE_SAMPLE || m.retrievalOutcomes <= 0) return null;
	return m.utilizedOutcomes / m.retrievalOutcomes;
}

/**
 * Derive the maturity stage + the per-gate evidence for the next unmet stage. Pure + deterministic:
 * the highest stage whose EVERY gate passes wins; a cold brain stays `nascent`. The returned `gates`
 * describe the gates for the FIRST unmet stage (what it needs to graduate next) — for `established`
 * they describe the established gates (already met).
 */
export function deriveMaturityStage(m: SoulMetrics): {
	stage: MaturityStage;
	gates: MaturityGateResult[];
} {
	const competence = computeCompetence(m);

	const developingGates: MaturityGateResult[] = [
		gate('concepts ≥ ' + DEVELOPING_GATES.concepts, m.concepts >= DEVELOPING_GATES.concepts, `${m.concepts} concepts`),
		gate('corrections ≥ ' + DEVELOPING_GATES.corrections, m.corrections >= DEVELOPING_GATES.corrections, `${m.corrections} corrections`),
		gate('causal chains ≥ ' + DEVELOPING_GATES.causalChains, m.causalChains >= DEVELOPING_GATES.causalChains, `${m.causalChains} causal chains`),
		gate('sessions ≥ ' + DEVELOPING_GATES.sessions, m.sessions >= DEVELOPING_GATES.sessions, `${m.sessions} sessions`)
	];
	const isDeveloping = developingGates.every((g) => g.pass);

	const establishedGates: MaturityGateResult[] = [
		gate('concepts ≥ ' + ESTABLISHED_GATES.concepts, m.concepts >= ESTABLISHED_GATES.concepts, `${m.concepts} concepts`),
		gate('corrections ≥ ' + ESTABLISHED_GATES.corrections, m.corrections >= ESTABLISHED_GATES.corrections, `${m.corrections} corrections`),
		gate('sessions ≥ ' + ESTABLISHED_GATES.sessions, m.sessions >= ESTABLISHED_GATES.sessions, `${m.sessions} sessions`),
		gate(
			`recall competence ≥ ${ESTABLISHED_GATES.competence} (≥${MIN_COMPETENCE_SAMPLE} outcomes)`,
			competence !== null && competence >= ESTABLISHED_GATES.competence,
			competence === null ? `competence unknown (${m.retrievalOutcomes} outcomes)` : `competence ${(competence * 100).toFixed(0)}%`
		)
	];
	const isEstablished = isDeveloping && establishedGates.every((g) => g.pass);

	if (isEstablished) return { stage: 'established', gates: establishedGates };
	if (isDeveloping) return { stage: 'developing', gates: establishedGates };
	return { stage: 'nascent', gates: developingGates };
}

function gate(name: string, pass: boolean, detail: string): MaturityGateResult {
	return { gate: name, pass, detail };
}

/** True iff the brain has ZERO accumulated signal across every dimension (a truly cold brain). */
function isColdBrain(m: SoulMetrics): boolean {
	return m.concepts === 0 && m.corrections === 0 && m.causalChains === 0 && m.sessions === 0 && m.retrievalOutcomes === 0;
}

/**
 * Derive the self-model from the raw metrics + the dominant concepts + learned values. PURE +
 * deterministic (the unit-test seam) — no DB, no fabrication: every field is a projection of the
 * inputs. A cold brain yields an honest nascent summary with empty knows-about/values.
 */
export function deriveSoul(input: {
	metrics: SoulMetrics;
	dominantConcepts: DominantConcept[];
	learnedValues: LearnedValue[];
}): SoulModel {
	const { metrics } = input;
	const { stage, gates } = deriveMaturityStage(metrics);
	const competence = computeCompetence(metrics);
	const knowsAbout = input.dominantConcepts.map((c) => c.label).slice(0, SOUL_KNOWS_ABOUT_LIMIT);
	const values = input.learnedValues.map((v) => excerpt(v.text, VALUE_EXCERPT_MAX)).slice(0, SOUL_VALUES_LIMIT);

	const summary = isColdBrain(metrics)
		? "Atelier's identity is nascent — insufficient accumulated brain history to derive a self-model yet."
		: `Atelier's identity is ${stage}. It has accumulated ${metrics.concepts} concept(s), ${metrics.corrections} learned ` +
			`correction(s), and ${metrics.causalChains} causal chain(s) across ${metrics.sessions} session(s)` +
			(competence !== null ? `; recall competence ${(competence * 100).toFixed(0)}%.` : '.');

	return {
		maturityStage: stage,
		nascent: stage === 'nascent',
		knowsAbout,
		values,
		competence,
		experience: metrics,
		gates,
		summary
	};
}

/** Single-line, bounded excerpt of a body (mirrors concierge.excerpt — kept local to stay pure). */
function excerpt(body: string, max: number): string {
	const oneLine = body.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Render the self-model as a CONCISE, bounded, SCREENED identity block for the concierge Stage-2
 * turn context. Returns null when the brain is truly COLD (zero signal) so the concierge OMITS the
 * block honestly (no "I know nothing" filler) — otherwise a few short lines the model grounds its
 * VOICE in. D-026: the assembled block is re-screened before it leaves the process (its inputs were
 * already screened at store time; this is belt-and-suspenders, mirroring the prompt assembler).
 */
export function formatSoulBlock(soul: SoulModel): string | null {
	if (isColdBrain(soul.experience)) return null;

	const lines: string[] = [`Maturity: ${soul.maturityStage}. ${soul.summary}`];
	if (soul.knowsAbout.length) {
		lines.push(`Knows about: ${soul.knowsAbout.join(', ')}.`);
	}
	if (soul.values.length) {
		lines.push(`Learned values (what NOT to do): ${soul.values.join('; ')}.`);
	}
	return screen(lines.join('\n')).text.trim();
}

// ── On-read aggregation over the live brain (the SurrealQL — F-020: real-surreal tested) ──

/** count() GROUP ALL returns [] for zero rows and [{c}] otherwise — read defensively → 0. */
function firstCount(rows: Array<{ c?: unknown }> | undefined): number {
	const c = rows?.[0]?.c;
	return typeof c === 'number' ? c : 0;
}

/**
 * Read the live brain-volume metrics (all `count()` GROUP ALL — six statements in ONE query). Only
 * active + clean concept/correction rows count (D-026 — a quarantined row is never part of identity).
 *
 * SCOPE (per-PM souls). When `project` is omitted this reads the GLOBAL brain (Atelier's soul) — the
 * query is BYTE-IDENTICAL to before (no regression). When a project id is given it derives that
 * project's slice: concept/memory/session filter their direct `project` column; causal_chain and
 * retrieval_outcome carry no project column, so they reach it THROUGH their `session` link
 * (`session.project`, the same idiom as atelier/timeline.ts). Global-only rows (project = NONE) and
 * OTHER projects' rows are excluded — clean isolation, so a small/new project computes an honest
 * `nascent` (F-008), never another project's or the global identity.
 */
export async function readSoulMetrics(db: Db, project?: string): Promise<SoulMetrics> {
	const scoped = project !== undefined;
	// Direct project column (concept/memory); session-linked reach it via session.project.
	const andProj = scoped ? ' AND project = $project' : '';
	const sessionWhere = scoped ? ' WHERE project = $project' : '';
	const sessProjWhere = scoped ? ' WHERE session.project = $project' : '';
	const sessProjAnd = scoped ? ' AND session.project = $project' : '';
	const sql =
		`SELECT count() AS c FROM concept WHERE status = "active" AND screen_status = "clean"${andProj} GROUP ALL;
		 SELECT count() AS c FROM memory WHERE category = "correction" AND status = "active" AND screen_status = "clean"${andProj} GROUP ALL;
		 SELECT count() AS c FROM causal_chain${sessProjWhere} GROUP ALL;
		 SELECT count() AS c FROM session${sessionWhere} GROUP ALL;
		 SELECT count() AS c FROM retrieval_outcome${sessProjWhere} GROUP ALL;
		 SELECT count() AS c FROM retrieval_outcome WHERE utilized = true${sessProjAnd} GROUP ALL;`;
	const [concepts, corrections, causal, sessions, outcomes, utilized] = scoped
		? await db.query<
				[
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>
				]
			>(sql, { project: link(project as string) })
		: await db.query<
				[
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>,
					Array<{ c: number }>
				]
			>(sql);
	return {
		concepts: firstCount(concepts),
		corrections: firstCount(corrections),
		causalChains: firstCount(causal),
		sessions: firstCount(sessions),
		retrievalOutcomes: firstCount(outcomes),
		utilizedOutcomes: firstCount(utilized)
	};
}

/**
 * Read the dominant concepts — what Atelier knows about — ranked by importance, then stability, then
 * access_count (all three in the projection so the ORDER BY idiom is legal — F-020 #1). Active +
 * clean only. `limit` inlined as a sanitized integer (SurrealDB LIMIT is not a bind param here).
 */
export async function readDominantConcepts(
	db: Db,
	limit = SOUL_KNOWS_ABOUT_LIMIT,
	project?: string
): Promise<DominantConcept[]> {
	const n = Math.max(1, Math.floor(limit));
	const andProj = project !== undefined ? ' AND project = $project' : '';
	const sql = `SELECT label, importance, stability, access_count FROM concept
		   WHERE status = "active" AND screen_status = "clean"${andProj}
		 ORDER BY importance DESC, stability DESC, access_count DESC LIMIT ${n};`;
	const [rows] = project !== undefined
		? await db.query<[Array<Record<string, unknown>>]>(sql, { project: link(project) })
		: await db.query<[Array<Record<string, unknown>>]>(sql);
	return (rows ?? []).map((r) => ({
		label: String(r.label ?? ''),
		importance: typeof r.importance === 'number' ? r.importance : 0,
		stability: typeof r.stability === 'number' ? r.stability : 0,
		accessCount: typeof r.access_count === 'number' ? r.access_count : 0
	}));
}

/**
 * Read the learned values — correction memories (`category = "correction"`) — ranked by importance,
 * then recency (created_at in the projection so the ORDER BY idiom is legal — F-020 #1). Active +
 * clean only. Bodies are already screened at store time; excerpted downstream in deriveSoul.
 */
export async function readLearnedValues(
	db: Db,
	limit = SOUL_VALUES_LIMIT,
	project?: string
): Promise<LearnedValue[]> {
	const n = Math.max(1, Math.floor(limit));
	const andProj = project !== undefined ? ' AND project = $project' : '';
	const sql = `SELECT content, importance, created_at FROM memory
		   WHERE category = "correction" AND status = "active" AND screen_status = "clean"${andProj}
		 ORDER BY importance DESC, created_at DESC LIMIT ${n};`;
	const [rows] = project !== undefined
		? await db.query<[Array<Record<string, unknown>>]>(sql, { project: link(project) })
		: await db.query<[Array<Record<string, unknown>>]>(sql);
	return (rows ?? []).map((r) => ({
		text: String(r.content ?? ''),
		importance: typeof r.importance === 'number' ? r.importance : 0
	}));
}

/**
 * Load the CURRENT derived self-model from the live brain (compute-on-read; the concierge's S4
 * consumer). Reads metrics + dominant concepts + learned values, then derives the pure model. On a
 * sparse/cold brain this returns an honest `nascent` model (empty knows-about/values) — never a
 * fabricated identity (F-008).
 *
 * Omit `project` for the GLOBAL Atelier soul (unchanged). Pass a project id for that project's PM
 * soul — the SAME derivation + thresholds over the project's slice of the brain, so a small/new
 * project is honestly `nascent` (per-PM souls).
 */
export async function loadSoul(db: Db, project?: string): Promise<SoulModel> {
	const [metrics, dominantConcepts, learnedValues] = await Promise.all([
		readSoulMetrics(db, project),
		readDominantConcepts(db, SOUL_KNOWS_ABOUT_LIMIT, project),
		readLearnedValues(db, SOUL_VALUES_LIMIT, project)
	]);
	return deriveSoul({ metrics, dominantConcepts, learnedValues });
}
