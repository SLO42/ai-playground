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

import type { Db } from '../db/client';
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
import { setStatus } from '../tasks/repo';
import { Semaphore } from './semaphore';
import { runPostTask, type CommandRunner } from './post-task';
import { claimNext, complete, enqueue, gcStale, spawnsSince, DAY_MS } from './workqueue';
import { runReviewFork, makeWriteSurface, type ReviewKind } from '../memory/index';
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

export class Orchestrator {
	readonly #db: Db;
	readonly #bus: EventBus;
	readonly #runtime: AgentRuntime;
	readonly #sem: Semaphore;
	readonly #mode: OrchMode;
	readonly #intervalMs?: number;
	readonly #route: RouteResolver;
	readonly #memory?: LaunchDeps['memory'];
	readonly #spawnReady: ReadonlySet<string>;
	readonly #postTask?: OrchestratorOptions['postTask'];
	readonly #dailyCap?: number;
	readonly #capWindowMs: number;

	#unsub?: Unsubscribe;
	#timer?: ReturnType<typeof setInterval>;
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
		this.#spawnReady = new Set(opts.spawnReadyStatuses ?? ['ready']);
		this.#postTask = opts.postTask;
		this.#dailyCap = opts.dailySpawnCap && opts.dailySpawnCap > 0 ? opts.dailySpawnCap : undefined;
		this.#capWindowMs = opts.dailyCapWindowMs ?? DAY_MS;
	}

	/** The interactive semaphore (read-only view for tests/diagnostics). */
	get semaphore(): Semaphore {
		return this.#sem;
	}

	get mode(): OrchMode {
		return this.#mode;
	}

	/** True only while a periodic timer is armed (periodic is OFF by default, D-004). */
	get periodicArmed(): boolean {
		return this.#timer !== undefined;
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
					const item = await claimNext(this.#db, nextClaimToken());
					if (!item) {
						permit.release();
						break; // queue empty — nothing more to spawn this pass
					}
					claimed++;
					// Spawn in the background; release the permit when the run ends so the
					// next parked work can proceed. An interactive agent never blocks the
					// drain loop itself — we don't await the whole run here.
					void this.#runItem(item, permit);
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
		permit: { release(): void }
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
			try {
				await setStatus(this.#db, taskId, 'in_progress');
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
				input: {
					projectId,
					taskId,
					agentId: route.agentId,
					model: route.model,
					intent: route.intent,
					budgets: route.budgets,
					toolPolicy: route.toolPolicy,
					capabilities: route.capabilities
				}
			});
			this.spawnCount++;
			ok = res.status === 'done';

			// TASK 2.7 — the post-task loop (DATA-MODEL §3 step 7). OFF by default; when
			// enabled, commit + run the project test command + optional follow-up and record
			// the outcome atomically. A post-task failure must NOT crash the drain or flip the
			// work_item terminal status (the SPAWN succeeded) — it is best-effort and logged
			// via its own agent_event. Runs only when the session actually ended (done/failed).
			if (this.#postTask?.enabled) {
				try {
					const project = await getProject(this.#db, projectId);
					await runPostTask(
						this.#db,
						{
							projectId,
							taskId,
							sessionId: res.sessionId,
							cwd: project?.root_path ?? '.',
							commitMessage: `chore(agent): task ${taskId}`,
							testCommand: project?.test_command,
							runOk: res.status === 'done'
						},
						{
							run: this.#postTask.runner,
							followUpOnTestFail: this.#postTask.followUpOnTestFail
						}
					);
				} catch {
					// best-effort: never let post-task failure crash the drain or the spawn verdict
				}
			}
		} catch {
			ok = false; // a spawn failure marks the work_item failed; never crash the drain
		} finally {
			await complete(this.#db, item.id, item.claimToken, ok ? 'done' : 'failed').catch(() => {});
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
}
