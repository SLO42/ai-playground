// server/sessions/messages — transcript read-side for the Sessions surface (TASK 6.7).
//
// The transcript STREAMS live via the `transcript` bus event (launch.ts republishes each
// runtime event onto the one bus → SSE, §2.11). This read-side supplies the HISTORICAL
// transcript (the message rows already persisted) when a view first opens a session — so a
// reload, or opening a finished session, shows what happened. Every row is a real `message`
// row the runtime stream produced (F-008 — nothing fabricated).
//
// Boundary discipline (D-016): the session id flows through assertRecordId and binds as a
// StringRecordId; no value is interpolated into the query.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** One transcript message, projected to plain serializable values for the page. */
export interface TranscriptMessage {
	id: string;
	role: string;
	content: string;
	/** Tool-call metadata when the message is a tool turn (name/args/ok/origin/steer). */
	toolCall?: Record<string, unknown>;
	at: string;
}

/**
 * Read a session's persisted transcript, oldest first. Returns [] for an unknown session
 * (honest empty, never a fabricated row). The session id is validated at the D-016 chokepoint.
 */
export async function listSessionMessages(
	db: Db,
	sessionId: string,
	limit = 500
): Promise<TranscriptMessage[]> {
	const sid = new StringRecordId(assertRecordId(sessionId));
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				role: string;
				content: string;
				tool_call?: Record<string, unknown>;
				at: unknown;
			}>
		]
	>(`SELECT id, role, content, tool_call, at FROM message WHERE session = $sid ORDER BY at ASC LIMIT $lim;`, {
		sid,
		lim: limit
	});
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		role: r.role,
		content: r.content,
		...(r.tool_call ? { toolCall: r.tool_call } : {}),
		at: r.at != null ? String(r.at) : ''
	}));
}
