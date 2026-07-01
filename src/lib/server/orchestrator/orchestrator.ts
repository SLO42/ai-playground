// TASK 2.2 — the orchestrator (event mode), DEGENERATE first (ARCHITECTURE §2.2;
// D-004; deps 1.3,1.4,1.4a,2.1,S0).
//
// Replaces v1's always-on 60s loop. In `event` mode the orchestrator is idle-cheap:
// subscriptions only, ~zero CPU. A task-created (or task→spawn-ready) trigger drives
// EXACTLY ONE spawn through the background `work_item` claim queue, gated by the
// in-process interactive semaphore.
//
// CRITICAL INVARIANTS:
//   • Subscribes via the `events` BUS ONLY (ARCHITECTURE §2.11) — it NEVER opens its
//     own SurrealDB live query. `db` owns all live queries (events/watchTable); the
//     orchestrator is just another bus consumer. This is the no-double-fire guard:
//     one task trigger arrives once, drives one enqueue, drives one spawn.
//   • work_item claim = SELECT-then-claim-by-id (workqueue.ts / DATA-MODEL §4.12),
//     NEVER UPDATE…ORDER BY.
//   • No spawn before 1.4a's deny rules — the spawn path is launchSession (1.6b),
//     which carries the isolated config + permissions.deny guardrail on every plan.
//   • DEGENERATE route (this wave): a STUB model selection, NO routing (2.3) and NO
//     memory recall (2.5). 2.3/2.5 wire those in afterward with no false deps here.
//   • Modes (D-004): `event` (default) | `manual` | `periodic`. `periodic` is PRESENT
//     but OFF by default — the timer is only armed when mode==='periodic' AND an
//     intervalMs is configured. `manual` runs only on an explicit runOnce()/trigger.
//
// Drain discipline (D-004/D-017): the queue is drained on a TRIGGER (a new enqueue, a
// freed semaphore permit, or an explicit drain), NEVER a busy loop. Each drain claims
// while permits AND work both remain, then stops.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { BusEvent, EventBus, Unsubscribe } from '../events/bus';
import type { DbChange } from '../events/db-source';
import type {
	AgentRuntime,
	CapabilitySet,
	Intent,
	ModelSelection,
	SpawnBudgets,
	ToolPolicy
} from '../runtime/index';
import { launchSession, type LaunchResult, type LaunchDeps } from '../sessions/launch';
import { getProject } from '../projects/repo';
import { setStatus, resetStuckTaskToFailed } from '../tasks/repo';
import { writeAgentEvent } from '../analytics/events';
import { Semaphore } from './semaphore';
import { runPostTask, resolveTestCommand, type CommandRunner } from './post-task';
import { mergeBackWorktree, type CommandRunner as GitRunner } from '../sessions/merge-back';
import { runGameVerifyStep, type GameVerifyRunner } from './game-verify-step';
import {
	claimNext,
	complete,
	enqueue,
	gcStale,
	spawnsSince,
	isCwdSpawningWorkType,
	DAY_MS
} from './workqueue';
import { runReviewFork, makeWriteSurface, type ReviewKind } from '../memory/index';
import { recordGraduationIfChanged, recordProjectGraduationIfChanged } from '../memory/soul-graduation';
import {
	runHireRequest,
	HIRE_REQUEST_WORK_TYPE,
	type HireRequestPayload
} from '../workforce/hire-dispatch';

export type OrchMode = 'event' | 'manual' | 'periodic';

/**
 * The resolved spawn plan the route seam hands the drain (TASK 2.3 — real routing now
 * fills this from resolveRoute; the field set is unchanged so the orchestrator shape is
 * routing-agnostic). The `route` seam may be sync (a degenerate stub / a test) OR async
 * (production resolveRoute, which awaits intent classification + provider health + writes
 * the routing_event) — the orchestrator awaits it either way.
 */
export interface StubRoute {
	model: ModelSelection;
	intent: Intent;
	budgets: SpawnBudgets;
	toolPolicy: ToolPolicy;
	/** Agent slot id to run the spawn as (a real slot picker lands with the pool wave). */
	agentId: string;
	/**
	 * Per-task capability set from the resolved intent bundle (D-036 / TASK 5.1). Forwarded
	 * onto the SpawnRequest so the runtime composes harness-base ⊕ THIS set (catalog-validated).
	 * Absent ⇒ the harness base only.
	 */
	capabilities?: CapabilitySet;
}

/** The route seam: maps a triggering task → a resolved spawn plan. Sync (degenerate stub /
 *  test) or async (production resolveRoute — content-dependent + writes the routing_event). */
export type RouteResolver = (taskId: string, projectId: string) => StubRoute | Promise<StubRoute>;

export interface OrchestratorOptions {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/** Interactive concurrency cap (config/orchestration.yaml concurrency.maxAgents). */
	maxConcurrent: number;
	/**
	 * Per-project in-flight cap (config/orchestration.yaml concurrency.perProject). The max number
	 * of sessions for the SAME project that may run concurrently — an ADDITIONAL gate on top of the
	 * global `maxConcurrent` semaphore. The shipped config carries perProject=3 now that per-session
	 * git-worktree isolation (WI-1..WI-3) gives each WRITE session its OWN worktree on the session
	 * branch (with FF-or-preserve merge-back), so concurrent same-repo work no longer races the shared
	 * project.root_path working tree/index (the F-007/F-046 git index.lock + file-stomp race) — this
	 * supersedes the F-046 perProject=1 stopgap; two DIFFERENT projects still run concurrently up to
	 * maxConcurrent. A task whose
	 * project is at its perProject in-flight count is PARKED (left pending) and re-evaluated when any
	 * in-flight session completes (event-driven re-drain, NO busy loop). Absent / < 1 ⇒ no per-project
	 * gate (byte-identical to the pre-gate behavior). The config boundary validates it as a positive
	 * integer (config/load.ts), so the live boot always passes a value ≥ 1.
	 */
	perProject?: number;
	/** Orchestration mode (D-004). Default 'event'. */
	mode?: OrchMode;
	/** Periodic interval; ONLY armed when mode==='periodic' (off by default, D-004). */
	intervalMs?: number;
	/**
	 * The route resolver: maps a triggering task → a resolved spawn plan. TASK 2.3 wired the
	 * real async `resolveRoute` in here (it classifies intent + selects tier + reads provider
	 * health + WRITES the routing_event with rationale) — with NO change to the orchestrator
	 * shape. May be sync (a degenerate stub / a test) or async; the drain awaits it either way.
	 */
	route: RouteResolver;
	/**
	 * TASK 8.3 — the live memory loop, forwarded onto every spawn's launchSession. When present
	 * (Ollama up — F-008), each session RECALLS a fenced wake-up briefing on spawn and EXTRACTS
	 * durable memories on session-end. Omitted ⇒ the loop is skipped (no recall/extract). The
	 * loop is best-effort (D-019) — it never blocks a spawn nor changes its verdict.
	 */
	memory?: LaunchDeps['memory'];
	/**
	 * WI-2 (WORKSPACE-ISOLATION-SPEC) — the per-session worktree acquirer, forwarded onto every
	 * orchestrator-driven spawn's launchSession. Production omits it ⇒ launchSession uses the real
	 * {@link acquireSessionWorktree} (a WRITE-class session on the project's git root gets an
	 * isolated worktree). Tests inject a fake so a code-write spawn against a non-git temp root does
	 * not fail closed on git mechanics they are not exercising.
	 */
	acquireWorktree?: LaunchDeps['acquireWorktree'];
	/**
	 * SH-2 GO-LIVE (SKILL-HARVEST-SPEC §"CAPTURE") — the skill-proposal CAPTURE seam, forwarded onto
	 * every orchestrator-driven spawn's launchSession. When present, a SUCCESSFUL code-write session
	 * offers its screened trajectory to this generator at session-end, which may DRAFT a skill_proposal
	 * (persisted born 'open' via SH-1; G2/D-039 — never self-promoted). Omitted ⇒ no harvest (the
	 * dormant default). BEST-EFFORT (D-019 / F-014): launchSession's seam swallows any fault — a
	 * harvester error NEVER blocks or fails the spawn.
	 */
	skillHarvester?: LaunchDeps['skillHarvester'];
	/**
	 * MODEL-BENCHMARK-SPEC class C — OPT-IN thinking capture, forwarded onto every orchestrator-
	 * driven spawn's launchSession. Default undefined/false ⇒ OFF (no benchmark thinking_capture
	 * rows; byte-identical no-regression). true ⇒ each spawn records its screened, provider-tagged
	 * thinking turns to the judged-eval corpus. Read per-boot from orchestration.yaml (F-029).
	 */
	captureThinking?: LaunchDeps['captureThinking'];
	/** Statuses that make a task spawn-ready. Default: 'ready'. */
	spawnReadyStatuses?: readonly string[];
	/**
	 * TASK 2.15 — the D-021 DAILY SPAWN CAP. The max number of work_items that may be
	 * CLAIMED (drained → spawned) within a rolling 24h window. Once reached, the drain
	 * stops claiming and parks the rest of the queue until the window rolls forward (a
	 * later trigger re-checks). 0 / undefined = uncapped (the cap is opt-in, like periodic).
	 * The window is anchored on each item's claimed_at (workqueue.spawnsSince), so it
	 * survives restarts and isn't fooled by a backlog produced earlier.
	 */
	dailySpawnCap?: number;
	/** Rolling cap window in ms. Default 24h (workqueue.DAY_MS). */
	dailyCapWindowMs?: number;
	/**
	 * Enable the post-task loop (TASK 2.7): on a session that ends, run the commit +
	 * project test command + optional follow-up and record the outcome (DATA-MODEL §3
	 * step 7). OFF by default so a degenerate orchestrator never touches git/the FS. When
	 * enabled, an injectable `runner` lets tests drive it without a live process (the
	 * default is execFile arrays — D-008).
	 */
	postTask?: {
		enabled: boolean;
		/** Injectable command runner (test seam); defaults to execFile arrays. */
		runner?: CommandRunner;
		/** Auto-enqueue a follow_up when the run succeeded but tests failed (default true). */
		followUpOnTestFail?: boolean;
	};
	/**
	 * WI-3 (WORKSPACE-ISOLATION-SPEC) — merge-back + teardown for per-session WRITE worktrees.
	 * When enabled, AFTER the post-task commit lands on the session branch (HB-1), a session that
	 * ran in an isolated worktree (WI-2: it carries worktree_path/worktree_branch) is reconciled:
	 *   • clean `done`  → FAST-FORWARD merge the session branch into the project branch, then tear
	 *     the worktree down + delete the merged branch (cleanup, F-014);
	 *   • non-FF (diverged) OR failed/cancelled → PRESERVE the branch + worktree and stamp an honest
	 *     screened note (F-007 — never lose committed work; the anti-invisible-failure surface).
	 * OFF by default so a degenerate/test orchestrator never touches git merge state unless asked.
	 * An injectable `runner` lets tests drive it against a real temp git repo; it defaults to
	 * merge-back's execFile arrays (D-008).
	 */
	mergeBack?: {
		enabled: boolean;
		/** Injectable git runner (test seam); defaults to merge-back's execFile arrays. */
		runner?: GitRunner;
	};
	/**
	 * GAME-VERIFY (docs/GAME-VERIFY-SPEC.md §"Orchestrator integration") — the live game-mod
	 * verification step. When enabled, AFTER the post-task build/test gate a session whose project
	 * DECLARES a `game_verify` harness gets its built mod VERIFIED by running the game (deploy →
	 * launch → poll-log → screened verdict → MANDATORY kill), the verdict persisted, and a non-pass
	 * verdict fed back as a `follow_up` (the next iteration's fix signal — NOT a hard task failure,
	 * F-008). A project with no `game_verify` block ⇒ the runner is NEVER invoked (gated off, exactly
	 * like test_command). OFF by default so a degenerate/test orchestrator never launches anything.
	 * An injectable `runner` lets tests drive verdicts with NO real game (F-010/F-014); it defaults
	 * to `runGameVerify` (game-verify.ts). Best-effort: a game-verify fault NEVER crashes the drain (F-014/F-048).
	 */
	gameVerify?: {
		enabled: boolean;
		/** Injectable game-verify runner (test seam); defaults to `runGameVerify` (game-verify.ts). */
		runner?: GameVerifyRunner;
	};
}

/** What one drain pass did (diagnostics / tests). */
export interface DrainSummary {
	claimed: number;
	spawned: number;
}

let tokenSeq = 0;
/** A process-unique claim-token lease (per claim) — see workqueue.claimNext. */
function nextClaimToken(): string {
	return `orch_${process.pid}_${Date.now().toString(36)}_${(tokenSeq++).toString(36)}`;
}

/**
 * Default cadence for the BACKSTOP maintenance gc (R1-2). A slow (~5 min), time-based safety
 * net — NOT the primary release. R1-1's targeted release frees a finished session's claim
 * promptly; this only catches the ones that release MISSED (a crashed/orphaned `processing`
 * row, an aged terminal row). Deliberately coarse so it never races a legitimate long claim.
 */
const GC_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export class Orchestrator {
	readonly #db: Db;
	readonly #bus: EventBus;
	readonly #runtime: AgentRuntime;
	readonly #sem: Semaphore;
	readonly #mode: OrchMode;
	readonly #intervalMs?: number;
	readonly #route: RouteResolver;
	readonly #memory?: LaunchDeps['memory'];
	readonly #acquireWorktree?: LaunchDeps['acquireWorktree'];
	readonly #skillHarvester?: LaunchDeps['skillHarvester'];
	readonly #captureThinking?: LaunchDeps['captureThinking'];
	readonly #spawnReady: ReadonlySet<string>;
	readonly #postTask?: OrchestratorOptions['postTask'];
	readonly #mergeBack?: OrchestratorOptions['mergeBack'];
	readonly #gameVerify?: OrchestratorOptions['gameVerify'];
	readonly #dailyCap?: number;
	readonly #capWindowMs: number;
	/** Per-project in-flight cap (concurrency.perProject); undefined / < 1 ⇒ no gate. */
	readonly #perProject?: number;
	/**
	 * Live count of in-flight sessions PER project id — incremented when a task-spawn item is
	 * claimed, decremented in the SAME finally that releases the interactive permit (EVERY exit
	 * path: success/failure/throw). The decrement-on-all-paths discipline mirrors the global
	 * semaphore's release-once contract: a leaked counter would permanently wedge a project
	 * (F-014 class), so the count is bumped exactly once per claim and dropped exactly once per
	 * terminal. Zero-valued entries are deleted so the map never grows unbounded.
	 */
	readonly #inFlightByProject = new Map<string, number>();

	#unsub?: Unsubscribe;
	#timer?: ReturnType<typeof setInterval>;
	/** Backstop maintenance gc timer (R1-2). Unref'd; cleared in stop(). undefined ⇒ not armed. */
	#gcTimer?: ReturnType<typeof setInterval>;
	/** The gc sweep cadence (ms) — default until startMaintenance arms a (possibly overridden) interval. */
	#gcIntervalMs: number = GC_MAINTENANCE_INTERVAL_MS;
	/** True while a maintenance gc is still in flight — guards against overlapping ticks. */
	#gcInFlight = false;
	#started = false;
	/** True after stop(): a stopped orchestrator never claims/spawns new work. */
	#stopped = false;
	/** Guards against re-entrant drains (one drain at a time keeps claims serialized). */
	#draining = false;
	/** Set while draining if another trigger arrives, so we drain once more after. */
	#redrain = false;

	/** Total spawns this orchestrator has driven (diagnostics / the verify count). */
	spawnCount = 0;

	constructor(opts: OrchestratorOptions) {
		this.#db = opts.db;
		this.#bus = opts.bus;
		this.#runtime = opts.runtime;
		this.#sem = new Semaphore(opts.maxConcurrent);
		this.#mode = opts.mode ?? 'event';
		this.#intervalMs = opts.intervalMs;
		this.#route = opts.route;
		this.#memory = opts.memory;
		this.#acquireWorktree = opts.acquireWorktree;
		this.#skillHarvester = opts.skillHarvester;
		this.#captureThinking = opts.captureThinking;
		this.#spawnReady = new Set(opts.spawnReadyStatuses ?? ['ready']);
		this.#postTask = opts.postTask;
		this.#mergeBack = opts.mergeBack;
		this.#gameVerify = opts.gameVerify;
		this.#dailyCap = opts.dailySpawnCap && opts.dailySpawnCap > 0 ? opts.dailySpawnCap : undefined;
		this.#capWindowMs = opts.dailyCapWindowMs ?? DAY_MS;
		this.#perProject = opts.perProject && opts.perProject > 0 ? opts.perProject : undefined;
	}

	/** The interactive semaphore (read-only view for tests/diagnostics). */
	get semaphore(): Semaphore {
		return this.#sem;
	}

	/** The per-project in-flight cap (undefined ⇒ no gate). Read-only view for tests/diagnostics. */
	get perProjectCap(): number | undefined {
		return this.#perProject;
	}

	/** Current in-flight session count for a project id (0 when none). Tests/diagnostics. */
	inFlightFor(projectId: string): number {
		return this.#inFlightByProject.get(projectId) ?? 0;
	}

	/**
	 * The set of project ids ALREADY at their perProject in-flight cap — the claim gate the drain
	 * hands to claimNext so those projects' pending items stay parked. Empty when no per-project
	 * gate is configured (undefined #perProject). Computed fresh each drain pass from the live map.
	 */
	#cappedProjectIds(): string[] {
		if (this.#perProject === undefined) return [];
		const capped: string[] = [];
		for (const [pid, n] of this.#inFlightByProject) {
			if (n >= this.#perProject) capped.push(pid);
		}
		return capped;
	}

	/** Increment the in-flight count for a project (at claim/spawn). No-op for an empty id. */
	#bumpProject(projectId: string): void {
		if (!projectId) return;
		this.#inFlightByProject.set(projectId, (this.#inFlightByProject.get(projectId) ?? 0) + 1);
	}

	/**
	 * Decrement the in-flight count for a project (in the permit-release finally, every exit path).
	 * Floors at 0 and DELETES a zeroed entry so the map can't grow unbounded or go negative — a
	 * leaked/over-decremented counter is the F-014 wedge class this guards against.
	 */
	#dropProject(projectId: string): void {
		if (!projectId) return;
		const n = this.#inFlightByProject.get(projectId);
		if (n === undefined) return;
		if (n <= 1) this.#inFlightByProject.delete(projectId);
		else this.#inFlightByProject.set(projectId, n - 1);
	}

	get mode(): OrchMode {
		return this.#mode;
	}

	/** True only while a periodic timer is armed (periodic is OFF by default, D-004). */
	get periodicArmed(): boolean {
		return this.#timer !== undefined;
	}

	/** True while the R1-2 backstop maintenance gc interval is armed. Read-only view for tests. */
	get maintenanceArmed(): boolean {
		return this.#gcTimer !== undefined;
	}

	/**
	 * The periodic drain interval (ms) as configured, or undefined when none is set. Read-only view
	 * for the loops read model (no behavior change) — the timer is only ARMED in 'periodic' mode
	 * (see {@link periodicArmed}); this is the configured cadence regardless of mode.
	 */
	get intervalMs(): number | undefined {
		return this.#intervalMs;
	}

	/**
	 * The maintenance gc sweep interval (ms) — the LIVE armed cadence when {@link maintenanceArmed},
	 * else the default backstop cadence. Read-only view for the loops read model (no behavior change).
	 */
	get gcIntervalMs(): number {
		return this.#gcIntervalMs;
	}

	/**
	 * Start the orchestrator. In `event` (and `periodic`) mode it subscribes to the
	 * bus — the ONLY way it observes triggers (§2.11, never its own live query). In
	 * `periodic` mode it ALSO arms the drain timer, but ONLY when an intervalMs is set
	 * (so `periodic` with no interval is still effectively off — D-004). `manual` mode
	 * subscribes to nothing and runs only on explicit runOnce().
	 */
	start(): void {
		if (this.#started) return;
		this.#started = true;

		if (this.#mode === 'event' || this.#mode === 'periodic') {
			this.#unsub = this.#bus.subscribe(
				(e) => void this.#onTrigger(e),
				// Only db_change events for the `task` table reach the handler — the
				// bus filter keeps the orchestrator from waking on unrelated traffic.
				(e) => e.type === 'db_change' && e.topic === 'task'
			);
		}

		if (this.#mode === 'periodic' && this.#intervalMs && this.#intervalMs > 0) {
			// Periodic present but OFF by default (D-004): only reached when the operator
			// explicitly selects periodic mode AND configures an interval.
			this.#timer = setInterval(() => void this.drain(), this.#intervalMs);
			if (typeof this.#timer.unref === 'function') this.#timer.unref();
		}
	}

	/**
	 * Stop subscriptions + any timer. Idempotent. In-flight spawns finish on their own,
	 * but a stopped orchestrator will NOT claim or spawn any further work — the drain
	 * loop and the post-run re-drain both short-circuit once stopped, so it can never
	 * pick up newly-enqueued items after shutdown.
	 */
	stop(): void {
		this.#stopped = true;
		this.#unsub?.();
		this.#unsub = undefined;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		// R1-2 — tear down the backstop maintenance interval too, so no timer outlives shutdown
		// (F-014: a leaked interval keeps firing gc against a closing DB). Idempotent: clearing an
		// undefined handle is a no-op, and #runMaintenanceTick also short-circuits once #stopped.
		if (this.#gcTimer) clearInterval(this.#gcTimer);
		this.#gcTimer = undefined;
		this.#started = false;
	}

	/**
	 * Handle a `task` db_change from the bus. A task that ENTERS a spawn-ready status
	 * is enqueued exactly once (the work_item dedup_key collapses a duplicate enqueue),
	 * then a drain is triggered. CREATE rows in a spawn-ready status also enqueue (a
	 * task created directly as 'ready'). This is the single trigger seam — one bus
	 * event ⇒ at most one enqueue ⇒ at most one spawn.
	 *
	 * Crash-safe: this is invoked fire-and-forget (`void this.#onTrigger`), so any error in
	 * the enqueue/drain MUST be caught here — an unhandled rejection would take down the whole
	 * server process. A trigger failure (e.g. a transient DB error, or a dedup race when more
	 * than one writer briefly overlaps) is logged and swallowed; the orchestrator is event-
	 * driven, so a later trigger re-checks. This never weakens the dedup/no-double-fire guard:
	 * enqueueTask still collapses a duplicate via the work_item UNIQUE dedup_key.
	 */
	async #onTrigger(e: BusEvent): Promise<void> {
		const change = e.data as DbChange;
		if (change.action === 'DELETE') return;
		const row = change.result as { id?: unknown; status?: string; project?: unknown } | null;
		if (!row || typeof row.status !== 'string') return;
		if (!this.#spawnReady.has(row.status)) return;

		const taskId = change.record || (row.id != null ? String(row.id) : '');
		const projectId = row.project != null ? String(row.project) : '';
		if (!taskId || !projectId) return;

		try {
			await this.enqueueTask(taskId, projectId);
			await this.drain();
		} catch (err) {
			console.warn(
				`[orchestrator] trigger for ${taskId} failed (will re-check on the next trigger): ${(err as Error).message}`
			);
		}
	}

	/**
	 * TASK 2.15 — GC the queue (D-021). A fire-and-forget maintenance trigger (D-017),
	 * NOT a loop: deletes aged terminal rows and resets crashed `processing` rows back to
	 * pending so they re-drain. Call from a SessionStart / idle maintenance trigger. Returns
	 * the GcResult counts. Delegates to the pure workqueue primitive (D-016 boundary).
	 */
	async gc(opts?: { terminalMaxAgeMs?: number; stuckMaxAgeMs?: number }): Promise<{
		deletedTerminal: number;
		recoveredStuck: number;
	}> {
		return gcStale(this.#db, opts ?? {});
	}

	/**
	 * R1-2 — arm the BACKSTOP maintenance interval. gcStale (recover orphaned `processing`
	 * work_items past their stuck-age + delete aged terminal rows) was otherwise reachable ONLY
	 * via an explicit gc() trigger and was never invoked automatically, so a missed R1-1 targeted
	 * release left a `processing` row stuck for its full lease. This arms a BOUNDED, unref'd
	 * interval (default ~5 min) that fires gc() in the background — a slow, time-based safety net,
	 * NOT the primary release (R1-1's prompt release stays primary) and NOT a busy loop.
	 *
	 * F-014 discipline: each tick is wrapped in try/catch (a GC fault NEVER propagates and never
	 * crashes the host), runs are NON-overlapping (the #gcInFlight guard skips a tick while the
	 * prior gc is still running, so a slow gc can't stack), the handle is unref()'d (it never keeps
	 * the Node process alive), and stop() clears it (no leaked timer at shutdown). Idempotent: a
	 * second call while already armed — or after stop() — is a no-op. Default cadence keeps the
	 * 1h stuckMaxAgeMs (a long-running legitimate claim is never freed early); callers may override
	 * the interval (tests) but should NOT lower stuckMaxAgeMs.
	 */
	startMaintenance(opts?: {
		intervalMs?: number;
		gcOpts?: { terminalMaxAgeMs?: number; stuckMaxAgeMs?: number };
	}): void {
		if (this.#gcTimer || this.#stopped) return;
		const intervalMs =
			opts?.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : GC_MAINTENANCE_INTERVAL_MS;
		this.#gcIntervalMs = intervalMs;
		const gcOpts = opts?.gcOpts;
		this.#gcTimer = setInterval(() => void this.#runMaintenanceTick(gcOpts), intervalMs);
		if (typeof this.#gcTimer.unref === 'function') this.#gcTimer.unref();
	}

	/**
	 * One maintenance tick (R1-2). Skips entirely if a prior gc is still in flight (no overlap)
	 * or the orchestrator has stopped, runs gc() under a try/catch so a fault is logged-and-
	 * swallowed (never propagates out of the fire-and-forget timer callback — F-014), and always
	 * clears the in-flight guard in the finally so a single failed tick can't wedge the backstop.
	 */
	async #runMaintenanceTick(gcOpts?: {
		terminalMaxAgeMs?: number;
		stuckMaxAgeMs?: number;
	}): Promise<void> {
		if (this.#gcInFlight || this.#stopped) return;
		this.#gcInFlight = true;
		try {
			await this.gc(gcOpts);
		} catch (err) {
			console.warn(
				`[orchestrator] backstop maintenance gc failed (will retry next tick): ${(err as Error).message}`
			);
		} finally {
			this.#gcInFlight = false;
		}
	}

	/**
	 * Enqueue a task_run `work_item` for one task. Idempotent within the active window
	 * via the dedup_key UNIQUE index (§4.12) — a second enqueue of the same active task
	 * is a no-op. Returns whether a NEW row was created.
	 */
	async enqueueTask(taskId: string, projectId: string): Promise<boolean> {
		const { enqueued } = await enqueue(this.#db, {
			workType: 'task_run',
			payload: { taskId, projectId },
			projectId,
			// Per-task dedup (§4.12): different tasks coexist as concurrent task_run items;
			// re-enqueuing the SAME pending task is a no-op. task_run has no session at
			// enqueue, so the task id is the dedup discriminator.
			dedupScope: taskId
		});
		return enqueued;
	}

	/**
	 * Drain the claim queue: while an interactive permit AND a claimable work_item both
	 * exist, claim one and spawn it. NEVER a busy loop — the loop ends the instant either
	 * permits or work run out (D-004). Re-entrancy is collapsed: a trigger arriving mid-
	 * drain sets a redraw flag so we drain once more rather than overlapping passes.
	 */
	async drain(): Promise<DrainSummary> {
		if (this.#stopped) return { claimed: 0, spawned: 0 }; // stopped → never claim
		if (this.#draining) {
			this.#redrain = true;
			return { claimed: 0, spawned: 0 };
		}
		this.#draining = true;
		let claimed = 0;
		let spawned = 0;
		try {
			do {
				this.#redrain = false;
				// Spawn while we have BOTH a free interactive permit AND claimable work.
				for (;;) {
					if (this.#stopped) break; // shutdown mid-drain — stop claiming
					// TASK 2.15 — daily spawn cap (D-021): once the rolling-window claim count
					// reaches the cap, stop claiming and PARK the rest. The window rolls forward
					// on its own; a later trigger re-checks. Threshold-gated, NOT a busy loop.
					if (this.#dailyCap !== undefined) {
						const drained = await spawnsSince(this.#db, this.#capWindowMs);
						if (drained >= this.#dailyCap) break; // cap reached — leave work parked
					}
					const permit = this.#sem.tryAcquire();
					if (!permit) break; // interactive cap reached — leave work parked
					// Per-project gate (concurrency.perProject): hand claimNext the project ids
					// already AT their in-flight cap so their `task_run` items are skipped (parked,
					// left pending) and re-evaluated when an in-flight session completes (the
					// permit-release finally re-drains). Computed fresh each iteration so a bump
					// from the claim just made above is reflected on the next claim in this pass.
					const item = await claimNext(this.#db, nextClaimToken(), {
						excludeProjectIds: this.#cappedProjectIds()
					});
					if (!item) {
						permit.release();
						break; // queue empty (or all remaining are capped-project cwd-spawning items) — park the rest
					}
					claimed++;
					// Count this session against its project's in-flight cap BEFORE the spawn, so the
					// next claim in this pass (and concurrent drains) see the updated count. Only a
					// CWD-SPAWNING work type (isCwdSpawningWorkType: task_run, review) consumes a project
					// session slot — those run launchSession in project.root_path and commit there; forks
					// (memory_review/hire_request) do not write to the project cwd, so they never bump the
					// per-project counter. Same single source the claim SELECT gate uses (workqueue.ts), so
					// the bump set and the park set can never drift. The matching decrement runs in
					// #runItem's permit-release finally on EVERY exit path.
					const gated =
						this.#perProject !== undefined &&
						isCwdSpawningWorkType(item.workType ?? (item.payload.work_type as string | undefined));
					const gatedProjectId = gated ? (item.projectId ?? String(item.payload.projectId ?? '')) : '';
					if (gatedProjectId) this.#bumpProject(gatedProjectId);
					// Spawn in the background; release the permit when the run ends so the
					// next parked work can proceed. An interactive agent never blocks the
					// drain loop itself — we don't await the whole run here.
					void this.#runItem(item, permit, gatedProjectId);
					spawned++;
				}
			} while (this.#redrain);
		} finally {
			this.#draining = false;
		}
		return { claimed, spawned };
	}

	/**
	 * Run one claimed work_item as a spawn, then mark it terminal and release the permit.
	 * The route seam (TASK 2.3) resolves the spawn plan — in production it AWAITS resolveRoute,
	 * which picks the provider+model through the canonical order (override→intent→tier→adaptive
	 * →health→fallback) and WRITES the routing_event with rationale+intent BEFORE the spawn, so
	 * the how/why is recorded the instant the model is chosen. The route is resolved exactly once
	 * per claimed item (one claim ⇒ one route ⇒ one spawn — the exactly-one-spawn guarantee). A
	 * route failure throws into the catch below → the work_item is marked failed (NO fabricated
	 * route, no spawn). The spawn goes through launchSession (1.6b), which attaches the 1.4a
	 * isolated-config + permissions.deny guardrail.
	 */
	async #runItem(
		item: {
			id: string;
			workType?: string;
			payload: Record<string, unknown>;
			claimToken: string;
			projectId?: string;
			sessionId?: string;
		},
		permit: { release(): void },
		/**
		 * The project id this item was counted against in the per-project in-flight map (bumped at
		 * claim in the drain). Empty string ⇒ NOT gated (a non-cwd-spawning fork — memory_review/
		 * hire_request — or no per-project cap) — #dropProject('') is a no-op. The decrement runs in
		 * the task path's permit-release finally
		 * on EVERY exit path (success/failure/throw) so the counter can never leak (F-014 wedge).
		 */
		gatedProjectId = ''
	): Promise<void> {
		// BL-7 Part B (D-027 FAST tier DRAIN) — a `memory_review` work_item is the in-use writer
		// fork, NOT a task spawn. It carries no taskId; the OLD #runItem read only payload.taskId
		// and early-returned → the fork never ran. Dispatch it HERE, BEFORE the task-spawn path,
		// so the fork drains under the SAME D-021 cap + claim-token + stale-GC the drain already
		// enforces (no new uncapped spawn path). Best-effort: a fork failure marks the item failed
		// and is logged, NEVER crashes the drain — mirroring the post-task best-effort pattern.
		// The work_type is read from the row (claimNext.workType) OR the payload, whichever is set.
		const workType = item.workType ?? (item.payload.work_type as string | undefined);
		if (workType === 'memory_review') {
			let reviewOk = false;
			try {
				// session/project are TOP-LEVEL work_item columns (enqueueReview wrote them there),
				// surfaced by claimNext as item.sessionId/projectId — NOT inside payload. Forward both
				// so the fork stamps m0033 provenance (originating session) onto every written row.
				await this.#runReviewItem(item.payload, item.sessionId, item.projectId);
				reviewOk = true;
			} catch (err) {
				console.warn(
					`[orchestrator] memory_review ${item.id} fork failed (best-effort, item marked failed): ${(err as Error).message}`
				);
			} finally {
				await complete(this.#db, item.id, item.claimToken, reviewOk ? 'done' : 'failed').catch(() => {});
				permit.release();
				void this.drain();
			}
			return;
		}

		// PM→HR dispatch (gap B) — a `hire_request` work_item is NOT a task spawn: it asks the
		// recruiter to DRAFT a certification key-set for a project's capability gap (runHireRequest
		// → draftCertificationSet, PROPOSE-ONLY, B1/B2). Dispatch it HERE, before the task-spawn
		// path, mirroring the memory_review fork: it drains under the SAME D-021 cap + claim-token +
		// stale-GC the drain already enforces (no new uncapped spawn path). PROPOSE-ONLY — it NEVER
		// runs the gauntlet (runRecruiterCampaign fires only post-approval) and NEVER confirms a key.
		// Best-effort: a failure (e.g. the B1 self-cert refusal, RecruiterIntegrityError) marks the
		// item failed and is logged, NEVER crashes the drain — mirroring the memory_review pattern.
		if (workType === HIRE_REQUEST_WORK_TYPE) {
			let hireOk = false;
			try {
				await this.#runHireRequestItem(item.payload);
				hireOk = true;
			} catch (err) {
				console.warn(
					`[orchestrator] hire_request ${item.id} draft failed (best-effort, item marked failed): ${(err as Error).message}`
				);
			} finally {
				await complete(this.#db, item.id, item.claimToken, hireOk ? 'done' : 'failed').catch(() => {});
				permit.release();
				void this.drain();
			}
			return;
		}

		const taskId = String(item.payload.taskId ?? '');
		const projectId = String(item.payload.projectId ?? '');
		let ok = false;
		try {
			if (!taskId || !projectId) return;
			// THE HEARTBEAT (post-task transition prerequisite) — move the task ready → in_progress
			// BEFORE the spawn. The spawn path (launchSession) only writes the SESSION row's status;
			// it leaves the TASK on `ready`. The post-task loop's terminal write is guarded by the
			// SAME state machine setStatus uses — `done`/`failed` are only legal FROM in_progress/
			// review (tasks/repo.ts ALLOWED_TRANSITIONS), so a task still on `ready` at post-task time
			// would be SILENTLY left ready (post-task.ts `IF $cur IN ["in_progress","review"]`), never
			// advancing to terminal and never firing the db_change the autonomous PM consumes. Moving
			// it here closes that link: ready → in_progress (now) → done|failed (post-task).
			//
			// Best-effort + idempotent (interrupt contract): setStatus is the canonical transition
			// chokepoint with its own atomic guard. A legal ready→in_progress moves it; an already
			// in_progress/review task is an identity no-op; an illegal/terminal current status (a stale
			// claim whose task advanced, or a concurrent move) throws and is SWALLOWED — we then spawn
			// exactly as before, preserving the prior unconditional-spawn behaviour. A transition
			// failure must NEVER by itself crash the drain or fail the spawn (F-014).
			//
			// HB-H2 (red-team divergence close): capture whether the task ACTUALLY landed in a
			// post-task-eligible pre-state. setStatus returns the row on success (now `in_progress`,
			// or an identity no-op for an already in_progress/review task); on an illegal current
			// status — a stale claim or a concurrent operator/PM move between enqueue and claim (the
			// `backlog`-task class the daily-cap test exercises) — it THROWS. Post-task's terminal
			// write is guarded by `IF $cur IN ["in_progress","review"]` (post-task.ts:343); if we are
			// NOT in one of those, that UPDATE SILENTLY skips while the commit/complete-as-done still
			// ran — the exact {committed work + work_item done + ok event + non-terminal task}
			// divergence the PM never sees. We make that pre-state OBSERVABLE here so the post-task
			// block below can refuse the silent half-state instead of swallowing it.
			let preStateEligible = false;
			try {
				const moved = await setStatus(this.#db, taskId, 'in_progress');
				// Eligible ⇔ the task is now in a status post-task may terminally advance. setStatus only
				// ever moves TO `in_progress`, so a non-null return is `in_progress` (legal move or
				// identity) — but check both legal pre-states defensively against any future caller.
				preStateEligible = moved?.status === 'in_progress' || moved?.status === 'review';
			} catch (transErr) {
				console.warn(
					`[orchestrator] task ${taskId} ready→in_progress skipped (status advanced or concurrent move; spawning anyway): ${(transErr as Error).message}`
				);
			}
			// Resolve the route (production: awaits resolveRoute → writes the routing_event with
			// rationale+intent). Awaiting a sync stub return is a no-op, so test/degenerate seams
			// keep working unchanged. Resolved once per claim — the exactly-one-spawn invariant.
			const route = await this.#route(taskId, projectId);
			const res: LaunchResult = await launchSession({
				db: this.#db,
				bus: this.#bus,
				runtime: this.#runtime,
				// TASK 8.3 — the memory loop rides every orchestrator-driven spawn (recall on
				// spawn, extract on session-end). Undefined ⇒ the loop is skipped (Ollama down).
				memory: this.#memory,
				// WI-2: forward the worktree acquirer so a WRITE-class spawn runs in an isolated
				// per-session worktree (production default = the real acquirer; tests inject a fake).
				acquireWorktree: this.#acquireWorktree,
				// SH-2 GO-LIVE: forward the skill-harvest CAPTURE seam so a SUCCESSFUL code-write spawn
				// drafts a born-'open' skill_proposal at session-end (best-effort, D-019 — launchSession
				// swallows any fault). Undefined ⇒ no harvest (the dormant default).
				skillHarvester: this.#skillHarvester,
				// MODEL-BENCHMARK-SPEC class C — forward the OPT-IN thinking-capture toggle so a spawn
				// records its screened, provider-tagged thinking to the judged-eval corpus. Undefined/
				// false ⇒ OFF (no thinking_capture rows; byte-identical no-regression).
				captureThinking: this.#captureThinking,
				input: {
					projectId,
					taskId,
					agentId: route.agentId,
					model: route.model,
					intent: route.intent,
					budgets: route.budgets,
					toolPolicy: route.toolPolicy,
					capabilities: route.capabilities,
					// LIFECYCLE-GRAPH (m0067): the cause of this spawn IS the work_item the drain just
					// claimed — the proximate, always-known trigger. Thread its id onto the spawn
					// agent_event.parent_event_id so the node-graph draws the queue→session edge
					// explicitly (Continue/PM rooted that work_item upstream) instead of inferring it.
					parentEventId: item.id
				}
			});
			this.spawnCount++;
			ok = res.status === 'done';

			// HB-H2 — the post-task loop runs ONLY when the task actually reached a post-task-
			// eligible pre-state (in_progress/review). If it did NOT (stale claim / concurrent
			// move; preStateEligible=false), entering runPostTask would commit + git-add/rev-parse
			// + mark the work_item `done` + write an ok completion event WHILE post-task.ts:343
			// silently skips the terminal task UPDATE — the {committed work + done work_item + ok
			// event + non-terminal task} divergence the PM (which fires only on a TERMINAL task
			// transition) never sees. We REFUSE that here: no commit, work_item marked `failed`
			// (ok stays false → the finally's complete(...'failed')), and a divergence `error`
			// agent_event names the cause so the half-state can NEVER occur silently (F-008).
			if (this.#postTask?.enabled && !preStateEligible) {
				ok = false; // honest: do NOT complete this item as `done` (the finally marks it failed)
				try {
					// HONEST + OBSERVABLE: name what triggered it (task not in a legal post-task
					// pre-state), what caught it (this gate), and what a reader sees (an `error`
					// event linked to the session/project — `divergence` is not a schema-accepted
					// agent_event type, so we use `error`, the honest "the failure" type).
					await writeAgentEvent(this.#db, {
						type: 'error',
						session: res.sessionId,
						project: projectId,
						detail: {
							by: 'orchestrator',
							reason: 'post-task-divergence',
							error:
								`post-task terminal write skipped: task ${taskId} was not in a legal ` +
								`post-task pre-state (in_progress/review) at completion — stale claim or ` +
								`concurrent status move. NO commit performed; work_item marked failed.`,
							taskId
						}
					});
				} catch (evErr) {
					// best-effort: an event-write failure never crashes the drain (F-014). The
					// work_item is STILL marked failed in the finally, so the divergence is not silent.
					console.warn(
						`[orchestrator] post-task divergence event write failed for task ${taskId} (work_item still marked failed): ${(evErr as Error).message}`
					);
				}
			} else if (this.#postTask?.enabled) {
				// TASK 2.7 — the post-task loop (DATA-MODEL §3 step 7). OFF by default; when
				// enabled, commit + run the project test command + optional follow-up and record
				// the outcome atomically. A post-task failure must NOT crash the drain or flip the
				// work_item terminal status (the SPAWN succeeded) — it is best-effort and logged
				// via its own agent_event. Runs only when the session actually ended (done/failed)
				// AND the task is in a legal post-task pre-state (HB-H2 gate above).
				try {
					const project = await getProject(this.#db, projectId);
					// WI-3 COMPOSITION: a WRITE session ran in an isolated per-session WORKTREE (WI-2);
					// the agent edits live THERE, not the shared project root. So the post-task git
					// add -A + commit MUST run IN THE WORKTREE — that lands the commit on the session
					// BRANCH for WI-3 merge-back to fast-forward. The worktree provenance is on the
					// session row; absent (READ session / non-git project) => the shared project root
					// (pre-WI-3 behaviour, unchanged). Read ONCE here and reused by merge-back below.
					const wt = await this.#readWorktree(res.sessionId);
					const cwd = wt?.path ?? project?.root_path ?? '.';
					// HB-2 — resolve the test command HONESTLY: prefer a positively-detected real
					// test target (testCommandFor) over a stored bare token that would false-fail.
					// null ⇒ honest skip (no test attempted), never a false fail / false follow-up.
					const testCommand =
						resolveTestCommand({
							buildTool: project?.build_tool,
							storedTestCommand: project?.test_command,
							cwd
						}) ?? undefined;
					const ptRes = await runPostTask(
						this.#db,
						{
							projectId,
							taskId,
							sessionId: res.sessionId,
							cwd,
							commitMessage: `chore(agent): task ${taskId}`,
							testCommand,
							runOk: res.status === 'done'
						},
						{
							run: this.#postTask.runner,
							followUpOnTestFail: this.#postTask.followUpOnTestFail
						}
					);
					// HB-H3 — the MID-RUN divergence close. The HB-H2 gate above only catches a
					// stale CLAIM pre-state; a concurrent operator/PM status move can also land
					// DURING the session run, AFTER preStateEligible was captured. runPostTask now
					// performs the guarded terminal transition FIRST and refuses to commit / write
					// an ok completion when it does not land — returning divergent:true with a
					// divergence `error` event already recorded. Honor it here: the task was NOT
					// terminally advanced by us, so the work_item is NOT a `done` (mirror HB-H2 —
					// a false `done` is the divergence). ok stays false → the finally marks it failed.
					if (ptRes.divergent) {
						ok = false;
						console.warn(
							`[orchestrator] post-task mid-run divergence for task ${taskId} (concurrent status move; work_item marked failed, divergence event recorded): now '${ptRes.taskStatus}'`
						);
					} else if (this.#gameVerify?.enabled && res.status === 'done') {
						// GAME-VERIFY (docs/GAME-VERIFY-SPEC.md) — runs AFTER the build/test gate
						// (post-task) on a CLEAN-done session, BEFORE the task is considered settled.
						// GATED: only a project that DECLARES a `game_verify` harness launches anything
						// (runGameVerifyStep returns ran:false otherwise — no behavior change for non-game
						// projects). The built mod is verified by running the game (deploy → launch →
						// poll-log → screened verdict → MANDATORY kill, serialized per game). A NON-pass
						// verdict is NOT a hard fail (F-008): it is persisted + fed back as a follow_up (the
						// next iteration's fix signal) — `ok` stays true, the task stays done. Best-effort:
						// the step never throws (F-014/F-048); the .catch is belt-and-suspenders.
						await runGameVerifyStep(
							this.#db,
							{
								projectId,
								taskId,
								sessionId: res.sessionId,
								cwd,
								rawConfig: project?.game_verify
							},
							{ runner: this.#gameVerify.runner }
						).catch((gvErr) =>
							console.warn(
								`[orchestrator] game-verify step skipped for task ${taskId} (best-effort; task stays done): ${(gvErr as Error).message}`
							)
						);
					}
				} catch {
					// best-effort: never let post-task failure crash the drain or the spawn verdict
				}
			}

			// WI-3 — merge-back + teardown. Runs AFTER the post-task commit (HB-1) so a clean
			// session's committed work is on the session BRANCH before we fast-forward it into the
			// project branch. ONLY for a session that actually ran in an isolated worktree (WI-2: the
			// row carries worktree_path/worktree_branch); a READ session / non-git project never got
			// one and is skipped. The exit state reflects the FINAL verdict (`ok`), which the post-task
			// divergence above may have flipped to false → that session PRESERVES its branch instead of
			// merging. Best-effort (F-014): a merge-back fault is logged and NEVER crashes the drain or
			// changes the work_item verdict — any committed work stays on its branch.
			if (this.#mergeBack?.enabled) {
				await this.#mergeBackSession(res.sessionId, projectId, ok ? 'done' : 'failed').catch((mbErr) =>
					console.warn(
						`[orchestrator] merge-back skipped for session ${res.sessionId} (best-effort; committed work stays on its branch): ${(mbErr as Error).message}`
					)
				);
			}
		} catch {
			ok = false; // a spawn failure marks the work_item failed; never crash the drain
		} finally {
			await complete(this.#db, item.id, item.claimToken, ok ? 'done' : 'failed').catch(() => {});
			// BL-R2 — a FAILED task_run must not strand its TASK on `in_progress`. The task was moved
			// ready→in_progress BEFORE the spawn (above), but post-task — the ONLY path that writes the
			// task's terminal `done`/`failed` — runs solely on the SUCCESS path. A route resolve throw,
			// a launchSession failure, or post-task being disabled (the default) all reach here with
			// ok=false and the task still `in_progress`, with NO next-boot reaper until restart. And
			// task_run work_items carry no `session`, so BL-R1's releaseSessionWork can't reach this
			// task either. So on a NON-OK terminal we drive the task to the honest `failed` (mirrors
			// post-task's failed write). GUARDED + idempotent (WHERE status IN [in_progress,review]):
			// a no-op when post-task already wrote the terminal (spawn-returned-failed path), when the
			// task advanced/was-parked elsewhere (stale claim / mid-run divergence — preStateEligible
			// false), or on a re-run. F-014: a transition fault is logged-and-swallowed, never crashes
			// the drain. Skipped on ok (post-task already wrote `done`) and when there is no taskId
			// (the early-return guard above, or a non-task work_type — already handled before here).
			if (!ok && taskId) {
				try {
					const failed = await resetStuckTaskToFailed(this.#db, taskId);
					if (failed) {
						console.warn(
							`[orchestrator] task ${taskId} → failed (task_run spawn/route failed; not stranded in_progress)`
						);
					}
				} catch (failErr) {
					console.warn(
						`[orchestrator] task ${taskId} terminal-failed transition errored (best-effort, drain continues): ${(failErr as Error).message}`
					);
				}
			}
			// Drop this session from its project's in-flight count BEFORE re-draining so the
			// re-drain sees the freed per-project slot and can claim a parked same-project task.
			// Runs on EVERY exit path (success/failure/throw via the catch above) — the decrement
			// can never be skipped, so the per-project counter never leaks/wedges (F-014). A no-op
			// when gatedProjectId is '' (ungated item / no per-project cap).
			this.#dropProject(gatedProjectId);
			// Free the interactive permit, then trigger one more drain so any work that
			// was parked behind the cap proceeds now (event-driven, not a busy loop).
			permit.release();
			void this.drain();
		}
	}

	/**
	 * BL-7 Part B (D-027 FAST tier DRAIN) — run the in-use writer fork over one drained
	 * `memory_review` work_item (loop.ts runReviewFork). ADD-only (D-028): the fork writes
	 * memory/skill rows through the tool-whitelisted MemoryWriteSurface and NOTHING else (no
	 * Db/exec/git/fs is reachable — the surface is the only capability it is handed). The review
	 * LLM seam (extract / proposeSkills) comes from the orchestrator's memory dep — the SAME way
	 * launchSession obtains it; in tests it is the injected mock. A missing memory dep (Ollama
	 * down / no-credential boot) is an HONEST hard error (F-008): the fork CANNOT run without the
	 * review LLM, so the item is marked failed — never silently completed as a fake success.
	 *
	 * The payload shape is the one enqueueReview wrote: `{ kind, turnText }` plus the row's
	 * `session`/`project` links (carried as record-id strings). The turnText was ALREADY screened
	 * at enqueue (launchSession), and store.ts re-screens every candidate BEFORE embed — so a
	 * planted secret cannot be written raw on either side.
	 */
	async #runReviewItem(
		payload: Record<string, unknown>,
		sessionId?: string,
		projectId?: string
	): Promise<void> {
		if (!this.#memory) {
			throw new Error('memory_review drained but no memory loop is configured (review LLM unavailable)');
		}
		const { service, extract, proposeSkills } = this.#memory;
		const kind = (payload.kind as ReviewKind | undefined) ?? 'memory';
		const turnText = typeof payload.turnText === 'string' ? payload.turnText : '';
		// session/project come from the work_item's top-level columns (claimNext), falling back to
		// any value the payload happens to carry — never fabricated.
		const session = sessionId ?? (payload.session != null ? String(payload.session) : undefined);
		const project = projectId ?? (payload.project != null ? String(payload.project) : undefined);
		const surface = makeWriteSurface(service.db, service.embedder);
		await runReviewFork({
			payload: { kind, turnText, session, project },
			surface,
			extract,
			proposeSkills
		});
		// S4 — the natural periodic "did the maturity stage change?" pass. The fork just grew the
		// brain (concepts/corrections), so this is the moment to record a graduation if the derived
		// stage crossed a boundary (soul-graduation.ts, m0078). It is FAIL-OPEN by contract (never
		// throws — a history write must never crash the drain, F-014/F-048) and dedup-safe (records
		// only on a real stage change), so it runs AFTER the fork on the same live db handle.
		await recordGraduationIfChanged(service.db);
		// Per-PM soul (per-PM identity) — the SAME fork also grew THIS project's slice of the brain
		// (the review item's concepts/corrections carry its project), so record the PROJECT's
		// graduation if ITS project-scoped stage crossed a boundary. Same fail-open + per-subject
		// dedup contract, keyed by the project record id. Skipped for a review item with no project.
		if (project) {
			await recordProjectGraduationIfChanged(service.db, project);
		}
	}

	/**
	 * PM→HR dispatch (gap B) — run the recruiter's DRAFT step over one drained `hire_request`
	 * work_item (runHireRequest → draftCertificationSet, PROPOSE-ONLY, B1/B2). The handler resolves
	 * the needed role + drafts the operator's B2 approve-surface; it writes NO certification key rows
	 * and NEVER runs the gauntlet (that fires only after the operator approves the key-SET). An
	 * 'unresolved' outcome (unknown role slug / no role_version yet) is an HONEST consume — the
	 * request was drained, there is simply nothing to draft yet (F-008), logged for the operator.
	 *
	 * The payload shape is the one dispatchHireRequest wrote: { projectId, roleSlug, defectClasses }.
	 * The defectClasses were screened at enqueue; the draft is propose-only + side-effect-free, so a
	 * re-drain is idempotent (interrupt contract).
	 */
	async #runHireRequestItem(payload: Record<string, unknown>): Promise<void> {
		const projectId = typeof payload.projectId === 'string' ? payload.projectId : '';
		const roleSlug = typeof payload.roleSlug === 'string' ? payload.roleSlug : '';
		const defectClasses = Array.isArray(payload.defectClasses)
			? payload.defectClasses.filter((c): c is string => typeof c === 'string')
			: [];
		const hirePayload: HireRequestPayload = { projectId, roleSlug, defectClasses };
		const outcome = await runHireRequest(this.#db, hirePayload);
		if (outcome.kind === 'unresolved') {
			console.warn(
				`[orchestrator] hire_request for role '${outcome.roleSlug}' unresolved (no draft produced): ${outcome.reason}`
			);
		}
	}

	/**
	 * WI-2/WI-3 — read ONE session's worktree provenance (worktree_path / worktree_branch, m0059).
	 * Returns null when the session did NOT run in an isolated worktree (a READ-class session / a
	 * non-git project / an explicit-cwd workflow step left BOTH option fields NONE) — an honest
	 * absent, never a fabricated path (F-008). Used to (a) point the post-task commit at the worktree
	 * so it lands on the session branch, and (b) drive WI-3 merge-back. The id binds at the D-016
	 * chokepoint as a record link; the values are coerced to plain strings (never raw SDK values).
	 */
	async #readWorktree(sessionId: string): Promise<{ path: string; branch: string } | null> {
		const sid = new StringRecordId(assertRecordId(sessionId));
		const [rows] = await this.#db.query<[Array<{ worktree_path?: unknown; worktree_branch?: unknown }>]>(
			`SELECT worktree_path, worktree_branch FROM ONLY $sid;`,
			{ sid }
		);
		const row = (Array.isArray(rows) ? rows[0] : rows) as
			| { worktree_path?: unknown; worktree_branch?: unknown }
			| undefined;
		const path = row?.worktree_path == null ? null : String(row.worktree_path);
		const branch = row?.worktree_branch == null ? null : String(row.worktree_branch);
		if (!path || !branch) return null;
		return { path, branch };
	}

	/**
	 * WI-3 (WORKSPACE-ISOLATION-SPEC) — reconcile ONE finished session's per-session worktree.
	 *
	 * Reads the session's WI-2 worktree provenance (worktree_path / worktree_branch). If the session
	 * did NOT run in an isolated worktree (a READ-class session / a non-git project / an explicit-cwd
	 * workflow step left BOTH fields NONE) there is nothing to merge or tear down → honest no-op. When
	 * it DID, hand off to {@link mergeBackWorktree}, which (under a per-project-root lock) FF-merges a
	 * clean-done branch into the project branch + tears the worktree down, or PRESERVES the branch +
	 * worktree + stamps an honest screened note on every other exit (F-007). The project root is the
	 * merge target tree (project.root_path). Best-effort: the helper never throws into the drain; a
	 * read/dispatch fault here is caught by the caller's `.catch` and logged — committed work always
	 * stays on its branch (F-014).
	 */
	async #mergeBackSession(
		sessionId: string,
		projectId: string,
		exitState: 'done' | 'failed'
	): Promise<void> {
		// Read the WI-2 provenance off the just-finished session row (the same read post-task used
		// for its commit cwd). Honest absent (option<string> NONE on a READ/non-git session) → no
		// worktree → skip cleanly (nothing to merge or tear down).
		const wt = await this.#readWorktree(sessionId);
		if (!wt) return; // not an isolated WRITE session — nothing to do
		const { path: worktreePath, branch: worktreeBranch } = wt;

		// The merge target tree is the project root. Absent project / root_path → cannot reconcile
		// (we never fabricate a path, F-008); the helper would have no valid cwd, so skip honestly.
		const project = await getProject(this.#db, projectId);
		const projectRoot = project?.root_path;
		if (!projectRoot) {
			console.warn(
				`[orchestrator] merge-back skipped for session ${sessionId}: project ${projectId} has no root_path (branch ${worktreeBranch} preserved)`
			);
			return;
		}

		const outcome = await mergeBackWorktree(
			this.#db,
			{ sessionId, projectRoot, worktreePath, worktreeBranch, exitState },
			{ run: this.#mergeBack?.runner }
		);
		// Log the honest outcome (merged / preserved / no-op) — the operator's audit trail. A preserve
		// is NOT an error here (the work is safe on its branch + the screened note surfaces on MC-4).
		console.info(`[orchestrator] merge-back for session ${sessionId}: ${outcome.kind} (branch ${outcome.branch})`);
	}
}

// ── Process-wide registry (mirrors pm-autonomous's activeAutonomousLoop) ─────────────────────────────
// The boot seam (boot.ts startOrchestrator) registers the live orchestrator; a READ-ONLY consumer (the
// loops read model) reads its armed-state getters (mode/periodicArmed/maintenanceArmed/intervalMs/
// gcIntervalMs) for an honest live status WITHOUT importing hooks.server.ts (circularity). Null when no
// orchestrator is running (degraded/credential-less boot) — the read model then surfaces the honest
// "not running" state rather than a fabricated one (F-008).

let activeOrch: Orchestrator | null = null;

/** Register the boot-started orchestrator (boot.ts). Pass null on teardown. */
export function setActiveOrchestrator(orch: Orchestrator | null): void {
	activeOrch = orch;
}

/** The live orchestrator, or null when none is running (degraded boot / no credential). */
export function activeOrchestrator(): Orchestrator | null {
	return activeOrch;
}
