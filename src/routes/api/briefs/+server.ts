// TASK 16.4 / PJH-1 — decision-brief decide endpoint; protected by m0071 login gate (D-025; D-016; F-008).
//
// POST /api/briefs  { id: 'decision_brief:<id>', action: 'approve' | 'reject' | 'defer',
//                     operatorConfirmed?: boolean, staffingProposal?: string }
//
// The RightTray decisions inbox posts here. The per-kind routing lives in ONE place — applyBriefDecision
// (PJH-1): it dispatches on the brief's artifact_kind, routing each kind through its EXISTING gate/effect
// (F-055 — never a second call path): task → the panel-gated promotion; cert_hire → the workforce hire
// path (B4 operator gate); repo_create → the RC-2 outward gate; review/fixture/unknown → an honest typed
// refusal. operatorConfirmed / staffingProposal are threaded from THIS loopback request (never agent text
// — the integrity wall). The change reaches the UI live via the `decision_brief`/`task` SSE watchers.

import { json, error } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import {
	applyBriefDecision,
	BriefActionError,
	BriefError,
	RepoCreateGateError,
	type BriefAction
} from '$lib/server/projects';
import {
	HireGateError,
	StaffingGateError,
	WorkforceInputError
} from '$lib/server/workforce';
import type { RequestHandler } from './$types';

const ACTIONS: readonly BriefAction[] = ['approve', 'reject', 'defer'];

export const POST: RequestHandler = async ({ request }) => {
	const db = tryGetDb();
	if (!db) throw error(503, 'database not connected');

	const body = (await request.json().catch(() => ({}))) as {
		id?: string;
		action?: string;
		operatorConfirmed?: boolean;
		staffingProposal?: string;
	};
	if (typeof body.id !== 'string' || !body.id) throw error(400, 'a brief id is required');
	if (!ACTIONS.includes(body.action as BriefAction)) {
		throw error(400, `action must be one of ${ACTIONS.join(' | ')} (got ${body.action ?? '(none)'})`);
	}

	try {
		// ONE dispatcher (PJH-1): applyBriefDecision routes on artifact_kind through each kind's EXISTING
		// gate/effect. operatorConfirmed (B4) + staffingProposal are threaded from THIS operator-driven
		// loopback request — a cert_hire/repo_create APPROVE fails CLOSED inside the effect without them.
		// A defer on an approve/reject-only kind (cert_hire/repo_create) is a typed BriefError → 409 below.
		const result = await applyBriefDecision(db, body.id, body.action as BriefAction, {
			operatorConfirmed: body.operatorConfirmed === true,
			...(typeof body.staffingProposal === 'string' && body.staffingProposal
				? { staffingProposal: body.staffingProposal }
				: {})
		});

		// Render per kind (a discriminated result — the surface fields differ by effect).
		if (result.kind === 'cert_hire') {
			const hire = result.hire!;
			return json({
				ok: true,
				action: body.action,
				briefStatus: result.brief.status,
				recommendation: hire.recommendation,
				lifecycle: hire.lifecycle,
				certFlipped: hire.certFlipped,
				...(hire.staffed !== undefined ? { staffed: hire.staffed, staff: hire.staffId } : {})
			});
		}
		if (result.kind === 'repo_create') {
			const repo = result.repo!;
			return json({
				ok: true,
				action: body.action,
				briefStatus: result.brief.status,
				created: repo.created,
				...(repo.failedAt ? { failedAt: repo.failedAt } : {}),
				...(repo.summary ? { gateSummary: repo.summary } : {}),
				...(repo.repoUrl ? { repoUrl: repo.repoUrl } : {})
			});
		}
		// task (the common shape — task status + any defer window).
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
		// A defer on an approve/reject-only kind (cert_hire / repo_create) — a client-side bad-action
		// (the tray hides the Defer control for those kinds; this is the server backstop). Checked BEFORE
		// BriefError (its superclass) so it maps to 400, distinct from a 409 state/authority refusal.
		if (err instanceof BriefActionError) throw error(400, err.message);
		if (err instanceof HireGateError) throw error(409, err.message);
		// HR-5 staffing feed: an approve with a STALE/wrong-kind/disposed staffingProposal makes
		// confirmStaffing throw StaffingGateError / WorkforceInputError — a fail-closed boundary
		// violation, not a server fault. Surface it as a clean 409 (never a masked 500). The cert
		// flip already landed (effect-then-ceremony); the brief stays open until a valid proposal
		// re-confirms (or the operator certifies-only by omitting it).
		if (err instanceof StaffingGateError) throw error(409, err.message);
		if (err instanceof WorkforceInputError) throw error(409, err.message);
		// RC-3: an approve without operatorConfirmed, a wrong-kind/stale brief — a fail-closed boundary
		// violation, not a server fault (the integrity wall surfaces here as a clean 409).
		if (err instanceof RepoCreateGateError) throw error(409, err.message);
		if (err instanceof BriefError) throw error(409, err.message);
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(500, (err as Error).message);
	}
};
