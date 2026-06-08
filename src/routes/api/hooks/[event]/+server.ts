// The control-plane hook ingest endpoint (TASK 1.9; D-019/D-024/D-025).
//
// The hook-proxy (scripts/hook-proxy.mjs) POSTs Claude Code lifecycle hooks here over
// LOOPBACK. We authorize (D-025: per-boot token + loopback Origin/Host) then record
// the event as ANALYTICS ONLY (D-024) into `agent_event`, best-effort. The response
// is ALWAYS the empty/continue object `{}` — NO permission/gate decision is ever
// returned, so a safety constraint can never depend on this best-effort path.
//
// Loopback binding is asserted at the server bind (D-025), not here. A rejected auth
// returns {} too (the proxy treats any response as continue) — we never leak why, and
// we never block: best-effort by contract (D-019).

import { json } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { authorizeHookRequest, ingestHookEvent } from '$lib/server/hooks';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	// D-025 auth — token + loopback Origin/Host. Fail-closed, but still return {} so
	// the proxy (and thus the session) proceeds untouched (D-019: never block).
	const auth = authorizeHookRequest(request.headers, process.env);
	if (!auth.ok) return json({});

	// Parse the payload defensively — a malformed body must not error the session.
	let payload: unknown = {};
	try {
		payload = await request.json();
	} catch {
		payload = {};
	}

	const db = tryGetDb();
	const res = await ingestHookEvent(params.event, payload, {
		// Best-effort analytics write; ingest swallows a throw (DB down → no-op, D-019).
		write: async (table, row) => {
			if (!db) throw new Error('db not connected'); // swallowed by ingest → no-op
			await db.query(`CREATE type::table($t) CONTENT $row;`, { t: table, row });
		}
	});

	// ALWAYS the continue/empty response — analytics only, never a gate decision (D-024).
	return json(res);
};
