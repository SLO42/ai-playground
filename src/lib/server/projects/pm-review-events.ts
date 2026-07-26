// COMPLETION-LEDGER Wave A (finding 6) — THE PM-REVIEW SCENE MARKER.
//
// THE GAP THIS CLOSES. `runPmReview` is the PM's thinking pass: it reads the project's live tasks,
// findings and open risks, derives typed pm_memory entries, and proposes tasks through the §4.1
// chokepoint. It writes a durable `pm_review` summary row (surfaced in the project PM tab) — and
// emits NO `scene_event`. So the ONE surface built to show WHO decided WHAT and WHY, the lifecycle
// scene/graph (`/projects/[id]/graph`), showed PM *ticks* (`pm_tick`, "the PM woke up") and never a
// single PM *review* ("the PM read the project and decided"). The most substantive act the PM
// performs was invisible in the graph of the PM's own life.
//
// WHY A SCENE EVENT AND NOT A NEW TABLE (F-055). The DURABLE record already exists and is
// already surfaced: the `pm_review` table is never pruned and the project page renders it. Adding
// a second durable writer would duplicate an audit that is not missing. What IS missing is the
// LIVE/DERIVED half — the rolling `scene_event` feed the graph reads — so this module writes
// exactly that, through the EXISTING chokepoint (scene/projector.appendSceneEvent), under the
// EXISTING PM marker family (`pm_review` joins `pm_tick`; m0085 widens the kind ASSERT).
//
// ANALYTICS QUALITY BAR (a flat `pm_review` marker would be a FAILURE). The meta reconstructs the
// whole decision: WHAT WOKE IT (trigger + provenance kind + the real evidence ids), WHAT IT READ
// (tasks/findings/risks examined, and the blocked/failed/severe counts that actually drive the
// rules), WHAT IT CONCLUDED (memories written, broken down by kind), WHAT IT DID ABOUT IT
// (proposals, by outcome — including the anti-spam `capped`/`defer_suppressed` absorptions), and —
// the previously-unpersisted one — WHY IT PROPOSED NOTHING (`proposalsSkipped`: no hired PM, or an
// observe-only PM). That reason was computed, returned to the caller, and DROPPED on every
// autonomous trigger; it is now a recorded fact.
//
// HONESTY (F-008). The PM review is DETERMINISTIC — it derives from real rows and calls NO model.
// `engine:'deterministic'` is stamped explicitly rather than left blank, so a reader never assumes
// an LLM formed these conclusions and no fabricated provider/model is implied. A count that is
// genuinely zero is recorded as zero (that is a fact); a reason that is genuinely absent is OMITTED
// (never the string 'undefined').
//
// FLAT META BY CONTRACT. scene/projector.screenSceneMeta drops nested objects/arrays fail-closed, so
// a nested value would be SILENTLY missing from the feed. Every value here is a primitive; id lists
// are joined into a bounded string. D-026: the meta carries only opaque `table:id` refs, counts and
// closed-vocabulary labels — plus `proposalsSkipped`, an engine-authored sentence, which is screened
// at the boundary anyway by appendSceneEvent's own screenSceneMeta.
//
// BEST-EFFORT, NEVER LOAD-BEARING (F-014/F-048): the review has ALREADY happened and its durable
// rows are ALREADY written by the time this runs. A marker fault is logged and swallowed — the
// established precedent for this exact shape (pm-autonomous.ts #emitPmTick, project-controls.ts).
//
// F-013: nothing here stores a datetime — scene_event server-stamps `at` with time::now().
//
// SHADOW PATHS (all four):
//   • nil input      — an absent provenance / skip-reason is OMITTED, never stringified.
//   • empty input    — a review that examined nothing and wrote nothing still emits an honest
//                      all-zero marker (a healthy, empty project IS a real reviewed state).
//   • upstream error — an appendSceneEvent throw is absorbed and returned as false.
//   • happy path     — a real row lands and is read back by the lifecycle graph's marker query
//                      (proven in pm-review-events.test.ts against a live SurrealDB).

import type { Db } from '../db/client';
import { appendSceneEvent } from '../scene/projector';

/** Cap on evidence ids folded into the marker — keeps the meta label-class, not a payload. */
const EVIDENCE_CAP = 10;

/** The scene_event kind this module owns (m0085). Exported so the graph reader names it once. */
export const PM_REVIEW_SCENE_KIND = 'pm_review';

/** The facts one review pass produced, as the marker records them. All primitives (flat by contract). */
export interface PmReviewSceneInput {
	/** The project (`project:…`) the pass reviewed. */
	projectId: string;
	/** The `pm_review:…` row this marker points at — the durable record it summarizes. */
	reviewId: string;
	/** WHAT woke the pass: manual / periodic / event (D-004). */
	trigger: string;
	/** The trigger-engine provenance kind (release / github_arrival / …), when the pass had one. */
	provenanceKind?: string;
	/** The REAL evidence ids the provenance rested on (bounded, joined). */
	provenanceEvidence?: string[];
	/** The PM authority at fire time (observe / propose / act), when known. */
	authority?: string;
	// ── What it READ ──
	tasksExamined: number;
	findingsExamined: number;
	risksOpen: number;
	blocked: number;
	failed: number;
	severeFindings: number;
	// ── What it CONCLUDED ──
	memoriesWritten: number;
	risksWritten: number;
	observationsWritten: number;
	learningsWritten: number;
	/** Async concierge advisories drained into pm_memory before this pass assembled its context. */
	advisoriesSurfaced: number;
	// ── What it DID ──
	proposalsMade: number;
	/** Proposals that resulted in a NEW task born 'proposed'. */
	proposalsCreated: number;
	/** Proposals ABSORBED by the anti-spam chokepoint (an open structural twin already stood). */
	proposalsAbsorbed: number;
	/** WHY no proposals were derived, when they weren't. Previously computed and DROPPED. */
	proposalsSkipped?: string;
	/** Wall-clock ms the pass took. */
	durationMs?: number;
}

/** Trim + drop a blank/absent optional string (never the literal 'undefined'). */
function opt(v: string | undefined | null): string | undefined {
	if (typeof v !== 'string') return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

/** A count → a non-negative integer. A nil/negative/NaN count becomes 0 rather than poisoning the
 *  meta with NaN — the caller derives every count from a real array length, so 0 is honest here. */
function count(v: number | undefined): number {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * One-sentence human summary of the pass — what the graph node and any generic feed shows.
 * Reads as prose, never a bare id (cross-cutting check 3).
 */
export function pmReviewSummary(input: PmReviewSceneInput): string {
	const read =
		`read ${count(input.tasksExamined)} task(s), ${count(input.findingsExamined)} finding(s)` +
		(count(input.blocked) ? `, ${count(input.blocked)} blocked` : '') +
		(count(input.severeFindings) ? `, ${count(input.severeFindings)} severe` : '');
	const wrote = `wrote ${count(input.memoriesWritten)} memory entry(ies)`;
	const acted = input.proposalsSkipped
		? `proposed nothing (${input.proposalsSkipped})`
		: count(input.proposalsMade) === 0
			? 'proposed nothing (no signal warranted a task)'
			: `proposed ${count(input.proposalsMade)} task(s)` +
				(count(input.proposalsAbsorbed)
					? ` (${count(input.proposalsAbsorbed)} absorbed onto a standing proposal)`
					: '');
	return `PM review (${input.trigger}): ${read}; ${wrote}; ${acted}.`;
}

/**
 * Emit ONE `pm_review` scene marker for a completed review pass.
 *
 * EVERY ERROR HAS A NAME — the one failure mode, what catches it, what the operator sees:
 *   • scene_event write fault (DB down, or the m0085 kind ASSERT rejecting 'pm_review' when the
 *     migration has not applied, or a bad project record-id at the D-016 guard) → caught here →
 *     console.warn + `false`. The review, its pm_memory rows and its durable pm_review row are ALL
 *     unaffected and still render in the project PM tab; only this pass's node is missing from the
 *     lifecycle graph. It never propagates: no PM review fails because its telemetry failed.
 *
 * Returns whether the marker landed, so a caller/test can assert honestly rather than assume.
 */
export async function emitPmReviewScene(db: Db, input: PmReviewSceneInput): Promise<boolean> {
	try {
		const evidence = (input.provenanceEvidence ?? [])
			.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
			.slice(0, EVIDENCE_CAP);
		await appendSceneEvent(db, {
			kind: PM_REVIEW_SCENE_KIND,
			// The marker points at the DURABLE record it summarizes, so a reader can always get from
			// the live node to the full, never-pruned pm_review row.
			ref: input.reviewId,
			source: 'pm_review',
			project: input.projectId,
			meta: {
				// ── WHAT WOKE IT ──
				trigger: input.trigger,
				...(opt(input.provenanceKind) ? { provenanceKind: opt(input.provenanceKind) } : {}),
				...(evidence.length ? { provenanceEvidence: evidence.join(',') } : {}),
				...(opt(input.authority) ? { authority: opt(input.authority) } : {}),
				// ── WHAT IT READ (the inputs the rules actually keyed off) ──
				tasksExamined: count(input.tasksExamined),
				findingsExamined: count(input.findingsExamined),
				risksOpen: count(input.risksOpen),
				blocked: count(input.blocked),
				failed: count(input.failed),
				severeFindings: count(input.severeFindings),
				// ── WHAT IT CONCLUDED ──
				memoriesWritten: count(input.memoriesWritten),
				risksWritten: count(input.risksWritten),
				observationsWritten: count(input.observationsWritten),
				learningsWritten: count(input.learningsWritten),
				advisoriesSurfaced: count(input.advisoriesSurfaced),
				// ── WHAT IT DID ──
				proposalsMade: count(input.proposalsMade),
				proposalsCreated: count(input.proposalsCreated),
				proposalsAbsorbed: count(input.proposalsAbsorbed),
				// The alternative NOT taken, and WHY — the previously-dropped reason (no hired PM /
				// observe-only). Omitted (not blanked) when proposals genuinely ran.
				...(opt(input.proposalsSkipped) ? { proposalsSkipped: opt(input.proposalsSkipped) } : {}),
				// The review derives from REAL rows and calls NO model. Stated explicitly so no reader
				// infers an LLM formed these conclusions (F-008 — no fabricated provider/model).
				engine: 'deterministic',
				...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
					? { durationMs: Math.floor(input.durationMs) }
					: {}),
				// The sentence the graph node label and any generic feed renders.
				summary: pmReviewSummary(input)
			}
		});
		return true;
	} catch (err) {
		console.warn(
			`[pm-review] scene_event '${PM_REVIEW_SCENE_KIND}' append failed for ${input.reviewId} ` +
				`(the review, its memories and its durable pm_review row are unaffected; this pass will be ` +
				`MISSING from the lifecycle graph): ${(err as Error).message}`
		);
		return false;
	}
}
