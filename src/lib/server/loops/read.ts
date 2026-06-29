// LOOPS — the server READ MODEL for Atelier's recurring autonomous loops (LOOP-ENGINEERING.md;
// operator directive 2026-06-29). It aggregates the FOUR REAL loops Atelier runs into one typed,
// HONEST view (F-008 — only loops that actually exist; a never-run loop reports 'not yet run', an
// undeterminable phase 'unknown', an absent timestamp null → UI '—', NEVER a fabricated count/time):
//   1. Orchestrator drain (GLOBAL)        — orchestrator.ts event/periodic drain
//   2. Orchestrator GC backstop (GLOBAL)   — orchestrator.ts startMaintenance gc sweep
//   3. Autonomous PM loop (PER-PROJECT)    — pm-autonomous.ts AutonomousPmLoop (L3 drive)
//   4. PM cadence trigger (PER-PM)         — pm.cadence cron + cadence_offset
//   5. Memory review (PER-SESSION, info)   — memory/loop.ts ReviewCadence (lowest priority, embedded)
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
import {
	activeAutonomousLoop,
	DEFAULT_MAX_TICKS_PER_WINDOW,
	type AutonomousLoopState
} from '../projects/pm-autonomous';
import { getPm, listAutonomousPms, listPmsWithCadence, type PmRow } from '../projects/pm-repo';
import { nextCadenceFireAt } from '../projects/pm-panel';

/** The four loop families Atelier runs. */
export type LoopKind = 'orchestrator' | 'pm-autonomous' | 'pm-cadence' | 'memory-review';

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
	 * For pm-autonomous loops ONLY: whether the drive is currently ARMED (the pause/kill toggle's
	 * source of truth). A pm-autonomous card only exists while the PM is armed, so this is true today;
	 * threaded honestly (not assumed) so the toggle reflects real state.
	 */
	armed?: boolean;
	/** Last ~10 runs from agent_event (newest first), details SCREENED (D-026). */
	recentRuns: LoopRun[];
}

export interface GetLoopsOptions {
	/** Filter to ONE project's loops (the per-project tab). Global loops are excluded when set. */
	projectId?: string;
}

/** Newest-first cap on the run history surfaced per loop. */
const RECENT_RUN_LIMIT = 10;
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
	opts: { projectId?: string; types?: readonly string[] } = {}
): Promise<LoopRun[]> {
	const params: Record<string, unknown> = { lim: RECENT_RUN_LIMIT };
	const clauses: string[] = [];
	if (opts.projectId) {
		params.pid = new StringRecordId(assertRecordId(opts.projectId));
		clauses.push('project = $pid');
	}
	if (opts.types && opts.types.length) {
		params.types = [...opts.types];
		clauses.push('type IN $types');
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

async function orchestratorLoops(db: Db): Promise<LoopView[]> {
	const orch = activeOrchestrator();
	// The drain's output IS spawns/completions — a fair, honest run history for the GLOBAL drain.
	const drainRuns = await recentRuns(db, { types: ['spawn', 'completion'] });

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

// ── (5) The per-session memory review loop (informational) ──────────────────────────────────────────

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

	const [orchViews, autonomousPms, cadencePms] = await Promise.all([
		orchestratorLoops(db),
		listAutonomousPms(db),
		listPmsWithCadence(db)
	]);
	const autoViews = await pmAutonomousLoops(db, autonomousPms);
	const cadenceViews = await pmCadenceLoops(db, cadencePms);

	return [...orchViews, ...autoViews, ...cadenceViews, memoryReviewLoop()];
}
