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

/** The per-session lifetime send budget was exhausted (abuse cap). Fail-closed + named. Lives HERE
 *  (not in send.ts) because the budget is now enforced ATOMICALLY at the write — the count and the
 *  insert are ONE SurrealDB transaction (PM2 finding c: the old read-then-create was a TOCTOU race
 *  N concurrent sends could each pass before any inserted, blowing past the cap). send.ts re-exports
 *  this as the public name so the endpoint mapping (→ 429) is unchanged. */
export class SendBudgetError extends Error {
	override readonly name = 'SendBudgetError';
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
	/**
	 * The per-session lifetime send cap. When set, the count+insert run as ONE transaction (the
	 * budget is checked INSIDE the write so concurrent sends cannot each pass a stale read and then
	 * all insert — PM2 finding c). Omit ⇒ no budget gate at the write (the caller did not request
	 * one). A breach throws SendBudgetError and the row is NOT written (the transaction rolls back).
	 */
	max_sends?: number;
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

	// Every send is assigned a per-sender monotonic SEQUENCE (peer_seq) from the session counter, set
	// AT CREATE inside ONE transaction (PM2 finding c). Two enforcement layers make the per-session
	// SEND BUDGET a HARD, DB-enforced invariant rather than a TOCTOU-racy read-then-write:
	//   (1) the counter: `UPDATE ONLY session SET peer_sends_count += 1 RETURN …` yields $new; when a
	//       cap is requested and $new > max we are over budget → DECREMENT back (the counter never
	//       drifts above the cap) and write NO row, returning an empty set (a CLEAN COMMIT — we avoid
	//       THROW because the JS SDK masks a multi-statement THROW as a generic "failed transaction").
	//   (2) the UNIQUE (from_session, peer_seq) index: the counter alone is INSUFFICIENT — this
	//       SurrealDB build MERGES concurrent `+= 1` deltas instead of aborting, so the counter stays
	//       correct but extra ROWS would leak. Stamping peer_seq=$new AT CREATE under the composite
	//       UNIQUE means two racing sends that landed the same $new collide and ONE transaction aborts
	//       — so AT MOST `max` rows can EVER exist per sender. A conflict/seq-collision surfaces as a
	//       transaction failure → bounded retry (F-014: no unbounded spin). When NO cap is requested
	//       (max_sends omitted) the same transaction runs WITHOUT the over-budget branch — it still
	//       assigns a unique peer_seq so a peer_seq-less NONE row never collides on the index.
	const hasCap =
		typeof input.max_sends === 'number' && Number.isFinite(input.max_sends) && input.max_sends >= 0;

	// Build the row's SET clause from the present content fields (+ peer_seq=$new). Keys are a fixed
	// internal allow-list (never agent-derived), values bind via $param (D-016) — no interpolation of
	// values, only of these literal column names.
	const setParts = Object.keys(content).map((k) => `${k} = $content.${k}`);
	setParts.push('peer_seq = $new');
	const createRow = `(CREATE ONLY peer_message SET ${setParts.join(', ')} RETURN AFTER)`;

	const budgetSql = `BEGIN;
		 LET $new = (UPDATE ONLY $from SET peer_sends_count += 1 RETURN peer_sends_count).peer_sends_count;
		 LET $row = ${
				hasCap
					? `IF $new <= $max { ${createRow} } ELSE { UPDATE ONLY $from SET peer_sends_count -= 1; NONE }`
					: createRow
			};
		 RETURN $row;
		 COMMIT;`;
	const bind: Record<string, unknown> = hasCap
		? { content, from: content.from_session, max: input.max_sends }
		: { content, from: content.from_session };

	// Bounded retry ONLY for a transaction failure (optimistic-concurrency conflict or a racing
	// seq-collision). A clean over-budget COMMIT (empty result) and a dedup collision are TERMINAL.
	// The spin is hard-capped (F-014: never an unbounded retry).
	const maxRetries = hasCap ? Math.min(Math.max(8, (input.max_sends as number) * 2), 32) : 16;
	for (let attempt = 0; ; attempt++) {
		let res: unknown[];
		try {
			res = await db.query<unknown[]>(budgetSql, bind);
		} catch (err) {
			const msg = (err as Error)?.message ?? '';
			// A dedup-key collision is a TERMINAL idempotent replay (SAME sender+client_key). The index
			// name surfaces directly on the plain path; INSIDE the budget transaction the JS SDK MASKS it
			// as a generic "failed transaction", so when a client_key is present and the tx failed, probe
			// for an existing (sender,client_key) row and map THAT to IdempotencyError before retrying —
			// otherwise an honest idempotent replay would be mis-reported as a budget/contention deny.
			if (/peer_message_dedup/i.test(msg)) mapWriteError(err, input.client_key);
			if (
				input.client_key &&
				/failed transaction|read or write conflict|retry/i.test(msg) &&
				(await dedupRowExists(db, str(content.from_session as object), input.client_key))
			) {
				throw new IdempotencyError(
					`sendPeerMessage: duplicate send — this sender already sent with client_key ` +
						`${JSON.stringify(input.client_key)} (idempotent retry collided on the dedup index)`
				);
			}
			// Transaction failure (concurrency conflict or a peer_seq race) → retry, bounded.
			if (/failed transaction|read or write conflict|retry|peer_message_seq/i.test(msg) && attempt < maxRetries) {
				continue;
			}
			// Retries exhausted on a seq/conflict failure under a cap: the cap is why it can't land.
			if (hasCap && /failed transaction|peer_message_seq|read or write conflict/i.test(msg)) {
				throw new SendBudgetError(
					`sendPeerMessage: per-session send budget contention exceeded retries (max ${input.max_sends}) — refused (abuse cap)`
				);
			}
			// Anything else → mapped to a named error or re-thrown verbatim (terminal).
			mapWriteError(err, input.client_key);
		}
		// RETURN $row is the last statement → its value is the last element of the response.
		const last = res[res.length - 1];
		const row =
			last && typeof last === 'object' && !Array.isArray(last) ? (last as Raw) : undefined;
		if (!row) {
			// Empty/NONE result. Under a cap this is the honest over-budget deny ($new > max, the
			// increment was rolled back, NO row written, a clean COMMIT). Without a cap it should never
			// happen — a missing row is then a real fault.
			if (hasCap) {
				throw new SendBudgetError(
					`sendPeerMessage: per-session send budget exhausted (max ${input.max_sends}) — refused (abuse cap)`
				);
			}
			throw new PeerRepoError('sendPeerMessage: insert returned no row');
		}
		// HONESTY GUARD (F-008). The SurrealDB 2.0.3 JS SDK sometimes RESOLVES a transaction that
		// actually ABORTED on the seq-collision, returning the pre-abort `CREATE … RETURN AFTER` value
		// — a PHANTOM row that never committed. (A direct `SELECT … FROM <id>` even returns the phantom,
		// so a by-id read is NOT a reliable check; only an INDEX scan reflects the committed table.) We
		// confirm the row is the committed owner of its (from_session, peer_seq) slot via a scan: if a
		// DIFFERENT row owns that seq (or none does), THIS transaction lost the race → retry (bounded),
		// then an honest budget/no-row deny. Runs only after a (rare) racing send.
		const seq = (row as { peer_seq?: unknown }).peer_seq;
		const committedId = await committedSeqOwner(db, str(content.from_session as object), seq);
		if (committedId && committedId === str(row.id)) return normPeerMessage(row);
		if (attempt < maxRetries) continue;
		if (hasCap) {
			throw new SendBudgetError(
				`sendPeerMessage: per-session send budget contention exceeded retries (max ${input.max_sends}) — refused (abuse cap)`
			);
		}
		throw new PeerRepoError('sendPeerMessage: insert did not persist (lost a write race)');
	}
}

/** The committed row id that OWNS a (from_session, peer_seq) slot per an INDEX scan, or null. Used by
 *  the honesty guard to reject a phantom row the SDK returned for an aborted transaction (a direct
 *  by-id read would see the phantom; an index scan reflects only committed rows). */
async function committedSeqOwner(
	db: Db,
	fromSession: string,
	seq: unknown
): Promise<string | null> {
	if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
	const sid = link(fromSession);
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM peer_message WHERE from_session = $sid AND peer_seq = $seq LIMIT 1;`,
		{ sid, seq }
	);
	const id = rows?.[0]?.id;
	return id != null ? str(id) : null;
}

/**
 * Map a peer_message write error to a NAMED error (every error has a name). A dedup UNIQUE-index
 * breach → IdempotencyError (the raw SurrealDB index message never leaks). Everything else is
 * re-thrown verbatim. ALWAYS throws (return type `never`) — the call sites rely on that.
 */
/** Does a row already exist for this (sender, client_key)? Used to recognize an idempotent replay
 *  when the budget transaction MASKED the dedup-index collision as a generic "failed transaction". */
async function dedupRowExists(db: Db, fromSession: string, clientKey: string): Promise<boolean> {
	try {
		const sid = link(fromSession);
		const [rows] = await db.query<[Array<{ c: number }>]>(
			`SELECT count() AS c FROM peer_message WHERE from_session = $sid AND client_key = $ck GROUP ALL;`,
			{ sid, ck: clientKey }
		);
		return (rows?.[0]?.c ?? 0) > 0;
	} catch {
		return false; // a probe fault must never mis-fire idempotency; fall through to retry/deny.
	}
}

function mapWriteError(err: unknown, clientKey: string | undefined): never {
	const msg = (err as Error)?.message ?? '';
	if (/peer_message_dedup|already contains|Database index|index .* already/i.test(msg)) {
		throw new IdempotencyError(
			`sendPeerMessage: duplicate send — this sender already sent with client_key ` +
				`${JSON.stringify(clientKey)} (idempotent retry collided on the dedup index)`
		);
	}
	throw err as Error;
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
