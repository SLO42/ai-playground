// TASK 2.2 — the `work_item` claim queue: the BACKGROUND concurrency mechanism
// (DATA-MODEL §4.12; ARCHITECTURE §2.2 "(b) Background heavy work"; D-021).
//
// This is the OTHER of the two distinct queues — the durable DB-backed claim queue.
// Producers `enqueue` rows; a worker `claimNext` claims the highest-priority unclaimed
// row ATOMICALLY. Per S0, the optimistic claim is single-winner under concurrency.
//
// CRITICAL (DATA-MODEL §4.12): SurrealDB 2.6.5 REJECTS `UPDATE … ORDER BY` (Unexpected
// token ORDER). The claim is therefore SELECT-then-claim-BY-ID:
//   1. SELECT the highest-priority pending+unclaimed id (ORDER BY is legal in SELECT).
//   2. UPDATE THAT id under `WHERE claim_token IS NONE` — a record-targeted compare-and-
//      set that is atomic (surrealkv isolation, proven single-winner in S0). Every loser
//      gets `[]` back; on `[]` we re-SELECT the next candidate and retry.
// We NEVER author `UPDATE … ORDER BY` and NEVER do `UPDATE…ORDER BY LIMIT` shortcuts.
//
// Boundary discipline (D-016): every VALUE binds via $param. The only interpolated
// tokens are record ids validated at db/validate.ts and wrapped as StringRecordId.
// Optional fields are OMITTED, never set to explicit NULL (option<T> rejects NULL,
// MEMORY-SPEC §6.1). Array/set legality stays in JS, not SQL.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A `work_item` lifecycle status (schema ASSERT, §4.12). */
export type WorkStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface EnqueueInput {
	/** task_run | scan | review | release | extract | follow_up | maintenance … */
	workType: string;
	/** The payload the worker needs to run the item (e.g. the task id to spawn). */
	payload: Record<string, unknown>;
	/** Lower = sooner; schema DEFAULT is 5. */
	priority?: number;
	/** Optional links — omitted (NONE) when absent (§6.1). */
	sessionId?: string;
	projectId?: string;
	/**
	 * Per-unit dedup discriminator folded into dedup_key (§4.12). Lets two items of the
	 * same work_type with NO session coexist (e.g. task_run for different tasks) while a
	 * re-enqueue of the SAME unit still dedups. Defaults to '' (session-keyed behavior).
	 */
	dedupScope?: string;
}

/** A claimed `work_item` row, ready for the worker to run. */
export interface ClaimedItem {
	id: string;
	workType: string;
	payload: Record<string, unknown>;
	priority: number;
	attempts: number;
	claimToken: string;
	projectId?: string;
	sessionId?: string;
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function str(v: unknown): string {
	return String(v);
}

/**
 * Enqueue a `work_item`. The UNIQUE `dedup_key` (active window: work_type|session|status,
 * §4.12) makes re-enqueueing the SAME active unit a UNIQUE-violation — caught here and
 * surfaced as `enqueued:false` rather than a thrown duplicate (exactly-once-ish, D-008).
 */
export async function enqueue(
	db: Db,
	input: EnqueueInput
): Promise<{ id: string; enqueued: boolean }> {
	const content = omitUndefined({
		work_type: input.workType,
		payload: input.payload,
		priority: input.priority,
		// Set status EXPLICITLY so the computed `dedup_key VALUE` (which keys on status,
		// §4.12) sees a concrete "pending" — relying on the schema DEFAULT leaves status
		// NONE at the moment the VALUE clause evaluates, so dedup_key falls to the ELSE
		// (record id) branch and the active-window UNIQUE dedup never engages.
		status: 'pending',
		dedup_scope: input.dedupScope,
		session: input.sessionId ? link(input.sessionId) : undefined,
		project: input.projectId ? link(input.projectId) : undefined
	});
	try {
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE work_item CONTENT $content RETURN AFTER;`,
			{ content }
		);
		return { id: str(rows[0].id), enqueued: true };
	} catch (err) {
		// A dedup_key UNIQUE collision means this active unit is already queued — not an
		// error, just a no-op dedup. Any other failure re-throws.
		const msg = (err as Error).message ?? '';
		if (/work_item_dedup|already (contains|exists)|index/i.test(msg)) {
			return { id: '', enqueued: false };
		}
		throw err;
	}
}

/**
 * Claim the single highest-priority pending+unclaimed `work_item` ATOMICALLY, or
 * `null` if the queue is empty. SELECT-then-claim-by-id (§4.12): never `UPDATE…ORDER BY`.
 *
 * `claimToken` is a caller-unique lease (per worker / per claim). On a lost race the
 * record-targeted UPDATE returns `[]`; we re-SELECT the next candidate and retry up to
 * `maxRetries` times (a finite bound, never a busy loop). When the SELECT itself finds
 * no candidate we return `null` immediately.
 */
export async function claimNext(
	db: Db,
	claimToken: string,
	maxRetries = 16
): Promise<ClaimedItem | null> {
	// Serialize claims on this connection (see claimSerializer): SurrealDB processes one
	// query at a time per connection, but two claimNext calls awaiting in JS can still
	// interleave their SELECT and CAS round-trips. Funnelling them through a per-db
	// promise chain makes each claim's SELECT→CAS contiguous so the record-targeted CAS
	// guard is reliably single-winner (S0) without paying for a transaction (whose
	// BEGIN/COMMIT would interleave with the launch path's plain queries on the shared
	// connection and surface spurious "failed transaction" errors). Claims are brief.
	return claimSerializer(db, async () => {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			// SELECT-then-claim-by-id as ONE statement batch (§4.12 reference form):
			//   LET $cand = (SELECT … ORDER BY priority LIMIT 1)[0].id;  -- read
			//   UPDATE $cand SET … WHERE claim_token IS NONE RETURN AFTER; -- guarded CAS
			// NEVER `UPDATE … ORDER BY` (2.6.5 rejects ORDER on UPDATE). We SELECT
			// (id, priority) not `VALUE id` because 2.6.5 requires the ORDER BY field in
			// the projection. The IF block guards `UPDATE NONE` (which throws) when the
			// queue is empty, yielding [] instead. The record-targeted `WHERE claim_token
			// IS NONE` is the atomic compare-and-set — exactly one claimer matches it.
			let claimed: Array<Record<string, unknown>>;
			try {
				const result = await db.query<unknown[]>(
					`LET $cand = (SELECT id, priority FROM work_item
					   WHERE status = "pending" AND claim_token IS NONE
					   ORDER BY priority ASC LIMIT 1)[0].id;
					 IF $cand != NONE {
					   RETURN UPDATE $cand
					     SET claim_token = $t, status = "processing", attempts += 1
					     WHERE claim_token IS NONE
					     RETURN AFTER;
					 } ELSE {
					   RETURN [];
					 };`,
					{ t: claimToken }
				);
				claimed = result[result.length - 1] as Array<Record<string, unknown>>;
			} catch (err) {
				// A retryable conflict — back off and retry the bounded loop; else re-throw.
				const msg = (err as Error).message ?? '';
				if (/conflict|can be retried|retry|failed transaction/i.test(msg)) {
					await new Promise((r) => setTimeout(r, 2 * (attempt + 1)));
					continue;
				}
				throw err;
			}
			const row = claimed?.[0];
			if (!row) {
				// $cand was NONE (no candidate) or the guarded UPDATE matched nothing (a
				// concurrent claim took it). Re-check: if no pending row remains, stop;
				// else retry so a multi-row queue isn't abandoned after one lost race.
				const [remaining] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM work_item
					   WHERE status = "pending" AND claim_token IS NONE GROUP ALL;`
				);
				if (Number(remaining?.[0]?.c ?? 0) === 0) return null;
				continue;
			}

			return {
				id: str(row.id),
				workType: str(row.work_type),
				payload: (row.payload as Record<string, unknown>) ?? {},
				priority: Number(row.priority ?? 5),
				attempts: Number(row.attempts ?? 0),
				claimToken,
				projectId: row.project != null ? str(row.project) : undefined,
				sessionId: row.session != null ? str(row.session) : undefined
			};
		}
		// Exhausted retries (extreme contention) — nothing claimable this pass.
		return null;
	});
}

// ── Per-db claim serializer ──────────────────────────────────────────────────────
// A tiny promise-chain mutex keyed by Db instance: each claimNext links onto the prior
// claim's tail so the SELECT→CAS round-trips never interleave for the SAME connection.
// Different Db instances (e.g. independent test servers) get independent chains.
const claimChains = new WeakMap<Db, Promise<unknown>>();
function claimSerializer<T>(db: Db, fn: () => Promise<T>): Promise<T> {
	const prior = claimChains.get(db) ?? Promise.resolve();
	const next = prior.then(fn, fn); // run fn regardless of how the prior claim settled
	// Keep the chain alive but swallow rejections on the stored tail so one failed claim
	// doesn't poison the next; the real result/rejection is returned to THIS caller.
	claimChains.set(
		db,
		next.then(
			() => undefined,
			() => undefined
		)
	);
	return next;
}

/**
 * Mark a claimed item terminal. Only the holder of `claimToken` may complete it (the
 * lease guard), so a stale worker can't clobber a re-claimed row. Sets completed_at.
 */
export async function complete(
	db: Db,
	id: string,
	claimToken: string,
	status: Extract<WorkStatus, 'done' | 'failed'>
): Promise<boolean> {
	const rid = link(id);
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`UPDATE $rid
		   SET status = $status, completed_at = time::now()
		   WHERE claim_token = $t
		   RETURN AFTER;`,
		{ rid, status, t: claimToken }
	);
	return (rows?.length ?? 0) > 0;
}

/** Count rows in a given status (diagnostics / drain threshold checks). */
export async function countByStatus(db: Db, status: WorkStatus): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item WHERE status = $status GROUP ALL;`,
		{ status }
	);
	return Number(rows?.[0]?.c ?? 0);
}
