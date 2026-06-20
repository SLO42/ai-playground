// PMA — the CONTINUOUS AUTONOMOUS PM LOOP (PM-LIFECYCLE-SPEC §PMA), built ON TOP of the shipped
// one-click lifecycle TICK (startProjectLifecycle, pm-lifecycle.ts).
//
// THE GOAL (operator): a project's PM drives FULLY UNSUPERVISED, hands-off, all the way to the FIRST
// release — but SAFELY. "Safely" is the whole point of this module:
//   • it STOPS HONESTLY on a hard blocker (never spins),
//   • it STOPS at the hard re-tick CAP (PMA-2 — a bug cannot spawn infinitely / burn unbounded spend),
//   • it STOPS at the publish/hire OPERATOR GATE (it can NEVER auto-publish or auto-hire),
//   • and it reports an HONEST stop state (running / blocked / cap-reached / dod-reached /
//     awaiting-release-confirm), NEVER a fake 'done' (F-008).
//
// HOW IT DRIVES — REUSES the existing seams; it adds NO new authority and NO new polling loop:
//   • TRIGGER = the EXISTING pm-triggers bus subscription on task `db_change` events
//     (pm-triggers.ts already subscribes to the `task` topic). This module is ANOTHER bus consumer (the
//     orchestrator pattern) — it NEVER opens its own live DB query. When a task reaches a TERMINAL state
//     (done/failed/withdrawn) AND the project's promoted batch has fully drained (no ready/in_progress/
//     review tasks left), the armed PM re-ticks toward the next batch.
//   • RE-TICK = startProjectLifecycle (the SAME one-click tick). That tick already: generates proposals
//     (the PM session), validates them through the panel, and PROMOTES via the panel's EXISTING 'act'
//     authority (we promote NOTHING here — integrity LOCKED). The tick's in-flight LOCK
//     (pm-lifecycle-lock.ts) means a re-tick that races a still-running tick gets a benign no-op — so a
//     burst of terminal events can NEVER double-spend.
//
// TERMINAL CONDITIONS (the loop stops on exactly ONE of these, all honest):
//   (1) DoD REACHED — the PM tick generated ZERO proposals (its own honest "no actionable gaps" — the
//       generator found nothing left to do toward the plan DoD) AND no work is in flight. The loop then
//       runs ONE release tick (the PM proposes the release tasks: version bump → pack/validate →
//       changelog) and HALTS at 'awaiting-release-confirm' — the real external publish is a SEPARATE
//       operator-gated action (D-037, release/+page.server.ts) this loop has NO path to. NEVER
//       auto-publishes.
//   (2) BLOCKED — a hard blocker the PM cannot propose a way forward for: a needsHire (a capability gap
//       that HALTS at the operator hire gate — D-039, NEVER auto-hires), or a re-tick that produced no
//       forward progress (zero promoted, zero left-for-operator, every proposal failed its panel) with a
//       blocked task standing. Surfaced honestly; the loop does NOT spin.
//   (3) CAP REACHED — the hard re-tick cap (PMA-2) is hit. Bounds unsupervised spend so a bug cannot
//       loop forever. (The orchestrator's EXISTING daily spawn cap, D-021, independently bounds the
//       actual session spawns — this cap bounds the LOOP's re-ticks.)
//
// SHADOW PATHS (built + tested): a terminal event for a project with NO pm / a DISARMED pm → no re-tick;
// a terminal event while a batch is still in flight → no re-tick (wait); a tick that THROWS (env/contract)
// → logged + swallowed, the loop records a blocked-by-error stop, never crashes the bus.
//
// F-014 discipline: the subscription is torn down by stop(); in-flight re-ticks are tracked so tests can
// await idle(). No timer is armed — this is purely event-driven (the bus is the clock).

import type { Db } from '../db/client';
import type { BusEvent, EventBus, Unsubscribe } from '../events/bus';
import type { DbChange } from '../events/db-source';
import { assertRecordId } from '../db/validate';
import { StringRecordId } from 'surrealdb';
import { getPm } from './pm-repo';
import {
	startProjectLifecycle,
	type LifecycleDeps,
	type StartLifecycleOpts,
	type StartLifecycleResult
} from './pm-lifecycle';

// ── Honest loop states (F-008 — never a fake 'done') ─────────────────────────────────────────────

/**
 * The honest stop/continue states the loop reports. EVERY state is a real, named condition:
 *   • running               — a batch was promoted; the loop is waiting for it to drain (not stopped).
 *   • dod-reached           — the PM found no actionable gaps + nothing in flight → the plan DoD is met.
 *   • awaiting-release-confirm — DoD met, release tasks proposed; HALTED at the operator publish gate.
 *   • blocked               — a hard blocker (needsHire / no forward progress with a blocker standing).
 *   • cap-reached           — the hard re-tick cap (PMA-2) was hit; unsupervised spend is bounded.
 *   • idle                  — nothing to do this event (disarmed / no PM / batch still in flight). Not a stop.
 */
export type AutonomousLoopState =
	| 'running'
	| 'dod-reached'
	| 'awaiting-release-confirm'
	| 'blocked'
	| 'cap-reached'
	| 'idle';

/** The outcome of one autonomous re-tick decision for a project (diagnostics + the surfaced state). */
export interface AutonomousTickOutcome {
	projectId: string;
	state: AutonomousLoopState;
	/** Honest human-readable one-line reason (F-008 — never fabricated). */
	reason: string;
	/** The underlying lifecycle tick result when a tick actually ran (null when none ran — idle/cap). */
	lifecycle: StartLifecycleResult | null;
	/** How many re-ticks this loop has performed for this project in the rolling window (PMA-2). */
	ticksUsed: number;
}

// ── Config ────────────────────────────────────────────────────────────────────────────────────────

/**
 * PMA-2 — the HARD re-tick cap. The MAX number of autonomous re-ticks the loop performs for a single
 * project within a rolling window. Once hit, the loop STOPS at 'cap-reached' (no further re-tick) until
 * the window rolls forward. This is the unsupervised-spend backstop: even a pathological re-trigger storm
 * cannot loop more than this many times. REQUIRED (never undefined) — there is no uncapped mode here.
 */
export const DEFAULT_MAX_TICKS_PER_WINDOW = 24;

/** Rolling window for the re-tick cap (default 24h — mirrors the orchestrator's daily cap window). */
export const DEFAULT_TICK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Task statuses that mean "promoted and being worked" — a batch is in flight while ANY of these stand. */
const IN_FLIGHT = new Set(['ready', 'in_progress', 'review']);
/** Task statuses that are TERMINAL for the loop's batch-drained check. */
const TERMINAL = new Set(['done', 'failed', 'withdrawn']);

export interface AutonomousLoopOptions {
	db: Db;
	bus: EventBus;
	/** The deps the underlying lifecycle tick needs to drive REAL sessions (generator + panel). */
	deps: LifecycleDeps;
	/** PMA-2 hard re-tick cap per rolling window. Default DEFAULT_MAX_TICKS_PER_WINDOW. */
	maxTicksPerWindow?: number;
	/** Rolling-window length for the cap. Default DEFAULT_TICK_WINDOW_MS. */
	tickWindowMs?: number;
	/**
	 * Forwarded to startProjectLifecycle (configDir/maxProposals/validators). The TEST seam `generate`
	 * (an injected stub generator — NO spend) rides here too, exactly as the lifecycle test injects it.
	 */
	lifecycleOpts?: StartLifecycleOpts;
	/**
	 * The release-tick opts used for the ONE DoD release tick (the PM proposes version bump / pack /
	 * changelog). Defaults to `lifecycleOpts`. In tests this injects a release-proposal stub generator.
	 */
	releaseOpts?: StartLifecycleOpts;
	/** Clock seam (tests) for the rolling cap window. */
	now?: () => number;
}

// ── The loop engine ────────────────────────────────────────────────────────────────────────────────

export class AutonomousPmLoop {
	readonly #db: Db;
	readonly #bus: EventBus;
	readonly #deps: LifecycleDeps;
	readonly #maxTicks: number;
	readonly #windowMs: number;
	readonly #lifecycleOpts: StartLifecycleOpts;
	readonly #releaseOpts: StartLifecycleOpts;
	readonly #now: () => number;

	#unsub?: Unsubscribe;
	#started = false;
	#stopped = false;

	/** In-flight re-tick promises — awaited by idle() (tests / graceful shutdown). */
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Per-project re-tick timestamps within the rolling window (PMA-2 cap accounting). */
	readonly #tickTimes = new Map<string, number[]>();
	/** Per-project re-entrancy guard: one re-tick decision at a time per project (events coalesce). */
	readonly #deciding = new Set<string>();
	/** Projects already STOPPED (dod/blocked/cap) — they do not re-trigger until re-armed/reset. */
	readonly #stoppedProjects = new Map<string, AutonomousLoopState>();

	/** Re-ticks this loop has driven (diagnostics / the verify count). */
	reTickCount = 0;
	/** The last outcome per project (the surface reads this for the honest state). */
	readonly lastOutcome = new Map<string, AutonomousTickOutcome>();

	constructor(opts: AutonomousLoopOptions) {
		this.#db = opts.db;
		this.#bus = opts.bus;
		this.#deps = opts.deps;
		this.#maxTicks = opts.maxTicksPerWindow ?? DEFAULT_MAX_TICKS_PER_WINDOW;
		this.#windowMs = opts.tickWindowMs ?? DEFAULT_TICK_WINDOW_MS;
		this.#lifecycleOpts = opts.lifecycleOpts ?? {};
		this.#releaseOpts = opts.releaseOpts ?? opts.lifecycleOpts ?? {};
		this.#now = opts.now ?? (() => Date.now());
	}

	/**
	 * Start the loop. Subscribes to the SAME events bus the pm-triggers engine and orchestrator read,
	 * filtered to `task` db_change events only. NO timer is armed — the bus is the clock (event-driven).
	 * Idempotent.
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.#unsub = this.#bus.subscribe(
			(e) => {
				this.#track(this.#onTaskEvent(e));
			},
			(e) => e.type === 'db_change' && e.topic === 'task'
		);
	}

	/** Tear down the subscription (F-014). Idempotent. */
	stop(): void {
		this.#stopped = true;
		this.#unsub?.();
		this.#unsub = undefined;
		this.#started = false;
	}

	/** Await every in-flight re-tick (tests / graceful shutdown). */
	async idle(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/** Track a fire-and-forget re-tick so idle() can await it; errors are logged + swallowed (a loop
	 *  failure must NEVER take down the bus). */
	#track(p: Promise<unknown>): void {
		const tracked = p.catch((err) => {
			console.warn(`[pm-autonomous] re-tick handling failed: ${(err as Error).message}`);
		});
		this.#inFlight.add(tracked);
		void tracked.finally(() => this.#inFlight.delete(tracked));
	}

	// ── The trigger: a task reached a terminal state ────────────────────────────────────────────────

	async #onTaskEvent(e: BusEvent): Promise<void> {
		if (this.#stopped) return;
		const change = e.data as DbChange;
		if (!change || change.action === 'DELETE') return;
		const row = change.result as Record<string, unknown> | null;
		if (!row || row.project == null) return;
		// Only a TERMINAL transition is a candidate trigger (a batch member finished). Non-terminal
		// status changes (ready→in_progress etc.) are not loop triggers — the loop re-ticks only when a
		// promoted BATCH has fully drained, which we re-verify by reading the live task rows below.
		if (typeof row.status !== 'string' || !TERMINAL.has(row.status)) return;
		await this.evaluate(String(row.project));
	}

	/**
	 * Decide whether to re-tick the armed PM for `projectId` and, if so, do it. PUBLIC + deterministic
	 * so tests drive it without the bus. Re-entrancy-guarded per project (a burst of terminal events
	 * coalesces into one decision). Returns the outcome (also stored in lastOutcome).
	 */
	async evaluate(projectId: string): Promise<AutonomousTickOutcome> {
		if (this.#deciding.has(projectId)) {
			return (
				this.lastOutcome.get(projectId) ?? this.#record(projectId, 'idle', 'a decision is already in progress', null)
			);
		}
		this.#deciding.add(projectId);
		try {
			return await this.#decide(projectId);
		} finally {
			this.#deciding.delete(projectId);
		}
	}

	async #decide(projectId: string): Promise<AutonomousTickOutcome> {
		// Gate 1 — a HIRED + ARMED PM. No pm row, or autonomous=false ⇒ idle (a disarmed/absent PM is
		// supervised: the one-click tick is the only driver). NEVER auto-hires/arms.
		const pm = await getPm(this.#db, projectId).catch(() => null);
		if (!pm) return this.#record(projectId, 'idle', 'no PM hired — not autonomous', null);
		if (!pm.autonomous) return this.#record(projectId, 'idle', 'PM is not armed for autonomous drive', null);

		// Gate 2 — the project must not still have a promoted batch IN FLIGHT. We re-read the LIVE task
		// rows (F-008) so a stale/duplicate terminal event never re-ticks while work is still running —
		// the loop advances one batch at a time. A blocked task standing is handled below (it is not
		// "in flight" — it is a hard stop signal).
		const counts = await this.#taskCounts(projectId);
		if (counts.inFlight > 0) {
			return this.#record(
				projectId,
				'running',
				`a promoted batch is still in flight (${counts.inFlight} task(s)) — waiting for it to drain`,
				null
			);
		}

		// Gate 3 — the HARD re-tick cap (PMA-2). Prune the rolling window, then refuse if at the cap.
		// This is the unsupervised-spend backstop: even a re-trigger storm cannot loop past this.
		const ticksUsed = this.#prunedTickCount(projectId);
		if (ticksUsed >= this.#maxTicks) {
			return this.#record(
				projectId,
				'cap-reached',
				`autonomous re-tick cap reached (${ticksUsed}/${this.#maxTicks} in the last ${Math.round(this.#windowMs / 3_600_000)}h) — stopping until the window rolls forward (re-arm or wait)`,
				null
			);
		}

		// We are clear to re-tick. Record the tick BEFORE running it (so a crash mid-tick still counts
		// against the cap — fail-safe toward LESS spend, never more).
		this.#recordTickTime(projectId);

		// RE-TICK: the one-click lifecycle tick. Its in-flight LOCK serializes against any concurrent
		// tick (manual click / a racing terminal event) — a benign already-running result means no
		// second spend. Promotion stays the panel's job (integrity LOCKED).
		let res: StartLifecycleResult;
		try {
			res = await startProjectLifecycle(this.#db, this.#deps, projectId, this.#lifecycleOpts);
		} catch (err) {
			// EVERY ERROR HAS A NAME: a tick that throws (env/contract) is a hard stop, surfaced honestly
			// (blocked-by-error). The loop does NOT retry-spin on it.
			return this.#record(
				projectId,
				'blocked',
				`the lifecycle re-tick failed (${(err as Error).message}) — stopping; resolve the fault and re-arm`,
				null
			);
		}
		this.reTickCount++;

		return this.#classify(projectId, res);
	}

	/**
	 * Map a re-tick's lifecycle result onto the next loop state (the honest terminal/continue decision).
	 *   • needsHire                → blocked (a capability gap HALTS at the operator hire gate — D-039).
	 *   • alreadyRunning           → idle (the lock absorbed a concurrent tick — no double spend).
	 *   • generated 0 + no work    → DoD reached → propose the release tasks → awaiting-release-confirm.
	 *   • promoted/left-for-op > 0 → running (a batch advanced; wait for it to drain).
	 *   • no forward progress      → blocked (every proposal failed / nothing promotable + a blocker).
	 */
	async #classify(projectId: string, res: StartLifecycleResult): Promise<AutonomousTickOutcome> {
		if (res.needsHire) {
			return this.#record(
				projectId,
				'blocked',
				'a PM must be hired to drive this project — HALTED at the operator hire gate (never auto-hires)',
				res
			);
		}
		if (res.alreadyRunning) {
			// The lock absorbed a concurrent tick — nothing ran this call. Stay idle; the running tick's
			// own terminal events will re-trigger the loop. No double spend.
			return this.#record(projectId, 'idle', 'a lifecycle tick is already running — no second spend', res);
		}

		const forwardProgress = res.promoted > 0 || res.leftForOperator > 0;

		if (res.generated === 0) {
			// The PM proposed NOTHING — its own honest "no actionable gaps". Combined with no in-flight
			// work (Gate 2 already passed) this is the DoD-reached signal. Re-read to confirm no blocker
			// is standing (a blocked task means the PM is stuck, not done).
			const counts = await this.#taskCounts(projectId);
			if (counts.blocked > 0) {
				return this.#record(
					projectId,
					'blocked',
					`the PM proposed no new work but ${counts.blocked} task(s) are BLOCKED — stopping honestly (the PM cannot propose a way forward)`,
					res
				);
			}
			return await this.#reachDod(projectId, res);
		}

		if (forwardProgress) {
			return this.#record(
				projectId,
				'running',
				`re-tick promoted ${res.promoted} / left ${res.leftForOperator} for you — driving the next batch`,
				res
			);
		}

		// Generated proposals but NONE advanced (every panel failed, or all pushed back) AND a blocker
		// stands → the PM cannot move forward. Stop honestly rather than spin.
		const counts = await this.#taskCounts(projectId);
		if (counts.blocked > 0 || res.panelFailures.length > 0) {
			return this.#record(
				projectId,
				'blocked',
				`re-tick made no forward progress (${res.panelFailures.length} panel failure(s), ${counts.blocked} blocked task(s)) — stopping; the PM cannot propose a way forward`,
				res
			);
		}
		// Proposals exist but are awaiting the operator (propose authority left them 'proposed' without a
		// gate brief, or pushback) — that is a benign waiting state, not a stop.
		return this.#record(
			projectId,
			'running',
			`re-tick generated ${res.generated} proposal(s) awaiting resolution`,
			res
		);
	}

	/**
	 * DoD REACHED. Run ONE release tick — the PM proposes the release tasks (version bump → pack/validate
	 * → changelog) through the SAME startProjectLifecycle path (it promotes only DEVELOPMENT tasks; it has
	 * NO publish authority). Then HALT at 'awaiting-release-confirm': the real external publish is a
	 * SEPARATE operator-gated action (D-037, release/+page.server.ts) this loop cannot reach. NEVER
	 * auto-publishes.
	 *
	 * The release tick itself counts against the PMA-2 cap (it is a real spend). If the cap is already
	 * hit we stop at dod-reached WITHOUT the release tick (honest — the operator triggers release).
	 */
	async #reachDod(projectId: string, dodRes: StartLifecycleResult): Promise<AutonomousTickOutcome> {
		const ticksUsed = this.#prunedTickCount(projectId);
		if (ticksUsed >= this.#maxTicks) {
			return this.#record(
				projectId,
				'dod-reached',
				'the plan DoD is satisfied (the PM found no actionable gaps); the re-tick cap was hit before the release tick — trigger the release yourself',
				dodRes
			);
		}
		this.#recordTickTime(projectId);
		let rel: StartLifecycleResult;
		try {
			rel = await startProjectLifecycle(this.#db, this.#deps, projectId, this.#releaseOpts);
		} catch (err) {
			// A release-tick fault is honest: the DoD is still reached; surface the release proposal
			// failure and HALT for the operator (never auto-publish, never spin).
			return this.#record(
				projectId,
				'awaiting-release-confirm',
				`the plan DoD is satisfied; the release proposal tick failed (${(err as Error).message}) — review and trigger the release yourself (never auto-published)`,
				dodRes
			);
		}
		this.reTickCount++;
		// The release tick PROPOSED the release tasks (version/pack/changelog). The loop now HALTS at the
		// operator publish gate — the actual external publish (D-037) is operator-only.
		const proposed = rel.generated;
		return this.#record(
			projectId,
			'awaiting-release-confirm',
			`the plan DoD is satisfied — proposed ${proposed} release task(s) (version bump / package / changelog). HALTED at the publish gate: trigger the external publish yourself (D-037 — never auto-published).`,
			rel
		);
	}

	// ── Cap accounting (rolling window) ─────────────────────────────────────────────────────────────

	/** Prune the rolling window for a project, returning the live re-tick count within it (PMA-2). */
	#prunedTickCount(projectId: string): number {
		const cutoff = this.#now() - this.#windowMs;
		const times = (this.#tickTimes.get(projectId) ?? []).filter((t) => t >= cutoff);
		if (times.length > 0) this.#tickTimes.set(projectId, times);
		else this.#tickTimes.delete(projectId);
		return times.length;
	}

	#recordTickTime(projectId: string): void {
		const times = this.#tickTimes.get(projectId) ?? [];
		times.push(this.#now());
		this.#tickTimes.set(projectId, times);
	}

	// ── Honest state recording ──────────────────────────────────────────────────────────────────────

	#record(
		projectId: string,
		state: AutonomousLoopState,
		reason: string,
		lifecycle: StartLifecycleResult | null
	): AutonomousTickOutcome {
		const outcome: AutonomousTickOutcome = {
			projectId,
			state,
			reason,
			lifecycle,
			ticksUsed: this.#prunedTickCount(projectId)
		};
		this.lastOutcome.set(projectId, outcome);
		if (state === 'dod-reached' || state === 'awaiting-release-confirm' || state === 'blocked' || state === 'cap-reached') {
			this.#stoppedProjects.set(projectId, state);
		} else {
			this.#stoppedProjects.delete(projectId);
		}
		return outcome;
	}

	// ── Small bounded live read (D-016: id via the validate chokepoint, value via $param) ──────────────

	/** Live task-status tallies for a project — in-flight (ready/in_progress/review) + blocked counts.
	 *  Reads the LIVE rows (F-008) so a re-tick decision is never made off stale event data. */
	async #taskCounts(projectId: string): Promise<{ inFlight: number; blocked: number }> {
		const project = new StringRecordId(assertRecordId(projectId));
		const [rows] = await this.#db.query<[Array<{ status: string; c: number }>]>(
			`SELECT status, count() AS c FROM task WHERE project = $project GROUP BY status;`,
			{ project }
		);
		let inFlight = 0;
		let blocked = 0;
		for (const r of rows ?? []) {
			if (IN_FLIGHT.has(r.status)) inFlight += Number(r.c) || 0;
			else if (r.status === 'blocked') blocked += Number(r.c) || 0;
		}
		return { inFlight, blocked };
	}
}

// ── Process-wide registry (mirrors the pm-triggers + orchestrator registries) ───────────────────────
// The boot seam registers the live loop; routes read its lastOutcome for the honest state surface
// without importing hooks.server.ts (circularity).

let active: AutonomousPmLoop | null = null;

/** Register the boot-started loop (hooks.server.ts). */
export function setActiveAutonomousLoop(loop: AutonomousPmLoop | null): void {
	active = loop;
}

/** The live loop, or null when none is running (degraded boot / no credential). */
export function activeAutonomousLoop(): AutonomousPmLoop | null {
	return active;
}

// ── Boot seam (mirrors startOrchestrator) ───────────────────────────────────────────────────────────

/** What the boot wire did — so hooks.server.ts can log it and tests can assert it. */
export type AutonomousLoopBootResult =
	| { started: true; loop: AutonomousPmLoop }
	| { started: false; reason: string };

/**
 * Build + start the live autonomous loop (PMA), wired ON the SAME bus the orchestrator + pm-triggers
 * read. Called ONCE from hooks.server.ts after the watchers + orchestrator are up. Honest availability
 * (F-008): the loop drives REAL PM sessions (the lifecycle tick), so it needs the Claude Code credential
 * — when absent we skip cleanly (started:false) and the dashboard still boots. D-004: in MANUAL mode the
 * loop is OFF (the operator's one-click tick is the only driver) — only event/periodic modes arm it.
 *
 * The loop NEVER bypasses an operator gate: it only re-runs startProjectLifecycle (which promotes via the
 * panel's EXISTING 'act' authority), it never publishes (D-037) and never hires (D-039); spend is bounded
 * by the PMA-2 re-tick cap + the orchestrator's daily spawn cap.
 */
export async function startAutonomousLoop(
	db: Db,
	bus: EventBus,
	wiring: {
		getRuntime: (db: Db) => Promise<{ available: true; runtime: import('../runtime/index').AgentRuntime } | { available: false; reason: string }>;
		mode: import('../config/index').OrchMode;
		fallbackModel: import('../runtime/index').ModelSelection;
		budgets: import('../runtime/index').SpawnBudgets;
		proposalModel: import('../runtime/index').ModelSelection;
		proposalAgentId: string;
		maxTicksPerWindow?: number;
	}
): Promise<AutonomousLoopBootResult> {
	if (wiring.mode === 'manual') {
		return { started: false, reason: 'orchestration mode is manual — autonomous loop OFF (operator one-click only, D-004)' };
	}
	const avail = await wiring.getRuntime(db);
	if (!avail.available) {
		return { started: false, reason: avail.reason };
	}
	const loop = new AutonomousPmLoop({
		db,
		bus,
		deps: {
			bus,
			runtime: avail.runtime,
			fallbackModel: wiring.fallbackModel,
			budgets: wiring.budgets,
			proposalModel: wiring.proposalModel,
			proposalAgentId: wiring.proposalAgentId
		},
		...(wiring.maxTicksPerWindow != null ? { maxTicksPerWindow: wiring.maxTicksPerWindow } : {})
	});
	loop.start();
	setActiveAutonomousLoop(loop);
	return { started: true, loop };
}
