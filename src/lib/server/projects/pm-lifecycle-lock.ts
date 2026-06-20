// PM-LIFECYCLE-SPEC §PM-LC-2 hardening — the per-project in-flight lock for startProjectLifecycle.
//
// startProjectLifecycle is a REAL-SPEND action: it spawns a PM proposal-generation session and the
// validation panel. With no guard, a double-click or two concurrent submits each spawned a SECOND
// PM session (double model spend) and could double-propose the same fingerprint (proposeTask's dedup
// is a TOCTOU over a NON-unique index — schema.ts:1260). This module serializes ticks PER PROJECT so
// the second concurrent tick gets a BENIGN already-running result, never a raw error, never a second
// session.
//
// It MIRRORS the m0049 create_lock pattern (F-040, create/execute.ts acquireCreateLock/release):
//   • ACQUIRE = a FAIL-CLOSED `CREATE` (SurrealDB errors if the record already exists — last-writer
//     does NOT win; verified for create_lock). The lock id is keyed 1:1 to the project (id-part = the
//     project's local id, bound via type::thing — NEVER interpolated, D-016).
//   • RELEASE = a holder-scoped DELETE so ONLY this tick's `finally` can clear its own lock (a release
//     can never clobber a lock a different tick acquired). Best-effort: a release failure must not mask
//     the result the tick returns/throws (the TTL takeover below is the backstop).
//
// CA-H4 LOW lesson baked in — a SIGKILL between acquire and release must NOT permanently wedge the
// project: `at` records the acquire time, so a STALE lock (older than STALE_LOCK_MS — a crashed holder
// that never released) is taken over by a later tick via an ATOMIC compare-and-swap that only seizes a
// lock whose `at` is older than the cutoff. The lock self-heals; it can never block future ticks forever.

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { assertRecordIdOfTable } from '../db/validate';

/**
 * Stale-lock TTL. A held lock older than this is treated as a crashed holder and may be seized by a
 * later tick (CA-H4 — never wedge). A real tick (proposal session + panel) runs well under this; the
 * margin is generous so we never steal a lock from a slow-but-alive tick.
 */
export const STALE_LOCK_MS = 15 * 60 * 1000; // 15 minutes

/** The local id-part of a `project:<local>` record id (the part after the first colon). */
function projectLocalId(projectId: string): string {
	// projectId is already validated by the caller (assertRecordIdOfTable(..., 'project')); re-validate
	// here as the D-016 chokepoint for THIS module, then take the bound value after the table prefix.
	const validated = assertRecordIdOfTable(projectId, 'project');
	return validated.slice(validated.indexOf(':') + 1);
}

/**
 * True iff `msg` is SurrealDB's "the OTHER racer won this row" signal. There are TWO shapes (verified
 * against the live :8000 server with the exact SCHEMAFULL schema): a SEQUENTIAL loser sees the clean
 * `Database record ... already exists`; a TRUE-PARALLEL loser instead non-deterministically sees the
 * optimistic-transaction layer's `Failed to commit transaction due to a read or write conflict. This
 * transaction can be retried`. BOTH mean "someone else already holds (or is taking) this lock" — neither
 * is an unexpected DB fault, and matching ONLY /already exists/ re-threw the conflict variant (a raw 500
 * and, when both racers committed, the exact double-spend the lock exists to prevent). (PMLH-1 fix.)
 */
function isLockContended(msg: string): boolean {
	return /already exists/i.test(msg) || /read or write conflict/i.test(msg);
}

/**
 * Read the AUTHORITATIVE holder nonce currently persisted on the lock row, or undefined if no row exists.
 * The DB row is the single source of truth for ownership — acquire decides held/benign from THIS, never
 * from the CREATE/UPDATE call's own resolution (the SDK can falsely resolve a CREATE under a shared-socket
 * race; the row is always consistent — PMLH-1 root cause). `$id` is the project-bound id-part (D-016).
 */
async function readHolder(db: Db, idPart: string): Promise<string | undefined> {
	const rows = await db.query<Array<Array<{ holder?: string }>>>(
		`SELECT holder FROM type::thing('pm_lifecycle_lock', $id);`,
		{ id: idPart }
	);
	return rows?.[0]?.[0]?.holder;
}

/** Outcome of an acquire attempt. `held` true ⇒ this tick owns the lock and MUST release it. */
export interface LockAcquisition {
	/** True ⇒ this tick acquired (fresh CREATE or stale takeover) and owns the lock. */
	held: boolean;
	/** The nonce stored on the lock — pass back to releaseLifecycleLock so only THIS tick releases. */
	nonce: string;
	/** When held=false: 'already-running' (a live tick holds it). Present only on a benign refusal. */
	reason?: 'already-running';
}

/**
 * Acquire the per-project lifecycle lock. Atomic + interrupt-safe. The DB row is the SINGLE SOURCE OF
 * TRUTH for who holds the lock — we NEVER trust the CREATE's own resolution (see below) — so:
 *   1. CREATE the lock row keyed 1:1 to the project. SurrealDB's CREATE is fail-closed at the DB layer
 *      (probe: 20/20 races leave exactly ONE row), but on a TRUE-parallel collision the call resolves
 *      three ways the caller must NOT read as ownership: `already exists`, a retryable `read or write
 *      conflict`, OR (SDK quirk under a shared WebSocket connection — instrumented) a FALSE success
 *      where the SDK resolves BOTH racers' CREATE promises while only one row actually committed.
 *   2. READ-BACK VERIFY — unconditionally SELECT the row's stored `holder`. We hold the lock IFF the
 *      persisted holder is OUR nonce. This makes the SDK's CREATE resolution irrelevant: the loser of
 *      any of the three collision shapes reads back the WINNER's nonce ⇒ benign, never a phantom hold.
 *   3. If no row is ours and the existing one is STALE (older than the TTL — a crashed holder), seize it
 *      with an ATOMIC compare-and-swap UPDATE (CA-H4 — never wedge), then read back again to confirm.
 *   4. Otherwise a LIVE tick holds it ⇒ benign { held:false, reason:'already-running' } (no second spend).
 *
 * @throws re-throws any UNEXPECTED DB error (NOT a contended "already exists"/"read or write conflict")
 *         with its own name — a real DB fault must surface, never be masked as a benign refusal.
 */
export async function acquireLifecycleLock(db: Db, projectId: string): Promise<LockAcquisition> {
	const idPart = projectLocalId(projectId);
	const nonce = randomUUID();

	// 1. Attempt the CREATE. A contended outcome (already-exists OR the retryable transaction-conflict) is
	//    EXPECTED under a race and is absorbed — we decide ownership from the read-back, not from this call.
	//    A non-contended error is a real DB fault and surfaces with its own name (F-008).
	try {
		await db.query(
			`CREATE type::thing('pm_lifecycle_lock', $id) CONTENT { holder: $holder, at: time::now() } RETURN NONE;`,
			{ id: idPart, holder: nonce }
		);
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		if (!isLockContended(msg)) throw err;
	}

	// 2. READ-BACK VERIFY: the persisted holder is authoritative. If it is our nonce, the CREATE was really
	//    ours and we hold the lock — regardless of whether the SDK reported success or a (false) error.
	const holder = await readHolder(db, idPart);
	if (holder === nonce) return { held: true, nonce };

	// 3. A foreign lock row exists. Try an ATOMIC stale takeover: seize ONLY if the holder is dead
	//    (at < cutoff). The WHERE makes this a compare-and-swap — two racers cannot both win (SurrealDB
	//    applies the UPDATE atomically; the winner moves `at` forward so the other's WHERE no longer matches).
	const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
	try {
		await db.query(
			`UPDATE type::thing('pm_lifecycle_lock', $id) SET holder = $holder, at = time::now()
			 WHERE at < $staleBefore RETURN NONE;`,
			{ id: idPart, holder: nonce, staleBefore }
		);
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		// Parallel takeovers of the SAME stale lock can collide; the loser sees `read or write conflict` —
		// the other racer seized it first. Absorb it; the read-back below decides ownership honestly.
		if (!/read or write conflict/i.test(msg)) throw err;
	}
	// READ-BACK VERIFY the takeover too (never trust the UPDATE's resolution under the same SDK quirk).
	if ((await readHolder(db, idPart)) === nonce) return { held: true, nonce };

	// 4. A LIVE tick holds the lock — benign refusal (no second session, no double spend).
	return { held: false, nonce, reason: 'already-running' };
}

/**
 * Release the lifecycle lock — ONLY if THIS tick still holds it (holder nonce match), so a release can
 * never clear a lock a different tick acquired (e.g. after a stale takeover by a later tick). Best-effort:
 * swallow any failure (the STALE_LOCK_MS takeover is the backstop) so a release error never masks the
 * result the tick is returning/throwing. Idempotent — DELETE of an absent/foreign-held row is a no-op.
 */
export async function releaseLifecycleLock(db: Db, projectId: string, nonce: string): Promise<void> {
	try {
		const idPart = projectLocalId(projectId);
		await db.query(`DELETE type::thing('pm_lifecycle_lock', $id) WHERE holder = $holder;`, {
			id: idPart,
			holder: nonce
		});
	} catch {
		// Swallow — never mask the tick's real result; the TTL/stale-takeover is the backstop.
	}
}
