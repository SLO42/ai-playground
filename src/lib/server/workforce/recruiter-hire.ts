// HR-5 (HR-RECRUITER-SPEC §7.5) — the OPERATOR HIRE-GATE. The recruiter PROPOSES; the operator
// DISPOSES (B4). This is the ONE operator decision per candidate: a `decision_brief` whose
// artifact is the candidate's terminal interview_run, surfacing — from REAL run rows, never
// fabricated (F-008/D-038) — the candidate's role+tier, recall, FP, per-plant found/missed, the
// auto-dismissed + escalated items, and the recruiter's hire/no-hire recommendation WITH its
// falsifier. The operator's APPROVE flips the cert (transitionLifecycle 'passed' when the run
// passed but the operator-gate is the final say, B4) and/or feeds the EXISTING BL-3 staffing flow
// (confirmStaffing — 'certified' = passed the gauntlet; 'hired' = staffed onto a project). REJECT
// flips nothing and staffs nothing.
//
// THE FOUR INTEGRITY INVARIANTS THIS HOLDS (red-team these):
//   • B1 — no self-cert: a recruiter-self candidate is REFUSED (the recruiter is operator-
//     bootstrap-certified; it never has a hire brief raised on its own run).
//   • B2 — the operator approves; this NEVER confirms a launch key (no confirmLaunchKey call).
//   • B3 — read-only over the deterministic results: the evidence is assembled from the run's
//     persisted planted_found/total, false_positives, results (adjudication-reconciled via the
//     SHARED extractFixtureResults), and ambiguous queue. It NEVER rescores, never reads a key.
//   • B4 — the operator keeps the final gate: NO cert flip / NO staffing happens without an
//     explicit operatorConfirmed approve. The recruiter only RAISES the brief.
//
// EVERY ERROR HAS A NAME: HireGateError (a B1/B4 boundary violation or a malformed gate input).
// The brief-write reuses createDecisionBrief (which enforces the §8 format — one-sentence ask,
// issue, falsifier, 2–4 evidence links, exactly-one recommended option) and its one-open-brief-
// per-artifact absorb (interrupt contract: re-raising on the same run returns the same open brief).

import type { Db } from '../db/client';
import {
	createDecisionBrief,
	getBrief,
	markBriefDecided,
	type DecisionBriefRow
} from '../projects/briefs';
import {
	transitionLifecycle,
	getInterviewRun,
	getRole,
	getRoleVersion,
	getReviewProposal,
	type InterviewRunRow
} from './repo';
import { canTransition } from './lifecycle';
import { confirmStaffing, type ConfirmStaffingResult } from './staffing-proposal';
import { RECRUITER_SLUG, extractFixtureResults } from './recruiter';

// ── Named gate error ──────────────────────────────────────────────────────────────────

/** A hire-gate boundary violation — a B1 self-cert candidate, a B4 missing operator confirm, or a
 *  malformed/illegal gate input. Fail loud, fail closed; the route maps it operator-facing. */
export class HireGateError extends Error {
	override readonly name = 'HireGateError';
}

// ── The recruiter's hire decision (assembled from REAL run rows — B3 read-only) ─────────

export type HireRecommendation = 'hire' | 'no_hire';

/** Per-plant evidence for the brief, adjudication-reconciled (B3 read-only — never rescored). */
export interface HirePlantEvidence {
	fixture: string;
	found: string[];
	missed: string[];
}

/**
 * Everything the operator needs to decide the hire — assembled ONLY from the run's persisted,
 * deterministic rows (B3). recall/fp are the scorer's counts (honest: null recall when the run
 * planted nothing, so the surface renders '—' rather than a fabricated 0/0=1.0). The
 * recommendation is mechanical off the run's TERMINAL status (passed → hire; failed → no_hire);
 * an adjudicating/running/error run is NOT a hire candidate (no terminal verdict to recommend on).
 */
export interface HireDecision {
	run: string;
	role: string;
	roleSlug: string;
	roleName: string;
	roleVersion: string;
	tier: string;
	/** plantedFound / plantedTotal; null when plantedTotal is 0 (no fabricated recall, F-008). */
	recall: number | null;
	plantedFound: number;
	plantedTotal: number;
	falsePositives: number;
	maxFalsePositives: number | null;
	/** Per-fixture found/missed plant ids (adjudication-reconciled, read-only). */
	plants: HirePlantEvidence[];
	/** Items the recruiter auto-resolved (the `[auto]`-tagged adjudication audit rows). */
	autoResolved: Array<{ resolution: string; basis: string }>;
	/** Items left for the operator (escalated): the still-open ambiguous queue on the run. */
	escalated: Array<Record<string, unknown>>;
	/** hire iff the run passed; no_hire iff it failed. */
	recommendation: HireRecommendation;
	/** The HONEST strongest reason NOT to follow the recommendation (D-038 — never fabricated). */
	falsifier: string;
}

const TERMINAL_RUN_STATUSES = new Set<InterviewRunRow['status']>(['passed', 'failed']);

/**
 * Assemble the recruiter's hire decision for a TERMINAL interview_run (B3 read-only). Shadow
 * paths, every one named: run not found → HireGateError; recruiter-self candidate → HireGateError
 * (B1); a non-terminal run (running/adjudicating/error) → HireGateError (there is no hire verdict
 * to recommend on until the run is passed/failed); a run that planted nothing → recall null (F-008
 * honest, never a fabricated 1.0). The role row may be gone (a dangling run) → roleName falls back
 * to the slug/id (honest, never a throw).
 */
export async function buildHireDecision(db: Db, runId: string): Promise<HireDecision> {
	const run = await getInterviewRun(db, runId);
	if (!run) throw new HireGateError(`interview_run not found: ${runId}`);
	const role = await getRole(db, run.role);
	// B1 — a recruiter-self candidate never gets a hire brief (it is operator-bootstrap-certified).
	if (role?.slug === RECRUITER_SLUG) {
		throw new HireGateError(
			`B1 violation: the recruiter ('${RECRUITER_SLUG}') is operator-bootstrap-certified and never has a hire brief raised on its own run — refused`
		);
	}
	if (!TERMINAL_RUN_STATUSES.has(run.status)) {
		throw new HireGateError(
			`interview_run ${runId} is '${run.status}' — a hire decision needs a TERMINAL run (passed | failed). ` +
				`An adjudicating run has an open ambiguous queue the operator resolves FIRST (HR-1/HR-4); a running/error run has no verdict.`
		);
	}

	const plantedTotal = run.planted_total;
	const plantedFound = run.planted_found;
	const recall = plantedTotal > 0 ? plantedFound / plantedTotal : null;
	const criteria = run.pass_criteria as { pass_recall?: unknown; max_false_positives?: unknown };
	const maxFalsePositives =
		typeof criteria?.max_false_positives === 'number' ? criteria.max_false_positives : null;

	// B3 — per-plant evidence: the SHARED adjudication-reconciled reader (one source of truth).
	const plants = extractFixtureResults(run).map((r) => ({
		fixture: r.fixture,
		found: r.found,
		missed: r.missed
	}));

	// Auto-resolved items: the `[auto]`-tagged adjudication audit rows the recruiter (HR-4) wrote.
	const autoResolved: HireDecision['autoResolved'] = [];
	for (const raw of run.results ?? []) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (r.kind !== 'adjudication') continue;
		const note = typeof r.note === 'string' ? r.note : '';
		// HR-4 tags every auto-decision `[auto]`; operator resolutions carry a free-text note (or none).
		if (!note.includes('[auto]')) continue;
		autoResolved.push({ resolution: String(r.resolution ?? '—'), basis: note });
	}

	// Escalated items: a TERMINAL run's ambiguous queue is empty (adjudication clears it). Any
	// residual is surfaced verbatim (honest — never invented). For a passed/failed run this is [].
	const escalated = Array.isArray(run.ambiguous) ? run.ambiguous : [];

	const recommendation: HireRecommendation = run.status === 'passed' ? 'hire' : 'no_hire';

	// The HONEST falsifier (D-038): the strongest evidence-grounded reason the operator should NOT
	// follow the recommendation. For a hire it is the residual risk the green run cannot rule out;
	// for a no-hire it is the path by which the fail might NOT be the candidate's fault.
	const recallStr = recall === null ? 'no plants scored' : `${plantedFound}/${plantedTotal}`;
	const falsifier =
		recommendation === 'hire'
			? `Approving certifies on THIS fixture pool only (recall ${recallStr}, ${run.false_positives} false positive(s)). ` +
				`Do NOT hire if the pool under-covers the role's real defect classes, or if any auto-resolved item above masks a real miss — re-open it (HR-4 auto-decisions are reversible).`
			: `Recall ${recallStr} fell short / FP over bar. Do NOT no-hire if the fail is a KEY DEFECT (an over-strict plant the candidate correctly omitted) rather than a genuine miss — classifyCertificationFail distinguishes them; a key defect is fixed with a new fixture, not by rejecting the candidate.`;

	return {
		run: run.id,
		role: run.role,
		roleSlug: role?.slug ?? run.role,
		roleName: role?.name ?? role?.slug ?? run.role,
		roleVersion: run.role_version,
		tier: run.tier,
		recall,
		plantedFound,
		plantedTotal,
		falsePositives: run.false_positives,
		maxFalsePositives,
		plants,
		autoResolved,
		escalated,
		recommendation,
		falsifier
	};
}

// ── Raise the ONE hire brief (reuses createDecisionBrief; one-open-per-candidate) ───────

/** A short, human evidence line from a per-plant result (the §8 2–4 evidence links). */
function plantEvidenceLine(p: HirePlantEvidence): string {
	const found = p.found.length ? `found [${p.found.join(', ')}]` : 'found none';
	const missed = p.missed.length ? `, missed [${p.missed.join(', ')}]` : '';
	return `${p.fixture}: ${found}${missed}`;
}

/**
 * §7.5 — RAISE the operator's hire brief for a terminal interview_run. PROPOSE-ONLY (B4): this
 * writes ONLY a decision_brief (status 'open'); it flips no cert and staffs nothing — that is the
 * operator's APPROVE (applyHireDecision). The §8 format invariants (one-sentence ask, issue,
 * falsifier, 2–4 evidence, exactly-one recommended option) are enforced by createDecisionBrief.
 *
 * ONE OPEN BRIEF PER CANDIDATE (interrupt contract): createDecisionBrief absorbs an already-open
 * brief on the SAME artifact (the run) and returns it — re-raising is idempotent, never a duplicate
 * ask. classification 'confirm' (a hire-gate is an operator confirm of a recruiter proposal).
 *
 * EVIDENCE (2–4 links, honest): the candidate run id, the per-plant found/missed lines (capped to
 * keep 2–4), and a recall/FP summary — all from buildHireDecision (real rows, B3). Both options
 * carry a pro AND con; exactly the recommended one (hire→approve, no_hire→reject) carries the
 * reason. The falsifier is the decision's honest strongest counter-reason (never fabricated).
 */
export async function raiseHireBrief(db: Db, runId: string): Promise<DecisionBriefRow> {
	const decision = await buildHireDecision(db, runId);

	const recallStr = decision.recall === null ? '—' : `${decision.plantedFound}/${decision.plantedTotal}`;
	const summary =
		`recall ${recallStr} · ${decision.falsePositives} FP` +
		(decision.maxFalsePositives !== null ? ` (bar ≤${decision.maxFalsePositives})` : '') +
		(decision.autoResolved.length ? ` · ${decision.autoResolved.length} auto-resolved` : '') +
		(decision.escalated.length ? ` · ${decision.escalated.length} escalated` : '');

	// 2–4 evidence links (§8). Always: the run id + the recall/FP summary. Plus up to 2 per-plant
	// lines (the per-fixture found/missed basis). Capped at 4, floored at 2 (honest: even a no-plant
	// run yields the run + summary = 2).
	const evidence: string[] = [decision.run, `${decision.roleSlug} @ ${decision.tier} — ${summary}`];
	for (const p of decision.plants) {
		if (evidence.length >= 4) break;
		evidence.push(plantEvidenceLine(p));
	}

	const hire = decision.recommendation === 'hire';
	const ask = hire
		? `Hire ${decision.roleName} (${decision.tier})? Approve certifies it and feeds the staffing flow.`
		: `Hire ${decision.roleName} (${decision.tier})? The certification run FAILED — recruiter recommends NO hire.`;
	const issue =
		`The recruiter ran ${decision.roleName}'s certification gauntlet at tier ${decision.tier} ` +
		`(run ${decision.run}); it ${hire ? 'PASSED' : 'FAILED'} with recall ${recallStr} and ${decision.falsePositives} ` +
		`false positive(s). The recruiter PROPOSES; the operator DISPOSES — approve flips the cert and enables staffing, ` +
		`reject does neither (B4).`;

	const options = [
		{
			id: 'approve' as const,
			label: hire ? 'Approve — certify + enable staffing' : 'Approve — certify anyway',
			pro: hire
				? 'The candidate met the certification bar on the live fixture pool; certifying makes it staffable.'
				: 'You may have evidence the fail is a key defect, not a candidate miss (the recruiter could be wrong).',
			con: hire
				? 'Certification is only as strong as the fixture pool; an under-covering pool over-certifies.'
				: 'The deterministic run FAILED — certifying past a real miss ships an under-qualified role.',
			...(hire ? { recommended: 'The run passed the snapshot bar; certify and make it staffable (B4 — your call).' } : {})
		},
		{
			id: 'reject' as const,
			label: hire ? 'Reject — do not certify' : 'Reject — no hire',
			pro: hire
				? 'Withholds certification if you judge the pool too thin or the auto-resolutions unsafe.'
				: 'Honors the deterministic fail — no flip, no staffing.',
			con: hire
				? 'A correctly-passing candidate stays uncertified and cannot be staffed.'
				: 'If the fail was a key defect, you reject a behaviorally-correct candidate (re-version + fix the key instead).',
			...(hire ? {} : { recommended: 'The run failed the deterministic bar; no certification, no staffing.' })
		}
	];

	return createDecisionBrief(db, {
		artifact: decision.run,
		artifact_kind: 'cert_hire',
		classification: 'confirm',
		ask,
		issue,
		effort: {
			apply: hire ? 'one click — cert flip + staffing enabled' : 'one click — no change',
			wrongness: hire ? 'an under-qualified role staffed onto real work' : 'a correct candidate left uncertified'
		},
		evidence: evidence.slice(0, 4),
		falsifier: decision.falsifier,
		options
	});
}

// ── Apply the operator's hire decision (B4 — the final gate; reuses the cert flip + staffing) ──

export interface ApplyHireInput {
	/** The operator's explicit B4 confirm. REQUIRED true for approve — fail-closed, NO auto-hire. */
	operatorConfirmed: boolean;
	/** OPTIONAL: on approve, also feed the BL-3 staffing flow by confirming this staffing proposal
	 *  ('certified' → 'hired' onto a project). Absent ⇒ certify only (staffing is a separate D-039
	 *  act the operator may take later on the staffing board). REJECT ignores this. */
	staffingProposal?: string;
	/** OPTIONAL operator free text for the staffing row — SCREENED inside confirmStaffing (D-026). */
	charterNote?: string;
}

export interface ApplyHireResult {
	brief: DecisionBriefRow;
	/** The hire recommendation the brief carried (hire | no_hire) — for the surface. */
	recommendation: HireRecommendation;
	/** The candidate version's lifecycle AFTER the decision (approve may have flipped it to
	 *  'passed'; reject leaves it). */
	lifecycle: string;
	/** true iff this approve flipped the cert (interviewing→passed). false on reject, or when the
	 *  version was already 'passed' (the run's own finalizer drove it — idempotent absorb). */
	certFlipped: boolean;
	/** Present iff approve fed the staffing flow (staffingProposal supplied + confirmed). */
	staffing?: ConfirmStaffingResult;
}

/**
 * §7.5 / B4 WRITE-PATH — apply the operator's answer to an OPEN cert_hire brief. The SOLE entry
 * that flips a cert / feeds staffing FROM a hire brief.
 *
 *   approve → (B4 operatorConfirmed REQUIRED) flip the candidate version interviewing→passed when
 *             it is still mid-campaign (the operator-gate is the final say even though the run
 *             already passed — B4); if the version is ALREADY 'passed' (the run's finalizer drove
 *             it) the flip is a no-op (certFlipped:false). THEN, if staffingProposal supplied, feed
 *             the EXISTING BL-3 confirmStaffing (REUSE — 'certified' becomes 'hired' onto a
 *             project). Marks the brief 'approved'.
 *   reject  → NO flip, NO staffing. Marks the brief 'rejected'. (No operatorConfirmed needed — a
 *             reject withholds; only the spending/staffing approve is gated.)
 *
 * INTERRUPT CONTRACT: markBriefDecided absorbs a same-action re-decide (returns the row) and refuses
 * a different action on a decided brief — so a crash between the flip and the brief-mark re-runs
 * cleanly (the flip is itself idempotent: an already-'passed' version no-ops). EFFECT-then-ceremony
 * order mirrors applyBriefDecision so a re-run converges.
 *
 * Shadow paths, each named: brief not found / not 'open' (markBriefDecided guards relabel) →
 * BriefError; brief not artifact_kind 'cert_hire' → HireGateError; approve without operatorConfirmed
 * → HireGateError (B4); a candidate version in a lifecycle that cannot reach 'passed' AND is not
 * already 'passed' (e.g. a 'failed' run's version) → HireGateError (a no-hire run cannot be hired —
 * the operator must re-version, not certify a failed campaign).
 */
export async function applyHireDecision(
	db: Db,
	briefId: string,
	action: 'approve' | 'reject',
	input: ApplyHireInput = { operatorConfirmed: false }
): Promise<ApplyHireResult> {
	const brief = await getBrief(db, briefId);
	if (!brief) throw new HireGateError(`decision brief not found: ${briefId}`);
	if (brief.artifact_kind !== 'cert_hire') {
		throw new HireGateError(
			`brief ${briefId} targets '${brief.artifact_kind}', not 'cert_hire' — applyHireDecision only applies a hire-gate brief`
		);
	}

	// REJECT clears the brief and changes NOTHING (no flip, no staffing). It must NOT depend on
	// re-deriving the hire decision: a reject is a withdrawal, and the operator must be able to clear
	// a STALE brief even when the underlying run was deleted/mutated since the brief was raised (so
	// buildHireDecision would throw on the gone run). We therefore mark the brief 'rejected' FIRST,
	// then BEST-EFFORT enrich the result with the (possibly unavailable) recommendation/lifecycle.
	// EVERY ERROR HAS A NAME: a gone run surfaces as a HireGateError from buildHireDecision — caught
	// HERE (reject-only) and absorbed into honest fallbacks ('(unknown)'), never re-thrown (the brief
	// is already cleared; re-deriving the gone decision is not required to withdraw the ask).
	if (action === 'reject') {
		const decided = await markBriefDecided(db, brief.id, 'rejected');
		// Best-effort enrich from the (possibly gone) run; fall back to the brief's OWN recorded
		// recommendation (honest — it is what the brief actually asked), never a fabricated verdict.
		let recommendation: HireRecommendation = recommendationFromBrief(brief);
		let lifecycle = '(unknown)';
		try {
			const d = await buildHireDecision(db, brief.artifact);
			recommendation = d.recommendation;
			lifecycle = await versionLifecycle(db, d.roleVersion);
		} catch (err) {
			if (!(err instanceof HireGateError)) throw err; // a non-gate error is a real fault — surface it
			// the run/role is gone or no longer terminal — the stale brief is cleared regardless (interrupt
			// contract: a withdrawal never re-derives a vanished decision). Lifecycle stays '(unknown)'.
		}
		return {
			brief: decided,
			recommendation,
			lifecycle,
			certFlipped: false
		};
	}

	// APPROVE — the candidate of record is the run the brief points at; the version is what gets
	// certified. (Approve REQUIRES a re-derivable decision — you cannot certify a vanished run.)
	const decision = await buildHireDecision(db, brief.artifact);

	// approve — B4: the spending/staffing act is operator-gated, fail-closed.
	if (input.operatorConfirmed !== true) {
		throw new HireGateError(
			`approving a hire requires an explicit operator confirm (operatorConfirmed:true) — there is NO auto-hire; ` +
				`the recruiter proposes, the operator disposes (B4/D-039)`
		);
	}

	// ROLE CROSS-CHECK (B4 hardening) — VALIDATE BEFORE ANY EFFECT (no half-state): if a staffing
	// proposal is supplied it MUST staff the SAME role this hire brief certifies. Without this, an
	// operator approving role A's hire brief could pass role B's staffing proposal and flip-cert A
	// while staffing B onto a project — two unrelated D-039 acts fused on one click, neither reviewed
	// against the other. Checked HERE (before the cert flip) so a mismatch refuses with NO cert flip
	// leaked. Fail CLOSED + named (route → 409, never a silent mis-staff). Proposal carries role in `.role`.
	if (input.staffingProposal) {
		const proposal = await getReviewProposal(db, input.staffingProposal);
		if (!proposal) {
			throw new HireGateError(`staffing proposal not found: ${input.staffingProposal}`);
		}
		if (proposal.role !== decision.role) {
			throw new HireGateError(
				`staffing-proposal role mismatch: this hire brief certifies role '${decision.role}' (${decision.roleSlug}) ` +
					`but staffing proposal ${proposal.id} staffs role '${proposal.role}' — refusing to certify one role while ` +
					`staffing another on a single approve (B4: each D-039 act is the operator's, reviewed on its own brief). ` +
					`Approve the hire WITHOUT the staffing proposal, then staff the correct role on the staffing board.`
			);
		}
	}

	// CERT FLIP (B4): the operator-gate is the final say. Flip the version interviewing→passed when
	// it is still mid-campaign; absorb when it is already 'passed' (the run's finalizer drove it). A
	// version that cannot legally reach 'passed' and is not already 'passed' (e.g. a failed-run
	// version) is REFUSED — a no-hire campaign is not certifiable; the operator re-versions.
	let certFlipped = false;
	const before = await versionLifecycle(db, decision.roleVersion);
	if (before !== 'passed') {
		if (!canTransition(before, 'passed')) {
			throw new HireGateError(
				`cannot certify version ${decision.roleVersion}: its lifecycle '${before}' cannot reach 'passed' ` +
					`(only an 'interviewing' campaign flips to certified — a failed/withdrawn/draft version needs a re-version, §2.2). ` +
					`The hire is refused with no effect.`
			);
		}
		await transitionLifecycle(db, decision.roleVersion, 'passed');
		certFlipped = true;
	}

	// OPTIONAL STAFFING FEED (REUSE the BL-3 D-039 path): 'certified' → 'hired' onto a project. The
	// role cross-check above already proved the proposal staffs THIS brief's role; confirmStaffing
	// then live-re-validates the proposal (fail-closed on a disposed/stale one — StaffingGateError).
	let staffing: ConfirmStaffingResult | undefined;
	if (input.staffingProposal) {
		staffing = await confirmStaffing(db, {
			proposal: input.staffingProposal,
			operatorConfirmed: true,
			...(input.charterNote !== undefined ? { charterNote: input.charterNote } : {})
		});
	}

	// Ceremony LAST (effect-then-ceremony; interrupt contract): the brief mark records the operator's
	// decision after the effects landed, so a crash before this re-runs and converges (the flip
	// no-ops on the now-'passed' version, confirmStaffing absorbs its already-'swapped' proposal).
	const decided = await markBriefDecided(db, brief.id, 'approved');
	return {
		brief: decided,
		recommendation: decision.recommendation,
		lifecycle: await versionLifecycle(db, decision.roleVersion),
		certFlipped,
		...(staffing ? { staffing } : {})
	};
}

/** Read a role_version's current lifecycle (or '(missing)' — honest, never a throw on a dangling
 *  version; the cert-flip/refuse logic above already validated existence via buildHireDecision). */
async function versionLifecycle(db: Db, versionId: string): Promise<string> {
	const v = await getRoleVersion(db, versionId);
	return v?.lifecycle ?? '(missing)';
}

/** The recommendation the brief ITSELF recorded (its recommended option: approve→hire, reject→no_hire)
 *  — the honest fallback when the underlying run is gone and the decision cannot be re-derived. A
 *  cert_hire brief always carries exactly one recommended option (createDecisionBrief §8 enforces it);
 *  default 'no_hire' only if a malformed brief carries none (conservative — withholds, never asserts a
 *  hire we cannot substantiate). */
function recommendationFromBrief(brief: DecisionBriefRow): HireRecommendation {
	const recommended = brief.options.find((o) => o.recommended);
	return recommended?.id === 'approve' ? 'hire' : 'no_hire';
}
