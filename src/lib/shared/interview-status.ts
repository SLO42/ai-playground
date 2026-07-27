// THE INTERVIEW-RUN STATUS RULE — one definition, shared by every surface that states a score.
//
// WHY THIS MODULE EXISTS. "Has this run produced a score?" was spelled independently in THREE
// places (`workforce/recruiter-hire.ts`, `components/agents/hire-why-core.ts`,
// `components/agents/hiring-ledger-core.ts`) plus, by omission, in two `{#if}` chains in the
// markup. Every copy happened to agree, but nothing MADE them agree — and the F-008 defect this
// module was extracted for shipped twice, at two sibling surfaces, for exactly that reason: the
// header chips were fixed and the event line beneath them was not.
//
// It lives in `$lib/shared` (not `$lib/server`) because the two view modules compile into the
// CLIENT bundle and must not reach into the server tree. It is pure data: no DB, no I/O.
//
// THE ANCHOR. The status enum is owned by the `interview_run` ASSERT in `src/lib/server/db/
// schema.ts`. This module's job is to classify EVERY value that ASSERT admits — and
// `interview-status.test.ts` PARSES that ASSERT out of the schema source and fails if the two
// ever disagree. That is what makes "a new status cannot silently inherit `scored`" a checked
// property rather than a comment: adding one to the schema breaks the build until someone
// classifies it here, deliberately.

/**
 * A run has TERMINALLY produced its score. Only these two statuses may state recall / FP.
 *
 * Column provenance (`db/schema.ts` `interview_run` + the finalizes in `workforce/gauntlet.ts`):
 *   • `planted_total`   ← written at run CREATION, so the denominator is real from t=0;
 *   • `planted_found`   ← written by the deterministic scorer on the 'adjudicating' finalize AND
 *                         on the passed/failed finalizes;
 *   • `false_positives` ← written by the PASS BAR only, i.e. on the passed/failed finalizes. It
 *                         is NEVER written on the 'adjudicating' finalize.
 * So on any non-terminal status those columns are an uninitialised schema DEFAULT 0, or (for
 * 'adjudicating' `planted_found`) a LOWER BOUND that resolving the operator's ambiguous queue can
 * only raise — `plantedFound++` on `confirm_hit`, §3.4. Publishing either as though it were the
 * verdict is a plausible-looking fabricated value (F-008).
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed']);

/**
 * The statuses that exist and have NOT produced a score. Declared explicitly — not derived as
 * "everything else" — so the schema-parity test can prove the two sets TOGETHER cover the ASSERT
 * exactly, with nothing missing and nothing invented.
 */
export const NON_TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
	'running',
	'adjudicating',
	'error'
]);

/**
 * Whether a run may state its recall / false-positive numbers.
 *
 * FAIL-CLOSED BY CONSTRUCTION — an allow-list, never a deny-list. Shadow paths, all named:
 *   • null / undefined status (an unrecorded column, a dangling join) → false;
 *   • '' or a non-string that slipped past the types                  → false;
 *   • a status added to the schema tomorrow and not yet classified    → false.
 * The failure polarity is always "withhold the number", never "publish it anyway": withholding
 * costs the operator a glance at the status chip, publishing costs them a wrong verdict.
 */
export function isScoredStatus(status: string | null | undefined): boolean {
	return typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status);
}
