// TASK 16.3 — W-D7a: the role_version lifecycle state machine (WORKFORCE-SPEC §2.2)
// as PURE code — one enum, one transition table, unit-testable with no DB. The DB
// write path (workforce/repo.ts transitionLifecycle) consults THIS module; nothing
// else encodes transitions, so the spec's rulings live in exactly one place.
//
// §2.2 — ONE lifecycle enum:
//   draft → interviewing → (passed | failed | error)
//   error → interviewing on retry (§3.6)
//   withdrawn allowed from draft, passed, or unretried error (no stuck exit-less rows)
//   retired is terminal (explicit operator act; from passed only)
//   failed is terminal for the row — a fix is a NEW version
// There is NO 'incumbent' lifecycle state: a swapped-out version simply stays
// `passed` (and remains pinnable, §2.4). Lifecycle records the CERTIFICATION
// CAMPAIGN only — re-runs against a passed version NEVER mutate lifecycle (the
// campaign coupling lives in repo.ts finalizeInterviewRun and is gated on the
// version being mid-campaign, i.e. lifecycle === 'interviewing').

export type RoleVersionLifecycle =
	| 'draft'
	| 'interviewing'
	| 'passed'
	| 'failed'
	| 'error'
	| 'withdrawn'
	| 'retired';

export const ROLE_VERSION_LIFECYCLES: readonly RoleVersionLifecycle[] = [
	'draft',
	'interviewing',
	'passed',
	'failed',
	'error',
	'withdrawn',
	'retired'
];

/** The §2.2 transition table — the single source of legal moves. */
const TRANSITIONS: Record<RoleVersionLifecycle, readonly RoleVersionLifecycle[]> = {
	// Campaign start, or withdrawn before ever interviewing.
	draft: ['interviewing', 'withdrawn'],
	// The certification campaign's terminal trio.
	interviewing: ['passed', 'failed', 'error'],
	// Operator acts only: retire (terminal) or withdraw (hard-blocks pins, §2.4).
	passed: ['retired', 'withdrawn'],
	// Terminal — a fix is a NEW version (failed verdicts can't be laundered).
	failed: [],
	// Retry re-enters the campaign (§3.6); an unretried error may be withdrawn.
	error: ['interviewing', 'withdrawn'],
	// Terminal exits.
	withdrawn: [],
	retired: []
};

/** Named error for an illegal lifecycle move — names from, to, and the legal set. */
export class LifecycleError extends Error {
	override readonly name = 'LifecycleError';
	constructor(
		readonly from: string,
		readonly to: string,
		detail?: string
	) {
		const legal = (TRANSITIONS as Record<string, readonly string[]>)[from];
		super(
			`illegal role_version lifecycle transition '${from}' → '${to}'` +
				(legal ? ` (legal from '${from}': ${legal.length ? legal.join(', ') : 'none — terminal'})` : '') +
				(detail ? ` — ${detail}` : '')
		);
	}
}

/** True iff `from → to` is a legal §2.2 move. Unknown states are never legal (fail closed). */
export function canTransition(from: string, to: string): boolean {
	const legal = (TRANSITIONS as Record<string, readonly RoleVersionLifecycle[]>)[from];
	return !!legal && (legal as readonly string[]).includes(to);
}

/** Assert a legal move; throws {@link LifecycleError} naming the violation. */
export function assertTransition(from: string, to: string): void {
	if (!canTransition(from, to)) throw new LifecycleError(from, to);
}

/** Lifecycles a NEW interview run may be created against (repo.createInterviewRun).
 * draft/error start (or retry) the campaign; interviewing admits multi-tier probes
 * inside one campaign; passed/retired admit EVIDENCE re-runs (§2.2 — never lifecycle-
 * mutating). failed/withdrawn rows are dead: a fix is a NEW version. */
export const INTERVIEWABLE_LIFECYCLES: readonly RoleVersionLifecycle[] = [
	'draft',
	'interviewing',
	'error',
	'passed',
	'retired'
];

/** Lifecycles a version is in when it can still be DRIVEN through the day-0 ceremony
 * (reference-run → interview → adjudicate → flip-to-certified). This is NARROWER than
 * INTERVIEWABLE_LIFECYCLES: it excludes 'retired' (terminal operator act, no longer the
 * launch candidate) on top of 'failed'/'withdrawn'. The ceremony's version picker targets
 * the NEWEST such version per role (§8) — so once a failed v1 is re-versioned, the fresh
 * v2 (draft) becomes the target and the dead v1 is never re-driven. A role whose ONLY
 * version is failed/withdrawn/retired has no ceremony-selectable version (→ honest empty,
 * the reversion affordance). NB: 'failed' is TERMINAL (§2.2) — reversion is a NEW version,
 * NEVER a lifecycle reset on the failed row. */
export const CEREMONY_SELECTABLE_LIFECYCLES: readonly RoleVersionLifecycle[] = [
	'draft',
	'interviewing',
	'error',
	'passed'
];

/** True iff a version in this lifecycle can still be DRIVEN through the ceremony (the
 * picker selects the newest such version per role). Fail-closed on unknown states. */
export function isCeremonySelectable(lifecycle: string): boolean {
	return (CEREMONY_SELECTABLE_LIFECYCLES as readonly string[]).includes(lifecycle);
}

/** True iff a version is in a TERMINAL non-selectable state (failed/withdrawn/retired) —
 * the ceremony can never drive it. 'failed' specifically is the reversion trigger. */
export function isCeremonyTerminal(lifecycle: string): boolean {
	return lifecycle === 'failed' || lifecycle === 'withdrawn' || lifecycle === 'retired';
}

// ── interview_run status machine (§2.1/§3.4) ─────────────────────────────────────
// running → adjudicating (scorer done, ambiguous queue non-empty) | passed | failed | error
// adjudicating → passed | failed (operator resolution against the snapshot pass bar)

export type InterviewRunStatus = 'running' | 'adjudicating' | 'passed' | 'failed' | 'error';

const RUN_TRANSITIONS: Record<InterviewRunStatus, readonly InterviewRunStatus[]> = {
	running: ['adjudicating', 'passed', 'failed', 'error'],
	adjudicating: ['passed', 'failed'],
	passed: [],
	failed: [],
	error: []
};

/** Named error for an illegal interview_run status move. */
export class RunStatusError extends Error {
	override readonly name = 'RunStatusError';
	constructor(
		readonly from: string,
		readonly to: string
	) {
		const legal = (RUN_TRANSITIONS as Record<string, readonly string[]>)[from];
		super(
			`illegal interview_run status transition '${from}' → '${to}'` +
				(legal ? ` (legal from '${from}': ${legal.length ? legal.join(', ') : 'none — terminal'})` : '')
		);
	}
}

export function canRunTransition(from: string, to: string): boolean {
	const legal = (RUN_TRANSITIONS as Record<string, readonly InterviewRunStatus[]>)[from];
	return !!legal && (legal as readonly string[]).includes(to);
}

export function assertRunTransition(from: string, to: string): void {
	if (!canRunTransition(from, to)) throw new RunStatusError(from, to);
}

// ── review_proposal status machine (§5 performance-review loop) ──────────────────
// The §5 two-operator-touch lifecycle (m0046 status enum), as PURE code — one
// transition table, so the governance rulings live in exactly one place (the DB
// write path in resolution.ts consults THIS; nothing else encodes the moves).
//
// §5 gate order (PM-authored path):
//   proposed → validated (the §4 panel approved) | rejected_by_panel
//   validated → diff_review (operator opens the D-010 prompt-core diff) | withdrawn
//   diff_review → interviewing (operator approved the diff; the challenger was
//                 authored + the re-gauntlet started) | rejected_by_operator | withdrawn
//   interviewing → compared (the re-gauntlet finished + comparison recorded) | rejected_by_operator
//   compared → swapped (operator D-039 confirm) | rejected_by_operator
// Operator-authored proposals SKIP the panel (the operator IS the authority the
// panel protects, §5) — they are BORN at 'proposed' and the operator opens the diff
// directly: proposed → diff_review is therefore also legal (the §4 panel is bypassed).
// 'withdrawn' (PM withdrawal) is legal from any non-terminal pre-interview state.
// swapped / rejected_by_panel / rejected_by_operator / withdrawn are TERMINAL.

export type ProposalStatus =
	| 'proposed'
	| 'validated'
	| 'rejected_by_panel'
	| 'diff_review'
	| 'interviewing'
	| 'compared'
	| 'swapped'
	| 'rejected_by_operator'
	| 'withdrawn';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
	'proposed',
	'validated',
	'rejected_by_panel',
	'diff_review',
	'interviewing',
	'compared',
	'swapped',
	'rejected_by_operator',
	'withdrawn'
];

const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
	// §4 panel verdict, OR (operator-authored) the operator opens the diff directly, OR the
	// operator declines the auto-raised proposal outright (rejected_by_operator at the source).
	proposed: ['validated', 'rejected_by_panel', 'diff_review', 'rejected_by_operator', 'withdrawn'],
	// Operator opens the D-010 prompt-core diff (security before spend, §5 touch ①), or declines.
	validated: ['diff_review', 'rejected_by_operator', 'withdrawn'],
	// Operator approved the diff → challenger authored → re-gauntlet launched.
	diff_review: ['interviewing', 'rejected_by_operator', 'withdrawn'],
	// The re-gauntlet runs; on finish the comparison is recorded (or the operator rejects).
	interviewing: ['compared', 'rejected_by_operator', 'withdrawn'],
	// Touch ②: the one-click operator swap confirm (D-039), or a reject.
	compared: ['swapped', 'rejected_by_operator', 'withdrawn'],
	// Terminal exits.
	swapped: [],
	rejected_by_panel: [],
	rejected_by_operator: [],
	withdrawn: []
};

/** Named error for an illegal review_proposal status move (names from/to + legal set). */
export class ProposalStatusError extends Error {
	override readonly name = 'ProposalStatusError';
	constructor(
		readonly from: string,
		readonly to: string
	) {
		const legal = (PROPOSAL_TRANSITIONS as Record<string, readonly string[]>)[from];
		super(
			`illegal review_proposal status transition '${from}' → '${to}'` +
				(legal
					? ` (legal from '${from}': ${legal.length ? legal.join(', ') : 'none — terminal'})`
					: '')
		);
	}
}

export function canProposalTransition(from: string, to: string): boolean {
	const legal = (PROPOSAL_TRANSITIONS as Record<string, readonly ProposalStatus[]>)[from];
	return !!legal && (legal as readonly string[]).includes(to);
}

export function assertProposalTransition(from: string, to: string): void {
	if (!canProposalTransition(from, to)) throw new ProposalStatusError(from, to);
}

/** Terminal proposal statuses (the proposal is disposed; the (role,kind) slot is free). */
export const TERMINAL_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
	'swapped',
	'rejected_by_panel',
	'rejected_by_operator',
	'withdrawn'
];

export function isProposalTerminal(status: string): boolean {
	return (TERMINAL_PROPOSAL_STATUSES as readonly string[]).includes(status);
}
