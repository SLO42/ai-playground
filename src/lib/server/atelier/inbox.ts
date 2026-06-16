// server/atelier/inbox — G-C §5b: the INBOX / COMMS LENS over the fleet's `peer_message`
// bus (GLOBAL-TRANSCRIPT-SPEC §5b). A READ-ONLY operational view of what is QUEUED / STUCK /
// DROPPED on the agent↔agent bus — the dimension the timeline (reasoning/actions) does NOT
// give. The timeline shows comms that REACHED a transcript; this lens shows the routing
// envelope itself, filterable by `status`:
//
//   • pending      — sent, not yet drained to a recipient session (incl. the D-040 pm/atelier
//                    placeholder rows that sit pending until the `session.pm` seam lands).
//   • delivered    — drained into a recipient session (a `message` row also exists, G-A).
//   • expired      — TTL/hops elapsed before delivery (dropped, honestly visible — not silent).
//   • quarantined  — the write-time screen tripped a quarantineOnHit rule (D-026 fail-closed):
//                    the row holds the REDACTED text, never the raw secret. Visible, not dropped.
//
// Each item shows from→to (sender/recipient IDENTITY), the ALREADY-screened+fenced body
// (D-026 — this is a READ feature; it does NOT unscreen or re-introduce raw bodies), and
// age + hops. HONEST about the D-040 placeholder: a `pm`/`atelier` address has no concrete
// recipient identity yet (no `session.pm` seam), so those rows are LABELLED "awaiting recipient
// identity" — never silently shown as if routed.
//
// BOUNDED BY CONSTRUCTION (F-014 / D-024): the fleet bus is large, so this is NEVER an unbounded
// scan. The read is newest-first with a time-window + `LIMIT pageSize+1` (the +1 tells the pager
// whether an older page exists) + an optional `before` cursor + an optional `status` filter +
// an optional project scope. A failing read is NOT swallowed into a fake-empty: the loader maps
// it to a named DB error → an honest "unavailable" state (F-008).
//
// BOUNDARY (D-016): every record-id flows through assertRecordId and binds as a StringRecordId;
// the only interpolation is parameterized clause SHAPE (a fixed internal allow-list of column
// names), NEVER a value.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { PeerStatus } from '../peer/repo';
import type { ToKind } from '../peer/resolve';
import type { TimelineScope } from './timeline';

// ── Bounds (frozen — §5b / F-014) ──────────────────────────────────────────────────────

/** Default inbox page size (mirrors the timeline ~50). */
export const DEFAULT_INBOX_PAGE_SIZE = 50;
/** Hard cap so a hostile `?size=` cannot turn the lens into an unbounded scan. */
export const MAX_INBOX_PAGE_SIZE = 200;
/** Default trailing window: 7 days (tunable via `sinceMs`) — matches the timeline window. */
export const DEFAULT_INBOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The four lifecycle states a peer_message row can be in (mirrors the m0039 status ASSERT). */
export const INBOX_STATUSES: readonly PeerStatus[] = [
	'pending',
	'delivered',
	'expired',
	'quarantined'
] as const;

/** Type-guard for a caller-supplied status filter (anything else ⇒ no status filter / 'all'). */
export function isInboxStatus(v: unknown): v is PeerStatus {
	return v === 'pending' || v === 'delivered' || v === 'expired' || v === 'quarantined';
}

// ── The inbox item (one peer_message row, display-shaped) ───────────────────────────────

/** One inbox-lens item — a peer_message row projected to plain, already-screened display fields.
 *  Every field is plain-serializable (F-013 — datetimes already ISO strings); the `body` is the
 *  write-time screened+fenced envelope (NEVER raw). */
export interface InboxItem {
	/** Stable key (the source row id). */
	id: string;
	/** Lifecycle state (pending / delivered / expired / quarantined). */
	status: PeerStatus;
	/** Sender identity label (the role slug if it has one, else "session <id>"). Display-only. */
	from: string;
	/** Recipient identity label. For a `pm`/`atelier` address with no concrete recipient yet, this
	 *  is the address word ('pm'/'atelier'); `recipientPending` is true so the UI shows the honest
	 *  "awaiting recipient identity" note (the D-040 placeholder), never a fabricated session. */
	to: string;
	/** The destination class (session / role / pm / atelier) — drives the placeholder note. */
	toKind: ToKind;
	/** True when the recipient identity is not yet resolvable (a `pm`/`atelier` D-040 placeholder
	 *  row that sits pending until the `session.pm` seam lands). HONEST, never silent. */
	recipientPending: boolean;
	/** The ALREADY-screened+fenced body (D-026 — never raw). */
	body: string;
	/** Relay TTL remaining (0 = terminal). */
	hops: number;
	/** ISO-8601 creation timestamp (the order/age key). Null when absent/unparseable (→ '—'). */
	createdAt: string | null;
	/** ISO-8601 delivery timestamp, when delivered (else null → '—'). */
	deliveredAt: string | null;
	/** The project this comm is scoped to (short id), or '—' for a project-less address. */
	project: string;
}

export interface InboxPage {
	/** The active scope echoed back (the UI reflects the server's view). */
	scope: TimelineScope;
	/** The active status filter echoed back (null = all statuses). */
	status: PeerStatus | null;
	/** The inbox items, NEWEST-FIRST, at most `pageSize`. */
	items: InboxItem[];
	/** The cursor for the NEXT (older) page — pass as `before`. Null ⇒ no more (last page). */
	nextBefore: string | null;
	/** Per-status counts WITHIN the current window+scope (the filter chips' badges). Honest live
	 *  counts — never fabricated; a count read failure leaves this absent (the chips show no badge). */
	counts?: Record<PeerStatus, number>;
}

export interface InboxQuery {
	scope?: TimelineScope;
	/** Status filter; omit/null ⇒ all four statuses. */
	status?: PeerStatus | null;
	/** Page size (clamped 1..MAX_INBOX_PAGE_SIZE). */
	pageSize?: number;
	/** Cursor: return only rows strictly OLDER than this ISO timestamp (newest-first paging). */
	before?: string | null;
	/** Trailing window floor in ms (rows older than now-sinceMs are excluded). */
	sinceMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function str(v: unknown): string {
	return v == null ? '' : String(v);
}

/** F-013/F-008: SurrealDB 2.x datetime (non-POJO) → ISO string; absent/unparseable → null. */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

/** A short label for a record-link id ('table:abc' → 'abc'). Honest '—' for an absent value. */
function shortId(v: unknown): string {
	const s = str(v);
	if (!s) return '—';
	const i = s.indexOf(':');
	return i >= 0 ? s.slice(i + 1) : s;
}

function clampPageSize(n: number | undefined): number {
	if (!Number.isFinite(n as number) || (n as number) <= 0) return DEFAULT_INBOX_PAGE_SIZE;
	return Math.min(Math.floor(n as number), MAX_INBOX_PAGE_SIZE);
}

/** Build the recipient label + whether the recipient identity is a D-040 placeholder. A `pm`/
 *  `atelier` address has no concrete `session.pm` seam yet → the recipient is NOT resolvable, so
 *  the row is honestly "awaiting recipient identity" (recipientPending), labelled by the address
 *  word — never a fabricated session. A `session`/`role` address carries a concrete recipient. */
function recipientLabel(row: {
	to_kind: string;
	to_session: unknown;
	to_role: unknown;
}): { to: string; toKind: ToKind; recipientPending: boolean } {
	const kind = row.to_kind as ToKind;
	switch (kind) {
		case 'session':
			return { to: `session ${shortId(row.to_session)}`, toKind: 'session', recipientPending: false };
		case 'role':
			return { to: shortId(row.to_role), toKind: 'role', recipientPending: false };
		case 'pm':
			// D-040 placeholder: no `session.pm` seam → no concrete recipient identity yet (honest).
			return { to: 'pm', toKind: 'pm', recipientPending: true };
		case 'atelier':
			return { to: 'atelier', toKind: 'atelier', recipientPending: true };
		default:
			// Defensive: an unknown to_kind shows verbatim, marked pending (we can't resolve it).
			return { to: str(row.to_kind) || '—', toKind: kind, recipientPending: true };
	}
}

function normInboxItem(row: {
	id: unknown;
	from_session: unknown;
	from_role: unknown;
	to_kind: string;
	to_session: unknown;
	to_role: unknown;
	project: unknown;
	body: unknown;
	status: string;
	hops: unknown;
	created_at: unknown;
	delivered_at: unknown;
}): InboxItem {
	const rcpt = recipientLabel(row);
	return {
		id: str(row.id),
		status: row.status as PeerStatus,
		from: row.from_role != null ? shortId(row.from_role) : `session ${shortId(row.from_session)}`,
		to: rcpt.to,
		toKind: rcpt.toKind,
		recipientPending: rcpt.recipientPending,
		body: str(row.body),
		hops: Number.isFinite(Number(row.hops)) ? Number(row.hops) : 0,
		createdAt: isoOrNull(row.created_at),
		deliveredAt: isoOrNull(row.delivered_at),
		project: shortId(row.project)
	};
}

// ── The read ───────────────────────────────────────────────────────────────────────────

/**
 * Read ONE page of the fleet inbox lens, newest-first, BOUNDED (window + LIMIT pageSize+1 +
 * optional before cursor + optional status filter + optional project scope). Also returns the
 * per-status counts within the same window+scope (the chip badges) via ONE grouped count query.
 *
 * SHADOW PATHS:
 *   • nil/empty per-project scope id → throws at the D-016 chokepoint (a malformed id is a real
 *     bug — fail-loud, never a silent global page).
 *   • empty inbox → { items: [], nextBefore: null, counts: all-zero } (honest empty).
 *   • a DB/query fault → THROWS (the loader maps it to an honest "unavailable" — NOT swallowed
 *     into a fake-empty, which would lie that the bus is quiet, F-008). Note this differs from the
 *     timeline's best-effort multi-source merge: the inbox is a SINGLE table, so a failure here is
 *     total — there is no partial to honor.
 *
 * The body column is the write-time screened+fenced envelope (D-026); this read does NOT unscreen.
 */
export async function readInbox(db: Db, query: InboxQuery = {}): Promise<InboxPage> {
	const scope: TimelineScope = query.scope ?? { kind: 'global' };
	// Validate a per-project scope id EARLY (fail-loud at the boundary).
	if (scope.kind === 'project') assertRecordId(scope.project);

	const status: PeerStatus | null = isInboxStatus(query.status) ? query.status : null;
	const pageSize = clampPageSize(query.pageSize);
	const fetch = pageSize + 1; // +1 so the pager knows whether an older page exists
	const before = query.before && query.before.length > 0 ? query.before : null;
	const windowMs =
		Number.isFinite(query.sinceMs as number) && (query.sinceMs as number) > 0
			? (query.sinceMs as number)
			: DEFAULT_INBOX_WINDOW_MS;
	const cutoffIso = new Date(Date.now() - windowMs).toISOString();

	// WHERE clause shape — a fixed internal allow-list of columns; every VALUE binds via $param.
	const bind: Record<string, unknown> = { cutoff: new Date(cutoffIso), fetch };
	let where = 'created_at >= $cutoff';
	if (scope.kind === 'project') {
		where += ' AND project = $project';
		bind.project = link(scope.project);
	}
	if (status) {
		where += ' AND status = $status';
		bind.status = status;
	}
	let pageWhere = where;
	if (before) {
		pageWhere += ' AND created_at < $before';
		bind.before = new Date(before);
	}

	// Page read (status-filtered if requested) + the per-status count rollup (always over ALL
	// statuses within the window+scope, so the chip badges show the full picture regardless of the
	// active filter). Counts use the SAME window+scope (cutoff [+ project]) but NOT the status
	// filter nor the cursor — both statements share the one `bind` (SurrealDB binds are query-wide;
	// extra params the count statement does not name are simply unused).
	let countWhere = 'created_at >= $cutoff';
	if (scope.kind === 'project') {
		countWhere += ' AND project = $project';
	}

	const [pageRows, countRows] = await db.query<
		[
			Array<Parameters<typeof normInboxItem>[0]>,
			Array<{ status: string; c: number }>
		]
	>(
		`SELECT id, from_session, from_role, to_kind, to_session, to_role, project, body, status, hops,
		        created_at, delivered_at
		   FROM peer_message
		  WHERE ${pageWhere}
		  ORDER BY created_at DESC LIMIT $fetch;
		 SELECT status, count() AS c FROM peer_message WHERE ${countWhere} GROUP BY status;`,
		bind
	);

	const rows = pageRows ?? [];
	const hasMore = rows.length > pageSize;
	const kept = hasMore ? rows.slice(0, pageSize) : rows;
	const items = kept.map(normInboxItem);
	const nextBefore = hasMore && items.length > 0 ? items[items.length - 1].createdAt : null;

	// Per-status counts (honest live badges). Start every status at 0 so a status with no rows
	// reads an explicit 0, never absent-as-unknown.
	const counts: Record<PeerStatus, number> = {
		pending: 0,
		delivered: 0,
		expired: 0,
		quarantined: 0
	};
	for (const r of countRows ?? []) {
		if (isInboxStatus(r.status)) counts[r.status] = Number(r.c) || 0;
	}

	return { scope, status, items, nextBefore, counts };
}
