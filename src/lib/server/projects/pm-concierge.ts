// Path B (CONVERSATION-LAYER-SPEC) — the AUTONOMOUS PM review consults the Atelier concierge.
//
// WHAT THIS IS. Path A (f8e5730) let the AGENTIC pm-chat turn consult the concierge via its own
// granted `peer_send` tool. But specialist/skill/hard-decision needs actually ARISE during the
// DETERMINISTIC periodic/event review (runPmReview) — a pass that has NO LLM, NO session, and NO
// await-loop, so it cannot "ask and use the answer this tick". Path B is the honest async shape:
//
//   • EMIT — when the review detects a NOVEL specialist-need (blocked work / severe findings) it
//     writes ONE fire-and-forget `to_kind:'atelier'` peer_message (a plain DB write via the repo,
//     NOT an LLM turn — the deterministic pass CAN do this) and best-effort fires triggerConcierge.
//   • SURFACE — the concierge answers ASYNC (its reply inboxes to the project's PM peer-identity),
//     and a LATER review pass reads that reply and surfaces it into pm_memory as an advisory the
//     operator/PM weighs. Pending until answered — never a fabricated reply (F-008).
//
// THE REPLY-LANDING SEAM. handleAtelierMessages replies ONLY to `msg.fromSession` (to_kind:'session').
// The deterministic review has no session, so we anchor a DURABLE per-project "PM peer-identity"
// session (deterministic id, status='done' — it is an identity/mailbox, NOT a live agent process, so
// it stays OUT of the running fleet snapshot: no phantom 'pm' recipient, honest liveness F-008). The
// consult is sent FROM it; the concierge reply lands addressed TO it; a later pass drains that inbox.
//
// DEDUP (F-048-class anti-spam). runPmReview runs every tick; a standing need must NOT re-consult
// every tick. The peer_message dedup_key is `from_session|client_key` UNIQUE — with the STABLE
// identity session as sender and a DETERMINISTIC client_key (per project + need-kind + the exact
// signal id-set), a repeat consult for the SAME standing need collides → IdempotencyError → absorbed
// as a no-op. The key is keyed on immutable columns (no mutable-field VALUE), so there is no
// F-048 status-transition recompute hazard. A genuinely NOVEL need (a different id-set) gets a fresh
// key and one new consult.
//
// NON-STEERING (§7). The consult is ADVISORY — the review still makes its OWN deterministic proposals
// (deriveProposals is untouched); the concierge reply INFORMS the operator/next PM, it never auto-acts
// (no auto-hire, no skill install). FAIL-OPEN (F-014/F-048): every function here absorbs its own faults
// and NEVER throws — a DB fault on the review/drain path must never crash the server.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	sendPeerMessage,
	IdempotencyError,
	type SendPeerMessageInput,
	type PeerMessageRow
} from '../peer/repo';
import { ATELIER_SELF_PM } from '../peer/resolve';
import { getPm, addPmMemory, type PmMemoryRow } from './pm-repo';
import type { TaskRow } from '../tasks/repo';
import type { FindingRow } from '../scanner/findings-repo';

/** pm_memory.source tags — distinguish the consult record + the surfaced reply from ordinary review
 *  memories (so the PM tab / dedup can identify them). */
const CONSULT_SOURCE = 'pm-concierge-consult';
const CONSULT_REPLY_SOURCE = 'pm-concierge-reply';
/** pm_memory.source tag for a NON-concierge peer message surfaced off the PM identity mailbox —
 *  e.g. a granted worker's `peer_send({ to: { kind:'pm' } })` escalation ("I'm blocked"). Distinct
 *  from CONSULT_REPLY_SOURCE so surfaces/dedup never confuse a worker message with an advisory. */
const PEER_MESSAGE_SOURCE = 'pm-peer-message';

/** The session.agent sentinel marking the durable PM peer-identity (NOT a real on-disk agent). */
const PM_IDENTITY_AGENT = 'pm_review_identity';

/** Bound the surfacing read — one review pass drains at most this many pending advisories. */
const MAX_REPLIES_PER_PASS = 20;

/** Injectable seams so the unit tests assert the DB effects without a real concierge turn / network.
 *  Production leaves all undefined → the real repo writer + a dynamic-imported triggerConcierge. */
export interface PmConciergeDeps {
	/** The peer-bus writer. Default = sendPeerMessage(db, …). */
	send?: (db: Db, input: SendPeerMessageInput) => Promise<PeerMessageRow>;
	/** Fire the concierge event trigger (async, best-effort). Default = concierge/wire triggerConcierge. */
	trigger?: (db: Db) => Promise<unknown>;
	/** Clock (tests). Default = () => new Date(). */
	now?: () => Date;
}

// ── The durable per-project PM peer-identity (sender + reply mailbox) ──────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** FNV-1a → 8 hex chars. Deterministic + short — used for the identity id part and the dedup key. */
function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** The deterministic id PART (`type::thing('session', <this>)`) of a project's PM peer-identity. */
function identityIdPart(projectId: string): string {
	return `pmidentity_${fnv1a(projectId)}`;
}

/** Read the durable PM peer-identity session id for a project, or null when none exists yet. */
async function findPmIdentitySession(db: Db, projectId: string): Promise<string | null> {
	const idPart = identityIdPart(projectId);
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM type::thing('session', $idPart);`,
		{ idPart }
	);
	const id = rows?.[0]?.id;
	return id != null ? String(id) : null;
}

/**
 * Ensure the durable PM peer-identity session exists (deterministic id ⇒ idempotent + race-safe: two
 * concurrent ticks target the SAME id — one CREATEs, the loser collides and re-reads). status='done'
 * with ended_at set: it is an identity anchor, not a live agent, so it never appears as a running
 * 'pm' recipient (honest liveness, F-008). model names WHO it is, never a fake metric.
 */
async function ensurePmIdentitySession(
	db: Db,
	projectId: string,
	pmId: string,
	deps?: PmConciergeDeps
): Promise<string> {
	const existing = await findPmIdentitySession(db, projectId);
	if (existing) return existing;

	const now = deps?.now ?? (() => new Date());
	const idPart = identityIdPart(projectId);
	try {
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE type::thing('session', $idPart) CONTENT $content RETURN AFTER;`,
			{
				idPart,
				content: {
					kind: 'review',
					status: 'done',
					ended_at: now(),
					model: { provider: 'atelier', model_id: 'pm-review-identity' },
					runtime: 'claude-code',
					project: link(projectId),
					pm: pmId,
					agent: PM_IDENTITY_AGENT,
					note: 'PM peer-identity — durable mailbox for Atelier concierge advisories (autonomous review consults).'
				}
			}
		);
		return String(created[0].id);
	} catch (err) {
		// A concurrent tick already created it (deterministic id ⇒ "already exists"). Re-read.
		const again = await findPmIdentitySession(db, projectId);
		if (again) return again;
		throw err;
	}
}

// ── EMIT — one fire-and-forget consult per NOVEL specialist-need ───────────────────────────

/** One specialist/skill/decision need the review detected, framed content-free (D-026). */
interface ConsultNeed {
	/** Which signal fired (dedup namespace + provenance). */
	reason: 'blocked' | 'findings';
	/** A short content-free summary for the "awaiting advice" pm_memory (counts only). */
	summary: string;
	/** The deterministic dedup token (per project + reason + the exact signal id-set). */
	clientKey: string;
	/** The advisory consult body — need + counts only, NEVER task/finding content (D-026). */
	body: string;
}

/**
 * Pick the SINGLE highest-priority novel specialist-need for this pass (≤ 1 consult / tick). Blocked
 * work takes precedence (a specialist/skill to unblock is the clearest agent-rec need); else severe
 * findings (a specialist to triage security-quality debt). No signal ⇒ no consult (honest silence).
 * The client_key fingerprints the EXACT id-set, so the same standing need dedups and a changed set is
 * a genuinely novel need. Bodies are content-free (counts + the need), D-026-safe.
 */
function selectConsultNeed(projectLabel: string, tasks: TaskRow[], severe: FindingRow[]): ConsultNeed | null {
	const blocked = tasks.filter((t) => t.status === 'blocked');
	if (blocked.length > 0) {
		const ids = blocked.map((t) => t.id).sort();
		return {
			reason: 'blocked',
			summary: `${blocked.length} blocked task(s) — asked for a specialist/skill to unblock`,
			clientKey: `pmconsult:blocked:${fnv1a(ids.join(','))}`,
			body: [
				'[Autonomous PM review — advisory consult]',
				`Project "${projectLabel}": ${blocked.length} task(s) are blocked and delivery is stalled.`,
				'Which specialist agent (from the agent library) or skill could help unblock this class of work?',
				'ADVISORY ONLY: the PM/operator decides and acts — do not act on our behalf; hiring and skill install stay operator-gated.'
			].join('\n')
		};
	}
	if (severe.length > 0) {
		const ids = severe.map((f) => f.id).sort().slice(0, 20);
		return {
			reason: 'findings',
			summary: `${severe.length} critical/high finding(s) — asked for a triage/remediation specialist`,
			clientKey: `pmconsult:findings:${fnv1a(ids.join(','))}`,
			body: [
				'[Autonomous PM review — advisory consult]',
				`Project "${projectLabel}": ${severe.length} unresolved critical/high security finding(s) — security/quality debt gating release.`,
				'Which specialist agent or skill could help triage and remediate this class of debt?',
				'ADVISORY ONLY: the PM/operator decides and acts — do not act on our behalf; hiring and skill install stay operator-gated.'
			].join('\n')
		};
	}
	return null;
}

/** Default trigger — dynamic import keeps concierge/wire (harness/providers/config) out of the eager
 *  module graph (no import cycle) and honors the fire-and-forget contract (never throws). */
async function defaultTrigger(db: Db): Promise<void> {
	const { triggerConcierge } = await import('../concierge/wire');
	await triggerConcierge(db);
}

export interface ConsultOutcome {
	emitted: boolean;
	/** The "awaiting advice" pm_memory written on a NOVEL emit (surfaced into the PM tab), if any. */
	memory?: PmMemoryRow;
	/** Why nothing was emitted (no-PM / observe-only / no-signal / dedup / error) — never silent. */
	reason: string;
}

/**
 * EMIT one atelier consult IFF this pass has a novel specialist-need AND a hired PM with propose/act
 * authority (same gate as deriveProposals — an observe-only / no-PM project does not consult). Deduped
 * once per novel need (IdempotencyError absorbed). Fires the concierge async/non-blocking. On a novel
 * emit, records the honest PENDING state as a pm_memory ("awaiting advice"). NEVER throws (fail-open).
 */
export async function maybeEmitConciergeConsult(
	db: Db,
	args: { projectId: string; projectLabel: string; tasks: TaskRow[]; severe: FindingRow[] },
	deps?: PmConciergeDeps
): Promise<ConsultOutcome> {
	const { projectId, projectLabel, tasks, severe } = args;
	try {
		const pm = await getPm(db, projectId);
		if (!pm) return { emitted: false, reason: 'no hired PM — the autonomous review does not consult' };
		if (pm.authority !== 'propose' && pm.authority !== 'act') {
			return { emitted: false, reason: `observe-only PM (authority '${pm.authority}') — no consult` };
		}

		const need = selectConsultNeed(projectLabel, tasks, severe);
		if (!need) return { emitted: false, reason: 'no specialist-need signal this pass' };

		const sid = await ensurePmIdentitySession(db, projectId, pm.id, deps);
		const send = deps?.send ?? sendPeerMessage;

		let persisted: PeerMessageRow;
		try {
			persisted = await send(db, {
				from_session: sid,
				to_kind: 'atelier',
				body: need.body,
				client_key: need.clientKey
			});
		} catch (err) {
			if (err instanceof IdempotencyError) {
				// The SAME standing need was already consulted — do NOT re-emit / re-fire / re-note (anti-spam).
				return { emitted: false, reason: 'standing need already consulted (dedup)' };
			}
			throw err; // any other fault → outer fail-open
		}

		// Fire the concierge best-effort: ASYNC + NON-BLOCKING (never awaited — a 30s LLM turn must not
		// block/hang the review, F-014). The reply lands on a LATER pass (surfacePmInbox).
		const trigger = deps?.trigger ?? defaultTrigger;
		void Promise.resolve(trigger(db)).catch((e) =>
			console.warn(`[pm-concierge] trigger failed (fail-open): ${(e as Error).message}`)
		);

		// Honest PENDING state (F-008) — a real consult was emitted; the advice is not here yet.
		const memory = await addPmMemory(db, {
			project: projectId,
			kind: 'observation',
			content: `Consulted the Atelier concierge (awaiting advice): ${need.summary}.`,
			source: CONSULT_SOURCE,
			related_to: persisted.id,
			confidence: 1.0
		});
		return { emitted: true, memory, reason: need.reason };
	} catch (err) {
		console.warn(`[pm-concierge] maybeEmitConciergeConsult failed (fail-open): ${(err as Error).message}`);
		return { emitted: false, reason: 'error (fail-open)' };
	}
}

// ── SURFACE — drain the PM identity inbox (concierge advisories + worker peer messages) ────

/** One pending inbox row, with the sender columns graph-traversed off `from_session` so the
 *  surfaced label is RESOLVED from the live sender session row — never guessed (F-008). */
interface PmInboxRow {
	id: unknown;
	body: unknown;
	created_at: unknown;
	from_session: unknown;
	sender_pm: unknown;
	sender_agent: unknown;
	sender_role: unknown;
}

/** Honest label for a NON-concierge sender: role name first (the most meaningful WHO), then the
 *  agent slug, then the bare session id; an unresolvable sender is said to be exactly that (F-008
 *  — never a fabricated identity). The label is metadata only (role/agent/session id), never
 *  message content (D-026). */
function senderLabel(r: PmInboxRow): string {
	const sid = r.from_session != null ? String(r.from_session) : null;
	const role = typeof r.sender_role === 'string' && r.sender_role ? r.sender_role : null;
	const agent = typeof r.sender_agent === 'string' && r.sender_agent ? r.sender_agent : null;
	if (role && sid) return `Peer message from a "${role}" session (${sid})`;
	if (agent && sid) return `Peer message from agent "${agent}" (${sid})`;
	if (sid) return `Peer message from session ${sid}`;
	return 'Peer message from an unidentified session';
}

/**
 * Drain the pending messages on this project's PM inbox and surface each into pm_memory. The PM
 * inbox is TWO row shapes on the peer bus (both drained here; neither has any other drain):
 *   • `to_session = <PM peer-identity>` — the concierge's advisory replies (handleAtelierMessages
 *     addresses the identity mailbox directly), plus any direct session-addressed message to it;
 *   • `to_kind = 'pm' AND project = <this>` — a worker's `peer_send({to:{kind:'pm', project}})`
 *     escalation (send.ts destinationCoords stores NO to_session for the pm class — the address
 *     is the project's PM identity, not a session id).
 * Atomic pending→delivered CAS per message (only the pass that WINS the flip writes the memory —
 * no double-surface under concurrent ticks, F-048-class). The surfaced label branches by ORIGIN
 * (the sender session's `pm` identity):
 *   • the Atelier concierge (atelier_self, `pm` = ATELIER_SELF_PM) → the advisory observation
 *     ("async reply to a prior review consult") tagged CONSULT_REPLY_SOURCE, as before;
 *   • any OTHER sender → an honest "Peer message from <sender>" observation tagged
 *     PEER_MESSAGE_SOURCE — NEVER mislabeled as a concierge advisory (F-008).
 * Returns the memories written (folded into review.written). NEVER throws (fail-open) — a drain
 * fault must not crash the review/server (F-014).
 */
export async function surfacePmInbox(db: Db, projectId: string): Promise<PmMemoryRow[]> {
	try {
		const sid = await findPmIdentitySession(db, projectId);

		// F-020: the ORDER BY field (created_at) is in every SELECT list; to_session is indexed.
		// Sender columns traverse the from_session record link; a deleted/missing sender row
		// yields NONE → the honest "unidentified" fallback (F-008).
		const SENDER_PROJECTION = `id, body, created_at, from_session,
					from_session.pm AS sender_pm,
					from_session.agent AS sender_agent,
					from_session.role.name AS sender_role`;

		// Shape 1 — messages addressed TO the PM peer-identity session (concierge replies). Only
		// exists once a consult was ever emitted; no identity ⇒ skip (nothing can address it).
		let rows: PmInboxRow[] = [];
		if (sid) {
			const [identityRows] = await db.query<[PmInboxRow[]]>(
				`SELECT ${SENDER_PROJECTION}
					FROM peer_message
					WHERE to_session = $sid AND status = "pending"
					ORDER BY created_at ASC LIMIT ${MAX_REPLIES_PER_PASS};`,
				{ sid: link(sid) }
			);
			rows = rows.concat(identityRows ?? []);
		}

		// Shape 2 — pm-class messages for THIS project (worker escalations). Drained regardless of
		// the identity session: a worker can address {kind:'pm'} before any consult ever ran.
		const [pmKindRows] = await db.query<[PmInboxRow[]]>(
			`SELECT ${SENDER_PROJECTION}
				FROM peer_message
				WHERE to_kind = "pm" AND project = $project AND status = "pending"
				ORDER BY created_at ASC LIMIT ${MAX_REPLIES_PER_PASS};`,
			{ project: link(projectId) }
		);
		rows = rows.concat(pmKindRows ?? []);

		// Deterministic surface order across both shapes (the two sets are disjoint by construction —
		// a pm-class row stores no to_session — but the CAS flip below de-dupes defensively anyway).
		// F-013-class care: the SDK hands datetimes back as Date-likes — compare via epoch, never
		// String(Date) (locale text does not sort chronologically).
		const epoch = (v: unknown): number => {
			if (v instanceof Date) return v.getTime();
			const t = new Date(String(v ?? '')).getTime();
			return Number.isNaN(t) ? 0 : t;
		};
		rows.sort((a, b) => epoch(a.created_at) - epoch(b.created_at));

		const out: PmMemoryRow[] = [];
		for (const r of rows) {
			const replyId = String(r.id);
			// Atomic single-surface guard: flip pending→delivered; only proceed if THIS pass won the flip.
			const [flipped] = await db.query<[unknown[]]>(
				`UPDATE $rid SET status = "delivered", delivered_at = time::now()
					WHERE status = "pending" RETURN BEFORE;`,
				{ rid: link(replyId) }
			);
			if (!Array.isArray(flipped) || flipped.length === 0) continue; // lost the race / already surfaced

			const body = typeof r.body === 'string' ? r.body : '';
			// ORIGIN branch: only the concierge's atelier identity earns the advisory label.
			const fromAtelier = r.sender_pm != null && String(r.sender_pm) === ATELIER_SELF_PM;
			const memory = await addPmMemory(db, {
				project: projectId,
				kind: 'observation',
				content: fromAtelier
					? `Atelier concierge advisory (async reply to a prior review consult):\n${body}`
					: `${senderLabel(r)}:\n${body}`,
				source: fromAtelier ? CONSULT_REPLY_SOURCE : PEER_MESSAGE_SOURCE,
				related_to: replyId,
				confidence: 1.0
			});
			out.push(memory);
		}
		return out;
	} catch (err) {
		console.warn(`[pm-concierge] surfacePmInbox failed (fail-open): ${(err as Error).message}`);
		return [];
	}
}

/** Re-exported tags so the surface / tests can identify consult + reply + worker-message memories
 *  without magic strings. */
export { CONSULT_SOURCE, CONSULT_REPLY_SOURCE, PEER_MESSAGE_SOURCE, PM_IDENTITY_AGENT };
