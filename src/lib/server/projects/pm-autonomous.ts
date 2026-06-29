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
import { getPm, setPmAutonomous } from './pm-repo';
import {
	startProjectLifecycle,
	type LifecycleDeps,
	type StartLifecycleOpts,
	type StartLifecycleResult
} from './pm-lifecycle';
import { runReleaseReadinessGate, type ReleaseGateResult } from './release-gate';
import { appendSceneEvent } from '../scene/projector';
import type { EnvLike } from '../adapters/secrets';

// ── Honest loop states (F-008 — never a fake 'done') ─────────────────────────────────────────────

/**
 * The honest stop/continue states the loop reports. EVERY state is a real, named condition:
 *   • running               — a batch was promoted; the loop is waiting for it to drain (not stopped).
 *   • dod-reached           — the PM found no actionable gaps + nothing in flight → the plan DoD is met.
 *   • awaiting-release-confirm — DoD met, release tasks proposed; HALTED at the operator publish gate.
 *   • published             — DoD met, the operator's auto-publish consent was recorded AND the objective
 *                             release-readiness gate (build + pack + validate) passed → the EXISTING D-037
 *                             publish path ran and completed. v1 SHIPPED — the one-shot 0→v1 drive is DONE:
 *                             the loop AUTO-DISARMS the PM (autonomous=false) so it never re-ticks past v1,
 *                             and the state reads 'v1 shipped — autonomous mode complete; further versions
 *                             are on-demand'. Re-arming for v1.1 is a fresh, explicit operator action.
 *   • blocked               — a hard blocker (needsHire / no forward progress with a blocker standing).
 *   • cap-reached           — the hard re-tick cap (PMA-2) was hit; unsupervised spend is bounded.
 *   • idle                  — nothing to do this event (disarmed / no PM / batch still in flight). Not a stop.
 */
export type AutonomousLoopState =
	| 'running'
	| 'dod-reached'
	| 'awaiting-release-confirm'
	| 'published'
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
	/**
	 * The objective release-readiness gate's verdict when the consented auto-publish path ran (null on
	 * every other outcome). Present on BOTH a green 'published' result AND a red gate that halted at
	 * 'awaiting-release-confirm' — so the surface shows the exact build/pack/validate/publish facts (F-008).
	 */
	releaseGate?: ReleaseGateResult | null;
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
	/**
	 * PMA — the runtime env ($env/dynamic/private) the objective release-readiness gate reads the publish
	 * credential from (D-026 — presence only). REQUIRED for the consented auto-publish path: absent ⇒ the
	 * gate cannot resolve a token and the loop halts at 'awaiting-release-confirm' (unchanged-when-no-consent
	 * behavior is preserved regardless). Defaults to {} so an un-wired loop never publishes.
	 */
	env?: EnvLike;
	/**
	 * PMA — the consented auto-publish GATE seam. Injected the (db, env, projectId, consent) it needs to run
	 * the objective build+pack+validate gate and, only if green, the EXISTING D-037 publish. Tests inject a
	 * stub (NO real build, NO real publish); production omits it → the real {@link runReleaseReadinessGate}.
	 */
	releaseGate?: (input: {
		db: Db;
		env: EnvLike;
		projectId: string;
		consent: boolean;
	}) => Promise<ReleaseGateResult>;
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
	readonly #env: EnvLike;
	readonly #releaseGate: NonNullable<AutonomousLoopOptions['releaseGate']>;

	#unsub?: Unsubscribe;
	#started = false;
	#stopped = false;

	/** In-flight re-tick promises — awaited by idle() (tests / graceful shutdown). */
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Per-project re-tick timestamps within the rolling window (PMA-2 cap accounting). */
	readonly #tickTimes = new Map<string, number[]>();
	/** Per-project re-entrancy guard: one re-tick decision at a time per project (events coalesce). */
	readonly #deciding = new Set<string>();
	/**
	 * Projects already STOPPED. A terminal stop state (dod-reached / awaiting-release-confirm / blocked)
	 * LATCHES here and #decide re-surfaces it WITHOUT re-spending — the project stays stopped until an
	 * operator re-arm (a disarm clears the latch in #decide's Gate 1). This is what delivers the "never
	 * spin / stays stopped" guarantee. 'cap-reached' is recorded too but #decide deliberately re-evaluates
	 * it (NOT a hard latch) so the rolling window can free it — Gate 3 owns that decision.
	 */
	readonly #stoppedProjects = new Map<string, AutonomousLoopState>();
	/**
	 * PHASE SEPARATION (EXP-1 red-team hole #2) — projects whose release-prep tasks (version bump → 1.0.0,
	 * changelog, pack) have ALREADY been proposed this consented drive. The consented auto-publish is a TWO-
	 * PHASE flow: cycle 1 PROPOSES release prep and HOLDS (never publishes a version-stale artifact), then
	 * once those tasks DRAIN a later cycle runs the objective gate + publish. This flag is what makes the
	 * second cycle SKIP re-proposing (release-tick dedup only absorbs still-'proposed' rows, so a promoted-
	 * then-done release task would otherwise be re-proposed every cycle → a livelock) and go straight to the
	 * gate — guaranteeing release prep is proposed ONCE, drains, then publishes. Cleared on a disarm/re-arm
	 * (Gate 1) and on a published/blocked terminal so a fresh operator-initiated drive re-proposes cleanly.
	 */
	readonly #releasePrepProposed = new Set<string>();

	/** Re-ticks this loop has driven (diagnostics / the verify count). */
	reTickCount = 0;
	/** The last outcome per project (the surface reads this for the honest state). */
	readonly lastOutcome = new Map<string, AutonomousTickOutcome>();

	/** The HARD per-window re-tick cap (PMA-2). Read-only view for the loops read model. */
	get maxTicksPerWindow(): number {
		return this.#maxTicks;
	}

	/** The rolling-window length (ms) for the re-tick cap. Read-only view for the loops read model. */
	get tickWindowMs(): number {
		return this.#windowMs;
	}

	constructor(opts: AutonomousLoopOptions) {
		this.#db = opts.db;
		this.#bus = opts.bus;
		this.#deps = opts.deps;
		this.#maxTicks = opts.maxTicksPerWindow ?? DEFAULT_MAX_TICKS_PER_WINDOW;
		this.#windowMs = opts.tickWindowMs ?? DEFAULT_TICK_WINDOW_MS;
		this.#lifecycleOpts = opts.lifecycleOpts ?? {};
		this.#releaseOpts = opts.releaseOpts ?? opts.lifecycleOpts ?? {};
		this.#now = opts.now ?? (() => Date.now());
		this.#env = opts.env ?? {};
		// Production: the real objective gate (build + pack + validate → EXISTING D-037 publish). The seam
		// is injected the loop's own env so the gate's credential resolution stays D-026-confined.
		this.#releaseGate =
			opts.releaseGate ??
			((g) => runReleaseReadinessGate({ db: g.db, env: g.env, projectId: g.projectId, consent: g.consent }));
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
			const outcome = await this.#decide(projectId);
			// LIFECYCLE-GRAPH (LIFECYCLE-GRAPH-SPEC) — emit a `pm_tick` scene_event so the PM node + its
			// in/out edges become OBSERVABLE in the node-graph (today the tick lives only in the in-memory
			// lastOutcome). Emit ONLY when a real re-tick RAN (outcome.lifecycle != null) — an idle / latched
			// re-surface ran no tick and roots no PM node. BEST-EFFORT / NON-BLOCKING (D-019 / F-048): the
			// append is awaited-and-swallowed so a scene_event write fault NEVER changes the re-tick outcome
			// nor crashes the bus. Bounded meta (state/reason + ids only — never raw proposal text); screened.
			if (outcome.lifecycle) await this.#emitPmTick(projectId, outcome);
			return outcome;
		} finally {
			this.#deciding.delete(projectId);
		}
	}

	/**
	 * Best-effort `pm_tick` scene_event for one re-tick outcome. Surfaces the honest tick state +
	 * reason + cap usage, plus the BOUNDED set of task ids the tick PROPOSED/advanced (the PM node's
	 * OUT edges to the new task nodes — `proposedTaskIds`). All ids are `table:id` opaque refs, never
	 * raw row content; appendSceneEvent screens the meta (D-026). A throw here is caught + logged and
	 * never propagates (the re-tick already happened; this is observability, F-048).
	 */
	async #emitPmTick(projectId: string, outcome: AutonomousTickOutcome): Promise<void> {
		// proposedTaskIds: the real task ids this tick put through the panel (born 'proposed' / advanced)
		// — the PM node's outgoing edges to the new task nodes. Bounded to a small cap so the meta stays
		// label-class (the graph can fan out to the full set via the live task rows if it needs more).
		const proposedTaskIds = (outcome.lifecycle?.panels ?? [])
			.map((p) => p.taskId)
			.filter((id): id is string => typeof id === 'string' && id.length > 0)
			.slice(0, 20);
		try {
			await appendSceneEvent(this.#db, {
				kind: 'pm_tick',
				ref: projectId,
				source: 'pm',
				project: projectId,
				meta: {
					state: outcome.state,
					reason: outcome.reason,
					ticksUsed: outcome.ticksUsed,
					...(proposedTaskIds.length ? { proposedTaskIds: proposedTaskIds.join(',') } : {})
				}
			});
		} catch (err) {
			console.warn(
				`[pm-autonomous] pm_tick scene_event append failed (re-tick unaffected): ${(err as Error).message}`
			);
		}
	}

	async #decide(projectId: string): Promise<AutonomousTickOutcome> {
		// Gate 1 — a HIRED + ARMED PM. No pm row, or autonomous=false ⇒ idle (a disarmed/absent PM is
		// supervised: the one-click tick is the only driver). NEVER auto-hires/arms. Reading the live pm
		// row FIRST also makes the stop-latch self-clearing: a disarm (autonomous=false) — the ONLY way an
		// operator re-opens the loop — drops the latch here, so the subsequent re-arm starts clean WITHOUT
		// the route having to reach into this in-memory loop (addresses the re-arm-reset concern).
		const pm = await getPm(this.#db, projectId).catch(() => null);
		if (!pm) {
			this.#stoppedProjects.delete(projectId);
			this.#releasePrepProposed.delete(projectId);
			return this.#record(projectId, 'idle', 'no PM hired — not autonomous', null);
		}
		if (!pm.autonomous) {
			this.#stoppedProjects.delete(projectId);
			this.#releasePrepProposed.delete(projectId);
			return this.#record(projectId, 'idle', 'PM is not armed for autonomous drive', null);
		}

		// Stop-latch — a project that already reached a terminal stop state (dod-reached /
		// awaiting-release-confirm / published / blocked / cap-reached) STAYS stopped: a later terminal event must NOT
		// re-enter the spend path and re-propose duplicate release tasks or retry a failing tick (the
		// "never spin / stays stopped" contract). Re-surface the latched state WITHOUT re-spending; the
		// latch is cleared only by a disarm (above) — i.e. an explicit operator re-arm. (cap-reached is the
		// exception: it must re-evaluate so the rolling window can free it — Gate 3 owns that, returning
		// cap-reached again if still capped or re-ticking once the window rolls forward.)
		const latched = this.#stoppedProjects.get(projectId);
		if (latched && latched !== 'cap-reached') {
			const prev = this.lastOutcome.get(projectId);
			return this.#record(
				projectId,
				latched,
				prev ? `latched at ${latched} — staying stopped until re-armed (${prev.reason})` : `latched at ${latched} — staying stopped until re-armed`,
				prev?.lifecycle ?? null,
				prev?.releaseGate ?? null
			);
		}

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
	 * DoD REACHED. The consented auto-publish is a TWO-PHASE flow (EXP-1 red-team hole #2 — never publish a
	 * version-stale artifact):
	 *
	 *   PHASE 1 (PROPOSE + HOLD): run ONE release tick — the PM proposes the release tasks (version bump →
	 *     1.0.0, pack/validate, changelog) through the SAME startProjectLifecycle path (it promotes only
	 *     DEVELOPMENT tasks; it has NO publish authority of its own). When that tick GENERATES/ADVANCES any
	 *     release prep, those tasks have NOT RUN YET — if we built+packed+published in this SAME cycle we
	 *     would publish the OLD version (the version-bump task is still only 'proposed'/'ready'). So with
	 *     consent recorded we MARK release-prep-proposed and return a NON-LATCHING 'running' so those tasks
	 *     DEVELOP. The publish is HELD until they drain.
	 *
	 *   PHASE 2 (PUBLISH): a LATER terminal event re-enters here once release prep has DRAINED (Gate 2 in
	 *     #decide already guarantees nothing is in flight to reach #reachDod, and #releasePrepProposed proves
	 *     prep was already proposed this drive). We then SKIP re-proposing (the release-tick dedup only
	 *     absorbs still-'proposed' rows, so a promoted-then-done release task would otherwise be re-proposed
	 *     every cycle → a LIVELOCK) and run the OBJECTIVE release-readiness gate (build + pack + validate)
	 *     against the COMPLETED artifact (correct version). ONLY a fully GREEN gate proceeds through the
	 *     EXISTING D-037 publish path → 'published'. ANY red HALTS at 'awaiting-release-confirm' with the
	 *     failing checks surfaced (F-008).
	 *
	 *   • NO recorded consent (auto_publish_preauthorized=false/absent) → propose the release tasks then HALT
	 *     at 'awaiting-release-confirm' (the latch makes this terminal) — the real external publish is an
	 *     operator-gated action (D-037). UNCHANGED.
	 *
	 * Each release tick + the publish gate count against the PMA-2 cap (real spend). The two-phase flow runs
	 * the release tick AT MOST once per drive (gated by #releasePrepProposed), so it converges — it cannot
	 * re-propose forever. If the cap is hit before a phase, we stop honestly at dod-reached.
	 */
	async #reachDod(projectId: string, dodRes: StartLifecycleResult): Promise<AutonomousTickOutcome> {
		// CONSENT — re-read the LIVE pm row (F-008) for the operator's recorded auto-publish pre-authorization.
		// A read failure or a missing/false flag keeps publish operator-gated (fail safe toward NO publish).
		const pm = await getPm(this.#db, projectId).catch(() => null);
		const consent = pm?.auto_publish_preauthorized === true;

		// PHASE 2 — consent recorded AND release prep was ALREADY proposed this drive (and has now DRAINED:
		// Gate 2 in #decide guarantees nothing is in flight to reach here). Do NOT re-run the release tick
		// (that would re-propose a promoted-then-done task every cycle → livelock). Run the objective gate +
		// publish directly against the COMPLETED, correct-version artifact. This is the only cycle that publishes.
		if (consent && this.#releasePrepProposed.has(projectId)) {
			return await this.#runPublishGate(projectId, dodRes, consent);
		}

		// PHASE 1 — propose the release tasks (and, without consent, HALT at the operator gate as before).
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
		// The release tick PROPOSED the release tasks (version/pack/changelog) as development work.
		const proposed = rel.generated;

		if (!consent) {
			// UNCHANGED behavior: no recorded consent → HALT at the operator publish gate (D-037).
			return this.#record(
				projectId,
				'awaiting-release-confirm',
				`the plan DoD is satisfied — proposed ${proposed} release task(s) (version bump / package / changelog). HALTED at the publish gate: trigger the external publish yourself (D-037 — never auto-published).`,
				rel
			);
		}

		// CONSENT RECORDED — did this release tick PROPOSE/ADVANCE any release prep? If so, those tasks have
		// NOT RUN YET (version still stale). HOLD the publish (do NOT run the gate this cycle), mark prep as
		// proposed, and return a NON-LATCHING 'running' so the proposed tasks develop. A later terminal event
		// (once they drain) re-enters #reachDod, hits PHASE 2 above, and publishes the correct-version artifact.
		const releasePrepAdvanced = rel.generated > 0 || rel.promoted > 0 || rel.leftForOperator > 0;
		if (releasePrepAdvanced) {
			this.#releasePrepProposed.add(projectId);
			// Re-read the LIVE rows (F-008) for an honest in-flight count in the surfaced reason.
			const counts = await this.#taskCounts(projectId);
			return this.#record(
				projectId,
				'running',
				`the plan DoD is satisfied and auto-publish is pre-authorized — proposed ${proposed} release task(s) (version bump → 1.0.0 / package / changelog) this cycle (${counts.inFlight} now in flight). HOLDING the publish until release prep DRAINS so the build/pack/publish reflects the COMPLETED release (correct version), never a stale one — the objective gate runs on a later cycle once prep is done.`,
				rel
			);
		}

		// CONSENT RECORDED + the release tick proposed NOTHING (no release prep needed — e.g. the project was
		// already at its release version, or the release generator yielded no proposals) AND Gate 2 already
		// proved nothing is in flight → there is no stale artifact to wait on. Publish directly.
		return await this.#runPublishGate(projectId, rel, consent);
	}

	/**
	 * PHASE 2 — run the OBJECTIVE release-readiness gate (real exit codes — build + pack + validate) against
	 * the COMPLETED, drained release artifact, then the EXISTING D-037 publish ONLY if green. A gate fault
	 * (an unexpected throw) is a hard, honest HALT — never an auto-publish on an indeterminate gate. `relRes`
	 * is the lifecycle result carried into the outcome for the surface (the PHASE-1 or PHASE-2 tick).
	 */
	async #runPublishGate(
		projectId: string,
		rel: StartLifecycleResult,
		consent: boolean
	): Promise<AutonomousTickOutcome> {
		let gate: ReleaseGateResult;
		try {
			gate = await this.#releaseGate({ db: this.#db, env: this.#env, projectId, consent });
		} catch (err) {
			return this.#record(
				projectId,
				'awaiting-release-confirm',
				`the plan DoD is satisfied and auto-publish is pre-authorized, but the release-readiness gate errored (${(err as Error).message}) — HALTED at the publish gate (no publish); resolve and re-arm.`,
				rel,
				null
			);
		}

		if (gate.published) {
			// GREEN gate → the EXISTING D-037 publish ran + completed. The consented 0→v1 drive is DONE.
			//
			// AUTO-DISARM (operator directive: autonomous mode is a ONE-SHOT 0→v1 drive, NOT a forever-daemon).
			// The drive is over the moment v1 actually SHIPS — so on the REAL publish-success signal
			// (gate.published === true, a machine-verified exit code from the release-readiness gate — never a
			// guess) we DISARM the PM (autonomous=false) so the loop cannot keep re-ticking past v1. This reuses
			// the EXISTING setPmAutonomous write path (a MERGE — IDEMPOTENT: re-running it is a no-op when the
			// row is already disarmed, so an interrupted-and-re-run drive cannot double-anything). A disarm
			// failure is surfaced honestly (it does NOT fabricate a clean terminal state, F-008) but the publish
			// itself already completed, so we still report 'published' with the honest disarm caveat.
			//
			// Why disarm is SAFE here even though the state latches anyway: the #stoppedProjects latch keeps THIS
			// loop instance from re-spending, but a process restart (or a fresh loop) would re-arm off the live
			// pm row — DISARMING the row is what makes "stays stopped past v1" durable across restarts. Post-v1,
			// a new version is started by an EXPLICIT operator re-arm / PM proposal, never by the auto-loop
			// continuing (the re-arm flips autonomous=true again → a fresh drive, Gate 1 clears the latch).
			let disarmNote = '';
			let disarmedOk = false;
			try {
				const disarmed = await setPmAutonomous(this.#db, projectId, false);
				if (disarmed) {
					disarmedOk = true;
				} else {
					// The pm row vanished between the consent read and now — the publish stands; note it honestly.
					disarmNote = ' (note: could not auto-disarm — the PM row was not found; disarm it manually)';
				}
			} catch (err) {
				// A disarm write fault must NOT be reported as a clean v1 (F-008). The publish DID complete, so we
				// keep 'published', but we name the failed disarm so the operator can disarm by hand.
				disarmNote = ` (note: auto-disarm failed — ${(err as Error).message}; disarm the PM manually so the loop does not re-tick)`;
			}
			const outcome = this.#record(
				projectId,
				'published',
				`v1 shipped — autonomous mode complete; further versions are on-demand. The plan DoD was satisfied and the release-readiness gate was GREEN — ${gate.summary}. The consented auto-publish completed (D-037 path, real publish) and the PM was auto-disarmed (one-shot 0→v1 drive)${disarmNote}.`,
				rel,
				gate
			);
			// The DURABLE stop is now the live pm row (autonomous=false). When the disarm landed, drop the
			// in-memory 'published' latch so the row IS the single source of truth: a later terminal event with
			// the row still disarmed hits Gate 1 → idle (no re-spend), and an EXPLICIT operator re-arm
			// (autonomous=true) starts a FRESH drive WITHOUT a stale latch masking it as still-published — even
			// if no intervening evaluate observed the disarmed row. If the disarm FAILED (row gone / write
			// fault) we KEEP the latch as the in-memory backstop so this loop instance still never re-spins.
			if (disarmedOk) this.#stoppedProjects.delete(projectId);
			// The drive is complete — clear the release-prep latch so a fresh operator-initiated re-arm (a new
			// version) re-proposes release prep from scratch rather than skipping straight to a stale gate.
			this.#releasePrepProposed.delete(projectId);
			return outcome;
		}

		// RED gate → do NOT publish; HALT at the operator publish gate with the EXACT failing check surfaced.
		return this.#record(
			projectId,
			'awaiting-release-confirm',
			`the plan DoD is satisfied and auto-publish is pre-authorized, but the release-readiness gate is RED at "${gate.failedAt}" — ${gate.summary}. HALTED at the publish gate (no publish); fix the failure and re-arm.`,
			rel,
			gate
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
		lifecycle: StartLifecycleResult | null,
		releaseGate: ReleaseGateResult | null = null
	): AutonomousTickOutcome {
		const outcome: AutonomousTickOutcome = {
			projectId,
			state,
			reason,
			lifecycle,
			ticksUsed: this.#prunedTickCount(projectId),
			releaseGate
		};
		this.lastOutcome.set(projectId, outcome);
		if (
			state === 'dod-reached' ||
			state === 'awaiting-release-confirm' ||
			state === 'published' ||
			state === 'blocked' ||
			state === 'cap-reached'
		) {
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
 * The loop NEVER bypasses an operator gate UNCONSENTED: it re-runs startProjectLifecycle (which promotes
 * via the panel's EXISTING 'act' authority) and it auto-publishes ONLY when (a) the operator's
 * auto_publish_preauthorized consent is recorded AND (b) the objective release-readiness gate is green —
 * otherwise it halts at the publish gate (D-037). It NEVER hires (D-039); spend is bounded by the PMA-2
 * re-tick cap + the orchestrator's daily spawn cap. The publish credential is read from `wiring.env`
 * (D-026 — presence only) by the release-readiness gate.
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
		/** Runtime env ($env/dynamic/private) the release-readiness gate reads the publish secret from (D-026). */
		env?: EnvLike;
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
		...(wiring.maxTicksPerWindow != null ? { maxTicksPerWindow: wiring.maxTicksPerWindow } : {}),
		...(wiring.env != null ? { env: wiring.env } : {})
	});
	loop.start();
	setActiveAutonomousLoop(loop);
	return { started: true, loop };
}
