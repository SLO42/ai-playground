// The control-plane GATE endpoint (TASK 13.3; D-018/D-024/D-025; ARCHITECTURE §2.10e).
//
// scripts/gate-hook.mjs (the PreToolUse hook cli-backend.ts registers in every gated
// spawn's isolated settings) POSTs { config, payload } here over LOOPBACK. We authorize
// (D-025: per-boot token + loopback Origin/Host) then consult the gate layer
// (gate-transport.handleGatePreToolUse → gates.gatePreToolUse) and return the permission
// decision Claude Code enforces.
//
// UNLIKE the analytics ingest (api/hooks/[event], which always returns {} and never
// carries a safety decision — D-019), this endpoint IS a safety decision path and FAILS
// CLOSED (D-024): an unauthorized request, a malformed body, or a malformed gate config
// all yield an explicit DENY. The hook script likewise denies on any transport failure.

import { json } from '@sveltejs/kit';
import { authorizeHookRequest } from '$lib/server/hooks';
import {
	handleGatePreToolUse,
	gateDenyOutput,
	recordGateDenyIncident
} from '$lib/server/claude-code/gate-transport';
import { tryGetDb } from '$lib/server/db/runtime-init';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	// D-025 auth — token + loopback Origin/Host. Fail-closed: an unauthorized caller gets
	// an explicit deny (the hook script also treats any non-200 as deny).
	const auth = authorizeHookRequest(request.headers, process.env);
	if (!auth.ok) {
		return json(gateDenyOutput('unauthorized gate request — failing closed (D-024/D-025)'), {
			status: 401
		});
	}

	let body: unknown = null;
	try {
		body = await request.json();
	} catch {
		body = null; // handleGatePreToolUse denies a malformed body (fail closed)
	}
	const decision = handleGatePreToolUse(body);

	// TASK 15.1 — a safety-critical deny is an OPERATOR-VISIBLE incident ("the deny + the
	// incident"). Strictly best-effort observability AFTER the decision: a missing DB or a
	// write failure never alters the (already fail-closed) decision returned to the hook.
	if (decision.hookSpecificOutput.permissionDecision === 'deny') {
		const db = tryGetDb();
		if (db) {
			const payload = (body as { payload?: { session_id?: string; tool_name?: string } } | null)
				?.payload;
			await recordGateDenyIncident(db, decision, payload ?? {}).catch(() => {});
		}
	}
	return json(decision);
};
