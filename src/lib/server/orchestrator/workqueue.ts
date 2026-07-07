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

import { createHash } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A `work_item` lifecycle status (schema ASSERT, §4.12). */
export type WorkStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * The work types whose drain runs through `launchSession` in the project's SHARED working
 * tree (`project.root_path`) and COMMITS there — the F-046/F-007 git-index/file-stomp race
 * surface. These, and ONLY these, are subject to the per-project in-flight gate
 * (concurrency.perProject): two of them for the SAME project must be serialized so they don't
 * race the same repo. Defined in ONE place so adding a future cwd-spawn type extends the gate
 * everywhere (the candidate SELECT filter, the lost-race re-check, AND the orchestrator's
 * per-project counter bump) at once, not scattered.
 *
 * DELIBERATELY EXCLUDED — the IN-PROCESS forks `memory_review` and `hire_request`: they carry a
 * project link but write NOTHING to the project cwd (they hold only a MemoryWriteSurface / draft
 * to the DB), so gating them would wrongly starve the FAST-tier writer fork / HR draft (the
 * explicit HB-H1 deviation rationale). The gate set is the CWD-SPAWNING types, NOT all
 * project-linked work.
 */
export const CWD_SPAWNING_WORK_TYPES: readonly string[] = ['task_run', 'review'];

/** True iff `workType` spawns a session in the project's shared cwd (gate membership, single source). */
export function isCwdSpawningWorkType(workType: string | undefined): boolean {
	return workType !== undefined && CWD_SPAWNING_WORK_TYPES.includes(workType);
}

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

// ── BL-R3 (F-048 structural fix + F-026) — deterministic-id active-window dedup ──────────────
//
// The active-window dedup ("one pending-or-processing work_item per unit") is enforced by a
// DETERMINISTIC PRIMARY record id, NOT the secondary `work_item_dedup` UNIQUE index. On THIS
// SurrealDB build a secondary UNIQUE index over a computed VALUE field does NOT enforce under
// concurrent inserts (F-026 — two racers both commit) AND can INTERFERE with the atomic primary-
// key collision (the file_snapshot lesson). Only the PRIMARY record id is collision-atomic, so the
// unit's id IS the dedup key: two enqueues of the SAME (work_type, session, dedup_scope) resolve to
// the SAME record id → a second CREATE collides ATOMICALLY on the primary key (exactly one row, no
// matter the racer count). Because the id is STABLE across the pending→processing claim transition
// (the id never changes), it ALSO fixes the F-048 status-split clobber: a re-enqueue while the twin
// is already `processing` hits the same id and is deduped — the 2nd row is never created. NO
// migration ships for BL-R3 (F-057 revert): the active-window `dedup_key` VALUE field is UNCHANGED
// (work_type|session|dedup_scope|status, m0019) and the `work_item_dedup` index remains UNIQUE
// (m0012). For the deterministic-id task_run path that index is NOT the guarantee (the primary id
// is) — but it is DELIBERATELY LEFT in place because three OTHER producers (loop.ts enqueueReview /
// activation.ts reinterview / gauntlet.ts queued-interview) still `CREATE work_item` with a RANDOM
// id and rely on it for their dedup (see schema.ts §4.12 BL-R3 note). Do NOT drop it — re-triggers F-057.
//
// SCOPE_SEP is a NUL byte built at RUNTIME (String.fromCharCode(0)) so the three id components can
// never collide across a `|`-boundary (`a|b` vs `a`+`|b`) and the SOURCE stays pure-ASCII/diffable
// (a raw NUL would make git treat this file as binary). Mirrors file-snapshot.ts snapshotId().
const SCOPE_SEP = String.fromCharCode(0);

/**
 * The DETERMINISTIC `work_item:<hex>` record id for one active-window dedup unit
 * (work_type, session, dedup_scope) — the CONCURRENCY-SAFE dedup guarantee (F-026). Identical
 * (work_type|session|dedup_scope) maps to the SAME id, so two concurrent enqueues both `CREATE`
 * that id and the loser collides atomically on the primary key. session/dedup_scope absent ⇒ an
 * empty component (a session-less, scope-less unit gets its own stable id). The suffix is lowercase
 * hex (satisfies the D-016 record-id charset). PURE + exported — unit-testable without a DB.
 */
export function activeWorkItemId(workType: string, session: string, dedupScope: string): string {
	const scopeKey = `${workType}${SCOPE_SEP}${session}${SCOPE_SEP}${dedupScope}`;
	const suffix = createHash('sha256').update(scopeKey, 'utf8').digest('hex');
	return `work_item:${suffix}`;
}

/**
 * Is this the deterministic-id PRIMARY-KEY collision a concurrent/duplicate enqueue raises (F-026)?
 * On this SurrealDB build the same record-id double-CREATE surfaces as one of a few raw shapes (all
 * InternalError): record-already-exists, a commit-race read/write conflict when two writers reach
 * commit together, or (defense-in-depth) the leftover secondary-index `already contains`. Narrow by
 * design — invoked ONLY around the single deterministic-id CREATE, so a match can be nothing but the
 * dedup collision (mirrors file-snapshot.ts isSnapshotIdCollision; F-008 — re-raise everything else).
 */
function isWorkItemIdCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/record `?[^`']*`? already exists/i.test(msg) ||
		/failed transaction|read or write conflict|can be retried/i.test(msg) ||
		/work_item_dedup|already contains/i.test(msg)
	);
}

/** A work_item status IN the active dedup window (a pending/processing twin blocks a re-enqueue). */
const ACTIVE_STATUSES: readonly WorkStatus[] = ['pending', 'processing'];

/**
 * Enqueue a `work_item`, deduped within the ACTIVE window by a DETERMINISTIC PRIMARY id (see the
 * block comment above; F-048 structural fix + F-026). The unit is (work_type, session, dedup_scope):
 *
 *   • no active row for the unit          → CREATE it (`enqueued: true`);
 *   • an ACTIVE (pending/processing) twin → dedup, no new row (`enqueued: false`) — this is the
 *     F-048 fix: the id is stable across the claim transition, so a re-enqueue while the twin is
 *     already `processing` is caught (never a 2nd clobbering row);
 *   • only a TERMINAL (done/failed) row   → the prior run is finished, so REUSE that id for a fresh
 *     run (guarded reset back to pending) — this is what the old `dedup_key = <string>id` ELSE-branch
 *     bought us: a completed unit can be re-queued. The reset is GUARDED `WHERE status IN [done,failed]`
 *     so it can NEVER clobber a twin that a racer already reused+claimed (it then falls through to the
 *     dedup branch on the re-read).
 *
 * Returns the unit's deterministic id + whether a NEW run was queued. Idempotent / interrupt-safe:
 * a re-run collides on the id and resolves to the existing row's disposition. Shadow paths — nil/
 * empty payload: an honest empty-object payload row; absent session/project: OMITTED (NONE, §6.1);
 * a non-collision DB error: surfaced with its own name, NEVER swallowed as success (F-008).
 */
export async function enqueue(
	db: Db,
	input: EnqueueInput
): Promise<{ id: string; enqueued: boolean }> {
	const session = input.sessionId ?? '';
	const dedupScope = input.dedupScope ?? '';
	const ridStr = activeWorkItemId(input.workType, session, dedupScope);
	const rid = new StringRecordId(assertRecordId(ridStr));

	// The row body for a CREATE or a terminal-REUSE reset. status is set EXPLICITLY (§6.2) so the
	// dedup_key VALUE + status ASSERT see a concrete "pending"; the record id is the actual guard.
	const priority = input.priority ?? 5;
	const content = omitUndefined({
		work_type: input.workType,
		payload: input.payload,
		priority,
		status: 'pending' as const,
		dedup_scope: dedupScope,
		session: input.sessionId ? link(input.sessionId) : undefined,
		project: input.projectId ? link(input.projectId) : undefined
	});

	// Bounded classify-or-create loop (never spins — resolves in 1–2 passes; the cap only guards a
	// pathological reset↔reuse ping-pong). Each pass: read the unit's row by its deterministic id and
	// act on its disposition (active ⇒ dedup, terminal ⇒ guarded reuse, absent ⇒ CREATE; a lost
	// CREATE/reset race ⇒ re-read).
	for (let attempt = 0; attempt < 4; attempt++) {
		const [rows] = await db.query<[Array<{ status?: unknown }>]>(
			`SELECT status FROM $rid;`,
			{ rid }
		);
		const existing = rows?.[0];

		if (existing) {
			const status = str(existing.status) as WorkStatus;
			if (ACTIVE_STATUSES.includes(status)) {
				// An active twin already holds the unit — dedup (the F-048 fix, incl. the processing twin).
				return { id: ridStr, enqueued: false };
			}
			// Terminal (done/failed): the prior run finished — REUSE the id for a fresh run. GUARDED so a
			// concurrent reuse+claim can't be clobbered: if the row is no longer terminal by the time we
			// write, nothing matches → re-read (it's now active ⇒ dedup).
			const [reset] = await db.query<[Array<{ id: unknown }>]>(
				`UPDATE $rid SET
				   work_type = $content.work_type, payload = $content.payload, priority = $content.priority,
				   status = "pending", dedup_scope = $content.dedup_scope,
				   attempts = 0, claim_token = NONE, claimed_at = NONE, completed_at = NONE, handoff = NONE
				 WHERE status IN ["done", "failed"] RETURN AFTER;`,
				{ rid, content }
			);
			if ((reset?.length ?? 0) > 0) return { id: ridStr, enqueued: true };
			continue; // lost the reuse race — re-read (a racer reused it; likely active now ⇒ dedup)
		}

		// No row yet — CREATE on the deterministic id. A concurrent duplicate collides atomically on
		// the primary key (F-026): the winner returns the row; a loser's collision is caught → re-read.
		try {
			const [created] = await db.query<[Array<{ id: unknown }>]>(
				`CREATE $rid CONTENT $content RETURN AFTER;`,
				{ rid, content }
			);
			if (!created || created.length === 0) {
				// EVERY ERROR HAS A NAME: a CREATE that returns nothing is a real DB anomaly, not success.
				throw new Error(`enqueue: CREATE ${ridStr} returned no row (unexpected DB state).`);
			}
			return { id: ridStr, enqueued: true };
		} catch (err) {
			if (isWorkItemIdCollision(err)) continue; // a racer won the id — re-read its disposition
			throw err; // a non-collision DB error propagates unchanged (named, never swallowed, F-008)
		}
	}

	// Loop exhausted (extreme reuse↔dedup contention): re-read once and report honestly. An active
	// twin ⇒ dedup; anything else ⇒ surface the anomaly (F-008 — never fabricate an enqueued:true).
	const [final] = await db.query<[Array<{ status?: unknown }>]>(`SELECT status FROM $rid;`, { rid });
	if (final?.[0] && ACTIVE_STATUSES.includes(str(final[0].status) as WorkStatus)) {
		return { id: ridStr, enqueued: false };
	}
	throw new Error(`enqueue: could not resolve ${ridStr} after 4 passes (unexpected contention).`);
}

/** Options for {@link claimNext}. */
export interface ClaimOptions {
	/** Bounded retry count on a lost claim race (default 16). */
	maxRetries?: number;
	/**
	 * Per-project in-flight gate (orchestration concurrency.perProject). Project record-id
	 * strings whose in-flight SESSION count is ALREADY at the perProject cap — the claim SELECT
	 * skips a pending CWD-SPAWNING item (work_type ∈ {@link CWD_SPAWNING_WORK_TYPES}: task_run,
	 * review) linked to one of these projects so it is PARKED (left pending) for a later drain,
	 * while cwd-spawning items for other (free) projects stay claimable in the same pass. SCOPE:
	 * only cwd-spawning items are gated — they are the ones launchSession runs in the project's
	 * shared cwd and commits there (the F-007/F-046 git/file race). In-process forks
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
 * CWD-SPAWNING items ({@link CWD_SPAWNING_WORK_TYPES}) linked to a capped project are filtered
 * OUT of the candidate SELECT so they stay parked for a later drain, while other projects' items
 * (and the never-gated in-process forks) remain claimable in the same pass.
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
	// The cwd-spawning work types the per-project gate applies to (single source, bound via $param
	// at the D-016 boundary — never interpolated). Computed once; reused by both gated SELECTs below.
	const cwdSpawnTypes = [...CWD_SPAWNING_WORK_TYPES];
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
				// candidate SELECT skips pending CWD-SPAWNING items (work_type IN $cwdSpawnTypes:
				// task_run, review) linked to a capped project — `NOT (work_type IN $cwdSpawnTypes
				// AND project IN $excluded)` parks a session spawn whose project is at its in-flight
				// cap while leaving in-process forks (memory_review / hire_request, which write
				// nothing to the project cwd) and every other project's cwd-spawning items claimable
				// in the same pass.
				const projFilter =
					excluded.length > 0
						? `AND NOT (work_type IN $cwdSpawnTypes AND project IN $excluded)`
						: '';
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
					excluded.length > 0 ? { t: claimToken, excluded, cwdSpawnTypes } : { t: claimToken }
				);
				claimed = result[result.length - 1] as Array<Record<string, unknown>>;
			} catch (err) {
				// A retryable conflict — back off and retry the bounded loop; else re-throw.
				const msg = (err as Error).message ?? '';
				if (/conflict|can be retried|retry|failed transaction|work_item_dedup|already (contains|exists)/i.test(msg)) {
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
				// too so a queue full of ONLY capped-project cwd-spawning items terminates (returns
				// null) rather than spinning the retry loop.
				const projFilter =
					excluded.length > 0
						? `AND NOT (work_type IN $cwdSpawnTypes AND project IN $excluded)`
						: '';
				const [remaining] = await db.query<[Array<{ c: number }>]>(
					`SELECT count() AS c FROM work_item
					   WHERE status = "pending" AND claim_token IS NONE ${projFilter} GROUP ALL;`,
					excluded.length > 0 ? { excluded, cwdSpawnTypes } : {}
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

// ── F-048 follow-on — release a DEAD session's claimed work so the drain re-drives it ──
//
// gcStale (above) recovers crashed `processing` rows only by AGE (≥1h). But when a session is
// REAPED at boot (reaper.ts) or otherwise marked terminal, its in-flight fork twins — the
// `memory_review` / `review` work_items enqueued WITH that session id (work_item.session, §4.12;
// fast-tier-enqueue path launch.ts → loop.ts enqueueReview) — stay wedged `processing` for up to
// that whole hour. The orchestrator drain then STARVES on the orphaned twin (the exact F-048
// go-live symptom, hand-recovered via DB last time). Releasing them IMMEDIATELY on reap closes
// that gap: reset the twin back to pending + clear its lease (claim_token / claimed_at → NONE) so
// a re-claim re-stamps the daily-cap window and the drain picks it up at once.

/** Outcome of {@link releaseSessionWork} — honest real count (F-008). */
export interface ReleaseResult {
	/** `processing` work_items claimed by the session that were reset to pending + unclaimed. */
	released: number;
}

/**
 * Release every `processing` work_item CLAIMED BY `sessionId` back to pending + unclaimed so the
 * orchestrator drain re-drives it — the F-048 follow-on recovery (see block comment above).
 *
 * CALLER CONTRACT: `sessionId` is ALREADY in a TERMINAL state (failed/done/cancelled) — the caller
 * (reapStaleRuns, or any runtime session-failure path) flips the session BEFORE releasing its work,
 * so we never free work out from under a LIVE session. DEFENSE-IN-DEPTH: the release is additionally
 * scoped to `session.status != "running"` (a record-link traversal on the work_item's session link),
 * so a mis-call against a still-running session frees NOTHING (a no-op, never a steal). A session
 * that no longer exists (link → NONE) is treated as terminal — its orphaned work is safely released.
 *
 * Idempotent (interrupt contract): once the rows are pending (lease cleared) a second call matches
 * nothing and releases zero. F-014-safe: ONE bounded UPDATE — no retry loop, no timers, no spin; a
 * query fault rejects to the caller (the reaper wraps it per-session so it never crashes the server).
 */
export async function releaseSessionWork(db: Db, sessionId: string): Promise<ReleaseResult> {
	const sid = link(sessionId);
	// RETURN BEFORE counts the rows that matched the WHERE (mirrors gcStale's recovery count).
	const [rows] = await db.query<[Array<unknown>]>(
		`UPDATE work_item
		   SET status = "pending", claim_token = NONE, claimed_at = NONE
		   WHERE session = $sid AND status = "processing" AND session.status != "running"
		   RETURN BEFORE;`,
		{ sid }
	);
	return { released: rows?.length ?? 0 };
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
