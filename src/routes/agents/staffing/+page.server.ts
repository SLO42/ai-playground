// CAPABILITY-MATCH-SPEC (BL-3) — the OPERATOR-GATED PROJECT STAFFING surface (§5/§6 'Surfaces').
//
// Per project: its declared capability_needs, the data-driven matcher recommendations
// (REUSE/EXTEND/HIRE + evidence — recommendStaffing, PROPOSE-ONLY), the OPEN staffing proposals,
// and the currently-staffed roles. The gated actions:
//   • propose  — open a review_proposal{kind:'staffing'} for a REUSE candidate (PROPOSE-ONLY: no
//                project_staff write happens; the matcher PROVES the candidate first).
//   • confirm  — the operator's D-039 confirm → staffRole writes the row (the ONLY staff path).
//   • reject   — close the staffing proposal terminally (reuse §5 rejectProposal).
//   • unstaff  — soft un-staff an enabled role (operator-gated G2 suppression-shaped act).
// NO auto-staff path. Honest empties (F-008): a project with no declared defect_classes shows the
// honest "no needs declared" state; an unknown class is REJECTED at the needs boundary. Live off
// the ONE app:workforce SSE stream (D-035) — a propose/confirm/reject writes review_proposal /
// project_staff / role_event rows, all watched on /agents.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { listProjects } from '$lib/server/projects/repo';
import {
	confirmStaffing,
	loadProjectStaffingView,
	proposeStaffing,
	rejectStaffing,
	unstaffRole,
	StaffingGateError,
	CapabilityNeedsError,
	WorkforceInputError,
	type ProjectStaffingView
} from '$lib/server/workforce';
import { assertRecordId } from '$lib/server/db/validate';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface StaffingPageData {
	connected: boolean;
	/** One view per project that has any declared capability needs OR any candidates — projects
	 *  with nothing to match are omitted (honest: the surface is the staffing decision board, not
	 *  a project list). The whole list is empty when no project has declared needs yet. */
	views: ProjectStaffingView[];
	/** The operator-confirmed defect-class vocabulary at load (shown so the operator understands
	 *  what 'needs' can be declared); derived from the first view's match (all share it). */
	vocabulary: string[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<StaffingPageData> => {
	// Live: a staffing propose/confirm/reject + a needs edit write review_proposal / project_staff
	// / role_event / project rows — all watched by the /agents SSE stream (D-035).
	depends('app:workforce');
	depends('app:projects');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, views: [], vocabulary: [] };
	}
	try {
		const projects = await listProjects(db);
		const all: ProjectStaffingView[] = [];
		for (const p of projects) {
			try {
				const view = await loadProjectStaffingView(db, p.id, p.name);
				// Show a project only when it has declared needs OR the matcher found candidates/gaps,
				// OR it has an ORPHAN (staffed-but-not-candidate role / orphaned open proposal) the
				// operator must be able to clean up — otherwise an orphan on an otherwise-empty project
				// would be hidden and unreachable. A project that has none of these is not a staffing
				// decision (honest omit, F-008).
				const hasContent =
					view.match.needs.defect_classes.length > 0 ||
					view.match.candidates.length > 0 ||
					view.match.gaps.length > 0 ||
					view.orphanStaffed.length > 0 ||
					view.orphanProposals.length > 0;
				if (hasContent) all.push(view);
			} catch {
				// a single broken project view never sinks the page (honest partial).
			}
		}
		const vocabulary = all[0]?.match.vocabulary ?? [];
		return { connected: true, views: all, vocabulary };
	} catch (err) {
		return { connected: false, views: [], vocabulary: [], error: (err as Error).message };
	}
};

/** Validate a record id at the D-016 boundary; null when malformed. */
function rid(value: string): string | null {
	try {
		return assertRecordId(value);
	} catch {
		return null;
	}
}

export const actions: Actions = {
	// PROPOSE — open a staffing proposal for a REUSE candidate (PROPOSE-ONLY; matcher-gated).
	propose: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { staffing: { error: 'database not connected' } });
		const form = await request.formData();
		const project = rid(String(form.get('project') ?? ''));
		const role = rid(String(form.get('role') ?? ''));
		if (!project || !role) return fail(400, { staffing: { error: 'invalid project or role id' } });
		try {
			const res = await proposeStaffing(db, { project, role });
			return {
				staffing: { ok: true, action: 'propose', project, role, proposal: res.proposal.id, created: res.created }
			};
		} catch (err) {
			if (err instanceof StaffingGateError || err instanceof CapabilityNeedsError || err instanceof WorkforceInputError) {
				return fail(400, { staffing: { project, role, error: err.message } });
			}
			return fail(500, { staffing: { project, role, error: (err as Error).message } });
		}
	},

	// CONFIRM (D-039) — staffRole writes the project_staff row. Fail-closed without the tick.
	confirm: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { staffing: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = rid(String(form.get('proposal') ?? ''));
		const charterNote = String(form.get('charterNote') ?? '').trim() || undefined;
		if (!proposal) return fail(400, { staffing: { error: 'invalid proposal id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				staffing: { proposal, error: 'confirm the staffing — this writes the project_staff row (D-039; there is no auto-staff)' }
			});
		}
		try {
			const res = await confirmStaffing(db, {
				proposal,
				operatorConfirmed: true,
				...(charterNote ? { charterNote } : {})
			});
			return {
				staffing: { ok: true, action: 'confirm', proposal, staffed: res.staffed, staff: res.staff.id, role: res.proposal.role }
			};
		} catch (err) {
			if (err instanceof StaffingGateError || err instanceof WorkforceInputError) {
				return fail(400, { staffing: { proposal, error: err.message } });
			}
			return fail(500, { staffing: { proposal, error: (err as Error).message } });
		}
	},

	// REJECT — close the staffing proposal terminally (reuse §5 rejectProposal, screened reason).
	reject: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { staffing: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = rid(String(form.get('proposal') ?? ''));
		const reason = String(form.get('reason') ?? '').trim() || undefined;
		if (!proposal) return fail(400, { staffing: { error: 'invalid proposal id' } });
		try {
			const closed = await rejectStaffing(db, { proposal, ...(reason ? { reason } : {}) });
			return { staffing: { ok: true, action: 'reject', proposal, status: closed.status } };
		} catch (err) {
			if (err instanceof StaffingGateError || err instanceof WorkforceInputError) {
				return fail(400, { staffing: { proposal, error: err.message } });
			}
			return fail(500, { staffing: { proposal, error: (err as Error).message } });
		}
	},

	// UNSTAFF — soft un-staff an enabled role (operator-gated; suppression-shaped act, G2). The
	// confirm tick is required so an un-staff is never a stray click.
	unstaff: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { staffing: { error: 'database not connected' } });
		const form = await request.formData();
		const project = rid(String(form.get('project') ?? ''));
		const role = rid(String(form.get('role') ?? ''));
		if (!project || !role) return fail(400, { staffing: { error: 'invalid project or role id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, { staffing: { project, role, error: 'confirm the un-staff — the role stops working on this project' } });
		}
		try {
			const res = await unstaffRole(db, project, role);
			return { staffing: { ok: true, action: 'unstaff', project, role, wasStaffed: res !== null } };
		} catch (err) {
			if (err instanceof WorkforceInputError) return fail(400, { staffing: { project, role, error: err.message } });
			return fail(500, { staffing: { project, role, error: (err as Error).message } });
		}
	}
};
