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

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { roleDisplayName } from '$lib/shared/naming';
import { isScoredStatus } from '$lib/shared/interview-status';
import { assertRecordId } from '../db/validate';
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
	getReviewProposal
} from './repo';
import { canTransition } from './lifecycle';
import { emitCandidateConsidered, emitHireDecided } from './hire-events';
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

// THE SAME terminality rule the /agents ceremony chips and event lines gate their scores on —
// defined once in `$lib/shared/interview-status` and pinned to the schema ASSERT by a parity
// test, rather than re-spelled per module. This gate is the load-bearing one: it is BECAUSE it
// refuses every non-terminal run that the `candidate_considered` numbers downstream need no
// status key of their own to gate on (see hire-why-core.ts).

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
	if (!isScoredStatus(run.status)) {
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
		// NAMING: identical output for every resolvable role; the dangling-role fallback becomes
		// human (`probe_fit`) instead of a raw `role:` id in the operator's hire brief.
		roleSlug: roleDisplayName({ slug: role?.slug, ref: run.role }),
		roleName: roleDisplayName({ name: role?.name, slug: role?.slug, ref: run.role }),
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

	const brief = await createDecisionBrief(db, {
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

	// COMPLETION-LEDGER Wave A — a candidate entering CONSIDERATION is a first-class fact. Before
	// this wave the recruiter raised a brief and nothing recorded that it had happened: the operator
	// could not see who was being considered, on what evidence, or what the recruiter thought. This
	// carries the recommendation AND the `falsifier` — the honest strongest reason NOT to follow it
	// (the alternative-not-chosen, D-038) — so the WHY survives even after the brief is decided and
	// leaves the open queue. Best-effort (F-048): the brief is already raised; telemetry never un-raises it.
	try {
		await emitCandidateConsidered(db, {
			role: decision.role,
			roleSlug: decision.roleSlug,
			roleVersion: decision.roleVersion,
			run: decision.run,
			brief: brief.id,
			recommendation: decision.recommendation,
			recall: decision.recall,
			plantedFound: decision.plantedFound,
			plantedTotal: decision.plantedTotal,
			falsePositives: decision.falsePositives,
			maxFalsePositives: decision.maxFalsePositives,
			autoResolvedCount: decision.autoResolved.length,
			escalatedCount: decision.escalated.length,
			tier: decision.tier,
			falsifier: decision.falsifier
		});
	} catch (err) {
		console.warn(
			`[workforce] candidate_considered trace failed for ${brief.id} (the brief is unaffected): ${(err as Error).message}`
		);
	}
	return brief;
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
		// Held for the trace below: a reject must be attributable to a ROLE (role_event's FK), and
		// only the re-derived decision carries it.
		let traced: HireDecision | null = null;
		try {
			const d = await buildHireDecision(db, brief.artifact);
			recommendation = d.recommendation;
			lifecycle = await versionLifecycle(db, d.roleVersion);
			traced = d;
		} catch (err) {
			if (!(err instanceof HireGateError)) throw err; // a non-gate error is a real fault — surface it
			// the run/role is gone or no longer terminal — the stale brief is cleared regardless (interrupt
			// contract: a withdrawal never re-derives a vanished decision). Lifecycle stays '(unknown)'.
		}

		// COMPLETION-LEDGER Wave A — a REJECTED hire is exactly as important to see as an accepted
		// one, and previously left NO trace whatsoever (applyHireDecision wrote no audit row on
		// either arm). UPSTREAM-ERROR SHADOW PATH, named: when the underlying run/role has vanished
		// the reject still succeeds but cannot be attributed to a role, and role_event.role is a
		// required FK — so we skip the emission and say so, rather than inventing a role (F-008).
		if (traced) {
			try {
				await emitHireDecided(db, {
					role: traced.role,
					roleSlug: traced.roleSlug,
					roleVersion: traced.roleVersion,
					brief: brief.id,
					action: 'reject',
					recommendation,
					certFlipped: false,
					lifecycleBefore: lifecycle,
					lifecycleAfter: lifecycle,
					// A reject withholds; it is never the gated spend act, so no confirm is required.
					operatorConfirmed: false
				});
			} catch (err) {
				console.warn(
					`[workforce] hire_rejected trace failed for ${brief.id} (the rejection stands): ${(err as Error).message}`
				);
			}
		} else {
			console.warn(
				`[workforce] hire_rejected NOT traced for ${brief.id}: its interview_run (${brief.artifact}) is gone ` +
					`or no longer terminal, so the reject cannot be attributed to a role — the rejection itself stands.`
			);
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
	const lifecycleAfter = await versionLifecycle(db, decision.roleVersion);

	// COMPLETION-LEDGER Wave A — THE HIRE ITSELF. This is the single biggest hole the audit found:
	// the act that certifies a role and lets it be staffed onto real work wrote NO durable record at
	// all. The payload reconstructs the whole decision: what the recruiter recommended, what the
	// operator actually did, whether that OVERRODE the recommendation, whether the cert genuinely
	// flipped (vs the run's finalizer having already driven it), the lifecycle either side, and the
	// B4 confirm that gated it. Emitted AFTER the brief mark so it records a hire that actually
	// completed. Best-effort (F-048): the cert has already flipped; telemetry never un-flips it.
	try {
		await emitHireDecided(db, {
			role: decision.role,
			roleSlug: decision.roleSlug,
			roleVersion: decision.roleVersion,
			brief: brief.id,
			action: 'approve',
			recommendation: decision.recommendation,
			certFlipped,
			lifecycleBefore: before,
			lifecycleAfter,
			operatorConfirmed: true,
			...(input.staffingProposal ? { staffingProposal: input.staffingProposal } : {})
		});
	} catch (err) {
		console.warn(
			`[workforce] hired trace failed for ${brief.id} (the certification stands): ${(err as Error).message}`
		);
	}

	return {
		brief: decided,
		recommendation: decision.recommendation,
		lifecycle: lifecycleAfter,
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

// ── Gap D — the PM FIT-VERDICT layer (pm_fit_verdict, migration 0052) ───────────────────
//
// After HR raises the cert_hire brief (the candidate passed the OBJECTIVE gauntlet) and BEFORE the
// operator's B4 applyHireDecision, the PROJECT PM issues a fit-verdict judging fit for THIS project
// — the context HR's generic gauntlet lacks (e.g. a generic C# cert vs the project needing BepInEx/
// Unity specifics). This is FIRST-CLASS PM input, NOT a competing hard gate: a DENY pre-sets the
// operator's hire surface to REJECT with the reason shown, but the operator can OVERRIDE (D-039 stays
// final). A fit-verdict NEVER itself flips the cert or staffs — only applyHireDecision does (B4); this
// module's write here records the PM's judgment row, nothing more. EVERY ERROR HAS A NAME: a bad input
// (non-cert_hire brief, already-decided brief, empty reason) is a HireGateError.

export type FitOutcome = 'approve' | 'deny';

/** A PM fit-verdict bound to a cert_hire brief — the PM's judgment of fit for THIS project. */
export interface PmFitVerdictRow {
	id: string;
	/** The cert_hire decision_brief this fit-verdict judges. */
	brief: string;
	/** The project whose PM authored the verdict (null when project-less). */
	project: string | null;
	outcome: FitOutcome;
	/** The PM's fit rationale — REQUIRED on deny (the operator surface shows it). */
	reason: string;
	author: 'pm' | 'operator';
	/** ISO; null → '—' (F-013). */
	created_at: string | null;
}

export interface RecordPmFitVerdictInput {
	outcome: FitOutcome;
	/** REQUIRED — the fit rationale. A deny without a reason is refused (the operator must see WHY). */
	reason: string;
	/** Who authored it (default 'pm' — the project's PM; 'operator' when the operator records on the PM's behalf). */
	author?: 'pm' | 'operator';
}

function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function normFitVerdict(row: Record<string, unknown>): PmFitVerdictRow {
	return {
		id: String(row.id),
		brief: String(row.brief),
		project: row.project != null ? String(row.project) : null,
		outcome: row.outcome as FitOutcome,
		reason: typeof row.reason === 'string' ? row.reason : '',
		author: row.author === 'operator' ? 'operator' : 'pm',
		created_at: strDate(row.created_at)
	};
}

function fitLink(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Record the project PM's fit-verdict on an OPEN cert_hire brief (gap D). Shadow paths, each NAMED:
 *   • brief not found → HireGateError;
 *   • brief not artifact_kind 'cert_hire' → HireGateError (a fit-verdict only judges a hire gate);
 *   • brief already decided (not 'open') → HireGateError (the operator already disposed — a late
 *     fit-verdict cannot change a decided hire; the PM must catch it while the gate stands);
 *   • empty/blank reason → HireGateError (the operator must see WHY, especially on a deny).
 * The verdict NEVER flips a cert or staffs (B4 — only applyHireDecision does); it writes ONE
 * pm_fit_verdict row. Latest-wins per brief (re-recording is allowed while the brief is open — the
 * PM may revise its fit call; the surface reads the newest via getPmFitVerdictForBrief).
 */
export async function recordPmFitVerdict(
	db: Db,
	briefId: string,
	input: RecordPmFitVerdictInput
): Promise<PmFitVerdictRow> {
	const reason = (input.reason ?? '').trim();
	if (!reason) {
		throw new HireGateError(
			'a PM fit-verdict requires a reason (the operator must see WHY — a deny especially needs its rationale)'
		);
	}
	if (input.outcome !== 'approve' && input.outcome !== 'deny') {
		throw new HireGateError(`fit-verdict outcome must be approve | deny (got ${JSON.stringify(input.outcome)})`);
	}
	const brief = await getBrief(db, briefId);
	if (!brief) throw new HireGateError(`decision brief not found: ${briefId}`);
	if (brief.artifact_kind !== 'cert_hire') {
		throw new HireGateError(
			`brief ${briefId} targets '${brief.artifact_kind}', not 'cert_hire' — a PM fit-verdict only judges a hire-gate brief`
		);
	}
	if (brief.status !== 'open') {
		throw new HireGateError(
			`cert_hire brief ${briefId} is already '${brief.status}' — the operator has disposed; a fit-verdict only stands while the hire gate is open`
		);
	}

	const content: Record<string, unknown> = {
		brief: fitLink(brief.id),
		outcome: input.outcome,
		reason,
		author: input.author === 'operator' ? 'operator' : 'pm'
	};
	if (brief.project) content.project = fitLink(brief.project);

	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`CREATE pm_fit_verdict CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normFitVerdict(rows[0]);
}

/**
 * The PM's LATEST fit-verdict on a cert_hire brief, or null (no verdict yet). Latest-wins: the PM may
 * revise its fit call while the brief is open; the surface shows the newest. Honest null when none
 * (F-008 — the operator surface shows 'no PM fit-verdict yet', never a fabricated approve).
 */
export async function getPmFitVerdictForBrief(db: Db, briefId: string): Promise<PmFitVerdictRow | null> {
	const bid = fitLink(briefId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM pm_fit_verdict WHERE brief = $bid ORDER BY created_at DESC LIMIT 1;`,
		{ bid }
	);
	return rows.length ? normFitVerdict(rows[0]) : null;
}
