// TASK 10.2 — RightTray mark-read endpoint (loopback control, D-025; D-016; F-008).
//
// POST /api/notifications  { action: 'read', id: 'notification:<id>' }  → mark one read
//                          { action: 'read-all' }                       → mark all read
//
// The mutation is a plain guarded UPDATE off the DB singleton; the change reaches the UI
// LIVE via the `notification` SSE watcher (§2.11) — the tray + Topbar badge re-derive from
// the re-invalidated layout load, never a fabricated optimistic count. We still echo the
// fresh unread count so the caller can confirm. Protection = the m0071 login gate (loopback bypasses it; external needs the signed SameSite=lax cookie), NOT the server bind.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import { markRead, markAllRead } from '$lib/server/notifications/repo';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string };
	const action = body.action;

	try {
		if (action === 'read') {
			if (typeof body.id !== 'string' || !body.id) throw error(400, 'read requires an id');
			const unread = await markRead(db, body.id);
			return json({ ok: true, action, unread });
		}
		if (action === 'read-all') {
			const unread = await markAllRead(db);
			return json({ ok: true, action, unread });
		}
		throw error(400, `unknown action: ${action ?? '(none)'}`);
	} catch (err) {
		// A malformed id is a 400 at the D-016 boundary, not a 500.
		if (err instanceof IdentifierError) throw error(400, 'invalid notification id');
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(500, (err as Error).message);
	}
};
