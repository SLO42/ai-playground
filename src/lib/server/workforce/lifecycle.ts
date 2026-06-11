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
