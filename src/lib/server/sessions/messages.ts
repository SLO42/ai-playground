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
	/** Replay discriminator (m0037): assistant_text | thinking | tool_use | tool_result |
	 *  result | briefing | system | user. Absent on rows written before m0037. */
	kind?: string;
	/** Per-session monotonic replay order (m0037). 0 for legacy rows that predate the field. */
	seq?: number;
	/** Server-authoritative, immutable origin (m0038 / D-035a): operator | agent | system |
	 *  hook. Stamped at the authenticated ingress, NEVER derived from content; only `operator`
	 *  steers. ALWAYS present — legacy rows predating the field coalesce to the honest `agent`
	 *  default at read time. This is the AUTHORITY a reader uses to distinguish a pushed-in
	 *  communication from the agent's own prose — exposing it adds NO steering/forgery path
	 *  (the value is the server stamp, period). */
	origin: string;
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
	// Order by seq (m0037 — the authoritative per-session replay order, immune to
	// same-millisecond `at` ties a fast stream produces) then `at` as a stable tiebreaker that
	// also preserves the order of legacy rows written before seq existed (their seq reads NONE,
	// which sorts together — `at` keeps them in wall-clock order).
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				role: string;
				kind?: string;
				seq?: number;
				origin?: string;
				content: string;
				tool_call?: Record<string, unknown>;
				at: unknown;
			}>
		]
	>(
		// m0038: COALESCE origin → "agent" in the projection. The schema DEFAULT only fires on
		// CREATE, so the ~178 rows that predate m0038 store NO origin and read back NONE; `??`
		// stamps the honest `agent` default at read time (a legacy row is the agent's OWN
		// transcript turn — NEVER operator/steering). Same shape as the seq/kind NONE handling;
		// this is the F-013/F-015 rule — never return a raw NONE that the UI renders as absent.
		`SELECT id, role, kind, seq, origin ?? "agent" AS origin, content, tool_call, at FROM message WHERE session = $sid ORDER BY seq ASC, at ASC LIMIT $lim;`,
		{ sid, lim: limit }
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		role: r.role,
		...(r.kind != null ? { kind: r.kind } : {}),
		...(r.seq != null ? { seq: r.seq } : {}),
		// origin is always present after the `?? "agent"` coalesce above (legacy NONE → agent).
		origin: r.origin ?? 'agent',
		content: r.content,
		...(r.tool_call ? { toolCall: r.tool_call } : {}),
		at: r.at != null ? String(r.at) : ''
	}));
}
