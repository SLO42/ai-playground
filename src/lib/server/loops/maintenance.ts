// MAINTENANCE LOOP ENGINE — the generic manifest-driven cadence runner for Atelier's
// SELF-MAINTENANCE loops (LOOP-ENGINEERING; operator directive 2026-06-29/30).
//
// This is the FIRST executor the loop manifest drives: GLOBAL (project = NULL) manifest rows with
// kind='maintenance' are read LIVE each tick and dispatched to a REGISTERED in-code action keyed by
// the row's stable `identifier` (a static registry — no dynamic code loading, ever). pm/orchestrator
// manifest rows remain declaration-only (manifest.ts header); ONLY maintenance rows execute here.
//
// Modeled on PmTriggerEngine (pm-triggers.ts) and REUSING its exported cron machinery (parseCron /
// periodicDue — no duplicated cron logic): an unref'd tick timer, per-loop minute dedup (one cron
// match = one firing), and the same D-004 mode discipline (manual orchestration mode = NO automatic
// fires of any kind; start() arms no timer).
//
// GATES — a maintenance loop FIRES only when ALL hold, re-checked from the DB EVERY tick (the
// /loops enabled toggle is the kill switch — never cached):
//   1. D-004 mode gate: orchestration mode is not 'manual' (mirrors pmTriggerAllowed).
//   2. The manifest row is enabled (kill switch, re-read per tick).
//   3. The readiness ARM gate (the SAME policy the pm arm path enforces, arm-gate.ts): the loop's
//      Design Checklist is GREEN — or the operator recorded an explicit OVERRIDE on the row.
//      A declared-but-unarmed loop stays honestly inert ('declared-not-running', F-008).
//   4. A registered action exists for the identifier (unknown identifier = warn once + skip; the
//      engine never invents behavior for a row it does not recognize).
//   5. The row's cadence parses and matches the tick minute (unparseable = honestly never due).
//
// FAIL-OPEN (F-048): a maintenance fault must NEVER crash the server. Every action run is absorbed
// (error → an honest ok:false run-log entry), and even a run-log WRITE failure is absorbed with a
// warn. Actions are expected to be deterministic, credential-free and bounded (F-014) — the two
// registered ones (maintenance-actions.ts) run their eval work in a deadline-bounded THROWAWAY
// SurrealDB and only write results/proposals to the live DB (propose-only; operator sovereignty).
//
// RUN LOG: each firing writes one agent_event row (type='maintenance', detail={loop, ok, summary})
// — the honest history the /loops card + detail page surface (read.ts recentRuns filters on
// detail.loop). Summaries are metadata-only (counts/metrics), and the read path screens them for
// display anyway (D-026).

import type { Db } from '../db/client';
import type { OrchMode } from '../config/index';
import { parseCron, periodicDue } from '../projects/pm-triggers';
import { evaluateReadiness } from '../../components/loops/readiness-core';
import {
	getLoopManifest,
	listLoopManifest,
	upsertLoopManifest,
	type LoopManifestRow
} from './manifest';

/** The outcome one maintenance action reports — recorded verbatim in the run log (honest, F-008). */
export interface MaintenanceRunResult {
	/** False when the action faulted or could not do its work (still logged, never thrown). */
	ok: boolean;
	/** One-line honest summary of what happened (metadata only — no content, D-026). */
	summary: string;
	/** Optional small structured extras for the run-log detail (metadata only). */
	detail?: Record<string, unknown>;
}

export interface MaintenanceActionContext {
	/** The LIVE runtime DB (results/proposals land here; actions must not pollute live memory). */
	db: Db;
	/** The tick instant the firing was evaluated at. */
	now: Date;
}

/** One registered maintenance action — dispatched per due manifest row, keyed by identifier. */
export type MaintenanceAction = (ctx: MaintenanceActionContext) => Promise<MaintenanceRunResult>;

/** The static identifier → action registry (in-code only — no dynamic loading). */
export type MaintenanceRegistry = ReadonlyMap<string, MaintenanceAction>;

/** The two shipped self-maintenance loop identifiers (stable manifest keys). */
export const MAINT_EVAL_REGRESSION = 'maint:eval-regression';
export const MAINT_RERANKER_EVAL = 'maint:reranker-eval';

/**
 * D-004 mode gate for AUTOMATIC maintenance fires — mirrors pmTriggerAllowed's discipline:
 * manual orchestration mode means no automatic fires of any kind (event/periodic modes permit).
 */
export function maintenanceFireAllowed(mode: OrchMode): boolean {
	return mode !== 'manual';
}

/**
 * Would the engine fire this manifest row when its cadence comes due? PURE over the row + the
 * engine's mode/registry — the SAME gate order tickOnce enforces, exposed so the /loops running
 * view (read.ts) can render an armed maintenance loop honestly (armed = will fire when due;
 * anything less stays 'declared-not-running', F-008).
 */
export function maintenanceLoopArmed(
	row: LoopManifestRow,
	opts: { mode: OrchMode; registry: MaintenanceRegistry }
): boolean {
	if (!maintenanceFireAllowed(opts.mode)) return false;
	if (row.kind !== 'maintenance' || row.projectId !== null) return false;
	if (!row.enabled) return false;
	if (!opts.registry.has(row.identifier)) return false;
	if (!row.cadence || !parseCron(row.cadence)) return false;
	const readiness = evaluateReadiness(row.checklist);
	return readiness.green || row.override === true;
}

export interface MaintenanceLoopEngineOptions {
	db: Db;
	/** Orchestration mode (D-004) — read once per boot, like the orchestrator/pm engines. */
	mode: OrchMode;
	/** The action registry (in-code; injectable for tests). */
	registry: MaintenanceRegistry;
	/** Periodic tick interval. Only armed when the mode permits automatic fires. */
	tickMs?: number;
	/** Clock seam (tests). */
	now?: () => Date;
}

const DEFAULT_TICK_MS = 15_000; // < the 60s cron resolution; minute-deduped anyway (pm-triggers)

export class MaintenanceLoopEngine {
	readonly #db: Db;
	readonly #mode: OrchMode;
	readonly #registry: MaintenanceRegistry;
	readonly #tickMs: number;
	readonly #now: () => Date;

	#timer?: ReturnType<typeof setInterval>;
	#started = false;
	#stopped = false;

	/** In-flight tick promises — awaited by idle() (tests / shutdown honesty). */
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Loops with a run currently executing (a slow action never double-runs concurrently). */
	readonly #running = new Set<string>();
	/** Per-loop minute dedup (one cron match = one firing — the pm-triggers pattern). */
	readonly #lastKey = new Map<string, number>();
	/** Identifiers already warned about (one warn per unregistered id / bad cadence, not per tick). */
	readonly #warned = new Set<string>();

	/** Firings this engine has run (diagnostics / the verify count). */
	runCount = 0;
	/** Firings whose action faulted (absorbed + logged, never thrown — F-048). */
	faultCount = 0;

	constructor(opts: MaintenanceLoopEngineOptions) {
		this.#db = opts.db;
		this.#mode = opts.mode;
		this.#registry = opts.registry;
		this.#tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
		this.#now = opts.now ?? (() => new Date());
	}

	get mode(): OrchMode {
		return this.#mode;
	}

	/** True only while the tick timer is armed (never in manual mode — D-004). */
	get periodicArmed(): boolean {
		return this.#timer !== undefined;
	}

	/** The gate-order armed check for one manifest row (the /loops running-view seam). */
	armedFor(row: LoopManifestRow): boolean {
		if (this.#stopped) return false;
		return maintenanceLoopArmed(row, { mode: this.#mode, registry: this.#registry });
	}

	/**
	 * Start the engine. In MANUAL mode this arms NO timer — D-004: manual mode means no automatic
	 * fires of any kind. Otherwise: one unref'd tick timer (the pm-triggers pattern; F-014 —
	 * stop() tears it down and it never keeps the process alive).
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		if (!maintenanceFireAllowed(this.#mode)) return;
		if (this.#tickMs > 0) {
			this.#timer = setInterval(() => {
				this.#track(this.tickOnce());
			}, this.#tickMs);
			if (typeof this.#timer.unref === 'function') this.#timer.unref();
		}
	}

	/** Stop the tick timer (F-014 teardown). Idempotent. */
	stop(): void {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#started = false;
	}

	/** Await all in-flight work (tests / shutdown honesty). */
	async idle(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/** Track a fire-and-forget promise; errors are logged + swallowed (F-048 — a maintenance
	 *  fault never takes down the server). */
	#track(p: Promise<unknown>): void {
		const tracked = p.catch((err) => {
			console.warn(`[maintenance-loops] tick failed: ${(err as Error).message}`);
		});
		this.#inFlight.add(tracked);
		void tracked.finally(() => this.#inFlight.delete(tracked));
	}

	/**
	 * One pass: re-read the GLOBAL maintenance manifest rows LIVE (the enabled toggle / checklist /
	 * override are never cached — the kill switch works the moment the row flips), gate each, and
	 * run the due ones sequentially (never two eval actions churning at once — the F-052 lesson).
	 * Public + deterministic so tests drive it without timers. Returns how many loops fired.
	 */
	async tickOnce(at?: Date): Promise<number> {
		if (this.#stopped) return 0;
		if (!maintenanceFireAllowed(this.#mode)) return 0;
		const when = at ?? this.#now();
		let fired = 0;

		const rows = (await listLoopManifest(this.#db)).filter(
			(r) => r.kind === 'maintenance' && r.projectId === null
		);
		for (const row of rows) {
			// Gate 4 — a registered action (warn once; a row we don't recognize never runs).
			if (!this.#registry.has(row.identifier)) {
				this.#warnOnce(
					`unreg:${row.identifier}`,
					`${row.identifier}: no registered maintenance action — the row stays declared-only.`
				);
				continue;
			}
			// Gate 2 — enabled (the kill switch, fresh from the DB this tick).
			if (!row.enabled) continue;
			// Gate 3 — readiness ARM gate (green or the operator's recorded override; arm-gate policy).
			const readiness = evaluateReadiness(row.checklist);
			if (!readiness.green && row.override !== true) continue;
			// Gate 5 — cadence parses + matches this minute (unparseable = honestly never due).
			if (!row.cadence || !parseCron(row.cadence)) {
				this.#warnOnce(
					`cadence:${row.identifier}`,
					`${row.identifier}: unparseable cadence ${JSON.stringify(row.cadence ?? null)} — it will not fire.`
				);
				continue;
			}
			const { due, minuteKey } = periodicDue({ cadence: row.cadence }, when);
			if (!due) continue;
			if (this.#lastKey.get(row.identifier) === minuteKey) continue; // already fired this match
			this.#lastKey.set(row.identifier, minuteKey);
			if (this.#running.has(row.identifier)) continue; // a prior run is still executing

			fired++;
			await this.#run(row, when);
		}
		return fired;
	}

	/** Run one loop's action, absorb ANY fault (F-048), and write the honest run-log entry. */
	async #run(row: LoopManifestRow, when: Date): Promise<void> {
		this.#running.add(row.identifier);
		const startedAt = Date.now();
		try {
			const action = this.#registry.get(row.identifier)!;
			let result: MaintenanceRunResult;
			try {
				result = await action({ db: this.#db, now: when });
			} catch (err) {
				result = { ok: false, summary: `maintenance action failed: ${(err as Error).message}` };
			}
			this.runCount++;
			if (!result.ok) this.faultCount++;
			await this.#log(row.identifier, result, Date.now() - startedAt);
		} catch (err) {
			// Even a run-log write failure is absorbed — never propagate off the tick (F-048).
			console.warn(
				`[maintenance-loops] ${row.identifier}: run-log write failed: ${(err as Error).message}`
			);
		} finally {
			this.#running.delete(row.identifier);
		}
	}

	/** One honest agent_event run-log row per firing (type='maintenance', detail.loop keys it). */
	async #log(identifier: string, result: MaintenanceRunResult, durationMs: number): Promise<void> {
		await this.#db.query(
			`CREATE agent_event CONTENT { type: 'maintenance', duration_ms: $d, detail: $detail };`,
			{
				d: Math.max(0, Math.round(durationMs)),
				detail: {
					loop: identifier,
					ok: result.ok,
					summary: result.summary,
					...(result.detail !== undefined ? { data: result.detail } : {})
				}
			}
		);
	}

	#warnOnce(key: string, message: string): void {
		if (this.#warned.has(key)) return;
		this.#warned.add(key);
		console.warn(`[maintenance-loops] ${message}`);
	}
}

// ── Default declared loops (seeded create-if-absent at boot) ───────────────────────────────────────

/** The shipped self-maintenance loop declarations. Cadences are nightly + staggered; both are
 *  operator-editable on the manifest row afterwards (the seed NEVER overwrites an existing row). */
export const DEFAULT_MAINTENANCE_SEEDS: ReadonlyArray<{
	identifier: string;
	label: string;
	cadence: string;
}> = [
	{
		identifier: MAINT_EVAL_REGRESSION,
		label: 'Memory eval regression (nightly)',
		cadence: '30 4 * * *'
	},
	{
		identifier: MAINT_RERANKER_EVAL,
		label: 'Reranker train + eval (nightly)',
		cadence: '45 4 * * *'
	}
];

/**
 * Declare the shipped maintenance loops, CREATE-IF-ABSENT ONLY (idempotent by identifier — a
 * double boot creates nothing, and an operator-edited row — cadence, enabled, checklist, override —
 * is NEVER clobbered back to defaults). New rows ship with the Design Checklist EMPTY, so readiness
 * is NOT green and the engine does not fire them until the operator ticks the checklist (or records
 * an override) via /loops — declared, visible, honestly inert (F-008). Returns how many were created.
 */
export async function seedMaintenanceLoops(db: Db): Promise<number> {
	let created = 0;
	for (const seed of DEFAULT_MAINTENANCE_SEEDS) {
		const existing = await getLoopManifest(db, seed.identifier);
		if (existing) continue;
		await upsertLoopManifest(db, {
			identifier: seed.identifier,
			kind: 'maintenance',
			label: seed.label,
			cadence: seed.cadence,
			phase: 'L1' // report/propose-only actions — the ladder's report-only rung
		});
		created++;
	}
	return created;
}

// ── Process-wide registry (mirrors pm-triggers' active-engine handle) ──────────────────────────────

let active: MaintenanceLoopEngine | null = null;

/** Register the boot-started engine (hooks.server.ts). */
export function setActiveMaintenanceEngine(engine: MaintenanceLoopEngine | null): void {
	active = engine;
}

/** The live engine, or null when none is running (degraded boot / manual-only). */
export function activeMaintenanceEngine(): MaintenanceLoopEngine | null {
	return active;
}
