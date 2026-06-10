// Process shutdown teardown (TASK 13.5 finding 6; F-014 prevention).
//
// hooks.server.ts opens 14+ live-query watchers, starts the orchestrator, holds the
// runtime DB connection, and may have live claude.exe children — and until 13.5 NOTHING
// in src handled SIGTERM/SIGINT, so a stopped dev server leaked all of it (the F-014
// orphan storm was exactly this shape). This module registers ONCE-only signal handlers
// that run an ordered, bounded teardown:
//
//   1. stop the orchestrator(s)        — no NEW work is claimed/spawned
//   2. tree-kill tracked claude children — Windows-safe (taskkill /T via services/proc)
//   3. kill the live-query watchers     — the SSE sources go quiet
//   4. close the DB connection          — the socket is released
//   5. exit
//
// Every step is best-effort (a failed step never blocks the next), and a hard watchdog
// (WATCHDOG_MS) force-exits even if a step hangs on a dead socket — a shutdown handler
// that can itself hang would just reintroduce F-014. Deps are injected so the teardown
// is fully unit-testable without sending real signals or exiting the test process.

/** What the teardown needs to tear down — injected by hooks.server.ts. */
export interface ShutdownDeps {
	/** Stop the orchestrator(s): no further claims/spawns. Sync (Orchestrator.stop()). */
	stopOrchestrators(): void;
	/** Windows-safe tree-kill of every tracked claude child (cli-backend registry). */
	killChildren(): Promise<unknown>;
	/** Kill every open live-query watcher (DbSourceHandle.stop()). */
	stopWatchers(): Promise<unknown>;
	/** Close the runtime DB connection (db/client closeDb — idempotent). */
	closeDb(): Promise<unknown>;
	/** Terminate the process. Injected so tests never exit the runner. */
	exit(code: number): void;
	/** Optional logger (console.log in production). */
	log?(msg: string): void;
}

/** Hard bound on the whole teardown — a hung step (dead DB socket) must not wedge exit. */
export const WATCHDOG_MS = 5000;

// Once-only across dev SSR module re-evaluation (Vite can re-import this module on HMR;
// module-scope state alone would re-register handlers and double-run the teardown).
const REGISTERED_FLAG = Symbol.for('atelier.shutdown.registered');
const RAN_FLAG = Symbol.for('atelier.shutdown.ran');
type FlagHost = Record<symbol, boolean | undefined>;

/** Test seam: clear the once-only flags (NEVER called in production). */
export function resetShutdownForTest(): void {
	(globalThis as FlagHost)[REGISTERED_FLAG] = undefined;
	(globalThis as FlagHost)[RAN_FLAG] = undefined;
}

/**
 * Run the ordered teardown exactly once. Every step is individually best-effort:
 * a throwing/rejecting step is swallowed and the NEXT step still runs (a teardown
 * that aborts halfway leaks the rest). Idempotent — a second signal is a no-op.
 */
export async function runShutdown(deps: ShutdownDeps): Promise<void> {
	const g = globalThis as FlagHost;
	if (g[RAN_FLAG]) return;
	g[RAN_FLAG] = true;

	const log = deps.log ?? (() => {});
	log('[shutdown] signal received — stopping orchestrator, children, watchers, DB.');
	try {
		deps.stopOrchestrators();
	} catch {
		/* best-effort */
	}
	try {
		await deps.killChildren();
	} catch {
		/* best-effort */
	}
	try {
		await deps.stopWatchers();
	} catch {
		/* best-effort */
	}
	try {
		await deps.closeDb();
	} catch {
		/* best-effort */
	}
	log('[shutdown] teardown complete.');
}

/**
 * Register the SIGTERM/SIGINT handlers ONCE per process (survives dev HMR re-eval via a
 * global flag). On the first signal: run the teardown, then exit(0). A watchdog force-
 * exits(1) after {@link WATCHDOG_MS} even if a teardown step hangs (F-014: a shutdown
 * path must itself be bounded). Returns true when the handlers were installed by THIS
 * call, false when they were already in place.
 */
export function registerShutdown(deps: ShutdownDeps, proc: NodeJS.EventEmitter = process): boolean {
	const g = globalThis as FlagHost;
	if (g[REGISTERED_FLAG]) return false;
	g[REGISTERED_FLAG] = true;

	const onSignal = (): void => {
		const watchdog = setTimeout(() => deps.exit(1), WATCHDOG_MS);
		(watchdog as { unref?: () => void }).unref?.();
		void runShutdown(deps)
			.catch(() => {})
			.finally(() => {
				clearTimeout(watchdog);
				deps.exit(0);
			});
	};
	proc.once('SIGTERM', onSignal);
	proc.once('SIGINT', onSignal);
	return true;
}
