// Concierge advisories — READ-ONLY projection of the Path-B PM↔concierge consult lifecycle
// (pm-concierge.ts) for the operator surfaces (project PM tab + /brain).
//
// SOURCE OF TRUTH: the peer bus. A consult is a `peer_message` FROM a project's durable PM
// peer-identity mailbox (`session.agent = PM_IDENTITY_AGENT`) with `to_kind:'atelier'`; the
// concierge's advisory reply is a `peer_message` addressed TO that same mailbox (nothing else
// addresses it — pm-concierge.ts docstring). Both bodies were screened+fenced by the peer repo at
// write time (D-026), so displaying them verbatim surfaces no raw content.
//
// LIFECYCLE PAIRING. Since m0079 the concierge's reply stamps `peer_message.reply_to` with the
// consult id it answers (handleAtelierMessages), so pairing is EXACT by id. LEGACY replies (written
// before m0079) have no reply_to — for those we fall back to the old positional contract (the
// concierge drains its atelier inbox created_at ASC and replies once per consult, so legacy replies
// land FIFO): remaining unstamped replies pair, in order, with the remaining unanswered consults.
// The FIFO candidate set is ORIGIN-FILTERED to concierge-sent rows (`from_session.pm` =
// ATELIER_SELF_PM — the same origin branch surfacePmInbox uses): since the worker conversation
// layer, WORKER messages also land on the PM identity mailbox, and an unstamped worker row must
// never masquerade as an advisory reply (F-008; workers are surfaced separately with honest labels).
// A consult with neither an exact nor a fallback reply is honestly PENDING (never a fabricated
// answer, F-008). If a concierge turn faulted mid-drain, the exact pairing keeps every later
// stamped reply on its true consult instead of skewing the tail.
//
// F-013: created_at is coerced to an ISO string here — a `load` never hands out a raw SDK datetime.
// F-020 #1: every ORDER BY field is in the SELECT projection. D-016: LIMIT is a clamped integer
// literal (SurrealDB LIMIT does not bind a $param), never caller text.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { FENCE_OPEN, FENCE_CLOSE } from '../memory/fence';
import { ATELIER_SELF_PM } from '../peer/resolve';
import { PM_IDENTITY_AGENT } from './pm-concierge';
import { isoOrNull } from './repo';

/** One consult + its (possibly not-yet-landed) advisory, serialization-safe for a `load` (F-013). */
export interface ConciergeAdvisoryRow {
	/** The consult peer_message record id. */
	id: string;
	/** The asking project record id, or null (defensive — the identity session carries it). */
	project: string | null;
	/** Which review signal fired the consult — parsed from the deterministic client_key. */
	need: 'blocked' | 'findings' | 'other';
	/** The content-free consult ask (screened at write, D-026) — boilerplate lines stripped. */
	asked: string;
	/** Honest lifecycle: PENDING until a real reply row landed (F-008). */
	status: 'pending' | 'answered';
	/** The concierge's advisory text (screened at write, D-026), or null while pending. */
	advisory: string | null;
	/** ISO-8601 consult time, or null when absent (F-013). */
	askedAt: string | null;
	/** ISO-8601 reply time, or null while pending (F-013). */
	answeredAt: string | null;
}

/** Default number of advisories a surface shows. */
export const CONCIERGE_ADVISORIES_LIMIT = 8;

/** Hard per-mailbox read bound (consults and replies each). */
const PER_MAILBOX_CAP = 50;

/** Hard bound on identity mailboxes scanned for the cross-project view. */
const MAILBOX_SCAN_CAP = 100;

function clampLimit(limit: number | undefined): number {
	if (limit == null || !Number.isFinite(limit)) return CONCIERGE_ADVISORIES_LIMIT;
	return Math.max(1, Math.min(PER_MAILBOX_CAP, Math.floor(limit)));
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Coerce a possibly-record value (RecordId | string | {id}) to its string form, else null. */
function recordToString(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === 'string') return v;
	if (typeof v === 'object') {
		const asStr = (v as { toString?: () => string }).toString?.();
		if (asStr && asStr !== '[object Object]') return asStr;
		const inner = (v as { id?: unknown }).id;
		if (typeof inner === 'string') return inner;
	}
	return null;
}

/** Parse the review signal out of the deterministic dedup client_key (`pmconsult:<reason>:<hash>`). */
function needFromClientKey(v: unknown): ConciergeAdvisoryRow['need'] {
	if (typeof v !== 'string') return 'other';
	const m = /^pmconsult:(blocked|findings):/.exec(v);
	return m ? (m[1] as 'blocked' | 'findings') : 'other';
}

/**
 * Unwrap the peer repo's §10 reference fence for HUMAN display. The fence exists to keep channel
 * bodies out of LLM instruction positions (D-026); this UI text is Svelte-escaped display, never
 * re-fed to an agent, so unwrapping is safe — the body itself stayed screened at write.
 */
function unfence(body: string): string {
	if (!body.startsWith(FENCE_OPEN)) return body.trim();
	const inner = body.replace(FENCE_CLOSE, '');
	const sep = inner.indexOf('\n---\n');
	return (sep >= 0 ? inner.slice(sep + 5) : inner.replace(FENCE_OPEN, '')).trim();
}

/** Strip the consult body's fixed header/footer boilerplate, keeping the content-free ask lines. */
function askedFromBody(body: unknown): string {
	if (typeof body !== 'string' || body.length === 0) return '';
	const plain = unfence(body);
	const kept = plain
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('[') && !l.startsWith('ADVISORY ONLY'));
	return kept.length > 0 ? kept.join(' ') : plain;
}

interface MailboxRef {
	sessionId: string;
	project: string | null;
}

/** Find the PM peer-identity mailbox(es) — all of them, or a single project's. Bounded. */
async function findMailboxes(db: Db, projectId?: string): Promise<MailboxRef[]> {
	const where = projectId ? 'agent = $agent AND project = $project' : 'agent = $agent';
	const [rows] = await db.query<[Array<{ id: unknown; project: unknown }>]>(
		`SELECT id, project FROM session WHERE ${where} LIMIT ${MAILBOX_SCAN_CAP};`,
		projectId ? { agent: PM_IDENTITY_AGENT, project: link(projectId) } : { agent: PM_IDENTITY_AGENT }
	);
	return (rows ?? []).flatMap((r) => {
		const sessionId = recordToString(r.id);
		return sessionId ? [{ sessionId, project: recordToString(r.project) }] : [];
	});
}

/** Read one mailbox's consults + replies (both ASC, bounded) and pair them: EXACT by reply_to
 *  (m0079) first; legacy replies (no reply_to) fall back to the old positional FIFO contract. */
async function readMailbox(db: Db, box: MailboxRef): Promise<ConciergeAdvisoryRow[]> {
	const sid = link(box.sessionId);
	// F-020 #1: created_at is in both projections for the ORDER BY idiom.
	const [consults] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, body, client_key, created_at FROM peer_message
			WHERE from_session = $sid AND to_kind = "atelier"
			ORDER BY created_at ASC LIMIT ${PER_MAILBOX_CAP};`,
		{ sid }
	);
	// The sender's `pm` identity traverses the from_session link (a deleted sender → NONE → the
	// row is NOT concierge-origin, so it can only pair via an explicit reply_to stamp).
	const [replies] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, body, reply_to, created_at, from_session.pm AS sender_pm FROM peer_message
			WHERE to_session = $sid
			ORDER BY created_at ASC LIMIT ${PER_MAILBOX_CAP};`,
		{ sid }
	);
	// Split replies: STAMPED (reply_to set → exact map, first stamp wins) vs LEGACY (pre-m0079,
	// reply_to NONE → FIFO queue). A stamped reply whose consult is outside this window pairs with
	// nothing — it declared its target, so it never leaks into the FIFO fallback. The FIFO queue
	// admits ONLY concierge-origin rows: worker messages also land on this mailbox now, and an
	// unstamped non-concierge row must never mis-pair as an advisory reply (F-008).
	const exact = new Map<string, Record<string, unknown>>();
	const legacy: Array<Record<string, unknown>> = [];
	for (const r of replies ?? []) {
		const target = recordToString(r.reply_to);
		if (target) {
			if (!exact.has(target)) exact.set(target, r);
		} else if (r.sender_pm != null && String(r.sender_pm) === ATELIER_SELF_PM) {
			legacy.push(r);
		}
	}
	let li = 0;
	return (consults ?? []).map((c) => {
		const cid = recordToString(c.id);
		// Exact first; else the next legacy reply in landing order (?? short-circuits, so a legacy
		// reply is only CONSUMED when no exact reply claimed this consult).
		const reply = (cid ? exact.get(cid) : undefined) ?? legacy[li++];
		return {
			id: recordToString(c.id) ?? '',
			project: box.project,
			need: needFromClientKey(c.client_key),
			asked: askedFromBody(c.body),
			status: reply ? 'answered' : 'pending',
			advisory:
				reply && typeof reply.body === 'string' && reply.body.length > 0
					? unfence(reply.body)
					: null,
			askedAt: isoOrNull(c.created_at),
			answeredAt: reply ? isoOrNull(reply.created_at) : null
		};
	});
}

/**
 * List concierge advisories, newest-consult-first — one project's (opts.projectId) or all projects'
 * (the /brain cross-project view). Every row traces to a real consult peer_message (F-008); honest
 * [] when no consult was ever emitted. Read-only; a throw is the caller's honest-partial to absorb
 * (both loaders wrap it, mirroring listRecentDecisions).
 */
export async function listConciergeAdvisories(
	db: Db,
	opts: { projectId?: string; limit?: number } = {}
): Promise<ConciergeAdvisoryRow[]> {
	const n = clampLimit(opts.limit);
	const boxes = await findMailboxes(db, opts.projectId);
	if (boxes.length === 0) return [];
	const perBox = await Promise.all(boxes.map((b) => readMailbox(db, b)));
	return perBox
		.flat()
		.sort((a, b) => (b.askedAt ?? '').localeCompare(a.askedAt ?? ''))
		.slice(0, n);
}
