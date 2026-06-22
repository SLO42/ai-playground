// CC-STATUS — pure derivations for the project command-center status dashboard (ProjectStatus.svelte).
//
// All logic that turns LIVE rows into the dashboard's visual model lives here as pure functions so it
// is unit-testable without rendering Svelte (the transcript-core pattern). NOTHING here fabricates a
// number (F-008): every count comes from the real task/session rows the loader already fetched, and the
// autonomous-loop badge maps the loop's REAL last-state (null ⇒ an honest "not engaged", never a fake
// 'running'). This is a plain .ts module — NO runes (F-009).

/** The task-status vocabulary mirrored from tasks/repo.ts TASK_STATUSES (kept in sync; the funnel order). */
export type TaskPhase =
	| 'proposed'
	| 'backlog'
	| 'ready'
	| 'in_progress'
	| 'review'
	| 'blocked'
	| 'done'
	| 'failed'
	| 'withdrawn';

/** The ordered funnel toward the DoD (proposed → done). blocked/failed are surfaced OUTSIDE the funnel. */
export const PIPELINE_FUNNEL: readonly TaskPhase[] = [
	'proposed',
	'backlog',
	'ready',
	'in_progress',
	'review',
	'done'
] as const;

/** Statuses surfaced as the "needs attention" exception band (outside the forward funnel). */
export const PIPELINE_EXCEPTIONS: readonly TaskPhase[] = ['blocked', 'failed'] as const;

/** One funnel segment: a status, its live count, and its share of the funnel total (for the bar width). */
export interface PipelineSegment {
	status: TaskPhase;
	count: number;
	/** 0–100 share of the funnel total (NOT of all tasks — exceptions are excluded from the bar). */
	pct: number;
}

/** The full task-pipeline model the dashboard renders. */
export interface TaskPipeline {
	/** The forward funnel segments in order (proposed → done), each with a live count + bar share. */
	segments: PipelineSegment[];
	/** Exception counts (blocked / failed) surfaced as their own band. */
	exceptions: { status: TaskPhase; count: number }[];
	/** Total tasks counted in the forward funnel (the bar denominator). */
	funnelTotal: number;
	/** Total tasks across ALL statuses (incl. exceptions + withdrawn) — the honest project-wide count. */
	total: number;
	/** True when the project has zero tasks at all (the honest empty state — "no tasks yet"). */
	empty: boolean;
}

/** A minimal task shape — only `status` is read (works with the loader's TaskSummary). */
export interface TaskLike {
	status: string;
}

/**
 * Build the task-pipeline model from the live task rows. SHADOW PATHS: a nil/empty list ⇒ an honest
 * empty pipeline (every segment 0, `empty:true`); an UNKNOWN status (a row whose status is not in the
 * vocab) is counted into `total` but not into any funnel segment — it is never silently dropped and
 * never fabricated into a known bucket. Percentages are integer shares of the funnel total (0 when the
 * funnel is empty — never a divide-by-zero / NaN).
 */
export function buildPipeline(tasks: readonly TaskLike[] | null | undefined): TaskPipeline {
	const rows = tasks ?? [];
	const counts = new Map<string, number>();
	for (const t of rows) {
		const s = t?.status ?? '';
		counts.set(s, (counts.get(s) ?? 0) + 1);
	}
	const funnelTotal = PIPELINE_FUNNEL.reduce((sum, s) => sum + (counts.get(s) ?? 0), 0);
	const segments: PipelineSegment[] = PIPELINE_FUNNEL.map((status) => {
		const count = counts.get(status) ?? 0;
		const pct = funnelTotal > 0 ? Math.round((count / funnelTotal) * 100) : 0;
		return { status, count, pct };
	});
	const exceptions = PIPELINE_EXCEPTIONS.map((status) => ({
		status,
		count: counts.get(status) ?? 0
	}));
	return {
		segments,
		exceptions,
		funnelTotal,
		total: rows.length,
		empty: rows.length === 0
	};
}

/** The autonomous-loop badge's visual tone — drives the token color (no raw hex; F-008 honest mapping). */
export type LoopTone = 'running' | 'done' | 'blocked' | 'warning' | 'idle' | 'none';

/** The badge model: a tone (color), a short label, and the honest reason text (verbatim, server-screened). */
export interface LoopBadge {
	tone: LoopTone;
	label: string;
	/** The loop's honest one-line reason, or null when the loop has not engaged this project. */
	reason: string | null;
	/** Re-ticks used this window (PMA-2), or null when no loop state exists. */
	ticksUsed: number | null;
	/** True when the loop has never acted on this project (the honest "not engaged" state). */
	notEngaged: boolean;
}

/** The loop's honest last-state shape from the loader (data.autonomousLoop). */
export interface LoopStateLike {
	state: string;
	reason: string;
	ticksUsed: number;
}

/**
 * Map the loop's REAL last-state to the dashboard badge. SHADOW PATHS: a null loop state (no loop
 * running / it has not acted on this project) ⇒ an honest "not engaged" badge with tone 'none' — NEVER
 * a fabricated 'running' (F-008). An UNKNOWN state string falls through to a neutral 'idle' tone with
 * the raw state as the label rather than being dropped (EVERY ERROR HAS A NAME — even an unmodelled
 * state is shown, not hidden).
 */
export function loopBadge(loop: LoopStateLike | null | undefined): LoopBadge {
	if (!loop) {
		return {
			tone: 'none',
			label: 'not engaged',
			reason: null,
			ticksUsed: null,
			notEngaged: true
		};
	}
	const base = { reason: loop.reason || null, ticksUsed: loop.ticksUsed, notEngaged: false };
	switch (loop.state) {
		case 'running':
			return { tone: 'running', label: 'driving', ...base };
		case 'dod-reached':
			return { tone: 'done', label: 'DoD reached', ...base };
		case 'published':
			return { tone: 'done', label: 'v1 shipped', ...base };
		case 'awaiting-release-confirm':
			return { tone: 'warning', label: 'awaiting release confirm', ...base };
		case 'blocked':
			return { tone: 'blocked', label: 'blocked', ...base };
		case 'cap-reached':
			return { tone: 'warning', label: 'cap reached', ...base };
		case 'idle':
			return { tone: 'idle', label: 'idle', ...base };
		default:
			// Unmodelled state — surface it honestly rather than hiding it (never a fabricated label).
			return { tone: 'idle', label: loop.state || 'unknown', ...base };
	}
}

/** A minimal session shape — only `status` and `note` are read (works with the loader's FleetSession). */
export interface SessionLike {
	status: string;
	note?: string | null;
}

/** The live-session summary band: how many sessions are running now + recently-failed (with reasons). */
export interface SessionSummary {
	running: number;
	failed: number;
	/** The recently-failed sessions with their honest MC-4 reason (note) — capped for display. */
	failures: { note: string | null }[];
}

/**
 * Summarize the project's sessions for the dashboard. SHADOW PATHS: a nil/empty list ⇒ all-zero (the
 * honest "no sessions" state). `running` counts `status === 'running'`; `failed` counts
 * `status === 'failed'`. Failed sessions carry their REAL note (the MC-4 honest failure reason) — null
 * when none was recorded (legacy/absent), NEVER a fabricated reason (F-008). The failures list is
 * capped at `maxFailures` so a storm of failures cannot blow the surface up.
 */
export function summarizeSessions(
	sessions: readonly SessionLike[] | null | undefined,
	maxFailures = 5
): SessionSummary {
	const rows = sessions ?? [];
	let running = 0;
	let failed = 0;
	const failures: { note: string | null }[] = [];
	for (const s of rows) {
		if (s?.status === 'running') running += 1;
		else if (s?.status === 'failed') {
			failed += 1;
			if (failures.length < maxFailures) failures.push({ note: s.note ?? null });
		}
	}
	return { running, failed, failures };
}
