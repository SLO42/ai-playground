/**
 * /agents — per-run adjudication busy-state helpers (TASK 16.7b).
 *
 * The adjudication queue renders ONE form per adjudicating run. Each form's submit
 * must disable ONLY its own "Resolve all & finalize" button — submitting run A must
 * leave run B (and every other queued run) resolvable.
 *
 * Regression guard (16.7b): the prior implementation used a single shared scalar
 * `adjBusy` flag, so submitting any one run disabled the button on ALL queued runs.
 * Busy is now scoped PER RUN, keyed by run id, via these pure helpers — so the
 * isolation contract is unit-testable in the node runner without a component mount.
 *
 * Plain `.ts` (no runes): the reactive `$state` map lives in the component; these are
 * the rune-free transition/lookup functions it calls (F-009 — runes stay in .svelte).
 */

/** A run-id → busy map. Absent key means "not busy" (button enabled). */
export type AdjBusyMap = Record<string, boolean>;

/** Is THIS run currently submitting? Absent → false (never disable on an unknown run). */
export function isRunBusy(map: AdjBusyMap, run: string): boolean {
  return map[run] ?? false;
}

/**
 * Return a NEW map with `run` set to `busy` (immutable update so Svelte's `$state`
 * reactivity fires). Only the named run changes; every other run's flag is preserved.
 */
export function setRunBusy(map: AdjBusyMap, run: string, busy: boolean): AdjBusyMap {
  return { ...map, [run]: busy };
}
