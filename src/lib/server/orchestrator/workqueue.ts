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

/** Options for {@link claimNext}. */
export interface ClaimOptions {
	/** Bounded retry count on a lost claim race (default 16). */
	maxRetries?: number;
	/**
	 * Per-project in-flight gate (orchestration concurrency.perProject). Project record-id
	 * strings whose in-flight SESSION count is ALREADY at the perProject cap — the claim SELECT
	 * skips a pending `task_run` item linked to one of these projects so it is PARKED (left
	 * pending) for a later drain, while task_run items for other (free) projects stay claimable
	 * in the same pass. SCOPE: only `task_run` items are gated — they are the ones launchSession
	 * runs in the project's shared cwd (the F-007/F-046 git/file race). In-process forks
	 * (memory_review / hire_request) carry a project link but write NOTHING to the cwd, so they
	 * are NEVER parked by this gate. This enforces the per-project cap WITHOUT a busy loop: a
	 * parked item is re-evaluated when an in-flight session for its project completes and
	 * re-drains. Empty/absent ⇒ no gate (byte-identical to the pre-gate behavior).
	 */
	excludeProjectIds?: readonly string[];
}

/**
 * Claim the single highest-priority pending+unclaimed `work_item` ATOMICALLY, or
 * `null` if the queue is empty. SELECT-then-claim-by-id (§4.12): never `UPDATE…ORDER BY`.
 *
 * `claimToken` is a caller-unique lease (per worker / per claim). On a lost race the
 * record-targeted UPDATE returns `[]`; we re-SELECT the next candidate and retry up to
 * `maxRetries` times (a finite bound, never a busy loop). When the SELECT itself finds
 * no candidate we return `null` immediately.
 *
 * `opts.excludeProjectIds` is the per-project in-flight gate (concurrency.perProject): pending
 * items linked to a capped project are filtered OUT of the candidate SELECT so they stay parked
 * for a later drain, while other projects' items remain claimable in the same pass.
 */
export async function claimNext(
	db: Db,
	claimToken: string,
	maxRetries: number | ClaimOptions = 16
): Promise<ClaimedItem | null> {
	// Back-compat overload: a bare number is the old maxRetries arg; an object is ClaimOptions.
	const opts: ClaimOptions = typeof maxRetries === 'number' ? { maxRetries } : maxRetries;
	const retries = opts.maxRetries ?? 16;
	// Validate every excluded id at the D-016 chokepoint, then wrap as a record link so the
	// SELECT compares against real record ids (never a raw interpolated string). Dedup defensively.
	const excluded = [...new Set(opts.excludeProjectIds ?? [])].map((id) => link(id));
	// Serialize claims on this connection (see claimSerializer): SurrealDB processes one
	// query at a time per connection, but two claimNext calls awaiting in JS can still
	// interleave their SELECT and CAS round-trips. Funnelling them through a per-db
	// promise chain makes each claim's SELECT→CAS contiguous so the record-targeted CAS
	// guard is reliably single-winner (S0) without paying for a transaction (whose
	// BEGIN/COMMIT would interleave with the launch path's plain queries on the shared
	// connection and surface spurious "failed transaction" errors). Claims are brief.
	return claimSerializer(db, async () => {
		for (let attempt = 0; attempt <= retries; attempt++) {
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
				// Per-project gate (concurrency.perProject): when excluded ids are present, the
				// candidate SELECT skips ONLY pending `task_run` items linked to a capped project —
				// `NOT (work_type = "task_run" AND project IN $excluded)` parks a session spawn whose
				// project is at its in-flight cap while leaving in-process forks (memory_review /
				// hire_request, which write nothing to the project cwd) and every other project's
				// task_run claimable in the same pass.
				const projFilter =
					excluded.length > 0 ? `AND NOT (work_type = "task_run" AND project IN $excluded)` : '';
				const result = await db.query<unknown[]>(
					`LET $cand = (SELECT id, priority FROM work_item
					   WHERE status = "pending" AND claim_token IS NONE ${projFilter}
					   ORDER BY priority ASC LIMIT 1)[0].id;
					 IF $cand != NONE {
					   RETURN UPDATE $cand
					     SET claim_token = $t, status = "processing", attempts += 1,
					         claimed_at = time::now()
					     WHERE claim_token IS NONE
					     RETURN AFTER;
					 } ELSE {
					   RETURN [];
					 };`,
					excluded.length > 0 ? { t: claimToken, excluded } : { t: claimToken }
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
				// $cand was NONE (no candidate, incl. all candidates filtered by the per-project
				// gate) or the guarded UPDATE matched nothing (a concurrent claim took it). Re-check
				// under the SAME project gate: if no claimable pending row remains, stop; else retry
				// so a multi-row queue isn't abandoned after one lost race. The gate is applied here
				// too so a queue full of ONLY capped-project task_run items terminates (returns null)
				// rather than spinning the retry loop.
				const projFilter =
					excluded.length > 0 ? `AND NOT (work_type = "task_run" AND project IN $excluded)` : '';
				const [remaining] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM work_item
					   WHERE status = "pending" AND claim_token IS NONE ${projFilter} GROUP ALL;`,
					excluded.length > 0 ? { excluded } : {}
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

/** Count rows whose status remains pending+unclaimed — the threshold-drain signal. */
export async function pendingDepth(db: Db): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item
		   WHERE status = "pending" AND claim_token IS NONE GROUP ALL;`
	);
	return Number(rows?.[0]?.c ?? 0);
}

// ── TASK 2.15 — daily spawn cap (D-021) ──────────────────────────────────────────
//
// KongCode caps how many heavy items are drained per rolling day so a burst of
// producers (D-017 maintenance, post-task extraction, follow-ups) can't run the host
// agent CLI unbounded. We count the items that have been CLAIMED (status moved off
// "pending" → attempts >= 1) within the rolling 24h window. `claimed_at` is stamped on
// the atomic claim (see claimNext) so the window is anchored to when work actually
// SPAWNED, not when it was produced — a backlog produced days ago but drained today
// still counts against today's cap. Optionally scope the cap to one work_type.

/** The default rolling cap window (24h). */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many work_items have been CLAIMED (drained → spawned) within the rolling window
 * (default 24h). This is the daily-cap counter the orchestrator checks BEFORE claiming
 * the next background item. Anchored on `claimed_at` (stamped on the atomic claim), so
 * re-running the migration or producing a backlog earlier never inflates the count.
 */
export async function spawnsSince(
	db: Db,
	windowMs: number = DAY_MS,
	workType?: string
): Promise<number> {
	const since = new Date(Date.now() - windowMs).toISOString();
	const filter = workType ? `AND work_type = $wt` : '';
	const [rows] = await db.query<[Array<{ c: number }>]>(
		`SELECT count() AS c FROM work_item
		   WHERE claimed_at != NONE AND claimed_at >= <datetime>$since ${filter}
		   GROUP ALL;`,
		workType ? { since, wt: workType } : { since }
	);
	return Number(rows?.[0]?.c ?? 0);
}

// ── TASK 2.15 — stale-item GC (D-021: "7-day GC of stale items") ──────────────────
//
// Old terminal rows (done/failed) accumulate; KongCode GC's them after ~7 days. Per
// D-015 the GC of an OPERATIONAL queue row is a hard delete (the work_item table is NOT
// a knowledge table — it carries no durable knowledge; the knowledge it PRODUCED lives
// in memory/skill rows that GC never touches). We ALSO reap orphaned `processing` rows
// whose worker crashed (a stale claim older than the window with no terminal write) by
// RESETTING them to pending+unclaimed so they can be re-drained — crash recovery, not
// deletion. Both are gated on age so a re-run is a no-op once nothing is stale.

export interface GcResult {
	/** Terminal (done/failed) rows older than the window that were deleted. */
	deletedTerminal: number;
	/** Stuck `processing` rows (crashed worker) older than the window, reset to pending. */
	recoveredStuck: number;
}

/**
 * GC the queue (D-021). Deletes terminal rows older than `terminalMaxAgeMs` (default 7d)
 * and resets `processing` rows whose claim is older than `stuckMaxAgeMs` (default 1h) back
 * to pending+unclaimed so a crashed worker's item is re-drained. Idempotent: once nothing
 * is stale it deletes/recovers zero. Time math runs in SurrealQL via a bound ISO cutoff.
 */
export async function gcStale(
	db: Db,
	opts: { terminalMaxAgeMs?: number; stuckMaxAgeMs?: number } = {}
): Promise<GcResult> {
	const termCut = new Date(Date.now() - (opts.terminalMaxAgeMs ?? 7 * DAY_MS)).toISOString();
	const stuckCut = new Date(Date.now() - (opts.stuckMaxAgeMs ?? 60 * 60 * 1000)).toISOString();
	// 1) reap crashed `processing` rows → pending+unclaimed (clear the lease + claimed_at so
	//    the re-claim re-stamps the window). 2) delete aged terminal rows. Two statements,
	//    one round-trip; RETURN BEFORE counts the affected rows per statement.
	const res = await db.query<[Array<unknown>, Array<unknown>]>(
		`UPDATE work_item
		   SET status = "pending", claim_token = NONE, claimed_at = NONE
		   WHERE status = "processing" AND claimed_at != NONE
		     AND claimed_at < <datetime>$stuckCut
		   RETURN BEFORE;
		 DELETE work_item
		   WHERE status IN ["done","failed"] AND completed_at != NONE
		     AND completed_at < <datetime>$termCut
		   RETURN BEFORE;`,
		{ stuckCut, termCut }
	);
	return {
		recoveredStuck: res[0]?.length ?? 0,
		deletedTerminal: res[1]?.length ?? 0
	};
}

// ── TASK 2.15 — crash-safe handoff (D-021: "crash-safe handoff written on session end") ─
//
// KongCode writes a handoff record SYNCHRONOUSLY on session end so an item interrupted
// mid-flight can be resumed by another worker after a crash. We persist the handoff state
// onto the work_item row's `handoff` object (FLEXIBLE, schema §4.12). Guarded by the
// claim_token lease so only the current holder may write its handoff (a stale worker that
// lost the lease can't clobber the row that was re-claimed). recoverHandoffs surfaces the
// handoff state of items still mid-flight so a freshly-booted orchestrator can resume them.

/**
 * Persist crash-recovery handoff state onto a claimed item, SYNCHRONOUSLY on session end
 * (D-021). Lease-guarded: only the current `claim_token` holder writes. Returns whether
 * the row was matched (false ⇒ the lease moved / the row is gone — caller must not assume
 * the handoff persisted).
 */
export async function writeHandoff(
	db: Db,
	id: string,
	claimToken: string,
	handoff: Record<string, unknown>
): Promise<boolean> {
	const rid = link(id);
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`UPDATE $rid SET handoff = $handoff
		   WHERE claim_token = $t RETURN AFTER;`,
		{ rid, handoff, t: claimToken }
	);
	return (rows?.length ?? 0) > 0;
}

/** A mid-flight item plus its persisted handoff state (crash-recovery surface). */
export interface HandoffRow {
	id: string;
	workType: string;
	payload: Record<string, unknown>;
	handoff: Record<string, unknown>;
	claimToken: string;
}

/**
 * Surface every `processing` item that carries handoff state — the crash-recovery view a
 * freshly-booted orchestrator reads to resume interrupted work (D-021). Read-only.
 */
export async function recoverHandoffs(db: Db): Promise<HandoffRow[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, work_type, payload, handoff, claim_token FROM work_item
		   WHERE status = "processing" AND handoff != NONE;`
	);
	return (rows ?? []).map((r) => ({
		id: str(r.id),
		workType: str(r.work_type),
		payload: (r.payload as Record<string, unknown>) ?? {},
		handoff: (r.handoff as Record<string, unknown>) ?? {},
		claimToken: str(r.claim_token)
	}));
}
