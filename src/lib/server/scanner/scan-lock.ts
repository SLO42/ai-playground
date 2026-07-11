// SCN-1 — per-(project,family) single-flight lock around the scan-and-persist window.
//
// The scanner persists a finding family as archive-active-then-insert-fresh (D-015 soft
// archive; findings-repo.ts / dep-repo.ts / ux-repo.ts). That window has NO dedup guard:
// two concurrent scans of the SAME (project, family) both archive (finding nothing or the
// same stale set) and then both insert their fresh batch — leaving TWO active finding sets
// where there must be exactly one (SCANNER-SPEC SCN-1). Findings are point-in-time rows, so
// a D-008 computed dedup key does not fit (the rows are legitimately distinct); the fix is a
// cheap in-process serialization lock (single-process deployment — ORCHESTRATOR-SPEC ORH-5,
// so no distributed lock is needed).
//
// Semantics: QUEUE-BEHIND (the simpler of the spec's two options — coalesce vs queue). A
// second scan of the SAME key awaits the first's settle (success OR failure) before it runs,
// so it archives the first scan's freshly-inserted rows and inserts its own — net exactly ONE
// active set, with the freshest data. DIFFERENT keys ((other project) or (other family)) never
// contend — they run fully concurrently. A scan that THROWS still releases the lock (the next
// waiter runs on the settled tail, never poisoned by the prior throw), so a failing scan can
// never wedge the key (F-014 no-crash / no-wedge discipline).
//
// This mirrors the house per-key lock idiom: orchestrator/game-verify-step.ts withGameLock and
// analytics/spend-budget.ts withBudgetGate (a FIFO async chain per key, map entry deleted when
// its chain drains so the map cannot grow unbounded).

/** The three finding families that share the `security_finding` table by rule prefix. */
export type ScanFamily = 'security' | 'dependency' | 'ux';

/** FIFO serialization chain per (family, project) key; the entry is deleted when its chain drains. */
const scanLocks = new Map<string, Promise<unknown>>();

/** The lock key: family + trimmed project id. Different family OR different project ⇒ different key. */
function scanLockKey(family: ScanFamily, projectId: string): string {
	return `${family}::${projectId.trim()}`;
}

/**
 * Run `fn` with the per-(project,family) scan lock held — serialized against any OTHER scan of
 * the SAME family+project, concurrent with every different key. The chain NEVER rejects (a prior
 * scan's failure must not poison the next): each waiter runs on the prior's SETTLED tail
 * (`.then(fn, fn)`), then cleans the map entry when it is the current tail. The caller still sees
 * `fn`'s own resolution/rejection.
 */
export async function withScanLock<T>(
	family: ScanFamily,
	projectId: string,
	fn: () => Promise<T>
): Promise<T> {
	const key = scanLockKey(family, projectId);
	const prior = scanLocks.get(key) ?? Promise.resolve();
	const run = prior.then(
		() => fn(),
		() => fn()
	);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	scanLocks.set(key, tail);
	try {
		return await run;
	} finally {
		if (scanLocks.get(key) === tail) scanLocks.delete(key);
	}
}

/** Test/diagnostics: number of keys with an in-flight scan chain (0 when idle). */
export function scanLockInFlightCount(): number {
	return scanLocks.size;
}
