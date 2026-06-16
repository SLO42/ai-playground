// G-B — PEER_MESSAGE FLEET BUS: the SEND engine (PEER-MESSAGE-SPEC §2/§11; D-035a/D-026/D-036).
//
// WHAT THIS IS. The server-side brain the loopback /api/peer/send endpoint calls when a GRANTED
// agent invokes the `peer_send` tool. It is the ONE place that turns a tool-call into a persisted,
// fenced, policy-checked, bounded peer message — and (when a recipient is live) a non-steering
// delivery into that session. It is deliberately a PURE-ish orchestration over injected deps
// (db reads via repo/resolve, the live-delivery fn, the bus) so the policy + bounds are unit-
// testable against a real SurrealDB without a running fleet.
//
// THE LOCKED INVARIANTS (D-035a — do NOT weaken):
//   • origin = agent, ALWAYS. A peer message is DATA, NON-STEERING. The repo fences the body
//     (screen → fence{source:'channel'}); the live delivery is channel.interject with NO operator
//     token + viaControlEndpoint:false → the channel stamps origin=agent and steer=false by its
//     own fail-closed rule. Nothing here can elevate a peer message to a command.
//   • The SENDER is resolved SERVER-SIDE from the authenticated session context — NEVER from the
//     tool-call body. The endpoint hands us a `senderSessionId` it read from the server-controlled
//     spawn env (ATELIER_SESSION_ID, pinned at spawn — an agent cannot set its own env, same trust
//     basis as CLAUDE_CONFIG_DIR). We READ the live `session` row for that id to learn the sender's
//     role + project; a body that CLAIMS a different sender/origin is inert (the claim never reaches
//     the from_session/from_role columns — those come from the row we read).
//
// BOUNDS (abuse resistance — §spec; mirrors the recall-budget posture: a fail-closed cap that a
// later mutation can't relax into fail-open):
//   • per-session SEND BUDGET — a session may send at most MAX_SENDS_PER_SESSION peer messages in
//     its lifetime (counted live from persisted rows); exhaustion → a NAMED honest deny, never a
//     silent drop.
//   • MAX_RECIPIENTS — a single send fans out to at most MAX_RECIPIENTS_PER_SEND live sessions
//     (a 'role' address with a huge running cohort can't be a broadcast amplifier).
//   • HOPS — every send requires hops ≥ 1; a relay decrements; hops 0 is TERMINAL (it cannot be
//     re-sent). This is what prevents an A→B→A ping-pong from looping forever.
//
// CROSS-PROJECT ISOLATION is enforced by resolveAddress (CrossProjectError) — a project-A session
// addressing project-B is a NAMED error, fail-closed, surfaced to the agent. Only 'atelier' crosses.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	resolveAddress,
	type PeerAddress,
	type PeerSender,
	type ToKind,
	PeerAddressError,
	CrossProjectError
} from './resolve';
import {
	sendPeerMessage,
	loadFleetSnapshot,
	type PeerMessageRow,
	PeerRepoError,
	IdempotencyError,
	SendBudgetError
} from './repo';

// ── Named errors — every error has a name (what triggers it is in the message) ──

// SendBudgetError now lives in repo.ts (the budget is enforced ATOMICALLY at the write — count and
// insert in one transaction; PM2 finding c). It is re-exported below so the endpoint mapping (→429)
// and existing importers are unchanged.

/** hops < 1 at ingress, or a relay of a hops-0 (terminal) message. Prevents A→B→A ping-pong. */
export class HopsExhaustedError extends Error {
	override readonly name = 'HopsExhaustedError';
}

/** The authenticated sender session does not exist / is not running. Cannot stamp a sender. */
export class SenderResolutionError extends Error {
	override readonly name = 'SenderResolutionError';
}

// ── Bounds (frozen caps — a fail-closed cap a later mutation must not relax) ──────

/** A session's LIFETIME peer-send budget. Counted live from persisted from_session rows. */
export const MAX_SENDS_PER_SESSION = 50;
/** Max live recipient sessions a single send delivers to (broadcast-amplifier guard). */
export const MAX_RECIPIENTS_PER_SEND = 8;
/** The default relay TTL when a caller omits hops. */
export const DEFAULT_HOPS = 1;
/** The largest hops a caller may request (a generous relay depth; bounds runaway relays). */
export const MAX_HOPS = 4;

// ── The live-delivery seam (injected — the channel push, fail-open at the call site) ──

/**
 * Deliver one already-FENCED peer body INTO a running recipient session as a NON-STEERING
 * agent-origin turn. The production impl wraps channel.interject({ viaControlEndpoint:false }) —
 * the channel stamps origin=agent + steer=false by its OWN fail-closed rule (it never trusts a
 * body, and there is no operator token on this path). Returns true iff delivery was acknowledged.
 * MUST NOT throw — a delivery fault is fail-OPEN (F-014): the row already persisted as pending and
 * the recipient drains it on its next inbox read; a live push failure never fails the whole send.
 */
export type DeliverLive = (recipientSessionId: string, fencedBody: string) => Promise<boolean>;

/** Publish a fleet-bus event onto the ONE events bus (live transcript visibility is FREE via G-A
 *  once the row persists; this is the extra peer_message routing signal for the bus/SSE). */
export type PublishBus = (ev: {
	type: 'notification';
	topic: string;
	key: string;
	data: Record<string, unknown>;
}) => void;

export interface SendPeerDeps {
	db: Db;
	/** Live delivery into a running recipient (fail-open). Omit ⇒ no live push (rows still persist). */
	deliver?: DeliverLive;
	/** Bus publish for the routing signal (best-effort). Omit ⇒ no publish. */
	publish?: PublishBus;
}

// ── The send input (the endpoint hands us the SERVER-RESOLVED sender + the agent's address/body) ──

export interface SendPeerInput {
	/** The authenticated sender session id, resolved SERVER-SIDE (env, never the body). */
	senderSessionId: string;
	/** The agent-controlled destination (kind + the coordinate for that kind). */
	address: PeerAddress;
	/** The RAW agent text — screened+fenced by the repo before it ever lands (never persisted raw). */
	body: string;
	/** Relay TTL (default DEFAULT_HOPS). Must be ≥ 1 and ≤ MAX_HOPS. */
	hops?: number;
	/** Ingress idempotency token → dedup_key (a retried send collides rather than double-sending). */
	clientKey?: string;
}

export interface SendPeerResult {
	/** The persisted peer_message row id. */
	messageId: string;
	/** The server-stamped sender (from the session row — NEVER the body). */
	from: { session: string; role: string | null; project: string | null };
	/** The resolved destination class. */
	toKind: ToKind;
	/** Concrete live recipient session ids the message resolved to (may be empty → inbox/pending). */
	recipients: string[];
	/** Recipients the live push actually reached (subset of `recipients`; empty when none were up). */
	deliveredTo: string[];
	/** Whether the body was quarantined at screen-time (stored redacted, status='quarantined'). */
	quarantined: boolean;
	/** Honest note when no live recipient (offline pm/role/atelier, or pending inbox). */
	note: string | null;
}

// ── Sender resolution (SERVER-SIDE — D-035a) ──────────────────────────────────────

interface SenderRow {
	session: string;
	role: string | null;
	project: string | null;
	kind: string;
	status: string;
}

/**
 * Read the live `session` row for the SERVER-supplied sender id to learn its role + project. The
 * sender identity is NEVER taken from the tool body (D-035a) — it is THIS row. A missing or non-
 * running session is a NAMED SenderResolutionError (fail-closed: we will not stamp a peer message
 * with an unverifiable sender). A malformed id trips the D-016 chokepoint, re-surfaced as the same
 * named error so the boundary fails loud, not with a raw IdentifierError.
 */
async function resolveSender(db: Db, senderSessionId: string): Promise<SenderRow> {
	let rid: StringRecordId;
	try {
		rid = new StringRecordId(assertRecordId(senderSessionId));
	} catch {
		throw new SenderResolutionError(
			`peer send: sender session id is not a valid record id: ${JSON.stringify(senderSessionId)}`
		);
	}
	type SessRow = { id: unknown; role?: unknown; project?: unknown; kind?: unknown; status?: unknown };
	const [rows] = await db.query<[SessRow | SessRow[] | null]>(
		`SELECT id, role, project, kind, status FROM ONLY $rid;`,
		{ rid }
	);
	const row: SessRow | undefined = Array.isArray(rows) ? rows[0] : rows ?? undefined;
	if (!row) {
		throw new SenderResolutionError(
			`peer send: sender session ${senderSessionId} not found (cannot stamp sender)`
		);
	}
	const status = row.status != null ? String(row.status) : '';
	if (status !== 'running') {
		throw new SenderResolutionError(
			`peer send: sender session ${senderSessionId} is not running (status=${status || 'unknown'}) — refused`
		);
	}
	return {
		session: String(row.id),
		role: row.role != null ? String(row.role) : null,
		project: row.project != null ? String(row.project) : null,
		kind: row.kind != null ? String(row.kind) : '',
		status
	};
}

// ── The send engine ───────────────────────────────────────────────────────────────

/**
 * Send one peer message end-to-end (PEER-MESSAGE-SPEC). The ordered pipeline:
 *   1. Resolve the SENDER server-side (D-035a) — read the live session row; fail-closed if absent.
 *   2. Bounds: hops ∈ [1, MAX_HOPS] (HopsExhaustedError otherwise); per-session lifetime budget
 *      (SendBudgetError on exhaustion).
 *   3. Resolve the DESTINATION + enforce the recipient policy (resolveAddress over the live fleet
 *      snapshot): cross-project DIRECT is a CrossProjectError (only atelier crosses). Cap the live
 *      recipient fan-out at MAX_RECIPIENTS_PER_SEND.
 *   4. Persist the row (sendPeerMessage) — the body is screened+fenced there (raw never lands); a
 *      quarantine hit stores status='quarantined' (fail-closed, D-026).
 *   5. Best-effort LIVE delivery into each up recipient (fail-OPEN, F-014) + a bus signal.
 *
 * SHADOW PATHS: nil/empty body → the repo fences an empty/quarantined-empty body (harmless); zero
 * live recipients → an honest pending inbox (note set, recipients=[]), NOT an error; a delivery
 * fault → fail-open (the row is pending, drained later). EVERY error is named (above + the resolve/
 * repo named errors propagate verbatim so the endpoint can map each to an honest status).
 */
export async function sendPeer(input: SendPeerInput, deps: SendPeerDeps): Promise<SendPeerResult> {
	const { db } = deps;

	// (1) SERVER-SIDE sender resolution — the identity is the live row, never the body (D-035a).
	const sender = await resolveSender(db, input.senderSessionId);

	// (2) Bounds — hops first (cheap, no I/O), then the per-session budget meter.
	const requestedHops = Number.isFinite(input.hops as number)
		? Math.floor(input.hops as number)
		: DEFAULT_HOPS;
	if (requestedHops < 1) {
		throw new HopsExhaustedError(
			`peer send: hops must be ≥ 1 (got ${input.hops}); a hops-0 message is terminal and cannot be sent`
		);
	}
	if (requestedHops > MAX_HOPS) {
		throw new HopsExhaustedError(
			`peer send: hops ${requestedHops} exceeds the relay cap MAX_HOPS=${MAX_HOPS}`
		);
	}
	// The per-session SEND BUDGET is NOT pre-checked here anymore (PM2 finding c): a separate
	// count-then-create is a TOCTOU race — N concurrent sends each read "under budget" then all
	// insert, blowing past MAX_SENDS_PER_SESSION. The cap is now enforced ATOMICALLY inside the
	// persist (sendPeerMessage with max_sends: count + CREATE in ONE transaction), which throws
	// SendBudgetError and rolls back when at the cap. So the (N+1)th concurrent send is refused even
	// under contention. (We pass MAX_SENDS_PER_SESSION below.)

	// (3) Resolve the destination + enforce the recipient policy over the LIVE fleet snapshot. A
	// cross-project DIRECT flow throws CrossProjectError HERE (fail-closed) before any write. The
	// sender's OWN role/project (from the row, not the body) is what gates isolation.
	const senderCtx: PeerSender = {
		session: sender.session,
		role: sender.role,
		project: sender.project
	};
	const fleet = await loadFleetSnapshot(db);
	const resolution = resolveAddress(input.address, senderCtx, fleet);
	// Broadcast-amplifier guard: cap the LIVE fan-out. The persisted row is single; only the live
	// push set is capped (the rest still inbox as pending and drain individually).
	const recipients = resolution.sessions.slice(0, MAX_RECIPIENTS_PER_SEND);

	// (4) Persist — the repo screens+fences the body (raw never lands) and stores quarantined-fail-
	// closed when screen trips. We pass the SERVER-resolved sender coordinates + the resolved
	// destination coordinates (NOT the agent's raw address — the resolver already validated them).
	const persisted: PeerMessageRow = await sendPeerMessage(db, {
		from_session: sender.session,
		...(sender.role ? { from_role: sender.role } : {}),
		to_kind: resolution.kind,
		...destinationCoords(input.address),
		body: input.body,
		hops: requestedHops,
		...(input.clientKey ? { client_key: input.clientKey } : {}),
		// Atomic budget gate (PM2 finding c): the count+insert run in ONE transaction inside the repo.
		max_sends: MAX_SENDS_PER_SESSION
	});

	// (5) Best-effort LIVE delivery into each up recipient — fail-OPEN (F-014). The body delivered
	// is the SAME screened+fenced envelope that persisted (never the raw text). A delivery throw or
	// a false ack is swallowed: the row is pending and the recipient drains it later.
	const deliveredTo: string[] = [];
	if (deps.deliver && recipients.length > 0 && persisted.status !== 'quarantined') {
		for (const rid of recipients) {
			try {
				const ok = await deps.deliver(rid, persisted.body);
				if (ok) deliveredTo.push(rid);
			} catch {
				// fail-open: a live push fault never fails the send (the row is pending).
			}
		}
		// Mark delivered ONLY when at least one live push was acknowledged (honest status).
		if (deliveredTo.length > 0) {
			try {
				await markDelivered(db, persisted.id);
			} catch {
				// fail-open: a status flip fault never fails the send (drain still sees it pending).
			}
		}
	}

	// Bus signal (best-effort): a fleet-bus routing notification keyed by the sender session so the
	// SSE layer can surface "message sent". Transcript visibility of the DELIVERED turn is FREE via
	// G-A (the live push persisted a `message` row); this is the extra send-side signal only.
	try {
		deps.publish?.({
			type: 'notification',
			topic: sender.session,
			key: persisted.id,
			data: {
				kind: 'peer_message_sent',
				messageId: persisted.id,
				toKind: resolution.kind,
				recipients: recipients.length,
				deliveredTo: deliveredTo.length,
				quarantined: persisted.status === 'quarantined'
			}
		});
	} catch {
		/* publish is best-effort — never fails the send */
	}

	return {
		messageId: persisted.id,
		from: { session: sender.session, role: sender.role, project: sender.project },
		toKind: resolution.kind,
		recipients,
		deliveredTo,
		quarantined: persisted.status === 'quarantined',
		note: resolution.note
	};
}

/** Map the agent's address coordinates → the repo's destination columns (only the ones the kind
 *  uses; the resolver already validated/threw for a mismatch). Omitted coords stay NONE. */
function destinationCoords(address: PeerAddress): {
	to_session?: string;
	to_role?: string;
	project?: string;
} {
	switch (address.kind) {
		case 'session':
			return address.toSession ? { to_session: address.toSession } : {};
		case 'role':
			return {
				...(address.toRole ? { to_role: address.toRole } : {}),
				...(address.project ? { project: address.project } : {})
			};
		case 'pm':
			return address.project ? { project: address.project } : {};
		case 'atelier':
		default:
			return {}; // atelier is the singular platform identity — no coordinates
	}
}

/** Flip a peer_message → delivered + stamp delivered_at. Used only after a live push was acked. */
async function markDelivered(db: Db, messageId: string): Promise<void> {
	const rid = new StringRecordId(assertRecordId(messageId));
	await db.query(`UPDATE $rid MERGE $c;`, {
		rid,
		c: { status: 'delivered', delivered_at: new Date() }
	});
}

// Re-export the named errors callers map to honest statuses. SendBudgetError now originates in
// repo.ts (atomic budget enforcement, PM2 finding c) but is re-exported here so the endpoint's
// import from this module — and the →429 mapping — is unchanged.
export { PeerAddressError, CrossProjectError, PeerRepoError, IdempotencyError, SendBudgetError };
