// LOOPS UI — pure derivations for the Loops surface (LoopCard.svelte / LoopList.svelte).
//
// All logic that turns a LIVE LoopView (the LP-1 server read model) into the card's visual model
// lives here as pure functions so it is unit-testable without rendering Svelte (the
// project-status-core / transcript-core pattern). NOTHING here fabricates a value (F-008): every
// label is derived from the honest LoopView fields LP-1 already produced — an absent timestamp
// renders '—' (or the run-driven loops' honest 'not yet run'), never a made-up time/count. This is a
// plain .ts module — NO runes (F-009). Types are imported type-only from the server read model
// (erased at build; the established client pattern — see scene/observability components).

import type { LoopView, LoopKind, LoopPhase, LoopScope } from '$lib/server/loops/read';

/** The per-kind icon key (drives which inline glyph LoopCard renders) + a screen-reader role word. */
export interface KindMeta {
	/** Stable icon key — one of the LoopKind values (the card switches on it). */
	icon: LoopKind;
	/** Short a11y role word for the icon (the icon itself is decorative/aria-hidden). */
	srLabel: string;
}

const KIND_META: Record<LoopKind, KindMeta> = {
	orchestrator: { icon: 'orchestrator', srLabel: 'orchestrator loop' },
	'pm-autonomous': { icon: 'pm-autonomous', srLabel: 'autonomous PM loop' },
	'pm-cadence': { icon: 'pm-cadence', srLabel: 'scheduled PM loop' },
	'memory-review': { icon: 'memory-review', srLabel: 'memory review loop' },
	// Self-maintenance loops (m0080) reuse the neutral orchestrator glyph — no bespoke icon yet.
	maintenance: { icon: 'orchestrator', srLabel: 'maintenance loop' }
};

/** Map a loop kind to its icon key + a11y role word. An unknown kind (defensive) falls back to a
 *  neutral orchestrator glyph rather than throwing — EVERY ERROR HAS A NAME, even an unmodelled kind. */
export function kindMeta(kind: LoopKind): KindMeta {
	return KIND_META[kind] ?? { icon: 'orchestrator', srLabel: 'loop' };
}

/** Human-readable maturity meta for the phase badge (LOOP-ENGINEERING.md ladder). The text is the
 *  badge face; `title` is the longer hover/aria description so the L1/L2/L3 codes are never opaque. */
export interface PhaseMeta {
	text: string;
	title: string;
}

const PHASE_META: Record<LoopPhase, PhaseMeta> = {
	L1: { text: 'L1', title: 'L1 · report-only (proposes; the operator decides)' },
	L2: { text: 'L2', title: 'L2 · assisted (may act on a human-gated allowlist)' },
	L3: { text: 'L3', title: 'L3 · autonomous (auto-acts on an allowlist, capped)' },
	unknown: { text: '—', title: 'maturity ladder does not apply to this loop' }
};

/** Map the loop phase to its badge face + descriptive title. */
export function phaseMeta(phase: LoopPhase): PhaseMeta {
	return PHASE_META[phase] ?? PHASE_META.unknown;
}

/**
 * Relative "time ago" for a loop run. SHADOW PATHS: null/empty/un-parseable ⇒ '—' (honest unknown,
 * never a fabricated time; F-008). Deterministic, tokens-free copy mirroring the Home feed's `ago`.
 * `now` is injectable so the unit tests are not wall-clock-dependent.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '—';
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return '—';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/**
 * Forward-looking "time until" for a loop's next scheduled fire (e.g. a PM cadence cron). Distinct
 * from relativeTime, which clamps to the past (`Math.max(0, now-t)`) and would collapse EVERY future
 * fire to "0s ago" — so the next-fire field must NOT route through it. SHADOW PATHS: null/empty/
 * un-parseable ⇒ '—' (honest unknown, F-008); a non-future timestamp (≤ now, i.e. the fire is due/
 * overdue) ⇒ 'due now' rather than a negative or fabricated value. `now` is injectable for tests.
 */
export function nextFireLabel(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '—';
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return '—';
	const s = Math.round((t - now) / 1000);
	if (s <= 0) return 'due now';
	if (s < 60) return `in ${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `in ${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `in ${h}h`;
	return `in ${Math.round(h / 24)}d`;
}

// LP-1 establishes that two loops keep NO per-run history BY DESIGN (the GC reaper writes no
// agent_event; the memory-review loop is cadence-only) — for THOSE, an absent last-run is honestly
// '—' (no history kept), NOT 'not yet run'. The run-driven loops (drain / pm-autonomous / pm-cadence)
// surface 'not yet run' only when they have genuinely never fired (empty agent_event history). This
// set is grounded in LP-1's documented loop ids, not invented.
const NO_HISTORY_LOOP_IDS = new Set<string>(['orch:gc', 'mem-review']);

/**
 * The headline last-run label. A present timestamp ⇒ relative time; an absent one ⇒ '—' for the
 * by-design no-history loops, else the honest 'not yet run' for a run-driven loop that never fired.
 */
export function lastRunLabel(
	view: Pick<LoopView, 'id' | 'lastRunAt'>,
	now: number = Date.now()
): string {
	if (view.lastRunAt) return relativeTime(view.lastRunAt, now);
	return NO_HISTORY_LOOP_IDS.has(view.id) ? '—' : 'not yet run';
}

/** True when this loop surfaces a per-run history at all (drives whether the expander renders). */
export function tracksRunHistory(view: Pick<LoopView, 'id'>): boolean {
	return !NO_HISTORY_LOOP_IDS.has(view.id);
}

/** The ticks-used/max label, or null when the loop has no tick window (most loops). */
export function ticksLabel(
	view: Pick<LoopView, 'ticksUsed' | 'ticksMax'>
): string | null {
	if (view.ticksMax == null) return null;
	const used = view.ticksUsed ?? 0;
	return `${used} / ${view.ticksMax}`;
}

/**
 * The orchestrator DRAIN card's config/sync display model (LP-2). Derived purely from the honest
 * LoopView config fields LP-2 produced (configuredMode / runningMode / restartNeeded / intervalMs) —
 * nothing fabricated (F-008): an unreadable config shows configured '—', a stopped orchestrator shows
 * running 'not running', and the status tells the TRUTH about whether a restart is pending. Returns
 * null for every loop that carries no orchestrator mode-config (only the drain card does), so the
 * component renders the block only where it applies.
 */
export interface OrchConfigView {
	/** Configured mode (orchestration.yaml) or '—' when unreadable. */
	configured: string;
	/** The live orchestrator's booted mode, or 'not running' when none is live. */
	running: string;
	/** Human sweep-interval label (e.g. '60s sweep'), or null when no interval is configured. */
	interval: string | null;
	/** True when the running mode differs from configured → a restart is pending. */
	restartNeeded: boolean;
	/** The honest status + tone: 'restart needed' (warning) | 'in sync' (done) | 'not running' (idle) |
	 *  'config unreadable' (warning, when running but the configured mode could not be read). */
	status: { text: string; tone: 'warning' | 'done' | 'idle' };
}

/**
 * Build the orchestrator drain card's config/sync view, or null when the loop carries no
 * orchestrator mode-config. SHADOW PATHS: configuredMode null ⇒ '—'; runningMode null ⇒ 'not running'
 * + 'not running' status (idle); intervalMs null ⇒ no interval row. A live mode mismatch ⇒ a warning
 * 'restart needed' status; matching modes ⇒ a 'in sync' done status. Never implies a live change took
 * effect when a restart is pending (F-008/F-029).
 */
export function orchConfigView(
	view: Pick<LoopView, 'kind' | 'configuredMode' | 'runningMode' | 'restartNeeded' | 'intervalMs'>
): OrchConfigView | null {
	// Only the drain card sets these fields (configuredMode is set even when null); the GC card and
	// every non-orchestrator loop leave them undefined → no block.
	if (view.kind !== 'orchestrator' || view.configuredMode === undefined) return null;
	const configured = view.configuredMode ?? '—';
	const running = view.runningMode ?? 'not running';
	const interval =
		typeof view.intervalMs === 'number' && view.intervalMs > 0
			? `${Math.round(view.intervalMs / 1000)}s sweep`
			: null;
	const restartNeeded = view.restartNeeded === true;
	let status: OrchConfigView['status'];
	if (restartNeeded) {
		status = { text: 'restart needed', tone: 'warning' };
	} else if (view.runningMode == null) {
		status = { text: 'not running', tone: 'idle' };
	} else if (view.configuredMode == null) {
		// Running, but the configured mode is unreadable → we CANNOT claim "in sync" (F-008 honesty).
		status = { text: 'config unreadable', tone: 'warning' };
	} else {
		status = { text: 'in sync', tone: 'done' };
	}
	return { configured, running, interval, restartNeeded, status };
}

/** One scope-grouped block of loop cards (System loops first, then one per project). */
export interface LoopGroup {
	/** Stable group key: 'system' for global loops, else the project record id. */
	key: string;
	/** Group heading — 'System loops' or the project's display name (slug fallback). */
	title: string;
	scope: LoopScope;
	loops: LoopView[];
}

/** Strip the `project:` table prefix for an honest fallback label when no name is known. */
function projectFallbackLabel(projectId: string): string {
	return projectId.includes(':') ? projectId.split(':').slice(1).join(':') : projectId;
}

/**
 * Group loops for the Loops page: the GLOBAL (system) loops in one block first, then one block per
 * distinct project in first-seen order. SHADOW PATHS: a nil/empty list ⇒ [] (the page renders its
 * honest empty state); a project-scoped loop with no projectId (defensive — should not happen) is
 * bucketed under a stable '(unknown project)' group rather than dropped. `projectNames` maps a
 * project record id → display name; a missing entry falls back to the de-prefixed id (honest, never
 * a fabricated name).
 */
export function groupLoops(
	loops: readonly LoopView[] | null | undefined,
	projectNames: Record<string, string> = {}
): LoopGroup[] {
	const rows = loops ?? [];
	const system: LoopView[] = [];
	const byProject = new Map<string, LoopView[]>();
	const order: string[] = [];

	for (const loop of rows) {
		if (loop.scope === 'global') {
			system.push(loop);
			continue;
		}
		const key = loop.projectId ?? '(unknown project)';
		if (!byProject.has(key)) {
			byProject.set(key, []);
			order.push(key);
		}
		byProject.get(key)!.push(loop);
	}

	const groups: LoopGroup[] = [];
	if (system.length) {
		groups.push({ key: 'system', title: 'System loops', scope: 'global', loops: system });
	}
	for (const key of order) {
		const title =
			key === '(unknown project)'
				? 'Unknown project'
				: (projectNames[key] ?? projectFallbackLabel(key));
		groups.push({ key, title, scope: 'project', loops: byProject.get(key)! });
	}
	return groups;
}
