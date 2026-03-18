import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import {
	getPendingConfirmations,
	confirmToolCalls,
	denyToolCalls
} from '$lib/server/session-manager.js';

/**
 * GET: Retrieve pending tool confirmations for a session.
 * Returns { pending: PendingToolCall[] }
 */
export const GET: RequestHandler = async ({ params }) => {
	const sessionId = params.id;
	const pending = getPendingConfirmations(sessionId);
	return json({ pending });
};

/**
 * POST: Confirm or deny pending tool calls.
 *
 * Body:
 *   { action: 'confirm', toolCallIds?: string[] }  — confirm specific or all pending tools
 *   { action: 'deny' }                              — deny all pending tools
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const sessionId = params.id;

	let body: { action: string; toolCallIds?: string[] };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!body.action || !['confirm', 'deny'].includes(body.action)) {
		return json({ error: 'action must be "confirm" or "deny"' }, { status: 400 });
	}

	if (body.action === 'confirm') {
		const ok = await confirmToolCalls(sessionId, body.toolCallIds);
		if (!ok) {
			return json({ error: 'No pending confirmations for this session' }, { status: 404 });
		}
		return json({ success: true, action: 'confirmed' });
	}

	// deny
	const ok = await denyToolCalls(sessionId);
	if (!ok) {
		return json({ error: 'No pending confirmations for this session' }, { status: 404 });
	}
	return json({ success: true, action: 'denied' });
};
