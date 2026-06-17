// CAPABILITY-MATCH-SPEC §4/§5 (BL-3) — the OPERATOR-GATED STAFFING PROPOSAL bridge.
//
// The matcher (capability-match.recommendStaffing) is PROPOSE-ONLY: it returns REUSE/EXTEND/HIRE
// recommendations and NEVER staffs/hires (§2.2/§4.4). This module is the gate between a matcher
// recommendation and the actual project_staff write — and EVERY spending/staffing act is behind
// the D-039 operator confirm (CAPABILITY-MATCH §2.2 invariant 2; LOCKED 2026-06-16):
//
//   ① PROPOSE (proposeStaffing)  — a REUSE recommendation → a review_proposal{kind:'staffing'}
//      born status='proposed'. It records the matcher EVIDENCE (the candidate role, the covered/
//      missing classes, the cost tier) in trigger; it writes NOTHING to project_staff. Reuses the
//      §5 createReviewProposal lifecycle — it does NOT fork it. Anti-spam: idempotent per
//      (project, role) — an OPEN staffing proposal for the same pair is returned, not duplicated.
//   ② CONFIRM (confirmStaffing) — the operator's explicit D-039 confirm → staffRole writes the
//      ONE project_staff row (enabled=true + role_event{op:'staffed'}) and the proposal closes
//      status='swapped' (the shared "operator-confirmed change applied" terminal — same meaning
//      tier_change uses). FAIL-CLOSED: no confirm → StaffingGateError; NO auto-staff path exists.
//   ③ REJECT (rejectStaffing)    — reuse the §5 rejectProposal (closes terminal + screened reason).
//
// WHY review_proposal{kind:'staffing'} and not a fork: m0046 already declares 'staffing' in the
// kind enum; the §5 createReviewProposal/setProposalStatus/rejectProposal lifecycle + the D-039
// gate are the established operator-gated path (the task LOCK: "reuse createReviewProposal + the
// D-039 gate — do NOT fork it"). The proposal's `role` column carries the CANDIDATE role; the
// PROJECT (project_staff is per project,role) rides in the FLEXIBLE trigger object (a staffing
// proposal targets a project, not just a role — review_proposal has no project column).
//
// EXTEND / HIRE are NOT auto-proposed here: an EXTEND grows a role (new fixtures + re-cert — a
// prompt_revision/fixture-authoring concern) and a HIRE authors a brand-new role + its gauntlet
// (the day-0 ceremony path); both are operator-gated authoring acts OUTSIDE a one-click staff.
// This bridge handles the REUSE case (one-click hire of an existing certified role) — the matcher
// still SURFACES extend/hire recommendations for the operator (loadProjectStaffingView), it just
// does not fabricate an auto-proposal for an act that needs operator authoring (F-008 honest scope).

import type { Db } from '../db/client';
import {
	createReviewProposal,
	getReviewProposal,
	listReviewProposalsForRole,
	rejectProposal,
	setProposalStatus,
	staffRole,
	getProjectStaff,
	OPEN_PROPOSAL_STATUSES,
	WorkforceInputError,
	type ProjectStaffRow,
	type ReviewProposalRow
} from './index';
import {
	recommendStaffing,
	type RoleRecommendation,
	type StaffingRecommendation
} from './capability-match';

// ── Named error (every error has a name; the message names what triggered it) ────────

/** A staffing-gate violation — a missing operator D-039 confirm, a proposal in the wrong
 *  status/kind, or a candidate that is no longer a valid REUSE. Fail loud, fail closed; the
 *  route maps it to a 400 (operator-facing), never a silent staff. */
export class StaffingGateError extends Error {
	override readonly name = 'StaffingGateError';
}

// ── The staffing proposal's trigger shape (the matcher evidence, persisted) ──────────

/** What a kind:'staffing' proposal carries in its trigger object (CAPABILITY-MATCH §4 evidence).
 *  Harness-authored (the matcher composes it from real rows) — stored verbatim (no screen). */
export interface StaffingTrigger {
	signal: 'capability_match';
	/** The project this staffing targets (review_proposal has no project column — it rides here). */
	project: string;
	/** REUSE only at the one-click bridge (extend/hire need operator authoring). */
	match: 'reuse';
	/** The needed defect-classes this candidate PROVES (the §3.8 evidence). */
	covered: string[];
	/** The candidate role's full proven coverage at match time. */
	coverage: string[];
	/** The candidate's operating tier (cost evidence); null when unresolved. */
	tier: string | null;
	/** The human evidence line the matcher produced. */
	evidence: string;
}

function isStaffingTrigger(t: Record<string, unknown>): t is StaffingTrigger & Record<string, unknown> {
	return t?.signal === 'capability_match' && typeof t?.project === 'string';
}

// ── ① PROPOSE — a REUSE recommendation → review_proposal{kind:'staffing'} ─────────────

export interface ProposeStaffingInput {
	project: string;
	/** The candidate catalog role to staff (must be a REUSE candidate in the live match). */
	role: string;
}

export interface ProposeStaffingResult {
	proposal: ReviewProposalRow;
	/** false when an OPEN staffing proposal already existed for this (project, role) — the
	 *  existing one is returned (anti-spam idempotency, interrupt contract). */
	created: boolean;
	/** The matcher recommendation this proposal was opened from (the evidence the operator reads). */
	recommendation: RoleRecommendation;
}

/**
 * §4 touch ①: open a STAFFING proposal for a (project, candidate role) — PROPOSE-ONLY. Runs the
 * LIVE matcher (recommendStaffing) to (a) prove the candidate is currently a REUSE recommendation
 * (its proven coverage ⊇ the project's needed classes) and (b) capture the evidence; then opens a
 * review_proposal{kind:'staffing', status:'proposed'} carrying that evidence in trigger. It writes
 * NOTHING to project_staff — that is the operator's confirm (touch ②).
 *
 * FAIL-CLOSED (named):
 *   • the candidate is NOT a REUSE candidate in the live match (it doesn't cover all needs, or it
 *     proves none) → StaffingGateError (the matcher PROVES coverage; we never propose a staffing
 *     the data does not support — F-008).
 *   • the project is already staffed with this role (enabled row) → StaffingGateError (no
 *     duplicate staffing; the operator unstaffs first).
 *   • project/role not found → WorkforceInputError (via recommendStaffing / the matcher).
 *
 * ANTI-SPAM / INTERRUPT CONTRACT: an OPEN staffing proposal already exists for this (project,
 * role) → return it (created:false), never a second proposal. (review_proposal has no UNIQUE on
 * dedup_key by design — the cap is enforced by this open-check, mirroring drift.ts.)
 */
export async function proposeStaffing(
	db: Db,
	input: ProposeStaffingInput
): Promise<ProposeStaffingResult> {
	const recommendation = await assertReuseCandidate(db, input.project, input.role);

	// Already staffed (enabled)? Refuse a duplicate staffing proposal — the operator unstaffs
	// first. A disabled (soft-unstaffed) row is fine to re-staff.
	const existingStaff = await getProjectStaff(db, input.project, input.role);
	if (existingStaff && existingStaff.enabled) {
		throw new StaffingGateError(
			`role ${input.role} is already staffed on project ${input.project} (enabled) — unstaff it before proposing a re-staff`
		);
	}

	// Anti-spam: an OPEN staffing proposal for this (project, role) is returned, not duplicated.
	const open = await findOpenStaffingProposal(db, input.project, input.role);
	if (open) {
		return { proposal: open, created: false, recommendation };
	}

	const trigger: StaffingTrigger = {
		signal: 'capability_match',
		project: input.project,
		match: 'reuse',
		covered: recommendation.covered,
		coverage: recommendation.coverage,
		tier: recommendation.tier,
		evidence: recommendation.evidence
	};
	const proposal = await createReviewProposal(db, {
		role: input.role,
		kind: 'staffing',
		trigger: trigger as unknown as Record<string, unknown>
	});
	return { proposal, created: true, recommendation };
}

// ── ② CONFIRM — operator D-039 → staffRole writes the row → close 'swapped' ───────────

export interface ConfirmStaffingInput {
	proposal: string;
	/** The operator's explicit D-039 confirm. REQUIRED true — fail-closed, NO auto-staff. */
	operatorConfirmed: boolean;
	/** Optional operator free text recorded on the project_staff row — SCREENED inside staffRole
	 *  (D-026). Absent ⇒ no note. */
	charterNote?: string;
}

export interface ConfirmStaffingResult {
	proposal: ReviewProposalRow;
	staff: ProjectStaffRow;
	/** false when the proposal was already 'swapped' (idempotent absorb — interrupt contract). */
	staffed: boolean;
}

/**
 * §4 touch ② / D-039 WRITE-PATH — the SOLE staff-from-proposal entry. The operator confirms; this
 * writes the ONE project_staff row via staffRole (source='pm_validated' — the matcher proposed it,
 * the operator validated it) and closes the proposal 'swapped' (the shared operator-confirmed-
 * change-applied terminal; staffing has no version swap, so 'swapped' here means "the staffing
 * was applied" — the same meaning tier_change gives it). staffRole is itself idempotent +
 * concurrency-safe (the project_staff_dedup graceful no-op) so a double-confirm is benign.
 *
 * FAIL-CLOSED GOVERNANCE (the red-team invariants):
 *   • operatorConfirmed !== true → StaffingGateError (NO auto-staff path exists, D-039).
 *   • proposal not found / not kind:'staffing' / no project in trigger → WorkforceInputError.
 *   • proposal in a terminal NON-'swapped' status (rejected/withdrawn) → StaffingGateError (a
 *     disposed proposal cannot be confirmed — re-propose).
 *
 * INTERRUPT CONTRACT: an already-'swapped' proposal re-reads + returns its project_staff row
 * (idempotent absorb) rather than double-writing or erroring.
 */
export async function confirmStaffing(
	db: Db,
	input: ConfirmStaffingInput
): Promise<ConfirmStaffingResult> {
	if (input.operatorConfirmed !== true) {
		throw new StaffingGateError(
			`confirmStaffing requires an explicit operator D-039 confirm — there is NO auto-staff path; the operator IS the staffing authority (CAPABILITY-MATCH §2.2/D-039)`
		);
	}
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (proposal.kind !== 'staffing') {
		throw new StaffingGateError(
			`proposal ${proposal.id} is kind '${proposal.kind}', not 'staffing' — confirmStaffing only applies a staffing proposal`
		);
	}
	if (!isStaffingTrigger(proposal.trigger)) {
		throw new WorkforceInputError(
			`staffing proposal ${proposal.id} has no project in its trigger — cannot resolve the (project, role) to staff (data corruption)`
		);
	}
	const project = proposal.trigger.project;

	// INTERRUPT CONTRACT: already applied → absorb (idempotent).
	if (proposal.status === 'swapped') {
		const staff = await getProjectStaff(db, project, proposal.role);
		if (!staff) {
			throw new WorkforceInputError(
				`staffing proposal ${proposal.id} is 'swapped' but no project_staff row exists for (${project}, ${proposal.role}) — data corruption`
			);
		}
		return { proposal, staff, staffed: false };
	}
	if (proposal.status !== 'proposed') {
		throw new StaffingGateError(
			`proposal ${proposal.id} is status '${proposal.status}' — only a 'proposed' staffing proposal can be confirmed (a disposed proposal must be re-proposed)`
		);
	}

	// THE WRITE: staffRole creates/enables the project_staff row + role_event{op:'staffed'}. It is
	// idempotent + concurrency-safe (the project_staff_dedup graceful no-op), so a concurrent
	// double-confirm collapses to one row. source='pm_validated' (matcher-proposed, operator-confirmed).
	const staff = await staffRole(db, project, proposal.role, {
		source: 'pm_validated',
		...(input.charterNote !== undefined ? { charterNote: input.charterNote } : {})
	});

	// Close the proposal terminally (proposed → swapped, the operator-confirmed-applied terminal).
	const moved = await setProposalStatus(db, proposal.id, { to: 'swapped' });
	return { proposal: moved, staff, staffed: true };
}

// ── ③ REJECT — reuse the §5 rejectProposal (terminal + screened reason + cooldown) ────

export interface RejectStaffingInput {
	proposal: string;
	reason?: string;
}

/** Reject/withdraw a staffing proposal — reuses the §5 rejectProposal (closes terminal with a
 *  SCREENED reason, D-026; feeds the cooldown anchor). Validates kind='staffing' first so a
 *  prompt_revision is never closed through this surface. */
export async function rejectStaffing(
	db: Db,
	input: RejectStaffingInput
): Promise<ReviewProposalRow> {
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (proposal.kind !== 'staffing') {
		throw new StaffingGateError(
			`proposal ${proposal.id} is kind '${proposal.kind}', not 'staffing' — rejectStaffing only closes a staffing proposal`
		);
	}
	const res = await rejectProposal(db, {
		proposal: input.proposal,
		...(input.reason ? { reason: input.reason } : {})
	});
	return res.proposal;
}

// ── Surface aggregator — the /agents/staffing view (read-only, honest) ────────────────

/** One project's full staffing view: its needs + the matcher result + any OPEN staffing
 *  proposals (so the surface renders the gated confirm/reject controls). Honest empties (F-008). */
export interface ProjectStaffingView {
	project: string;
	projectName: string;
	/** The full match result (needs + candidates + gaps + vocabulary). */
	match: StaffingRecommendation;
	/** OPEN staffing proposals for this project, keyed by candidate role id → proposal id +
	 *  status (the surface shows the confirm/reject controls on the matching candidate card). */
	openProposals: Array<{ proposal: string; role: string; status: string; createdAt: string | null }>;
	/** The currently-staffed (enabled) roles on this project (id list) — the surface marks them. */
	staffedRoles: string[];
}

/**
 * Build the read-only staffing view for ONE project: its declared needs + the live matcher result
 * + the OPEN staffing proposals + the currently-staffed roles. Reuses recommendStaffing (the
 * PROPOSE-ONLY matcher) + the staff reads — NO writes. Honest empties (F-008): a project with no
 * declared defect_classes yields empty candidates + gaps (fullyCovered vacuously true).
 */
export async function loadProjectStaffingView(
	db: Db,
	projectId: string,
	projectName: string
): Promise<ProjectStaffingView> {
	const match = await recommendStaffing(db, projectId);

	// OPEN staffing proposals for this project: scan each candidate's role proposals (bounded) +
	// the gaps' candidate roles produce none. We collect across the candidate roles (the only
	// roles a staffing proposal can target via this surface).
	const openProposals: ProjectStaffingView['openProposals'] = [];
	const seen = new Set<string>();
	for (const c of match.candidates) {
		if (seen.has(c.role)) continue;
		seen.add(c.role);
		const open = await findOpenStaffingProposal(db, projectId, c.role);
		if (open) {
			openProposals.push({ proposal: open.id, role: c.role, status: open.status, createdAt: open.created_at });
		}
	}

	// Currently-staffed (enabled) roles on this project.
	const { listProjectStaff } = await import('./staff');
	const staff = await listProjectStaff(db, projectId);
	const staffedRoles = staff.filter((s) => s.enabled).map((s) => s.role);

	return { project: match.project, projectName, match, openProposals, staffedRoles };
}

/** Find an OPEN staffing proposal for a (project, role) pair, or null. Reads the role's proposals
 *  (bounded) and filters to kind='staffing' + open status + matching project in trigger. */
async function findOpenStaffingProposal(
	db: Db,
	projectId: string,
	roleId: string
): Promise<ReviewProposalRow | null> {
	const proposals = await listReviewProposalsForRole(db, roleId);
	const openSet = new Set<string>(OPEN_PROPOSAL_STATUSES as unknown as string[]);
	for (const p of proposals) {
		if (p.kind !== 'staffing') continue;
		if (!openSet.has(p.status)) continue;
		if (isStaffingTrigger(p.trigger) && p.trigger.project === projectId) return p;
	}
	return null;
}

/** Re-run the matcher + assert the candidate role is a live REUSE recommendation; returns the
 *  candidate's recommendation (the evidence). Throws StaffingGateError when it is not REUSE. */
async function assertReuseCandidate(
	db: Db,
	projectId: string,
	roleId: string
): Promise<RoleRecommendation> {
	const match = await recommendStaffing(db, projectId);
	const candidate = match.candidates.find((c) => c.role === roleId);
	if (!candidate) {
		throw new StaffingGateError(
			`role ${roleId} is not a staffing candidate for project ${projectId} — it proves none of the project's needed defect classes (the matcher requires PROVEN coverage, §3.8)`
		);
	}
	if (candidate.match !== 'reuse') {
		throw new StaffingGateError(
			`role ${roleId} is an EXTEND candidate for project ${projectId} (covers [${candidate.covered.join(', ')}], missing [${candidate.missing.join(', ')}]) — a one-click staff requires a REUSE candidate (proves ALL needed classes); an EXTEND needs operator-authored fixtures + re-cert first`
		);
	}
	return candidate;
}
