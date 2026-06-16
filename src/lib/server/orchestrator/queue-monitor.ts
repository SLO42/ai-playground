// BL-9 — work-queue monitor READ-ONLY readers (WORK-QUEUE-MONITOR-SPEC §3/§6).
//
// The `work_item` background claim queue (workqueue.ts) runs invisibly. This adds a thin
// read-only lister + a stats aggregate so the operator can see backlog depth, daily-cap
// throttling (D-021), and stuck/stale items — without ever mutating the queue.
//
// LOCKED INVARIANTS (spec §2):
//   1. READ-ONLY. SELECTs only. We NEVER call gcStale / the reaper / claimNext / enqueue from
//      here — `staleCount` is a DERIVED READ against the SAME stuck threshold the GC uses, not
//      an invocation of the GC. No enqueue/claim/cancel/retry path exists in this module.
//   2. Honest states (F-008). Empty queue → depth 0 + an honest "idle" surface (the UI shows
//      "no work pending"); a reader that throws bubbles to the loader's honest error — never a
//      zero dressed as real.
//   3. NO new schema. work_item exists (schema.ts m0012); reuse workqueue.ts readers
//      (countByStatus / pendingDepth / spawnsSince) + add a thin listWorkItems + queueStats.
//   4. Bounded reads (F-014/D-024). The completed list is paginated/time-windowed by LIMIT +
//      an optional `before` cursor; the live counts are cheap GROUP aggregates.
//   5. F-013. Every datetime ISO-coerced; absent → undefined (UI '—').
//
// The daily cap is the orchestrator's `dailySpawnCap` (D-021) — but it is OPT-IN: the cap is
// undefined unless the operator wires one. boot.ts (the live wire) passes NO dailySpawnCap, so
// the running orchestrator is UNCAPPED. This monitor must report that reality (F-008): when no
// cap is enforced we surface "N spawned today · no cap enforced" and NEVER a fake /denominator
// or a false `throttled`. We only show "X remaining / throttled" when a real cap is supplied —
// the cap denominator must come from the same value the orchestrator enforces, never a view-local
// literal that the orchestrator does not actually apply. The stuck/stale window mirrors gcStale's
// default so the monitor and the GC agree (spec §7 D2).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { DAY_MS, pendingDepth, countByStatus, spawnsSince, type WorkStatus } from './workqueue';

/** Validate a `table:id` link at the D-016 chokepoint, wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	return s && s !== 'undefined' && s !== 'null' ? s : undefined;
}

/**
 * The default stuck/stale window for a `processing` claim — MIRRORS gcStale's stuckMaxAgeMs
 * default (workqueue.ts: 60 min) so the monitor's STALE flag and the GC's reap threshold
 * agree (spec §7 D2). A `processing` item whose claim is older than this is flagged STALE — a
 * DERIVED READ; the monitor never reaps it.
 */
export const DEFAULT_STUCK_MS = 60 * 60 * 1000;

/** One work_item row projected for the monitor (read-only). */
export interface WorkItemRow {
	id: string;
	workType: string;
	status: WorkStatus;
	priority: number;
	attempts: number;
	/** ISO enqueue time (F-013), undefined → '—'. */
	enqueuedAt?: string;
	/** ISO claim time (F-013) — present once claimed. */
	claimedAt?: string;
	/** ISO terminal time (F-013) — present once done/failed. */
	completedAt?: string;
	/** Whether the item currently holds a claim lease (processing). */
	claimed: boolean;
	/** Target ref the work names (project / session record id), plain text — no execution. */
	targetRef?: string;
	/** DERIVED: a processing item whose claim is older than the stuck window (honest STALE
	 *  read — NOT auto-reaped here). */
	stale: boolean;
	/** Age of the claim in ms (for the "claim age" column), undefined when unclaimed. */
	claimAgeMs?: number;
	/** Wall-clock duration enqueued→completed in ms, undefined until terminal. */
	durationMs?: number;
}

interface RawItem {
	id: unknown;
	work_type: string;
	status: string;
	priority?: unknown;
	attempts?: unknown;
	created_at?: unknown;
	claimed_at?: unknown;
	completed_at?: unknown;
	claim_token?: unknown;
	project?: unknown;
	session?: unknown;
}

function isWorkStatus(s: string): s is WorkStatus {
	return s === 'pending' || s === 'processing' || s === 'done' || s === 'failed';
}

function normItem(r: RawItem, now: number, stuckMs: number): WorkItemRow {
	const status: WorkStatus = isWorkStatus(r.status) ? r.status : 'pending';
	const enqueuedAt = isoOrUndef(r.created_at);
	const claimedAt = isoOrUndef(r.claimed_at);
	const completedAt = isoOrUndef(r.completed_at);
	const claimed = r.claim_token != null;
	const claimMs = claimedAt ? new Date(claimedAt).getTime() : undefined;
	const claimAgeMs = claimMs != null && !Number.isNaN(claimMs) ? Math.max(0, now - claimMs) : undefined;
	// STALE is a DERIVED READ: processing + claim older than the stuck window. We never reap.
	const stale = status === 'processing' && claimAgeMs != null && claimAgeMs > stuckMs;
	const enqMs = enqueuedAt ? new Date(enqueuedAt).getTime() : undefined;
	const compMs = completedAt ? new Date(completedAt).getTime() : undefined;
	const durationMs =
		enqMs != null && compMs != null && !Number.isNaN(enqMs) && !Number.isNaN(compMs)
			? Math.max(0, compMs - enqMs)
			: undefined;
	const targetRef = r.project != null ? String(r.project) : r.session != null ? String(r.session) : undefined;
	return {
		id: String(r.id),
		workType: r.work_type,
		status,
		priority: Number(r.priority ?? 5),
		attempts: Number(r.attempts ?? 0),
		...(enqueuedAt ? { enqueuedAt } : {}),
		...(claimedAt ? { claimedAt } : {}),
		...(completedAt ? { completedAt } : {}),
		claimed,
		...(targetRef ? { targetRef } : {}),
		stale,
		...(claimAgeMs != null ? { claimAgeMs } : {}),
		...(durationMs != null ? { durationMs } : {})
	};
}

/**
 * List work_item rows for the monitor, newest-first, bounded (F-014). Filter by `status`
 * (e.g. the active list = pending+processing; the completed list = done/failed). A `before`
 * ISO cursor paginates the completed history (rows enqueued strictly before the cursor).
 * Returns [] when empty (F-008). READ-ONLY — a plain SELECT.
 */
export async function listWorkItems(
	db: Db,
	opts: { status?: WorkStatus | WorkStatus[]; limit?: number; before?: string; stuckMs?: number } = {}
): Promise<WorkItemRow[]> {
	const limit = opts.limit ?? 50;
	const stuckMs = opts.stuckMs ?? DEFAULT_STUCK_MS;
	const clauses: string[] = [];
	const params: Record<string, unknown> = { limit };
	if (opts.status) {
		const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
		params.statuses = statuses;
		clauses.push(`status IN $statuses`);
	}
	if (opts.before) {
		params.before = opts.before;
		clauses.push(`created_at < <datetime>$before`);
	}
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
	const [rows] = await db.query<[RawItem[]]>(
		`SELECT id, work_type, status, priority, attempts, created_at, claimed_at,
		        completed_at, claim_token, project, session
		   FROM work_item
		   ${where}
		  ORDER BY created_at DESC
		  LIMIT $limit;`,
		params
	);
	const now = Date.now();
	return (rows ?? []).map((r) => normItem(r, now, stuckMs));
}

/** Look up a single work_item by id (per-item drill-down), or null. READ-ONLY. */
export async function getWorkItem(db: Db, id: string, stuckMs = DEFAULT_STUCK_MS): Promise<WorkItemRow | null> {
	const [rows] = await db.query<[RawItem[]]>(
		`SELECT id, work_type, status, priority, attempts, created_at, claimed_at,
		        completed_at, claim_token, project, session
		   FROM $id;`,
		{ id: link(id) }
	);
	const r = rows?.[0];
	return r ? normItem(r, Date.now(), stuckMs) : null;
}

/** Headline queue stats (the monitor's top row). All from real readers (F-008). */
export interface QueueStats {
	/** pending + unclaimed depth (the backlog signal). */
	pendingDepth: number;
	/** Currently `processing` (claimed) count. */
	processing: number;
	/** done + failed terminal counts. */
	done: number;
	failed: number;
	/** Items CLAIMED within the rolling cap window (today's spawns, D-021). Always real. */
	spawnsToday: number;
	/**
	 * Whether a daily spawn cap is ENFORCED by the orchestrator. When false (the live boot
	 * reality — boot.ts passes no dailySpawnCap), there is no denominator and no throttle:
	 * the UI shows "N spawned today · no cap enforced" (F-008 — no fabricated /N).
	 */
	capped: boolean;
	/** The daily cap (D-021 denominator) — ONLY present when `capped`; undefined when uncapped. */
	dailyCap?: number;
	/** max(cap - spawnsToday, 0) — ONLY present when `capped`; undefined when uncapped. */
	capRemaining?: number;
	/**
	 * Whether today's spawns have reached/exceeded the cap (throttled). ALWAYS false when
	 * uncapped — an uncapped orchestrator never throttles, so we never show a false throttle.
	 */
	throttled: boolean;
	/** DERIVED count of `processing` items older than the stuck window (honest STALE — not
	 *  reaped). */
	staleCount: number;
}

/**
 * Aggregate the headline queue stats from the real workqueue readers + a derived stale count.
 * READ-ONLY: depth/counts/spawns come from countByStatus/pendingDepth/spawnsSince; the stale
 * count is a SELECT against the SAME stuck threshold gcStale uses — the reaper is NEVER called.
 * Each aggregate is a cheap GROUP read. Throws bubble to the loader's honest-error path (F-008).
 *
 * HONEST CAP (F-008): `dailyCap` is OPT-IN — pass it ONLY when the orchestrator is actually wired
 * with that same `dailySpawnCap`. When omitted (the current live-boot reality — boot.ts wires no
 * cap), the orchestrator is UNCAPPED, so we report `capped:false`, no denominator, no throttle.
 * A cap is honored only when it is a positive finite number; a 0/negative/NaN value is treated as
 * "no cap" (matching the orchestrator's own `dailySpawnCap > 0` gate) — never a fake /0 denominator.
 */
export async function queueStats(
	db: Db,
	opts: { dailyCap?: number; stuckMs?: number; windowMs?: number } = {}
): Promise<QueueStats> {
	const capped = typeof opts.dailyCap === 'number' && Number.isFinite(opts.dailyCap) && opts.dailyCap > 0;
	const stuckMs = opts.stuckMs ?? DEFAULT_STUCK_MS;
	const windowMs = opts.windowMs ?? DAY_MS;
	const [depth, processing, done, failed, spawnsToday, staleCount] = await Promise.all([
		pendingDepth(db),
		countByStatus(db, 'processing'),
		countByStatus(db, 'done'),
		countByStatus(db, 'failed'),
		spawnsSince(db, windowMs),
		staleProcessingCount(db, stuckMs)
	]);
	const base = {
		pendingDepth: depth,
		processing,
		done,
		failed,
		spawnsToday,
		staleCount
	};
	if (!capped) {
		// UNCAPPED (boot reality): no denominator, never throttled (F-008 — no fabricated /N).
		return { ...base, capped: false, throttled: false };
	}
	const dailyCap = opts.dailyCap as number;
	return {
		...base,
		capped: true,
		dailyCap,
		capRemaining: Math.max(0, dailyCap - spawnsToday),
		throttled: spawnsToday >= dailyCap
	};
}

/**
 * DERIVED stale read: count `processing` items whose claim is older than the stuck window.
 * Mirrors gcStale's reap predicate (status=processing AND claimed_at < cutoff) but is a pure
 * count() SELECT — it READS the inputs the GC would act on, it does NOT run the GC (spec §2.1/§3).
 */
async function staleProcessingCount(db: Db, stuckMs: number): Promise<number> {
	const cutoff = new Date(Date.now() - stuckMs).toISOString();
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item
		   WHERE status = "processing" AND claimed_at != NONE
		     AND claimed_at < <datetime>$cutoff GROUP ALL;`,
		{ cutoff }
	);
	return Number(rows?.[0]?.c ?? 0);
}
