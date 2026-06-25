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
import {
	applyBriefDecision,
	applyRepoCreateDecision,
	BriefError,
	RepoCreateGateError,
	getBrief,
	type BriefAction
} from '$lib/server/projects';
import { env } from '$env/dynamic/private';
import {
	applyHireDecision,
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
		// HR-5 — a cert_hire brief has its OWN decide-effect (cert flip + staffing feed, B4); it is
		// NOT a task brief, so applyBriefDecision would reject it. Dispatch on artifact_kind. The
		// hire-gate has only approve/reject (no defer); approve REQUIRES operatorConfirmed (B4).
		const brief = await getBrief(db, body.id);
		if (brief?.artifact_kind === 'cert_hire') {
			if (body.action === 'defer') {
				throw error(400, 'a hire-gate brief is approve/reject only — there is no defer (the candidate stays open until decided)');
			}
			const result = await applyHireDecision(db, body.id, body.action as 'approve' | 'reject', {
				operatorConfirmed: body.operatorConfirmed === true,
				...(typeof body.staffingProposal === 'string' && body.staffingProposal
					? { staffingProposal: body.staffingProposal }
					: {})
			});
			return json({
				ok: true,
				action: body.action,
				briefStatus: result.brief.status,
				recommendation: result.recommendation,
				lifecycle: result.lifecycle,
				certFlipped: result.certFlipped,
				...(result.staffing ? { staffed: result.staffing.staffed, staff: result.staffing.staff.id } : {})
			});
		}

		// RC-3 — a repo_create brief has its OWN decide-effect (the RC-2 outward gate); it is NOT a
		// task brief, so applyBriefDecision would reject it. Dispatch on artifact_kind (mirrors
		// cert_hire). approve/reject only (no defer — the project stays repo-less until decided);
		// approve REQUIRES operatorConfirmed (B4 — the integrity wall: a PM/agent cannot set it, so a
		// PM-proposed repo-create can NEVER reach the gate without the operator's explicit confirm).
		if (brief?.artifact_kind === 'repo_create') {
			if (body.action === 'defer') {
				throw error(400, 'a repo-create brief is approve/reject only — there is no defer (the project stays repo-less until decided)');
			}
			const result = await applyRepoCreateDecision(db, body.id, body.action as 'approve' | 'reject', {
				env,
				operatorConfirmed: body.operatorConfirmed === true
			});
			return json({
				ok: true,
				action: body.action,
				briefStatus: result.brief.status,
				created: result.gate?.created ?? false,
				...(result.gate?.failedAt ? { failedAt: result.gate.failedAt } : {}),
				...(result.gate?.summary ? { gateSummary: result.gate.summary } : {}),
				...(result.repoUrl ? { repoUrl: result.repoUrl } : {})
			});
		}

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
