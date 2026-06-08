// The loopback CONTROL endpoint for session control — interject / stop / resume (TASK 6.7;
// D-011 / D-035 / D-025).
//
// This is THE D-035a "loopback control endpoint": a push that arrives HERE is the only path
// that may carry operator origin. We stamp `viaControlEndpoint: true` and present the
// per-boot HOOK_TOKEN to the channel seam, which constant-time compares it INTERNALLY to
// decide operator-origin steering — the runtime never sees the token. A push off any other
// path (the agent/SSE bus) can never be operator even if a token leaked (D-035a).
//
// Single-operator, local-first (D-025): the whole control plane is loopback-bound at the
// server bind (asserted in hooks.server.ts), so presenting the boot token here is the
// authenticated-operator signal. Every state change flows db → events → the one SSE (§2.11);
// the channel seam republishes the interject/session_status events, so the UI reflects it live.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { assertRecordId } from '$lib/server/db/validate';
import { createChannel } from '$lib/server/claude-code';
import {
	getBus,
	getBootToken,
	getRuntime,
	DEFAULT_MODEL,
	DEFAULT_AGENT,
	DEFAULT_BUDGETS,
	DEFAULT_TOOL_POLICY,
	DEFAULT_INTENT
} from '$lib/server/harness';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	// Validate the session id at the boundary (D-016) — a malformed id is a 400, not a query.
	let sessionId: string;
	try {
		sessionId = assertRecordId(`session:${params.id}`);
	} catch {
		throw error(400, 'invalid session id');
	}

	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const runtimeAvail = getRuntime();
	if (!runtimeAvail.available) {
		// Honest: control actions drive the real runtime; without a credential there is no
		// live session to steer (F-008 — never pretend it worked).
		throw error(503, runtimeAvail.reason);
	}

	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		message?: string;
		reason?: string;
	};
	const action = body.action;

	const channel = createChannel({
		db,
		bus: getBus(),
		runtime: runtimeAvail.runtime,
		bootToken: getBootToken()
	});

	try {
		if (action === 'interject') {
			const message = typeof body.message === 'string' ? body.message.trim() : '';
			if (!message) throw error(400, 'interject requires a non-empty message');
			// viaControlEndpoint + the boot token are the D-035a operator-origin signal. The
			// channel stamps origin server-side and never trusts the body.
			const result = await channel.interject({
				sessionId,
				body: message,
				presentedToken: getBootToken(),
				viaControlEndpoint: true
			});
			return json({ ok: true, action, origin: result.origin, steered: result.steered });
		}

		if (action === 'stop') {
			const result = await channel.stop({
				sessionId,
				agentId: DEFAULT_AGENT,
				...(typeof body.reason === 'string' ? { reason: body.reason } : {})
			});
			return json({ ok: true, action, status: result.status });
		}

		if (action === 'resume') {
			const result = await channel.resume({
				sessionId,
				agentId: DEFAULT_AGENT,
				model: DEFAULT_MODEL,
				intent: DEFAULT_INTENT,
				budgets: DEFAULT_BUDGETS,
				toolPolicy: DEFAULT_TOOL_POLICY
			});
			return json({ ok: true, action, status: result.status });
		}

		throw error(400, `unknown control action: ${action ?? '(none)'}`);
	} catch (err) {
		// Rethrow SvelteKit HttpErrors; wrap real failures with their honest message (§11).
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(500, (err as Error).message);
	}
};
