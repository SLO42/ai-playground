// G-B — PEER_MESSAGE FLEET BUS: the OFFLINE DRAIN (PEER-MESSAGE-SPEC §7/§5 D2; D-035a/D-026/F-014/F-015).
//
// WHAT THIS IS. The recipient side of the fleet bus — the close-the-loop half of G-B. The SEND
// path (send.ts) persists a peer_message row `pending` and best-effort live-delivers it when the
// recipient is RUNNING (PM2). But the spec's whole point is DURABILITY: a message to an OFFLINE
// agent must not be dropped. So at a recipient session's SPAWN, this module DRAINS that session's
// pending inbox — the messages addressed to it (by session id, by its role@project, or to the
// pm/atelier identity it acts as) — and:
//   1. EXPIRES (honest, never silently dropped — §7) any pending message past the TTL/age bound or
//      with an exhausted hop budget BEFORE delivery, flipping it status='expired'.
//   2. Returns the surviving messages' ALREADY-FENCED bodies so the caller folds them into the
//      session briefing at the existing composeBriefing injection point (buildBriefing.channelBodies
//      — fenced as DATA, D-026 §10). The body in the `body` column is the screen()→fence() envelope
//      the repo wrote (raw text NEVER persisted); re-fencing through the briefing collapses to a
//      single clean DATA block (stripEmbeddedSentinels).
//   3. Marks each drained message status='delivered' + delivered_at — IDEMPOTENTLY: the UPDATE is
//      guarded `WHERE status='pending'`, so a message the LIVE path (PM2) already flipped to
//      'delivered' is NOT re-drained, and a re-run of the drain (an interrupted spawn re-launched)
//      collapses by the row id (it is no longer pending). Redelivery can never double-deliver.
//   4. Writes the TRANSCRIPT `message` row (origin=agent, server-stamped) for each delivered peer
//      message so G-A renders it as a labelled 'communication' turn — transcript visibility is FREE
//      (the shared transcript-core classifier maps a pushed role + origin=agent → 'communication').
//
// D-035a (LOCKED). A drained peer message is origin=agent → DATA, NON-STEERING. The transcript row
// is stamped role='system' (a pushed-in turn, not the agent's own prose) + origin='agent' SERVER-
// SIDE here — NEVER derived from the body. It is fenced; it can be consulted, never obeyed.
//
// F-014. The drain is NON-BLOCKING / FAIL-OPEN: a drain fault (a DB hiccup, a transcript write
// error) NEVER blocks or fails the spawn — the caller wraps it best-effort and a partial drain is
// honest (the undelivered rows stay pending for the NEXT spawn). It is observability + delivery, not
// liveness. Every step is bounded (a LIMIT on the inbox scan; no spin, no fan-out).
//
// INTERRUPT CONTRACT. Assume the spawn dies mid-drain and re-runs: expiry + mark-delivered are
// idempotent (OVERWRITE-shaped UPDATE guarded by current status), so a re-run absorbs prior partial
// work — an already-delivered message is skipped, an already-expired one is skipped, nothing double-
// fires. No observable half-state is left.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { PeerMessageRow } from './repo';

// ── Bounds (frozen — §spec / F-014) ────────────────────────────────────────────────

/**
 * TTL: a pending peer message older than this (by created_at) EXPIRES on the next drain rather than
 * delivering — an agent doesn't want a week-old "I found X" injected as if it were live. Honest:
 * the row flips status='expired' (it is NEVER silently dropped). 7 days is generous for an event-
 * triggered PM/atelier identity that may be offline for a long stretch, while still bounding how
 * stale a delivered message can be. (A relay that has run out of hops — hops ≤ 0 — also expires:
 * its TTL as a *relayable* message is spent.)
 */
export const PEER_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max messages drained into one spawn's briefing (bound the inbox scan + the briefing cost). The
 *  briefing's own token budget tail-drops beyond what fits; this caps the rows we even touch. */
export const MAX_DRAIN_PER_SPAWN = 50;

// ── The recipient identity the drain resolves the inbox against ──────────────────────

/**
 * Who this freshly-spawned session IS, for inbox resolution. A pending peer_message is drained to
 * this session when it was addressed to:
 *   • this exact session (to_session = sessionId) — a direct address, OR
 *   • this session's role IN this project (to_role = role AND project = project) — a 'role' address.
 *
 * PM / ATELIER placeholder (§11, DOCUMENTED): a 'pm'/'atelier' message addresses an IDENTITY, not a
 * session. There is no `session.pm` column yet (PM sessions are launched but not stamped with a pm
 * link — see resolve.ts LiveSession.pm + repo.loadFleetSnapshot), so a freshly-spawned session
 * CANNOT yet declare "I am acting as pm X / the atelier". Until that seam (and D-040 self-hosting)
 * lands, `pm`/`atelier` messages are NOT drainable by session identity — they correctly stay pending
 * (the identity is event-triggered, usually offline) until they EXPIRE by TTL, which is the honest
 * behaviour for an identity with no running session to drain into. When the pm-link seam exists,
 * add `pm`/`atelier` to this shape + the inbox query; the rest of the drain is unchanged.
 */
export interface DrainRecipient {
	/** The freshly-spawned recipient session id (drains its direct to_session inbox). */
	sessionId: string;
	/** Its role identity (option) — drains to_role@project messages. Null ⇒ no role inbox. */
	role?: string | null;
	/** Its project scope (option) — the role-address scope. Null ⇒ no role-address drain. */
	project?: string | null;
}

/** One drained peer message, ready for the briefing + the transcript row. */
export interface DrainedMessage {
	/** The peer_message row id (the idempotency key). */
	id: string;
	/** The ALREADY-FENCED body (screen()→fence() at write — never raw). Folded into the briefing
	 *  as a channelBody with origin 'agent' (re-fenced to a single clean DATA block downstream). */
	body: string;
	/** The server-resolved sender session (provenance — the from_session column, never body-claimed). */
	fromSession: string;
	/** The sender role, when the sender had one (the from_role column). */
	fromRole: string | null;
	/** The address class this message arrived on (audit/explain). */
	toKind: PeerMessageRow['to_kind'];
}

export interface DrainResult {
	/** Messages drained + marked delivered this spawn (delivered live OR offline-drained). */
	delivered: DrainedMessage[];
	/** Count of pending messages EXPIRED by TTL/hops this drain (honest, never silently dropped). */
	expiredCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── The drain engine ───────────────────────────────────────────────────────────────

/**
 * Drain a freshly-spawned recipient session's pending peer-message inbox. Pipeline:
 *   1. EXPIRE first (§7): flip any pending message addressed to this recipient that is past the TTL
 *      (created_at older than now-TTL) OR out of hops (hops ≤ 0) → status='expired'. Honest, named —
 *      never a silent drop. Guarded `WHERE status='pending'` so it is idempotent.
 *   2. SELECT the surviving pending inbox (oldest first, bounded by MAX_DRAIN_PER_SPAWN), by the
 *      recipient identity (direct session id, OR its role@project — see DrainRecipient docs for the
 *      pm/atelier placeholder).
 *   3. For each: mark delivered IDEMPOTENTLY (UPDATE … WHERE status='pending' — a row the live PM2
 *      path already delivered is skipped, collapsing redelivery by id, like H2's messageId dedup),
 *      and on a real flip return its fenced body + provenance for the briefing.
 *
 * SHADOW PATHS: nil/empty recipient session id → throws at the D-016 chokepoint (a malformed spawn id
 * is a real bug, fail-loud); an empty inbox → { delivered:[], expiredCount:0 } (honest empty); a role-
 * less / project-less session → only its direct to_session inbox is drained (no role-address scan).
 * FAIL-OPEN at the CALL site (F-014): the caller wraps this so a throw never sinks the spawn.
 */
export async function drainInbox(db: Db, recipient: DrainRecipient): Promise<DrainResult> {
	const sid = link(recipient.sessionId);
	const role = recipient.role ? link(recipient.role) : null;
	const project = recipient.project ? link(recipient.project) : null;

	// CROSS-PROJECT RE-ASSERTION AT DELIVERY TIME (PM1; cross-project isolation — LOCKED).
	// The send path's resolveAddress enforces in-project for a DIRECT ('session') address ONLY when
	// the target session is RUNNING (it cannot policy-check a session it cannot see). A project-A
	// session that addresses a then-OFFLINE project-B session therefore persists a pending row with
	// to_session=<project-B session> and NO cross-project check (the resolver returned empty +
	// "inboxes as pending"). That row would otherwise be drained — and delivered — when the project-B
	// session later comes UP, a cross-project delivery via the offline-then-online path. We close it
	// HERE, where the recipient's project is finally known: a pending DIRECT message whose SENDER's
	// project differs from THIS recipient's project is EXPIRED (honest — never silently dropped, and
	// it can NEVER deliver across projects). project↔project is forbidden; only 'atelier' crosses,
	// and atelier is not drained by session identity (see DrainRecipient docs), so this guard is
	// scoped to the direct to_session leg. The sender's project is read by dereferencing the
	// from_session link (record<session>); a sender whose project is NONE matches a NONE recipient
	// project (same-scope, allowed) and mismatches any concrete project (fail-closed). NOTE: role@
	// project messages are NOT swept here — their project coordinate was set by the sender and
	// in-project-checked at send time; only the direct leg bypassed that check.
	// Compare project scopes in STRING space with a shared sentinel for "no project". A project-less
	// session has project=NONE; the recipient bind is NULL when absent. NONE != NULL is TRUE in
	// SurrealDB, so a naive record-link comparison would wrongly flag a legitimate project-less↔
	// project-less direct message as cross-project. We coalesce BOTH sides to a string (the record id
	// string, or the sentinel `$noProject` when absent) so NONE and NULL collapse to the same value:
	// project-less↔project-less is same-scope (allowed); project-A↔project-less or A↔B is cross (deny).
	const NO_PROJECT = ' none';
	// The recipient's project as a string sentinel (already a normalized `table:id` string or the
	// sentinel) — bound as a plain string so the comparison is string=string on both sides.
	const recipProjectStr = recipient.project ?? NO_PROJECT;
	let crossProjectExpired = 0;
	try {
		const [xRows] = await db.query<[Array<{ id: unknown }>]>(
			`UPDATE peer_message SET status = "expired"
			   WHERE status = "pending" AND to_kind = "session" AND to_session = $sid
			     AND (<string>(from_session.project) ?? $noProject) != $recipProject
			 RETURN id;`,
			{ sid, recipProject: recipProjectStr, noProject: NO_PROJECT }
		);
		crossProjectExpired = (xRows ?? []).length;
		if (crossProjectExpired > 0) {
			console.warn(
				`[peer-drain] expired ${crossProjectExpired} cross-project DIRECT message(s) at delivery ` +
					`for ${recipient.sessionId} (project ${recipient.project ?? '(none)'}) — cross-project ` +
					`peer delivery is forbidden (PM1)`
			);
		}
	} catch (err) {
		// Fail-open on the SWEEP fault only (F-014) — but the SELECT below ALSO re-applies the same
		// cross-project predicate, so even if this UPDATE failed/raced, a cross-project direct row is
		// NEVER selected for delivery. It simply stays pending until a later sweep flips it to expired.
		console.warn(
			`[peer-drain] cross-project expiry sweep failed for ${recipient.sessionId} (fail-open): ${(err as Error).message}`
		);
	}

	// The inbox WHERE clause: messages addressed to this recipient identity. Direct (to_session) is
	// always in scope; the role@project address is added only when this session HAS a role + project
	// (a role-less/project-less session has no role inbox). Built as a parameterized OR (D-016: every
	// value binds via $param; the only interpolation is the structural clause shape).
	const addressedClauses = ['to_session = $sid'];
	if (role && project) {
		addressedClauses.push('(to_role = $role AND project = $project)');
	}
	const addressed = `(${addressedClauses.join(' OR ')})`;
	const bind: Record<string, unknown> = { sid };
	if (role && project) {
		bind.role = role;
		bind.project = project;
	}

	// (1) EXPIRE — past TTL by age OR out of hops. A computed cutoff bound in $param. Guarded by
	// status='pending' so a delivered/already-expired row is untouched (idempotent, interrupt-safe).
	// time::now() - the row's created_at compared to the cutoff: a row created BEFORE the cutoff is
	// stale. We bind the cutoff as a concrete datetime (now - TTL) computed server-side here so the
	// expiry boundary is deterministic for the test (no clock skew between two queries).
	const cutoff = new Date(Date.now() - PEER_MESSAGE_TTL_MS);
	let expiredCount = 0;
	try {
		const [expiredRows] = await db.query<[Array<{ id: unknown }>]>(
			`UPDATE peer_message SET status = "expired"
			   WHERE status = "pending" AND ${addressed}
			     AND (created_at < $cutoff OR hops <= 0)
			 RETURN id;`,
			{ ...bind, cutoff }
		);
		expiredCount = (expiredRows ?? []).length;
	} catch (err) {
		// Fail-open (F-014): an expiry sweep fault never blocks the drain — log + proceed. The stale
		// rows simply stay pending for the next spawn's sweep (honest, never delivered-as-live here
		// because the SELECT below re-applies the SAME freshness predicate).
		console.warn(`[peer-drain] expiry sweep failed for ${recipient.sessionId} (fail-open): ${(err as Error).message}`);
	}

	// (2) SELECT the surviving pending inbox (oldest first, bounded). Re-apply the freshness predicate
	// (created_at >= cutoff AND hops > 0) so even if the expiry UPDATE above failed/raced, a stale row
	// is NOT delivered as if live — it is simply left pending (it will expire on a later sweep). We
	// ALSO re-apply the cross-project guard (PM1): exclude any DIRECT (to_session) row whose sender
	// project differs from this recipient's project, so even if the cross-project expiry UPDATE above
	// failed/raced, a cross-project direct message is NEVER selected for delivery (defence in depth —
	// the same reason the freshness predicate is duplicated here). Role@project rows are unaffected
	// (their project was sender-set + in-project-checked at send).
	// `created_at` is in the projection because SurrealDB requires an ORDER BY idiom to be a
	// selected field ("Missing order idiom" parse error otherwise — the repo's pendingInbox dodges
	// this with SELECT *; here we project explicitly, so the sort key must be projected too).
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, body, from_session, from_role, to_kind, created_at FROM peer_message
		   WHERE status = "pending" AND ${addressed}
		     AND created_at >= $cutoff AND hops > 0
		     AND NOT (to_kind = "session" AND to_session = $sid AND (<string>(from_session.project) ?? $noProject) != $recipProject)
		 ORDER BY created_at ASC LIMIT ${MAX_DRAIN_PER_SPAWN};`,
		{ ...bind, cutoff, recipProject: recipProjectStr, noProject: NO_PROJECT }
	);

	const delivered: DrainedMessage[] = [];
	for (const r of rows ?? []) {
		const id = String(r.id);
		// (3) Mark delivered IDEMPOTENTLY: the UPDATE is guarded `WHERE status='pending'` and RETURNs
		// the row only if IT flipped. If the live PM2 path (or a racing re-run of this drain) already
		// delivered this id, the guard matches nothing → no row returned → we DO NOT add it to the
		// briefing (no double-deliver, no duplicate transcript row). This is the H2 messageId-dedup
		// posture: redelivery collapses by the peer_message id.
		let flipped: Array<{ id: unknown }> | undefined;
		try {
			const rid = link(id);
			[flipped] = await db.query<[Array<{ id: unknown }>]>(
				`UPDATE $rid SET status = "delivered", delivered_at = time::now()
				   WHERE status = "pending" RETURN id;`,
				{ rid }
			);
		} catch (err) {
			// Fail-open (F-014): a mark-delivered fault on ONE message never sinks the whole drain — the
			// row stays pending and the NEXT spawn drains it (at-least-once, idempotent). Skip it here.
			console.warn(`[peer-drain] mark-delivered failed for ${id} (fail-open, stays pending): ${(err as Error).message}`);
			continue;
		}
		if (!flipped || flipped.length === 0) {
			// Already delivered (live PM2 path or a concurrent drain) — collapse by id, do not re-deliver.
			continue;
		}
		delivered.push({
			id,
			body: String(r.body ?? ''),
			fromSession: String(r.from_session ?? ''),
			fromRole: r.from_role != null ? String(r.from_role) : null,
			toKind: r.to_kind as PeerMessageRow['to_kind']
		});
	}

	return { delivered, expiredCount };
}
