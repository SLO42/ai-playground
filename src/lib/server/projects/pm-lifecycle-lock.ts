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
 * Acquire the per-project lifecycle lock. Atomic + interrupt-safe:
 *   1. FAIL-CLOSED CREATE — succeeds only if no lock row exists ⇒ we hold a FRESH lock.
 *   2. On "already exists": an ATOMIC compare-and-swap UPDATE that seizes the lock ONLY if its `at` is
 *      older than the stale cutoff (a crashed holder). If it returns our row, we took over a STALE lock.
 *   3. Otherwise a LIVE tick holds it ⇒ benign { held:false, reason:'already-running' } (no second spend).
 *
 * @throws re-throws any UNEXPECTED DB error (not the benign "already exists") with its own name — a DB
 *         fault must surface, never be masked as a benign refusal.
 */
export async function acquireLifecycleLock(db: Db, projectId: string): Promise<LockAcquisition> {
	const idPart = projectLocalId(projectId);
	const nonce = randomUUID();
	try {
		await db.query(
			`CREATE type::thing('pm_lifecycle_lock', $id) CONTENT { holder: $holder, at: time::now() } RETURN NONE;`,
			{ id: idPart, holder: nonce }
		);
		return { held: true, nonce };
	} catch (err) {
		const msg = String((err as Error)?.message ?? err);
		if (!/already exists/i.test(msg)) {
			// An unexpected DB error must surface with its own name — never masked as a benign refusal.
			throw err;
		}
	}

	// A lock row exists. Try an ATOMIC stale takeover: seize ONLY if the holder is dead (at < cutoff).
	// The WHERE makes this a compare-and-swap — two racers cannot both win (SurrealDB applies the UPDATE
	// atomically; the one whose UPDATE lands first moves `at` forward so the other's WHERE no longer matches).
	const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
	const rows = await db.query<Array<Array<{ holder?: string }>>>(
		`UPDATE type::thing('pm_lifecycle_lock', $id) SET holder = $holder, at = time::now()
		 WHERE at < $staleBefore RETURN AFTER;`,
		{ id: idPart, holder: nonce, staleBefore }
	);
	const seized = rows?.[0]?.[0];
	if (seized && seized.holder === nonce) {
		return { held: true, nonce };
	}

	// A LIVE tick holds the lock — benign refusal (no second session, no double spend).
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
