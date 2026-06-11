// TASK 16.4 — decision-brief decide endpoint (loopback control, D-025; D-016; F-008).
//
// POST /api/briefs  { id: 'decision_brief:<id>', action: 'approve' | 'reject' | 'defer' }
//
// The RightTray decisions inbox posts here. The EFFECTS are mechanical + server-side
// (applyBriefDecision — §2.2/D-035): approve promotes the proposed task to 'ready',
// reject withdraws it (verdicts close 'overridden_by_operator'/'upheld' per their
// value), defer stamps a cadence-derived window the structural fingerprint honors.
// The change reaches the UI live via the `decision_brief`/`task` SSE watchers.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import { applyBriefDecision, BriefError, type BriefAction } from '$lib/server/projects';
import type { RequestHandler } from './$types';

const ACTIONS: readonly BriefAction[] = ['approve', 'reject', 'defer'];

export const POST: RequestHandler = async ({ request }) => {
	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const body = (await request.json().catch(() => ({}))) as { id?: string; action?: string };
	if (typeof body.id !== 'string' || !body.id) throw error(400, 'a brief id is required');
	if (!ACTIONS.includes(body.action as BriefAction)) {
		throw error(400, `action must be one of ${ACTIONS.join(' | ')} (got ${body.action ?? '(none)'})`);
	}

	try {
		const result = await applyBriefDecision(db, body.id, body.action as BriefAction);
		return json({
			ok: true,
			action: body.action,
			briefStatus: result.brief.status,
			...(result.taskStatus ? { taskStatus: result.taskStatus } : {}),
			...(result.brief.defer_until ? { deferUntil: result.brief.defer_until } : {})
		});
	} catch (err) {
		// Boundary errors are 4xx with their honest names, never a masked 500.
		if (err instanceof IdentifierError) throw error(400, 'invalid brief id');
		if (err instanceof BriefError) throw error(409, err.message);
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(500, (err as Error).message);
	}
};
