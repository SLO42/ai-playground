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
	listDrainLedger,
	drainLedgerCounts,
	type QueueStats,
	type WorkItemRow,
	type DrainLedgerRow,
	type DrainLedgerCounts
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

/** Honest zeroed ledger counts for the disconnected/error path (never a fabricated "0 faults"
 *  presented as a live reading — the UI only renders these behind `connected`). */
const ZERO_LEDGER: DrainLedgerCounts = { faults: 0, holds: 0, parks: 0, windowMs: 24 * 60 * 60 * 1000 };

export interface QueueData {
	connected: boolean;
	stats: QueueStats;
	/** pending + processing items (the active list). */
	active: WorkItemRow[];
	/** done + failed items, newest-first, paginated (the recent-completed list). */
	completed: WorkItemRow[];
	/** The cursor for the next older completed page (ISO), or null when exhausted. */
	completedBefore: string | null;
	/**
	 * COMPLETION-LEDGER Wave A — the DRAIN LEDGER: named drain FAULTS (which step broke and why)
	 * and queue HOLDS (why work is waiting), newest first. This is the surface that answers
	 * "what broke?" and "why is this task not running?" — previously both were console-only.
	 */
	ledger: DrainLedgerRow[];
	/** Rolling-24h headline counts for the ledger (faults · holds · parks). */
	ledgerCounts: DrainLedgerCounts;
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
		return {
			connected: false,
			stats: ZERO_STATS,
			active: [],
			completed: [],
			completedBefore: null,
			ledger: [],
			ledgerCounts: ZERO_LEDGER
		};
	}
	try {
		// BL-9-H1 LOW — thread the REAL enforced cap so the monitor reports the SAME D-021 daily
		// cap the orchestrator actually enforces (boot.ts now wires one), not 'no cap enforced'.
		// Read from the same config seam the orchestrator reads (bootDailySpawnCap), so reported
		// == enforced. undefined ⇒ uncapped ⇒ queueStats reports capped:false (honest, no fake /N).
		const dailyCap = bootDailySpawnCap();
		// The ledger reads run in the SAME Promise.all as the queue reads and are NOT wrapped in a
		// best-effort catch: a broken ledger reader must surface as the page's honest error, not as
		// an empty panel that reads "nothing has failed" (the F-020-sweep trap — a best-effort catch
		// hiding a developer error). Both are bounded (LIMIT / rolling window), per F-014.
		const [stats, active, completed, ledger, ledgerCounts] = await Promise.all([
			queueStats(db, { dailyCap }),
			listWorkItems(db, { status: ['pending', 'processing'], limit: 100 }),
			listWorkItems(db, { status: ['done', 'failed'], limit: COMPLETED_PAGE, before }),
			listDrainLedger(db, { limit: 40 }),
			drainLedgerCounts(db)
		]);
		// Cursor for the next page = the enqueue time of the last completed row (when the page
		// filled). When the page is short there are no older rows → null (honest end-of-list).
		const completedBefore =
			completed.length === COMPLETED_PAGE ? (completed[completed.length - 1].enqueuedAt ?? null) : null;
		return { connected: true, stats, active, completed, completedBefore, ledger, ledgerCounts };
	} catch (err) {
		return {
			connected: false,
			stats: ZERO_STATS,
			active: [],
			completed: [],
			completedBefore: null,
			ledger: [],
			ledgerCounts: ZERO_LEDGER,
			error: (err as Error).message
		};
	}
};
