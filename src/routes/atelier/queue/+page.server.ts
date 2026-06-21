// BL-9 — /atelier/queue: the work-queue monitor (WORK-QUEUE-MONITOR-SPEC §4).
//
// READ-ONLY (spec §2.1): surfaces the work_item background claim queue — headline stats
// (pending depth · processing · today's spawns vs the D-021 daily cap · stale count), the active
// list (pending + processing, with a DERIVED STALE flag), and a paginated recent-completed list.
// NO enqueue/cancel/retry/GC is ever invoked here — queueStats/listWorkItems are pure SELECTs and
// staleCount is a derived read against the same threshold gcStale uses (never the reaper). Honest
// (F-008/D-019): DB down → connected:false + zeroed/empty + honest banner; a failing read →
// honest error, never a fabricated row. Bounded (F-014): the completed list is LIMIT-paged with a
// `?before=` cursor. Live (§4): a work_item row change re-invalidates this loader.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	queueStats,
	listWorkItems,
	type QueueStats,
	type WorkItemRow
} from '$lib/server/orchestrator/queue-monitor';
import { bootDailySpawnCap } from '$lib/server/orchestrator/boot';
import type { PageServerLoad } from './$types';

/** A safe zeroed stats block for the disconnected/error path (honest, not fabricated). The cap
 *  is reported as UNENFORCED here — matching the live boot reality (boot.ts wires no daily cap),
 *  so the UI never shows a fabricated /denominator or a false throttle when the DB is down. */
const ZERO_STATS: QueueStats = {
	pendingDepth: 0,
	processing: 0,
	done: 0,
	failed: 0,
	spawnsToday: 0,
	capped: false,
	throttled: false,
	staleCount: 0
};

export interface QueueData {
	connected: boolean;
	stats: QueueStats;
	/** pending + processing items (the active list). */
	active: WorkItemRow[];
	/** done + failed items, newest-first, paginated (the recent-completed list). */
	completed: WorkItemRow[];
	/** The cursor for the next older completed page (ISO), or null when exhausted. */
	completedBefore: string | null;
	error?: string;
}

/** Loose ISO-8601 SHAPE guard for the ?before= cursor (anything else ⇒ no cursor). */
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Accept a `?before=` cursor only if it is BOTH shape-valid (ISO) AND a real calendar date.
 * The shape regex alone admits e.g. `2024-99-99T00:00:00.000Z`, which would then hit the
 * `<datetime>$before` cast in queue-monitor and THROW inside SurrealDB — turning a healthy DB
 * into a false 'disconnected' card (F-008 honest-state violation). Mirrors the fmtTime guard
 * (`Number.isNaN(new Date(iso).getTime())`) already used in this feature's +page.svelte.
 * Anything that fails either check ⇒ no cursor (drop to the unfiltered newest page).
 */
export function _validCursor(raw: string | null): string | undefined {
	if (!raw || !ISO.test(raw)) return undefined;
	return Number.isNaN(new Date(raw).getTime()) ? undefined : raw;
}

export const load: PageServerLoad = async ({ url, depends }): Promise<QueueData> => {
	depends('app:work-queue');

	const before = _validCursor(url.searchParams.get('before'));
	const COMPLETED_PAGE = 25;

	const db = tryGetDb();
	if (!db) {
		return { connected: false, stats: ZERO_STATS, active: [], completed: [], completedBefore: null };
	}
	try {
		// BL-9-H1 LOW — thread the REAL enforced cap so the monitor reports the SAME D-021 daily
		// cap the orchestrator actually enforces (boot.ts now wires one), not 'no cap enforced'.
		// Read from the same config seam the orchestrator reads (bootDailySpawnCap), so reported
		// == enforced. undefined ⇒ uncapped ⇒ queueStats reports capped:false (honest, no fake /N).
		const dailyCap = bootDailySpawnCap();
		const [stats, active, completed] = await Promise.all([
			queueStats(db, { dailyCap }),
			listWorkItems(db, { status: ['pending', 'processing'], limit: 100 }),
			listWorkItems(db, { status: ['done', 'failed'], limit: COMPLETED_PAGE, before })
		]);
		// Cursor for the next page = the enqueue time of the last completed row (when the page
		// filled). When the page is short there are no older rows → null (honest end-of-list).
		const completedBefore =
			completed.length === COMPLETED_PAGE ? (completed[completed.length - 1].enqueuedAt ?? null) : null;
		return { connected: true, stats, active, completed, completedBefore };
	} catch (err) {
		return {
			connected: false,
			stats: ZERO_STATS,
			active: [],
			completed: [],
			completedBefore: null,
			error: (err as Error).message
		};
	}
};
