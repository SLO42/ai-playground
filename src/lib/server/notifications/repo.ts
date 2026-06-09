// TASK 10.2 — RightTray read model + mark-read mutations (UI-SPEC §3/§85/§147/§208;
// F-008; D-016; D-019; F-013).
//
// The slide-in right tray surfaces TWO real row sources, merged newest-first into one
// transient feed (UI-SPEC §85 "notifications + recent activity"):
//   • `notification` rows — durable operator notices (message + read flag), the unread
//     count drives the Topbar badge.
//   • `agent_event` rows  — the recent engine-activity feed (spawn/completion/error/…).
// Both are REAL rows (F-008): an empty engine yields an empty feed + a 0 unread badge,
// never a fabricated notice.
//
// F-013 GOTCHA: SurrealDB 2.x datetime fields come back as a non-POJO `DateTime` class
// (not a JS Date) which breaks SvelteKit's load serializer. EVERY datetime that crosses
// a page-load boundary is coerced to an ISO string in the row normalizer here, and the
// repo test reads a SET datetime back through this exact projection as a regression.
//
// D-016: the only interpolated identifier is a validated record id (assertRecordId); all
// values flow through $param bindings. Mutations are plain UPDATEs off the DB singleton —
// the change reaches the UI live via the `notification` SSE watcher (§2.11), never a 2nd query.

import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A durable operator notification (a real `notification` row; F-008). */
export interface NotificationItem {
	/** Distinct kind so the tray + the merged feed can tag/route each item. */
	kind: 'notification';
	id: string;
	message: string;
	read: boolean;
	/** ISO timestamp (coerced from the SurrealDB DateTime — F-013). */
	at: string;
}

/** One recent agent lifecycle event for the activity feed (a real `agent_event` row; F-008). */
export interface ActivityEventItem {
	kind: 'activity';
	id: string;
	/** Lifecycle type: spawn | completion | error | escalation | cancel. */
	type: string;
	/** ISO timestamp (coerced from the SurrealDB DateTime — F-013). */
	at: string;
	/** provider/model_id when the event carried a model, else null. */
	model: string | null;
	/** Linked session id (table:id) when present. */
	sessionId: string | null;
	/** Linked project id (table:id) when present. */
	projectId: string | null;
}

/** A single tray feed item — either a durable notification or a recent activity event. */
export type TrayItem = NotificationItem | ActivityEventItem;

/** The full tray read model the layout loader serves (all real rows; F-008). */
export interface TrayData {
	/** Notifications + recent activity, merged newest-first (bounded). */
	items: TrayItem[];
	/** Count of UNREAD `notification` rows — drives the Topbar badge. */
	unread: number;
}

/**
 * Normalise a SurrealDB datetime to an ISO string (F-013). The 2.x JS SDK returns a
 * `DateTime` class instance (NOT a JS `Date`); both expose `toISOString()`, so we accept
 * either, then fall back to a plain string. Anything else ⇒ '' (rendered as "—"; honest).
 */
function iso(at: unknown): string {
	if (at instanceof Date) return at.toISOString();
	if (typeof at === 'string') return at;
	if (at && typeof (at as { toISOString?: unknown }).toISOString === 'function') {
		try {
			return (at as { toISOString: () => string }).toISOString();
		} catch {
			return '';
		}
	}
	return '';
}

/** Project a raw `notification` row to a serializable {@link NotificationItem} (F-013 datetime). */
function toNotification(r: Record<string, unknown>): NotificationItem {
	return {
		kind: 'notification',
		id: String(r.id),
		message: String(r.message ?? ''),
		read: r.read === true,
		at: iso(r.at)
	};
}

/** Project a raw `agent_event` row to a serializable {@link ActivityEventItem} (F-013 datetime). */
function toActivity(r: Record<string, unknown>): ActivityEventItem {
	const m = (r.model ?? null) as Record<string, unknown> | null;
	const model =
		m && (m.provider || m.model_id)
			? `${String(m.provider ?? '?')}/${String(m.model_id ?? '?')}`
			: null;
	return {
		kind: 'activity',
		id: String(r.id),
		type: String(r.type ?? 'event'),
		at: iso(r.at),
		model,
		sessionId: r.session ? String(r.session) : null,
		projectId: r.project ? String(r.project) : null
	};
}

/** Read the count of UNREAD `notification` rows (real GROUP/count; F-008). */
export async function unreadCount(db: Db): Promise<number> {
	const [rows] = await db.query<[Array<{ c?: number }>]>(
		`SELECT count() AS c FROM notification WHERE read = false GROUP ALL;`
	);
	const c = rows?.[0]?.c;
	return typeof c === 'number' ? c : 0;
}

/**
 * Build the tray read model (F-008): the most recent notifications + agent events, merged
 * newest-first and bounded to `limit`, plus the unread-notification count for the badge.
 * Empty sources ⇒ `{ items: [], unread: 0 }` — an honest empty tray, never fabricated.
 */
export async function buildTrayData(db: Db, limit = 20): Promise<TrayData> {
	const [notifRows, eventRows] = await db.query<
		[Array<Record<string, unknown>>, Array<Record<string, unknown>>]
	>(
		`SELECT id, message, read, at FROM notification ORDER BY at DESC LIMIT $lim;
		 SELECT id, type, at, model, session, project FROM agent_event ORDER BY at DESC LIMIT $lim;`,
		{ lim: limit }
	);

	const notifications = (notifRows ?? []).map(toNotification);
	const activity = (eventRows ?? []).map(toActivity);

	// Merge newest-first by ISO timestamp (string compare is correct for ISO-8601), then bound.
	const items: TrayItem[] = [...notifications, ...activity]
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
		.slice(0, limit);

	const unread = notifications.filter((n) => !n.read).length;
	// If the notification window was saturated (all `limit` rows unread), fall back to a real
	// count so the badge never under-reports beyond the page (honest; F-008).
	const unreadTotal = notifications.length >= limit ? await unreadCount(db) : unread;

	return { items, unread: unreadTotal };
}

/**
 * Mark ONE notification read (D-016: the id is validated before interpolation). Idempotent —
 * marking an already-read row is a no-op UPDATE. Returns the new (post-update) unread count so
 * the caller can echo it; the live UI also re-derives it from the `notification` SSE watcher.
 */
export async function markRead(db: Db, id: string): Promise<number> {
	const recordId = assertRecordId(id);
	await db.query(`UPDATE type::thing($id) SET read = true;`, { id: recordId });
	return unreadCount(db);
}

/** Mark ALL notifications read in one statement (F-008: real rows only). Returns 0 (no unread left). */
export async function markAllRead(db: Db): Promise<number> {
	await db.query(`UPDATE notification SET read = true WHERE read = false;`);
	return unreadCount(db);
}
