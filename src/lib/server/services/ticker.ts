// SVC-1 (SERVICES-SPEC §3 / D-004 additive note, DECISIONS.md 7ca9145) — the PRODUCTION
// scheduler for the services supervision loop.
//
// THE GAP THIS CLOSES: the ServicesManager (manager.ts) owns pid+health liveness + bounded
// auto-restart, but `tick()` had NO production caller — it ran only from manager.test.ts. So a
// crashed desired-up service (e.g. an operator-armed Ollama) stayed DOWN until a page load
// happened to observe it, and even that only CORRECTED the row — it never auto-restarted. This
// module is the boot-wired periodic caller that makes the manager's auto-restart actually run.
//
// THE D-004 CONTRACT (why this is a sanctioned maintenance timer, not a busy loop):
//   • BOUNDED + unref'd. One setInterval whose timer is unref()'d — it NEVER holds the process
//     open (F-014), and stop() tears it down (the hooks.server.ts shutdown path). Mirrors the
//     orchestrator startMaintenance / MaintenanceLoopEngine precedent.
//   • SINGLE-FLIGHT. A tick that outruns its interval NEVER overlaps itself — the next fire is
//     skipped while one is in flight (the F-052 "one builder per resource" lesson, applied to the
//     supervision pass). skippedOverlaps counts these for diagnostics.
//   • FAULT-ISOLATED (F-014). Every tick is wrapped: a DB/probe/adapter fault is logged and
//     swallowed — a supervision fault NEVER crashes the server. faultCount records them.
//   • OFF-BY-CONFIG. `tickMs: 0` arms no timer (the manual-only / page-load-observed contract);
//     a positive value is the interval. Absent config ⇒ DEFAULT_SERVICES_TICK_MS (5 min).
//
// It is NOT mode-gated (unlike the orchestrator/PM engines): keeping a crashed local service
// alive is a safety backstop, not automatic AGENT work, so the D-004 off switch here is the
// config cadence (tickMs=0), not the orchestration mode. The manager itself only reconciles
// DESIRED-UP services, so this ticks nothing until the operator arms one (operate start).

import type { Db } from '../db/client';
import { getServicesManager } from './runtime';
import type { TickResult } from './manager';

/** The default supervision cadence (ms) when orchestration.yaml sets no `services.tickMs` (5 min). */
export const DEFAULT_SERVICES_TICK_MS = 300_000;

export interface ServicesTickerOptions {
	/** The runtime DB handle the process-wide ServicesManager records status/incidents through. */
	db: Db;
	/** Supervision interval (ms). 0 = OFF (no timer). Absent ⇒ {@link DEFAULT_SERVICES_TICK_MS}. */
	tickMs?: number;
	/**
	 * TEST/seam: the reconcile function invoked per tick. Defaults to the process-wide
	 * manager's `tick()` (the real supervision pass). Injectable so unit tests drive the
	 * cadence/overlap/fault behavior deterministically without a real DB or OS processes.
	 */
	tick?: () => Promise<TickResult[]>;
}

/**
 * A bounded, unref'd, single-flight periodic caller of the services supervision pass. Construct,
 * `start()` at boot (idempotent), and `stop()` on shutdown. When `tickMs <= 0` it arms no timer
 * (OFF); otherwise it reconciles the managed services every `tickMs` — auto-restarting a
 * desired-up service the manager finds dead (bounded by maxRestarts, incident-logged).
 */
export class ServicesTicker {
	readonly #tickMs: number;
	readonly #tick: () => Promise<TickResult[]>;

	#timer?: ReturnType<typeof setInterval>;
	#started = false;
	#stopped = false;
	/** The in-flight tick promise (single-flight guard) — null when idle. */
	#inFlight: Promise<void> | null = null;

	/** Ticks that ran to completion (diagnostics / the verify count). */
	runCount = 0;
	/** Ticks whose reconcile faulted — logged + swallowed, never thrown (F-014). */
	faultCount = 0;
	/** Fires skipped because a prior tick was still in flight (single-flight overlap guard). */
	skippedOverlaps = 0;

	constructor(opts: ServicesTickerOptions) {
		this.#tickMs = opts.tickMs ?? DEFAULT_SERVICES_TICK_MS;
		this.#tick = opts.tick ?? (() => getServicesManager(opts.db).tick());
	}

	/** The armed cadence (ms). 0 = OFF. */
	get tickMs(): number {
		return this.#tickMs;
	}

	/** True only while the periodic timer is armed (false when tickMs<=0 or after stop()). */
	get periodicArmed(): boolean {
		return this.#timer !== undefined;
	}

	/**
	 * Arm the periodic supervision tick. Idempotent (a second call is a no-op) and a no-op after
	 * stop(). When `tickMs <= 0` it arms NO timer (OFF — the manual-only contract). The timer is
	 * unref'd so it never keeps the process alive (F-014).
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		if (this.#tickMs <= 0) return; // OFF — no periodic supervision.
		this.#timer = setInterval(() => {
			void this.tickOnce();
		}, this.#tickMs);
		if (typeof this.#timer.unref === 'function') this.#timer.unref();
	}

	/** Tear down the timer (F-014 shutdown teardown). Idempotent. */
	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#started = false;
	}

	/**
	 * Run ONE supervision pass, SINGLE-FLIGHT + FAULT-ISOLATED. If a prior tick is still in
	 * flight this fire is SKIPPED (counted) rather than overlapped. Any reconcile fault is logged
	 * and swallowed — this method NEVER throws (F-014), so a fire-and-forget caller (the interval)
	 * can never take the process down with an unhandled rejection. Public + deterministic so tests
	 * drive it without timers.
	 */
	async tickOnce(): Promise<void> {
		if (this.#stopped) return;
		if (this.#inFlight) {
			this.skippedOverlaps += 1;
			return;
		}
		const run = (async () => {
			try {
				await this.#tick();
				this.runCount += 1;
			} catch (err) {
				this.faultCount += 1;
				console.warn(`[services-ticker] supervision tick failed: ${(err as Error).message}`);
			}
		})();
		this.#inFlight = run;
		try {
			await run;
		} finally {
			this.#inFlight = null;
		}
	}

	/** Await any in-flight tick (tests / shutdown honesty). */
	async idle(): Promise<void> {
		if (this.#inFlight) await this.#inFlight.catch(() => {});
	}
}
