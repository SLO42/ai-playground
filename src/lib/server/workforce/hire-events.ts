// COMPLETION-LEDGER Wave A — FIRST-CLASS hire + certification events.
//
// THE GAP THIS CLOSES (audit finding 1). The workforce/HR subsystem emitted ZERO scene_event rows,
// and its role_event audit covered only a thin slice: a gauntlet START was unaudited, an
// ADJUDICATION was unaudited, a RE-VERSION was unaudited, and — worst — the HIRE ITSELF
// (recruiter-hire.applyHireDecision) wrote NO audit row at all. An entire hire (candidate considered
// → gauntlet run → scored → adjudicated → certified → staffed) happened with no durable,
// human-visible trace. The operator could not watch or audit hiring.
//
// WHAT THIS MODULE IS: the ONE funnel every hire/cert emission goes through. It is NOT a second
// writer (F-055) — it composes the TWO EXISTING chokepoints and adds nothing of its own:
//   • repo.addRoleEvent   → role_event  — the workforce subsystem's own APPEND-ONLY, NEVER-PRUNED
//                                          audit feed. This is the DURABLE trace; /agents renders it.
//   • scene.appendSceneEvent → scene_event — the DERIVED live activity feed, a ROLLING 500-row
//                                          window (explicitly "not an audit log") driving the
//                                          living-brain scene.
// Both are written for every moment. The split is deliberate: scene_event's rolling prune would
// silently eat an audit trail, so the durable copy lives in role_event where nothing prunes it.
//
// ANALYTICS QUALITY BAR (this repo's first rule — a flat `hired` event is a FAILURE): every emission
// carries enough context to reconstruct HOW and WHY the decision was made — the inputs it rested on,
// the score/verdict, and the alternative NOT chosen where one exists (the recruiter's `falsifier`,
// the recommendation an operator overrode, the lifecycle a re-version walked away from).
//
// BEST-EFFORT, NEVER LOAD-BEARING: an emission fault is logged and swallowed — it can NEVER change
// the outcome of a hire, a cert flip, or a gauntlet run. This mirrors the established precedent in
// this codebase for exactly this shape (projects/pm-autonomous.ts `pm_tick`, project-controls.ts
// `continue`) and the F-048 rule that an auxiliary write never fails the host flow. The emission is
// AWAITED before it is swallowed, so callers and tests observe a deterministic ordering.
//
// D-026: every free-text value in a detail/meta payload is run through the secret/PII screen before
// it can land in either table. `falsifier`, adjudication notes and charter text are operator/agent
// prose — they are screened here, at the boundary, never stored raw.
//
// F-013 is a READ-side concern (normRoleEvent / listSceneEvents already ISO-coerce `at`); nothing in
// this module stores a datetime — both tables server-stamp `at` with time::now() (D-035).

import type { Db } from '../db/client';
import { screen } from '../memory/screen';
import { appendSceneEvent, type SceneEventKind } from '../scene/projector';
import { addRoleEvent, type RoleEventOp } from './repo';

/**
 * A flat, primitive-only context payload. FLAT BY CONTRACT, and that is load-bearing:
 * `screenSceneMeta` (scene/projector.ts) drops nested objects/arrays fail-closed, so a nested
 * value would be SILENTLY missing from the scene feed while present in role_event — two sinks
 * disagreeing about what happened. Keeping every payload flat guarantees both sinks record the
 * same facts. `undefined`/`null` entries are omitted (§6.1: absent, never a stored NONE).
 */
export type HireEventDetail = Record<string, string | number | boolean | null | undefined>;

/** One hire/certification moment: which audit op, which scene kind, and the WHY payload. */
export interface HireEventInput {
	/** role_event.op — the durable audit vocabulary (m0083). */
	op: RoleEventOp;
	/** scene_event.kind — the live-feed vocabulary (m0083). */
	sceneKind: SceneEventKind;
	/** The role this moment belongs to (role_event.role — REQUIRED, it is the audit's FK). */
	role: string;
	/** The candidate version, when the moment is version-scoped. */
	roleVersion?: string;
	/** The record the moment is ABOUT (e.g. `interview_run:x` / `decision_brief:y`) — scene_event.ref. */
	ref: string;
	/** The table `ref` belongs to — scene_event.source (the SSE topic, for filtering). */
	source: string;
	/** Owning project, when the moment has one (staffing does; global cert does not). */
	project?: string;
	/** The HOW/WHY payload — inputs, score, verdict, alternative-not-chosen. */
	detail: HireEventDetail;
}

/** Drop absent keys and D-026-screen every string value. Pure + total: never throws. */
function screenDetail(detail: HireEventDetail): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(detail)) {
		if (v === undefined || v === null) continue;
		if (typeof v === 'string') {
			const r = screen(v);
			// A quarantined value cannot be safely surfaced — keep the screened (redacted) body but
			// mark it, so neither feed implies it is the clean original.
			out[k] = r.status === 'quarantined' ? '[screened]' : r.text;
		} else {
			out[k] = v;
		}
	}
	return out;
}

/**
 * Emit ONE hire/certification moment to BOTH sinks. Best-effort per sink and INDEPENDENT: a
 * scene_event fault must not cost us the DURABLE role_event row (that is the audit of record), so
 * they are written in separate try/catch arms rather than one. role_event is written FIRST for that
 * reason. Returns which sinks landed, so a caller/test can assert honestly rather than assuming.
 *
 * EVERY ERROR HAS A NAME — the two failure modes, what catches them, what the operator sees:
 *   • role_event write fault (DB down, ASSERT rejects an un-enumerated op — the m0022 silent-swallow
 *     class) → caught here → console.warn + `roleEvent:false`. The hire still completes; the /agents
 *     hiring feed simply will not show this moment. This is the one we care most about, hence its own
 *     arm and its own log line naming the op.
 *   • scene_event write fault (same classes, plus a bad project record-id at the D-016 guard) →
 *     caught here → console.warn + `scene:false`. The durable audit is unaffected.
 * Neither ever propagates: no hire, cert flip or gauntlet run fails because its telemetry failed.
 */
export async function emitHireEvent(
	db: Db,
	input: HireEventInput
): Promise<{ roleEvent: boolean; scene: boolean }> {
	const detail = screenDetail(input.detail);
	let roleEventOk = false;
	let sceneOk = false;

	try {
		await addRoleEvent(db, {
			role: input.role,
			...(input.roleVersion ? { role_version: input.roleVersion } : {}),
			op: input.op,
			detail: { ...detail, ref: input.ref }
		});
		roleEventOk = true;
	} catch (err) {
		console.warn(
			`[workforce] role_event '${input.op}' append failed for ${input.ref} ` +
				`(the hire/cert outcome is unaffected; this moment will be MISSING from the /agents ` +
				`hiring feed): ${(err as Error).message}`
		);
	}

	try {
		await appendSceneEvent(db, {
			kind: input.sceneKind,
			ref: input.ref,
			source: input.source,
			...(input.project ? { project: input.project } : {}),
			meta: detail
		});
		sceneOk = true;
	} catch (err) {
		console.warn(
			`[workforce] scene_event '${input.sceneKind}' append failed for ${input.ref} ` +
				`(the durable role_event audit is unaffected): ${(err as Error).message}`
		);
	}

	return { roleEvent: roleEventOk, scene: sceneOk };
}

// ── The typed moments (each names its own WHY payload) ────────────────────────────────

/** A certification campaign OPENED an interview run (repo.createInterviewRun). The inputs the whole
 *  run will be judged against are captured HERE, at the start, so a later verdict can be replayed
 *  against what it actually ran on (fixture set, pass-bar snapshot, model, plant count). */
export async function emitGauntletStarted(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		roleVersion: string;
		run: string;
		tier: string;
		provider: string;
		modelId: string;
		fixtureSetSha: string;
		plantedTotal?: number;
		/** The version lifecycle BEFORE the run opened — 'draft'/'error' means this run STARTED a
		 *  campaign; 'passed'/'retired' means it is an EVIDENCE run that cannot demote (§2.2). */
		lifecycleBefore: string;
		retryOf?: string;
	}
): Promise<void> {
	await emitHireEvent(db, {
		op: 'gauntlet_started',
		sceneKind: 'gauntlet_started',
		role: args.role,
		roleVersion: args.roleVersion,
		ref: args.run,
		source: 'interview_run',
		detail: {
			role_slug: args.roleSlug,
			role_version: args.roleVersion,
			tier: args.tier,
			provider: args.provider,
			model_id: args.modelId,
			fixture_set_sha: args.fixtureSetSha,
			planted_total: args.plantedTotal,
			lifecycle_before: args.lifecycleBefore,
			// WHY this run exists: a fresh campaign, a §3.6 mechanical retry, or evidence against an
			// already-certified version. Reconstructable without joining the version row.
			trigger: args.retryOf
				? 'retry'
				: args.lifecycleBefore === 'passed' || args.lifecycleBefore === 'retired'
					? 'evidence'
					: 'campaign',
			retry_of: args.retryOf
		}
	});
}

/** The scorer reached a verdict on a run (repo.finalizeInterviewRun — the ONE chokepoint all 11
 *  gauntlet finalize paths funnel through). Carries the FULL basis of the verdict: recall and its
 *  numerator/denominator, false positives, the mechanical error class, what it cost, and whether the
 *  version's lifecycle actually moved (an evidence run against a 'passed' version never demotes). */
export async function emitGauntletScored(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		roleVersion: string;
		run: string;
		status: string;
		plantedTotal?: number;
		plantedFound?: number;
		falsePositives?: number;
		errorReason?: string;
		costUsd?: number;
		ambiguousCount: number;
		/** The version lifecycle BEFORE and AFTER — the honest record of whether this verdict moved
		 *  the campaign or was absorbed as evidence (§2.2 re-run-never-demotes). */
		lifecycleBefore: string;
		lifecycleAfter: string;
	}
): Promise<void> {
	// Honest recall (F-008): plantedTotal 0 ⇒ null, NEVER a fabricated 1.0 from 0/0.
	const recall =
		typeof args.plantedTotal === 'number' &&
		args.plantedTotal > 0 &&
		typeof args.plantedFound === 'number'
			? Number((args.plantedFound / args.plantedTotal).toFixed(4))
			: null;
	await emitHireEvent(db, {
		op: 'interviewed',
		sceneKind: 'gauntlet_scored',
		role: args.role,
		roleVersion: args.roleVersion,
		ref: args.run,
		source: 'interview_run',
		detail: {
			role_slug: args.roleSlug,
			role_version: args.roleVersion,
			status: args.status,
			recall,
			planted_found: args.plantedFound,
			planted_total: args.plantedTotal,
			false_positives: args.falsePositives,
			error_reason: args.errorReason,
			cost_usd: args.costUsd,
			ambiguous_count: args.ambiguousCount,
			lifecycle_before: args.lifecycleBefore,
			lifecycle_after: args.lifecycleAfter,
			// The alternative NOT taken: this verdict COULD have moved the campaign but did not
			// (an evidence run against an already-certified version, §2.2).
			demotion_withheld: args.lifecycleBefore !== 'interviewing' && args.status === 'failed'
		}
	});
}

/** An operator resolved a run's ambiguous-match queue (gauntlet.adjudicateInterviewRun). The counts
 *  per resolution ARE the reasoning — they show how many findings the operator confirmed as real
 *  hits vs called false positives vs dismissed, and what the run finalized as afterwards. */
export async function emitGauntletAdjudicated(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		roleVersion: string;
		run: string;
		itemCount: number;
		confirmedHits: number;
		falsePositives: number;
		dismissed: number;
		statusBefore: string;
		statusAfter: string;
	}
): Promise<void> {
	await emitHireEvent(db, {
		op: 'adjudicated',
		sceneKind: 'gauntlet_adjudicated',
		role: args.role,
		roleVersion: args.roleVersion,
		ref: args.run,
		source: 'interview_run',
		detail: {
			role_slug: args.roleSlug,
			role_version: args.roleVersion,
			items: args.itemCount,
			confirmed_hits: args.confirmedHits,
			false_positives: args.falsePositives,
			dismissed: args.dismissed,
			status_before: args.statusBefore,
			status_after: args.statusAfter,
			// The operator is the judge here (§3.4 — there is no judge agent); record that the
			// verdict below is human-authored, not scorer-derived.
			decided_by: 'operator'
		}
	});
}

/** A failed role was RE-VERSIONED (ceremony.reversionFailedRole) — the "try again" act. Records the
 *  version walked away from and the one that replaced it, so the lineage is reconstructable. */
export async function emitRoleReversioned(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		fromVersion: string;
		toVersion: string;
		fromLifecycle: string;
		reason: string;
	}
): Promise<void> {
	await emitHireEvent(db, {
		op: 'reversioned',
		sceneKind: 'role_reversioned',
		role: args.role,
		roleVersion: args.toVersion,
		ref: args.toVersion,
		source: 'role_version',
		detail: {
			role_slug: args.roleSlug,
			from_version: args.fromVersion,
			to_version: args.toVersion,
			from_lifecycle: args.fromLifecycle,
			reason: args.reason
		}
	});
}

/** The recruiter raised a cert_hire brief — a candidate is now UNDER CONSIDERATION (recruiter-hire.
 *  raiseHireBrief). This is the richest payload in the wave: it carries the recommendation AND the
 *  `falsifier` (the honest strongest reason NOT to follow it — the alternative-not-chosen, D-038),
 *  plus the evidence the recommendation rests on and how much was auto-resolved vs escalated. */
export async function emitCandidateConsidered(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		roleVersion: string;
		run: string;
		brief: string;
		recommendation: string;
		recall: number | null;
		plantedFound: number;
		plantedTotal: number;
		falsePositives: number;
		maxFalsePositives: number | null;
		autoResolvedCount: number;
		escalatedCount: number;
		tier: string;
		/** The honest strongest reason NOT to follow the recommendation (D-038). SCREENED (D-026). */
		falsifier: string;
	}
): Promise<void> {
	await emitHireEvent(db, {
		op: 'candidate_considered',
		sceneKind: 'candidate_considered',
		role: args.role,
		roleVersion: args.roleVersion,
		ref: args.brief,
		source: 'decision_brief',
		detail: {
			role_slug: args.roleSlug,
			role_version: args.roleVersion,
			run: args.run,
			tier: args.tier,
			recommendation: args.recommendation,
			// The evidence the recommendation RESTS ON.
			recall: args.recall,
			planted_found: args.plantedFound,
			planted_total: args.plantedTotal,
			false_positives: args.falsePositives,
			max_false_positives: args.maxFalsePositives,
			auto_resolved: args.autoResolvedCount,
			escalated: args.escalatedCount,
			// The ALTERNATIVE NOT CHOSEN — why the operator might reasonably decide the other way.
			falsifier: args.falsifier,
			// The recruiter only ever PROPOSES; the operator disposes (B4/D-039). Recorded so the
			// feed never reads as though HR hired anyone by itself.
			gate: 'operator_pending'
		}
	});
}

/** The operator DECIDED a hire brief (recruiter-hire.applyHireDecision — both arms). `approve` emits
 *  `hired`, `reject` emits `hire_rejected`. Records what the recruiter recommended alongside what the
 *  operator actually did, so an OVERRIDE (operator rejects a `hire`, or approves despite `no_hire`)
 *  is visible as a first-class fact rather than something inferred by comparing two rows. */
export async function emitHireDecided(
	db: Db,
	args: {
		role: string;
		roleSlug: string;
		roleVersion: string;
		brief: string;
		action: 'approve' | 'reject';
		recommendation: string;
		certFlipped: boolean;
		lifecycleBefore: string;
		lifecycleAfter: string;
		operatorConfirmed: boolean;
		staffingProposal?: string;
	}
): Promise<void> {
	const approved = args.action === 'approve';
	await emitHireEvent(db, {
		op: approved ? 'hired' : 'hire_rejected',
		sceneKind: approved ? 'hired' : 'hire_rejected',
		role: args.role,
		roleVersion: args.roleVersion,
		ref: args.brief,
		source: 'decision_brief',
		detail: {
			role_slug: args.roleSlug,
			role_version: args.roleVersion,
			action: args.action,
			// WHAT THE DECISION RESTED ON + the alternative not chosen.
			recommendation: args.recommendation,
			// True when the operator went AGAINST the recruiter's recommendation — the single most
			// interesting fact in a hire audit, recorded rather than left to be inferred.
			overrode_recommendation: approved
				? args.recommendation === 'no_hire'
				: args.recommendation === 'hire',
			cert_flipped: args.certFlipped,
			lifecycle_before: args.lifecycleBefore,
			lifecycle_after: args.lifecycleAfter,
			// B4/D-039 — the explicit operator confirm is the gate; recorded so an audit can prove
			// no cert ever flipped without it.
			operator_confirmed: args.operatorConfirmed,
			staffing_proposal: args.staffingProposal,
			staffed_in_same_act: Boolean(args.staffingProposal)
		}
	});
}

/** A certified role was STAFFED onto a project (staff.staffRole) — the hire becoming real work.
 *  Emits the `hire_staffed` scene kind, which has been in the m0055 vocabulary since the scene
 *  shipped but was never emitted ("Reserved") until this wave. Note staffRole ALREADY writes its own
 *  role_event{op:'staffed'}; this adds the scene-feed half plus the richer detail, and is emitted
 *  with op 'staffed' so the /agents feed shows one coherent row per staffing act. */
export async function emitHireStaffed(
	db: Db,
	args: {
		role: string;
		project: string;
		staffRow: string;
		source?: string;
		pinnedVersion?: string;
		tierOverride?: string;
		reStaff: boolean;
	}
): Promise<void> {
	// scene-only: staffRole's own addRoleEvent already wrote the durable audit row for this act, and
	// a second one would double-count the staffing in the /agents feed (F-055 — one write per act
	// through the owning chokepoint). We therefore call appendSceneEvent directly rather than
	// emitHireEvent, and swallow a fault exactly as emitHireEvent would.
	try {
		await appendSceneEvent(db, {
			kind: 'hire_staffed',
			ref: args.staffRow,
			source: 'project_staff',
			project: args.project,
			meta: screenDetail({
				role: args.role,
				project: args.project,
				// WHY this staffing happened: an operator act or a PM-validated proposal (§6).
				source: args.source,
				// A re-staff of an existing (project, role) row vs a first-time hire — the dedup path
				// makes these indistinguishable in the row itself, so it is recorded here.
				re_staff: args.reStaff,
				pinned_version: args.pinnedVersion,
				tier_override: args.tierOverride
			})
		});
	} catch (err) {
		console.warn(
			`[workforce] scene_event 'hire_staffed' append failed for ${args.staffRow} ` +
				`(the staffing and its role_event audit are unaffected): ${(err as Error).message}`
		);
	}
}
