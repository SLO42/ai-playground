// G-B — PEER_MESSAGE FLEET BUS: data plane (PEER-MESSAGE-SPEC §2; D-026/D-035a).
//
// Row types, normalizers, and the peer_message CRUD + the fleet-snapshot loader the
// resolver (peer/resolve.ts) consumes. This module owns the WRITE-TIME body envelope:
// every peer body passes screen() (secret/PII — D-026) THEN fence({source:'channel'})
// (the §10 DATA envelope + stripEmbeddedSentinels) before it ever lands in the `body`
// column — the RAW agent text is NEVER persisted (m0039 comment). A body that trips a
// quarantineOnHit screen rule is stored with status='quarantined' and the REDACTED text
// (fail-closed, D-026) — never the raw secret, never silently dropped.
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated tokens
// are record ids validated at the db/validate.ts chokepoint. Optional fields are OMITTED,
// never NULLed (option<T> rejects NULL — MEMORY-SPEC §6.1). Every datetime is ISO-coerced
// in the normalizer, absent → null → '—' (F-013). The origin of a peer message is ALWAYS
// agent (D-035a) — it is not a column here because the DELIVERED `message` row (G-A) carries
// origin=agent; peer_message rows are the routing envelope, intrinsically agent-origin.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';
import { fence } from '../memory/fence';
import type { FleetSnapshot, LiveSession } from './resolve';
import { ATELIER_PROJECT_KEY, type ToKind } from './resolve';

// ── Named errors ────────────────────────────────────────────────────────────────

/** Bad caller input at the peer-message data boundary (missing sender, missing required
 *  target coordinate for the to_kind, missing row on read). Fail loud + named. */
export class PeerRepoError extends Error {
	override readonly name = 'PeerRepoError';
}

/** A retried ingress write collided on the (sender|client_key) dedup UNIQUE index — the SAME
 *  sender already sent with this client_key. NAMED (the contract: every error has a name) so the
 *  endpoint maps it to an honest, idempotent ok:false rather than leaking the raw SurrealDB index
 *  violation. With the sender-namespaced dedup_key this can ONLY be the sender's own retry — a
 *  different session/project reusing the same client_key string no longer collides (poisoning-safe). */
export class IdempotencyError extends Error {
	override readonly name = 'IdempotencyError';
}

/** Max length of an agent-supplied client_key (the ingress idempotency token). Caps the indexed
 *  dedup_key VALUE so a hostile caller cannot bloat the UNIQUE index with a giant key. A UUID/short
 *  token is ~36 chars; 200 is generous headroom without being an index-size foot-gun. */
export const PEER_CLIENT_KEY_MAX = 200;

// ── Enums (mirror the m0039 DDL asserts) ────────────────────────────────────────

export type PeerStatus = 'pending' | 'delivered' | 'expired' | 'quarantined';

// ── Row type (normalized: ids/links → string, datetimes → ISO string | null) ────

export interface PeerMessageRow {
	id: string;
	from_session: string;
	from_role: string | null;
	to_kind: ToKind;
	to_session: string | null;
	to_role: string | null;
	project: string | null;
	/** The screened+fenced envelope (NEVER raw). */
	body: string;
	status: PeerStatus;
	hops: number;
	created_at: string | null;
	delivered_at: string | null;
}

// ── Helpers (mirror workforce/repo.ts discipline) ───────────────────────────────

type Raw = Record<string, unknown>;

function str(v: unknown): string {
	return String(v);
}

/** F-013 + F-008: SurrealDB 2.x datetime (non-POJO) → ISO string; absent/unparseable → null
 *  so the surface renders '—', NEVER the literal 'undefined'/'null'. */
function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function normPeerMessage(row: Raw): PeerMessageRow {
	return {
		id: str(row.id),
		from_session: str(row.from_session),
		from_role: row.from_role != null ? str(row.from_role) : null,
		to_kind: row.to_kind as ToKind,
		to_session: row.to_session != null ? str(row.to_session) : null,
		to_role: row.to_role != null ? str(row.to_role) : null,
		project: row.project != null ? str(row.project) : null,
		body: str(row.body),
		status: row.status as PeerStatus,
		hops: Number(row.hops),
		created_at: strDate(row.created_at),
		delivered_at: strDate(row.delivered_at)
	};
}

// ── Body envelope: screen → fence (write-time D-026 chokepoint) ─────────────────

export interface PeerBodyEnvelope {
	/** The screened+fenced text safe to persist in the `body` column. */
	body: string;
	/** 'quarantined' when screen tripped a quarantineOnHit rule (a private-key block etc.) —
	 *  the row is stored quarantined (fail-closed); 'ok' otherwise (clean or redacted-in-place). */
	status: 'ok' | 'quarantined';
	/** Screen rule ids that fired (audit/explain). Empty for a clean body. */
	reasons: string[];
}

/**
 * Turn raw agent text into the persisted body envelope (D-026): screen() for secrets/PII THEN
 * fence({source:'channel'}) into the §10 "reference, not instructions" DATA block (which also
 * strips any embedded fence sentinels — stripEmbeddedSentinels). The RAW text is never returned
 * or stored. A quarantineOnHit screen hit yields status:'quarantined' (the caller stores the row
 * with status='quarantined') but STILL fences the redacted text — never the raw secret, never a
 * silent drop. SHADOW PATHS: nil/non-string → screen() returns quarantined empty; empty string →
 * a fenced empty body (honest, harmless).
 */
export function buildPeerBody(raw: string): PeerBodyEnvelope {
	const screened = screen(raw);
	const fenced = fence({ source: 'channel', body: screened.text });
	return {
		body: fenced.text,
		status: screened.status === 'quarantined' ? 'quarantined' : 'ok',
		reasons: screened.reasons
	};
}

// ── Send input (the routing envelope the ingress writer stamps) ─────────────────

export interface SendPeerMessageInput {
	/** Authenticated sender session (stamped server-side at ingress — D-035a). */
	from_session: string;
	/** Sender role identity, when it has one (omit for a role-less chat/task session). */
	from_role?: string;
	to_kind: ToKind;
	to_session?: string;
	to_role?: string;
	project?: string;
	/** RAW agent text — screened+fenced here before write (never persisted raw). */
	body: string;
	/** Relay TTL (default 1; 0 = terminal). */
	hops?: number;
	/** Ingress idempotency token → dedup_key (a retried send collides rather than double-sends). */
	client_key?: string;
}

/**
 * Persist one peer message. The body is screened+fenced here (buildPeerBody) — raw text never
 * lands. A quarantined body is stored with status='quarantined' (fail-closed, D-026); otherwise
 * status defaults to 'pending' for the drain. Optional coordinates are OMITTED when absent
 * (option<T> rejects NULL). The dedup_key VALUE (client_key OR id) makes a retried ingress write
 * collide on the UNIQUE index. Returns the normalized row. Validation/policy of the DESTINATION
 * is the caller's job (resolveAddress) — this is the storage writer.
 */
export async function sendPeerMessage(db: Db, input: SendPeerMessageInput): Promise<PeerMessageRow> {
	if (typeof input?.from_session !== 'string' || !input.from_session.trim()) {
		throw new PeerRepoError('sendPeerMessage: from_session (authenticated sender) is required');
	}
	if (typeof input.body !== 'string') {
		throw new PeerRepoError('sendPeerMessage: body must be a string');
	}
	// Length-cap the agent-supplied idempotency token: it lands in the indexed dedup_key VALUE, so an
	// unbounded key would bloat the UNIQUE index. A bad shape is the caller's error (named, fail-loud).
	if (input.client_key !== undefined) {
		if (typeof input.client_key !== 'string') {
			throw new PeerRepoError('sendPeerMessage: client_key must be a string when present');
		}
		if (input.client_key.length > PEER_CLIENT_KEY_MAX) {
			throw new PeerRepoError(
				`sendPeerMessage: client_key exceeds the ${PEER_CLIENT_KEY_MAX}-char cap (got ${input.client_key.length})`
			);
		}
	}
	const envelope = buildPeerBody(input.body);

	const content: Record<string, unknown> = {
		from_session: link(input.from_session),
		to_kind: input.to_kind,
		body: envelope.body,
		status: envelope.status === 'quarantined' ? 'quarantined' : 'pending',
		hops: Number.isFinite(input.hops as number) ? Math.max(0, Math.floor(input.hops as number)) : 1
	};
	if (input.from_role) content.from_role = link(input.from_role);
	if (input.to_session) content.to_session = link(input.to_session);
	if (input.to_role) content.to_role = link(input.to_role);
	if (input.project) content.project = link(input.project);
	if (input.client_key) content.client_key = input.client_key;

	let rows: Raw[] | undefined;
	try {
		[rows] = await db.query<[Raw[]]>(`CREATE peer_message CONTENT $content RETURN AFTER;`, {
			content
		});
	} catch (err) {
		// Map the dedup UNIQUE-index violation to a NAMED IdempotencyError so the raw SurrealDB index
		// message never leaks (the 'every error has a name' contract). SurrealDB surfaces a unique-
		// index breach by mentioning the index name (peer_message_dedup) or "already contains"/
		// "Database index"; match defensively and re-throw everything else verbatim.
		const msg = (err as Error)?.message ?? '';
		if (/peer_message_dedup|already contains|Database index|index .* already/i.test(msg)) {
			throw new IdempotencyError(
				`sendPeerMessage: duplicate send — this sender already sent with client_key ` +
					`${JSON.stringify(input.client_key)} (idempotent retry collided on the dedup index)`
			);
		}
		throw err;
	}
	const row = rows?.[0];
	if (!row) throw new PeerRepoError('sendPeerMessage: insert returned no row');
	return normPeerMessage(row);
}

/** Read one peer_message by id (normalized). Returns null when absent (honest empty, not throw). */
export async function getPeerMessage(db: Db, id: string): Promise<PeerMessageRow | null> {
	const rid = link(id);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	const row = rows?.[0];
	return row ? normPeerMessage(row) : null;
}

/**
 * The drain query (§spec, uses the (to_session,status) index): a recipient session's PENDING
 * inbox, oldest first. Returns [] for an empty inbox (honest empty). Marking delivered is a
 * separate step (a later task wires delivery → a `message` row, G-A); this is the read side.
 */
export async function pendingInbox(db: Db, toSession: string): Promise<PeerMessageRow[]> {
	const sid = link(toSession);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM peer_message WHERE to_session = $sid AND status = "pending" ORDER BY created_at ASC LIMIT 200;`,
		{ sid }
	);
	return (rows ?? []).map(normPeerMessage);
}

// ── Fleet snapshot loader (the resolver's PURE input, assembled here) ────────────

/**
 * Load the live-fleet snapshot the resolver fans an address out against. ONE scoped query for
 * the running sessions + ONE for the PM identities, mapped into the pure FleetSnapshot shape.
 * Non-blocking/fail-open at the call site (F-014): the caller wraps this, but a clean snapshot
 * with an empty fleet is itself an honest "nobody is up" (every address inboxes as pending).
 *
 * The atelier placeholder (§11): atelier_self's PM (the global/project-less platform PM) is keyed
 * under ATELIER_PROJECT_KEY so an 'atelier' address resolves to it when up — a DOCUMENTED
 * placeholder until D-040 composes a real atelier identity.
 */
export async function loadFleetSnapshot(db: Db): Promise<FleetSnapshot> {
	const [sessRows] = await db.query<[Raw[]]>(
		`SELECT id, role, project, kind FROM session WHERE status = "running" LIMIT 1000;`
	);
	const running: LiveSession[] = (sessRows ?? []).map((r) => ({
		id: str(r.id),
		role: r.role != null ? str(r.role) : null,
		project: r.project != null ? str(r.project) : null,
		kind: str(r.kind),
		// DOCUMENTED PLACEHOLDER: there is no `session.pm` column yet (PM sessions are launched via
		// projects/pm-session.ts but not stamped with a pm link). Until that seam exists, every
		// running session reads pm=null → a 'pm'/'atelier' address resolves to ZERO sessions and
		// inboxes as pending (the PM/atelier is event-triggered, usually OFFLINE). Never fabricated.
		pm: r.pm != null ? str(r.pm) : null
	}));

	// PM identities: pm.project → pm.id (one PM per project, PM-SPEC). The resolver matches a 'pm'
	// address to a running session whose pm link equals this id (none today — see placeholder).
	// A project-less PM (atelier_self's global PM) is keyed under ATELIER_PROJECT_KEY (§11 atelier).
	const [pmRows] = await db.query<[Raw[]]>(`SELECT id, project FROM pm LIMIT 1000;`);
	const pmByProject: Record<string, string | null> = {};
	for (const r of pmRows ?? []) {
		const proj = r.project != null ? str(r.project) : null;
		const key = proj ?? ATELIER_PROJECT_KEY;
		pmByProject[key] = str(r.id);
	}

	return { running, pmByProject };
}
