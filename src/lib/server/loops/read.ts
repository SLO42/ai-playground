// LOOPS — the server READ MODEL for Atelier's recurring autonomous loops (LOOP-ENGINEERING.md;
// operator directive 2026-06-29). It aggregates the FOUR REAL loops Atelier runs into one typed,
// HONEST view (F-008 — only loops that actually exist; a never-run loop reports 'not yet run', an
// undeterminable phase 'unknown', an absent timestamp null → UI '—', NEVER a fabricated count/time):
//   1. Orchestrator drain (GLOBAL)        — orchestrator.ts event/periodic drain
//   2. Orchestrator GC backstop (GLOBAL)   — orchestrator.ts startMaintenance gc sweep
//   3. Autonomous PM loop (PER-PROJECT)    — pm-autonomous.ts AutonomousPmLoop (L3 drive)
//   4. PM cadence trigger (PER-PM)         — pm.cadence cron + cadence_offset
//   5. Self-maintenance loops (GLOBAL)     — loops/maintenance.ts MaintenanceLoopEngine (m0080;
//      manifest-driven, armed = enabled + readiness-green-or-override + registered + cadence)
//   6. Memory review (PER-SESSION, info)   — memory/loop.ts ReviewCadence (lowest priority, embedded)
//
// This is Phase 1 = VIEW + IDENTIFY only (config-editing is a separate wave). Live armed state is read
// through READ-ONLY accessors on the live singletons (activeOrchestrator / activeAutonomousLoop) — no
// behavior change. Run history comes from REAL agent_event rows; every surfaced detail string is run
// through screenForDisplay (D-026) before it leaves this module.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screenForDisplay } from '../memory/observability';
import { activityLabel } from '../analytics/events';
import { DEFAULT_CADENCE } from '../memory/loop';
import { loopBadge, type LoopTone } from '../../components/project/project-status-core';
import { activeOrchestrator } from '../orchestrator/orchestrator';
import { loadOrchestration, type OrchMode } from '../config';
import {
	activeAutonomousLoop,
	DEFAULT_MAX_TICKS_PER_WINDOW,
	type AutonomousLoopState
} from '../projects/pm-autonomous';
import { getPm, listAutonomousPms, listPmsWithCadence, type PmRow } from '../projects/pm-repo';
import { nextCadenceFireAt } from '../projects/pm-panel';
import { activeMaintenanceEngine } from './maintenance';
import { listLoopManifest, type LoopManifestRow } from './manifest';

/** The loop families Atelier runs ('maintenance' = the engine-driven self-maintenance loops, m0080). */
export type LoopKind =
	| 'orchestrator'
	| 'pm-autonomous'
	| 'pm-cadence'
	| 'memory-review'
	| 'maintenance';

/** Where a loop operates: a single GLOBAL loop for the whole platform, or one PER project. */
export type LoopScope = 'global' | 'project';

/**
 * The loop-engineering maturity badge (LOOP-ENGINEERING.md ladder). Derived from REAL arm/gate state:
 * an active autonomous drive ⇒ L3 (auto-act, capped); a PM armed-to-`act` ⇒ L2 (assisted); a
 * propose/observe (report-only) PM ⇒ L1. 'unknown' when the ladder does not apply to the loop (the
 * orchestrator execution engine, the per-session memory loop) or cannot be determined from live state.
 */
export type LoopPhase = 'L1' | 'L2' | 'L3' | 'unknown';

/** One run in a loop's recent history — projected + SCREENED (D-026) from a real agent_event row. */
export interface LoopRun {
	/** ISO timestamp of the event, or null when absent (UI '—'). */
	at: string | null;
	/** The event type (spawn/completion/error/escalation/cancel) — the honest outcome marker. */
	outcome: string;
	/** The event's one-line detail (summary>reason>error), SCREENED for display; '' when none. */
	detailScreened: string;
}

/** One loop's honest, typed read-model view. */
export interface LoopView {
	/** Stable identifier (e.g. `orch:drain`, `orch:gc`, `pm-auto:<projectId>`, `pm-cadence:<pmId>`, `mem-review`). */
	id: string;
	name: string;
	kind: LoopKind;
	scope: LoopScope;
	/** Set for project-scoped loops (the `project:<slug>` record id). */
	projectId?: string;
	tone: LoopTone;
	/** Short honest state label (e.g. 'driving', 'idle', 'not yet run', 'armed · event'). */
	stateLabel: string;
	phase: LoopPhase;
	/** Human-readable cadence (e.g. 'event-driven', 'event + 60s sweep', a cron string, 'tick-window 24/day'). */
	cadenceLabel: string;
	/** Most-recent run time (ISO), null when the loop has no run history (UI '—'). */
	lastRunAt?: string | null;
	/** Next scheduled fire (ISO) for cron loops, null otherwise / when none lands in the scan horizon. */
	nextFireAt?: string | null;
	/** Re-ticks used this window (autonomous loop), null when no loop state exists. */
	ticksUsed?: number | null;
	/** The hard per-window re-tick cap (autonomous loop). */
	ticksMax?: number | null;
	/**
	 * For pm-cadence loops ONLY: the RAW cron expression + duration offset, so the in-UI cadence
	 * editor can prefill the exact stored values (null when the field is unset → empty input). These
	 * are the same strings the `pmSchedule` write path consumes; the human `cadenceLabel` is for display.
	 */
	cadenceCron?: string | null;
	cadenceOffset?: string | null;
	/**
	 * For the orchestrator DRAIN loop ONLY (LP-2): the orchestration `mode` persisted in
	 * orchestration.yaml — the D-010-gated value /settings edits. Null when the config is unreadable/
	 * malformed (honest, never a fabricated mode; F-008). Absent on every non-orchestrator loop.
	 */
	configuredMode?: OrchMode | null;
	/**
	 * For the orchestrator DRAIN loop ONLY: the LIVE orchestrator's BOOTED mode (same source /settings
	 * reads). Null when no orchestrator is running (honest — the card shows 'not running').
	 */
	runningMode?: OrchMode | null;
	/**
	 * For the orchestrator DRAIN loop ONLY: true iff a live orchestrator booted with a mode DIFFERENT
	 * from the now-configured mode → a RESTART is required for the config change to take effect (the
	 * orchestrator reads `mode` once per boot). Mirrors settings/+page.server.ts:230. False when in
	 * sync OR nothing is running; absent on non-orchestrator loops (F-008/F-029 — never imply a live
	 * change took effect when it needs a restart).
	 */
	restartNeeded?: boolean;
	/**
	 * For the orchestrator DRAIN loop ONLY: the configured drain sweep interval (ms), null when unset/
	 * unreadable. The card renders it as a human '60s sweep'; the GC card's cadence stays its own field.
	 */
	intervalMs?: number | null;
	/**
	 * For pm-autonomous loops ONLY: whether the drive is currently ARMED (the pause/kill toggle's
	 * source of truth). A pm-autonomous card only exists while the PM is armed, so this is true today;
	 * threaded honestly (not assumed) so the toggle reflects real state.
	 */
	armed?: boolean;
	/** Last ~10 runs from agent_event (newest first), details SCREENED (D-026). */
	recentRuns: LoopRun[];
}

/** The orchestration config snapshot the orchestrator DRAIN card compares the live orchestrator
 *  against — honest by construction (a malformed config yields {mode:null,intervalMs:null}). */
export interface OrchConfigSnapshot {
	mode: OrchMode | null;
	intervalMs: number | null;
}

export interface GetLoopsOptions {
	/** Filter to ONE project's loops (the per-project tab). Global loops are excluded when set. */
	projectId?: string;
	/**
	 * Override the orchestration config snapshot (mode + interval) the orchestrator DRAIN card compares
	 * the LIVE orchestrator against. Defaults to reading config/orchestration.yaml live; pass an
	 * explicit snapshot (e.g. {mode:null,intervalMs:null} for the unreadable-config path) in tests so
	 * restartNeeded is deterministic and not coupled to the on-disk config's current mode.
	 */
	orchConfig?: OrchConfigSnapshot;
}

/**
 * Read the configured orchestration mode + interval from orchestration.yaml (the same D-010-gated
 * file /settings edits, resolved via CONFIG_DIR like settings/+page.server.ts). SHADOW PATHS: a
 * malformed/absent config throws ConfigError → caught → honest {mode:null,intervalMs:null} (F-008),
 * so the card shows configured '—' rather than a fabricated mode. EVERY ERROR HAS A NAME: the
 * ConfigError is named at the boundary and degraded here, not swallowed silently elsewhere.
 */
function readOrchConfig(): OrchConfigSnapshot {
	const dir = process.env.CONFIG_DIR?.trim() || 'config';
	try {
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		return { mode: orch.mode, intervalMs: orch.intervalMs ?? null };
	} catch {
		return { mode: null, intervalMs: null };
	}
}

/** Newest-first cap on the run history surfaced per loop CARD (the compact recent-runs list). */
const RECENT_RUN_LIMIT = 10;
/** The deeper cap the per-loop DETAIL page reads (uncapped in spirit; a sane upper bound guards the query). */
export const DETAIL_RUN_LIMIT = 200;
/** A rolling-24h tick window renders as 'day'; mirrors pm-autonomous DEFAULT_TICK_WINDOW_MS. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Coerce a SurrealDB datetime (or any value) to an ISO string, or null when absent (F-013) — never 'undefined'. */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	return s && s !== 'undefined' && s !== 'null' ? s : null;
}

interface RawRun {
	type?: string;
	at?: unknown;
	detail?: unknown;
}

/**
 * The last ~10 agent_event rows (newest first) for a loop's run history. SHADOW PATHS: a project with
 * no events ⇒ [] (honest "not yet run"). Every detail string passes through screenForDisplay (D-026)
 * before it leaves this module — agent_event.detail can carry error messages / host paths. `projectId`
 * undefined ⇒ a GLOBAL scan (the orchestrator drain); set ⇒ that project's rows only (bound as a record
 * link via the D-016 chokepoint, never interpolated). `types` narrows by event type.
 */
async function recentRuns(
	db: Db,
	opts: {
		projectId?: string;
		types?: readonly string[];
		/** Narrow to one maintenance loop's run-log rows (agent_event detail.loop === identifier). */
		loopIdentifier?: string;
		limit?: number;
	} = {}
): Promise<LoopRun[]> {
	const lim =
		typeof opts.limit === 'number' && opts.limit > 0
			? Math.min(Math.floor(opts.limit), DETAIL_RUN_LIMIT)
			: RECENT_RUN_LIMIT;
	const params: Record<string, unknown> = { lim };
	const clauses: string[] = [];
	if (opts.projectId) {
		params.pid = new StringRecordId(assertRecordId(opts.projectId));
		clauses.push('project = $pid');
	}
	if (opts.types && opts.types.length) {
		params.types = [...opts.types];
		clauses.push('type IN $types');
	}
	if (opts.loopIdentifier) {
		params.loop = opts.loopIdentifier;
		clauses.push('detail.loop = $loop');
	}
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
	const [rows] = await db.query<[RawRun[]]>(
		`SELECT type, at, detail FROM agent_event ${where} ORDER BY at DESC LIMIT $lim;`,
		params
	);
	return (rows ?? []).map((r) => ({
		at: isoOrNull(r.at),
		outcome: typeof r.type === 'string' && r.type ? r.type : 'unknown',
		detailScreened: screenForDisplay(activityLabel(r.detail) ?? '').text
	}));
}

/** Map the autonomous loop's last state to a tone + label, reusing the dashboard's loopBadge. */
function autonomousBadge(state: AutonomousLoopState | null, reason: string): {
	tone: LoopTone;
	label: string;
} {
	if (!state) return { tone: 'idle', label: 'not yet run' };
	const b = loopBadge({ state, reason, ticksUsed: 0 });
	return { tone: b.tone, label: b.label };
}

// ── (1)+(2) The two GLOBAL orchestrator loops ───────────────────────────────────────────────────────

async function orchestratorLoops(db: Db, cfg: OrchConfigSnapshot): Promise<LoopView[]> {
	const orch = activeOrchestrator();
	// The drain's output IS spawns/completions — a fair, honest run history for the GLOBAL drain.
	const drainRuns = await recentRuns(db, { types: ['spawn', 'completion'] });

	// Configured (orchestration.yaml) vs RUNNING (the live orchestrator booted with this mode once per
	// boot). restartNeeded mirrors settings/+page.server.ts:230 — a restart is needed ONLY when a live
	// orchestrator's booted mode differs from the now-configured mode. Honest: nothing running ⇒
	// runningMode null ⇒ restartNeeded false (no live change to mis-imply); config unreadable ⇒
	// configuredMode null ⇒ we do NOT claim a restart we cannot justify (F-008/F-029).
	const runningMode: OrchMode | null = orch ? orch.mode : null;
	const restartNeeded = runningMode !== null && cfg.mode !== null && runningMode !== cfg.mode;

	// Drain cadence: event-driven by default (D-004); 'periodic' mode adds a timed sweep. Unknown when
	// no orchestrator is live (we will not fabricate the configured cadence we cannot read — F-008).
	let drainCadence = 'unknown';
	if (orch) {
		if (orch.mode === 'periodic' && orch.intervalMs && orch.intervalMs > 0) {
			drainCadence = `event + ${Math.round(orch.intervalMs / 1000)}s sweep`;
		} else if (orch.mode === 'manual') {
			drainCadence = 'manual (operator-driven)';
		} else {
			drainCadence = 'event-driven';
		}
	}

	const drain: LoopView = {
		id: 'orch:drain',
		name: 'Orchestrator drain',
		kind: 'orchestrator',
		scope: 'global',
		tone: orch ? 'running' : 'idle',
		stateLabel: orch ? `armed · ${orch.mode}` : 'not running',
		phase: 'unknown',
		cadenceLabel: drainCadence,
		lastRunAt: drainRuns[0]?.at ?? null,
		nextFireAt: null,
		configuredMode: cfg.mode,
		runningMode,
		restartNeeded,
		intervalMs: cfg.intervalMs,
		recentRuns: drainRuns
	};

	const gc: LoopView = {
		id: 'orch:gc',
		name: 'Orchestrator GC backstop',
		kind: 'orchestrator',
		scope: 'global',
		tone: orch?.maintenanceArmed ? 'running' : 'idle',
		stateLabel: orch ? (orch.maintenanceArmed ? 'armed' : 'not armed') : 'not running',
		phase: 'unknown',
		cadenceLabel: orch ? `${Math.round(orch.gcIntervalMs / 60_000)}m sweep` : 'unknown',
		// The gc reaper writes no agent_event — honest: no per-run history (lastRun '—', empty runs).
		lastRunAt: null,
		nextFireAt: null,
		recentRuns: []
	};

	return [drain, gc];
}

// ── (3) PER-PROJECT autonomous PM loops ─────────────────────────────────────────────────────────────

async function pmAutonomousLoops(db: Db, pms: PmRow[]): Promise<LoopView[]> {
	const loop = activeAutonomousLoop();
	const ticksMax = loop?.maxTicksPerWindow ?? DEFAULT_MAX_TICKS_PER_WINDOW;
	const windowMs = loop?.tickWindowMs ?? ONE_DAY_MS;
	const windowLabel = windowMs === ONE_DAY_MS ? 'day' : `${Math.round(windowMs / 3_600_000)}h`;

	const views: LoopView[] = [];
	for (const pm of pms) {
		const outcome = loop?.lastOutcome.get(pm.project) ?? null;
		const badge = autonomousBadge(outcome?.state ?? null, outcome?.reason ?? '');
		const runs = await recentRuns(db, { projectId: pm.project });
		views.push({
			id: `pm-auto:${pm.project}`,
			name: `${pm.name} — autonomous drive`,
			kind: 'pm-autonomous',
			scope: 'project',
			projectId: pm.project,
			tone: badge.tone,
			stateLabel: badge.label,
			// An armed autonomous PM runs at L3 (auto-act on an allowlist, capped) per the ladder.
			phase: 'L3',
			cadenceLabel: `tick-window ${ticksMax}/${windowLabel}`,
			lastRunAt: runs[0]?.at ?? null,
			nextFireAt: null,
			ticksUsed: outcome?.ticksUsed ?? null,
			ticksMax,
			// This view is only built for an armed PM (listAutonomousPms / pm.autonomous gate) — armed=true.
			armed: true,
			recentRuns: runs
		});
	}
	return views;
}

// ── (4) PER-PM cadence triggers ─────────────────────────────────────────────────────────────────────

/** L2 when the PM may `act` (assisted, human-gated); L1 for a propose/observe (report-only) PM. */
function cadencePhase(pm: PmRow): LoopPhase {
	return pm.authority === 'act' ? 'L2' : 'L1';
}

async function pmCadenceLoops(db: Db, pms: PmRow[]): Promise<LoopView[]> {
	const views: LoopView[] = [];
	for (const pm of pms) {
		const runs = await recentRuns(db, { projectId: pm.project });
		views.push({
			id: `pm-cadence:${pm.id}`,
			name: `${pm.name} — cadence`,
			kind: 'pm-cadence',
			scope: 'project',
			projectId: pm.project,
			tone: 'idle',
			stateLabel: 'scheduled',
			phase: cadencePhase(pm),
			cadenceLabel: `cron ${pm.cadence}`,
			// The RAW values the in-UI cadence editor prefills (and the pmSchedule write path consumes).
			cadenceCron: pm.cadence ?? null,
			cadenceOffset: pm.cadence_offset ?? null,
			lastRunAt: runs[0]?.at ?? null,
			nextFireAt: nextCadenceFireAt(pm.cadence),
			recentRuns: runs
		});
	}
	return views;
}

// ── (5) GLOBAL self-maintenance loops (the MaintenanceLoopEngine, m0080) ────────────────────────────

/**
 * The RUNNING view of the engine-driven maintenance loops. A view exists ONLY for a manifest row the
 * LIVE engine would actually fire when due (engine.armedFor: mode + enabled + readiness-green-or-
 * override + registered action + parseable cadence) — anything less stays out of the running view and
 * surfaces via reconcile as 'declared-not-running' (honest, F-008; no fabricated armed card). No live
 * engine (degraded boot / manual mode) ⇒ no views. Run history = the engine's agent_event run log
 * (type 'maintenance', keyed per loop by detail.loop).
 */
async function maintenanceLoops(db: Db): Promise<LoopView[]> {
	const engine = activeMaintenanceEngine();
	if (!engine) return [];
	let rows: LoopManifestRow[] = [];
	try {
		rows = (await listLoopManifest(db)).filter(
			(r) => r.kind === 'maintenance' && r.projectId === null
		);
	} catch {
		return []; // manifest unreadable ⇒ honestly no running maintenance cards, never fabricated
	}
	const views: LoopView[] = [];
	for (const row of rows) {
		if (!engine.armedFor(row)) continue;
		const runs = await recentRuns(db, { types: ['maintenance'], loopIdentifier: row.identifier });
		views.push({
			id: row.identifier,
			name: row.label || row.identifier,
			kind: 'maintenance',
			scope: 'global',
			tone: 'running',
			stateLabel: `armed · ${engine.mode}`,
			phase: row.phase,
			cadenceLabel: `cron ${row.cadence}`,
			lastRunAt: runs[0]?.at ?? null,
			nextFireAt: nextCadenceFireAt(row.cadence ?? undefined),
			recentRuns: runs
		});
	}
	return views;
}

// ── (6) The per-session memory review loop (informational) ──────────────────────────────────────────

function memoryReviewLoop(): LoopView {
	return {
		id: 'mem-review',
		name: 'Memory review',
		kind: 'memory-review',
		scope: 'global',
		tone: 'idle',
		stateLabel: 'per-session',
		// A background per-session loop — the autonomy ladder does not apply (it acts on no project).
		phase: 'unknown',
		cadenceLabel: `every ${DEFAULT_CADENCE.memoryEveryNTurns} turns · ${DEFAULT_CADENCE.skillEveryMTools} tools`,
		// Cadence-only by design; the loop keeps no surfaced per-run history here (honest, not fabricated).
		lastRunAt: null,
		nextFireAt: null,
		recentRuns: []
	};
}

/**
 * Aggregate Atelier's REAL recurring loops into one honest, typed view (LOOP-ENGINEERING.md).
 *
 * SHADOW PATHS: a disconnected/degraded boot ⇒ no active orchestrator/loop singletons ⇒ the global
 * loops surface honest 'not running'/'unknown' (never a fabricated armed state); a project with no
 * armed PM ⇒ no per-project loop cards; a loop with no agent_event history ⇒ empty recentRuns +
 * lastRunAt null. `opts.projectId` filters to a single project's loops (the per-project tab) — global
 * loops (orchestrator, memory-review) are excluded so the tab shows only what belongs to that project.
 * EVERY ERROR HAS A NAME: an invalid projectId is rejected at the D-016 chokepoint (assertRecordId
 * throws) rather than silently returning everything.
 */
export async function getLoops(db: Db, opts: GetLoopsOptions = {}): Promise<LoopView[]> {
	const { projectId } = opts;

	if (projectId) {
		// Validate the id up front (D-016) so a bad id fails loudly, once, not per sub-query.
		assertRecordId(projectId);
		const pm = await getPm(db, projectId);
		if (!pm) return [];
		const autoViews = pm.autonomous ? await pmAutonomousLoops(db, [pm]) : [];
		const cadenceViews = pm.cadence ? await pmCadenceLoops(db, [pm]) : [];
		return [...autoViews, ...cadenceViews];
	}

	const cfg = opts.orchConfig ?? readOrchConfig();
	const [orchViews, autonomousPms, cadencePms, maintViews] = await Promise.all([
		orchestratorLoops(db, cfg),
		listAutonomousPms(db),
		listPmsWithCadence(db),
		maintenanceLoops(db)
	]);
	const autoViews = await pmAutonomousLoops(db, autonomousPms);
	const cadenceViews = await pmCadenceLoops(db, cadencePms);

	return [...orchViews, ...autoViews, ...cadenceViews, ...maintViews, memoryReviewLoop()];
}

/** The agent_event query a loop's run history is read from, or null when the loop keeps NO history by
 *  design (the GC reaper writes no event; the memory-review loop is cadence-only) — honest, never faked. */
function loopRunQuery(
	loop: Pick<LoopView, 'id' | 'kind' | 'projectId'>
): { projectId?: string; types?: readonly string[]; loopIdentifier?: string } | null {
	if (loop.id === 'orch:gc' || loop.id === 'mem-review') return null;
	// A maintenance loop's history is its OWN engine run log (agent_event type 'maintenance',
	// keyed per loop by detail.loop) — mirrors maintenanceLoops.
	if (loop.kind === 'maintenance') return { types: ['maintenance'], loopIdentifier: loop.id };
	// The GLOBAL drain's history IS spawns/completions (mirrors orchestratorLoops); a project loop's
	// history is that project's agent_event rows (mirrors pmAutonomousLoops / pmCadenceLoops).
	if (loop.kind === 'orchestrator') return { types: ['spawn', 'completion'] };
	if (loop.projectId) return { projectId: loop.projectId };
	return null;
}

/**
 * Read a SINGLE loop's DEEP run history for the per-loop detail page (the card's ~10 is too shallow for
 * review). SHADOW PATHS: a no-history-by-design loop ⇒ [] (honest, not fabricated); a loop that has never
 * fired ⇒ [] ("not yet run"). Reuses the SAME screened, ISO-coerced projection as the card (D-026/F-013)
 * and the SAME query shape each loop family already uses — just a deeper, bounded LIMIT (DETAIL_RUN_LIMIT).
 */
export async function getLoopRuns(
	db: Db,
	loop: Pick<LoopView, 'id' | 'kind' | 'projectId'>,
	opts: { limit?: number } = {}
): Promise<LoopRun[]> {
	const q = loopRunQuery(loop);
	if (!q) return [];
	return recentRuns(db, { ...q, limit: opts.limit ?? DETAIL_RUN_LIMIT });
}
