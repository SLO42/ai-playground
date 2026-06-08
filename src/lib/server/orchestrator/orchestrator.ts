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
import type { AgentRuntime, Intent, ModelSelection, SpawnBudgets, ToolPolicy } from '../runtime/index';
import { launchSession, type LaunchResult } from '../sessions/launch';
import { Semaphore } from './semaphore';
import { claimNext, complete, enqueue } from './workqueue';

export type OrchMode = 'event' | 'manual' | 'periodic';

/** The DEGENERATE stub route (2.3 replaces this with real routing). */
export interface StubRoute {
	model: ModelSelection;
	intent: Intent;
	budgets: SpawnBudgets;
	toolPolicy: ToolPolicy;
	/** Agent slot id to run the spawn as (a real slot picker lands with the pool wave). */
	agentId: string;
}

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
	 * The DEGENERATE route resolver: maps a triggering task → a stub spawn plan. 2.3
	 * swaps a real `resolveRoute` in here with NO change to the orchestrator shape.
	 */
	route: (taskId: string, projectId: string) => StubRoute;
	/** Statuses that make a task spawn-ready. Default: 'ready'. */
	spawnReadyStatuses?: readonly string[];
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
	readonly #route: OrchestratorOptions['route'];
	readonly #spawnReady: ReadonlySet<string>;

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
		this.#spawnReady = new Set(opts.spawnReadyStatuses ?? ['ready']);
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

		await this.enqueueTask(taskId, projectId);
		await this.drain();
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
	 * Run one claimed work_item as a spawn, then mark it terminal and release the
	 * permit. The DEGENERATE route supplies a stub model/intent/budgets/toolPolicy
	 * (no routing 2.3, no recall 2.5). The spawn goes through launchSession (1.6b),
	 * which attaches the 1.4a isolated-config + permissions.deny guardrail.
	 */
	async #runItem(
		item: { id: string; payload: Record<string, unknown>; claimToken: string },
		permit: { release(): void }
	): Promise<void> {
		const taskId = String(item.payload.taskId ?? '');
		const projectId = String(item.payload.projectId ?? '');
		let ok = false;
		try {
			if (!taskId || !projectId) return;
			const route = this.#route(taskId, projectId);
			const res: LaunchResult = await launchSession({
				db: this.#db,
				bus: this.#bus,
				runtime: this.#runtime,
				input: {
					projectId,
					taskId,
					agentId: route.agentId,
					model: route.model,
					intent: route.intent,
					budgets: route.budgets,
					toolPolicy: route.toolPolicy
				}
			});
			this.spawnCount++;
			ok = res.status === 'done';
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
}
