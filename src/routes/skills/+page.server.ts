// SH-4 (SKILL-HARVEST-SPEC §4) — /skills: the operator REVIEW surface for harvested skill proposals.
//
// Agents PROPOSE reusable skills (SH-1/SH-2 → skill_proposal rows, born status='open'); the OPERATOR
// promotes (G2/D-039). This page lists the OPEN proposals (highest-occurrence first — RECUR/RANK §2)
// with three operator actions, all through CSRF-safe SvelteKit server actions (parity with the project
// pmPanel/moveTask actions):
//
//   • APPROVE            → promoteSkill (SH-3): writes the confined SKILL.md to disk + syncs cc_skill,
//                          recording THIS operator as approved_by. Closes the F-045 dead-end.
//   • EDIT-THEN-APPROVE  → re-draft name/description/body as the OPERATOR's edit (screened — D-026),
//                          then promote. The edit is recorded against the same proposal row, then
//                          promoted by the operator.
//   • REJECT             → rejectSkill: MARK status='rejected' (G2 mark-don't-delete — retained for
//                          audit), recording the deciding operator.
//
// INTEGRITY: the approver/decider is SERVER-RESOLVED (the OPERATOR_ID constant below) — NEVER read from
// the request form. The dashboard is the operator's loopback control surface (same trust model as
// /settings and the project actions): an action invocation IS the operator. An agent has NO path to
// these actions (it cannot reach the dashboard server-action endpoint), and even if a body CLAIMED an
// approver, this code ignores it — promoteSkill/rejectSkill record OPERATOR_ID, full stop.
//
// Honest states (F-008): a disconnected DB → connected:false + empty list + the reason; a read fault →
// the named error surfaced, never zero-dressed-as-real; an empty open list → the honest empty state.
// The body the operator sees is the SCREENED body (screened at draft time SH-1, re-screened at promote
// SH-3) — a raw secret never renders. Boundary discipline (D-016): the proposal id is validated.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	listSkillProposals,
	editProposal,
	rejectSkill,
	SkillProposalContractError,
	SkillSecretEchoError,
	SkillRejectNotFoundError,
	SkillRejectNotAllowedError,
	type SkillProposalRow
} from '$lib/server/skills/proposal';
import {
	promoteSkill,
	SkillPromoteNotFoundError,
	SkillPromoteNotApprovedError,
	SkillPromoteConfinementError,
	SkillPromoteCollisionError,
	SkillPromoteSecretEchoError
} from '$lib/server/skills/promote';
import { assertRecordId } from '$lib/server/db/validate';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/**
 * The SERVER-RESOLVED operator identity recorded as approved_by on a promote/reject. The dashboard is
 * the operator's loopback control surface (no per-user auth; the action IS the operator — the same
 * implicit-operator model /settings + the project command-center actions use). NEVER read from the
 * request — an agent cannot forge an approval (G2/D-039). Overridable via env for a named deployment.
 */
const OPERATOR_ID = (process.env.OPERATOR_ID?.trim() || 'operator') as string;

/** How many chars of the (already-screened) body to surface as the review preview. */
const BODY_PREVIEW_CHARS = 600;

/** One open proposal reduced to what the review card renders (plain, serializable). */
export interface ProposalCard {
	id: string;
	name: string;
	description: string;
	/** The full screened body (the EDIT form pre-fills with this; never raw — screened SH-1). */
	body: string;
	/** A length-capped preview of the screened body for the collapsed card. */
	bodyPreview: string;
	/** True when the body was truncated for the preview (so the UI shows a "full body" affordance). */
	bodyTruncated: boolean;
	triggerContext: string;
	evidence: string[];
	occurrences: number;
	createdAt: string | null;
}

export interface SkillsReviewData {
	connected: boolean;
	/** Open proposals, highest-occurrence first (RECUR/RANK §2). Empty = honest no-proposals state. */
	proposals: ProposalCard[];
	/** Honest read error (DB fault) surfaced to the operator — never hidden as a fake empty. */
	error?: string;
}

function toCard(row: SkillProposalRow): ProposalCard {
	const body = row.body ?? '';
	const truncated = body.length > BODY_PREVIEW_CHARS;
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		body,
		bodyPreview: truncated ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body,
		bodyTruncated: truncated,
		triggerContext: row.trigger_context,
		evidence: row.evidence ?? [],
		occurrences: row.occurrences,
		createdAt: row.created_at
	};
}

export const load: PageServerLoad = async ({ depends }): Promise<SkillsReviewData> => {
	// SSE re-invalidation: a new harvested proposal (or an approve/reject) re-runs this loader.
	depends('app:skill-proposals');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, proposals: [], error: 'Database not connected — start SurrealDB.' };
	}
	try {
		const rows = await listSkillProposals(db, { status: 'open' });
		return { connected: true, proposals: rows.map(toCard) };
	} catch (err) {
		// A read fault is surfaced honestly (F-008) — never a fabricated empty.
		return { connected: false, proposals: [], error: (err as Error).message };
	}
};

/** Validate the proposal id at the boundary (D-016). Returns the validated id or null. */
function validProposalId(raw: FormDataEntryValue | null): string | null {
	const id = typeof raw === 'string' ? raw.trim() : '';
	if (!id) return null;
	try {
		return assertRecordId(id);
	} catch {
		return null;
	}
}

/** Map a promote error to a NAMED, operator-readable fail (EVERY ERROR HAS A NAME). */
function promoteFail(err: unknown) {
	if (err instanceof SkillPromoteNotFoundError) return fail(404, { review: { error: err.message } });
	if (err instanceof SkillPromoteNotApprovedError) return fail(403, { review: { error: err.message } });
	if (err instanceof SkillPromoteConfinementError) return fail(422, { review: { error: err.message } });
	if (err instanceof SkillPromoteCollisionError) return fail(409, { review: { error: err.message } });
	if (err instanceof SkillPromoteSecretEchoError) return fail(422, { review: { error: err.message } });
	if (err instanceof SkillProposalContractError) return fail(400, { review: { error: err.message } });
	if (err instanceof SkillSecretEchoError) return fail(422, { review: { error: err.message } });
	// editApprove's editProposal throws this when the source row vanished (honest absent).
	if (err instanceof SkillRejectNotFoundError) return fail(404, { review: { error: err.message } });
	return fail(500, { review: { error: (err as Error).message } });
}

export const actions: Actions = {
	/**
	 * APPROVE — promote the proposal as-is. promoteSkill writes the confined SKILL.md to disk, syncs
	 * cc_skill, and records OPERATOR_ID as approved_by (server-resolved — never the form). The name then
	 * exists as a referenceable capability id (F-045 closed). Honest on every failure (named).
	 */
	approve: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { review: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const proposalId = validProposalId(form.get('proposalId'));
		if (!proposalId) return fail(400, { review: { error: 'invalid proposal id' } });

		try {
			const res = await promoteSkill(db, { proposalId, approver: OPERATOR_ID });
			return {
				review: {
					ok: true as const,
					action: 'approve',
					name: res.name,
					filePath: res.filePath,
					wroteFile: res.wroteFile
				}
			};
		} catch (err) {
			return promoteFail(err);
		}
	},

	/**
	 * EDIT-THEN-APPROVE — the operator tweaks name/description/body, then promotes. The edit goes through
	 * editProposal (NOT proposeSkill): a body/description/evidence-only edit (name+trigger unchanged) is
	 * APPLIED IN PLACE on the SAME open row — without bumping `occurrences` (an operator edit is not a
	 * harvested recurrence) — and that updated row is promoted, so the operator's edited body is what lands
	 * on disk. Routing this through proposeSkill's dedup previously DROPPED the operator's edit (the dedup
	 * UPDATE only bumped occurrences) and promoted the ORIGINAL undedited body — silent data loss + a false
	 * "edited and approved" confirmation (the SH-4 DoD-review defect). A RENAME (name and/or trigger
	 * changed) is a different skill identity → editProposal creates a fresh open draft and LEAVES the
	 * original open (renamed:true; the UI says so). The edit re-screens every field through the write
	 * chokepoint, so a malformed name / quarantined secret fails closed (named) BEFORE any promote.
	 */
	editApprove: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { review: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		// The original id anchors the edit: editProposal compares the edited (name+trigger) identity to the
		// original row's, applying a same-identity edit IN PLACE and treating a changed identity as a rename.
		const srcId = validProposalId(form.get('proposalId'));
		if (!srcId) return fail(400, { review: { error: 'invalid proposal id' } });

		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const body = String(form.get('body') ?? '').trim();
		const triggerContext = String(form.get('triggerContext') ?? '').trim();
		if (!name || !description || !body || !triggerContext) {
			return fail(400, {
				review: { error: 'name, description, body and trigger context are all required to edit-then-approve.' }
			});
		}

		try {
			// Apply the OPERATOR's edit (editProposal SHAPES + SCREENS; in-place on a same-identity edit,
			// fresh draft on a rename). The RETURNED row carries the operator's edited body/description.
			const { row: edited, renamed } = await editProposal(db, srcId, {
				name,
				description,
				body,
				trigger_context: triggerContext
			});
			// Promote the edited row, recording OPERATOR_ID (server-resolved).
			const res = await promoteSkill(db, { proposalId: edited.id, approver: OPERATOR_ID });
			return {
				review: {
					ok: true as const,
					action: 'editApprove',
					name: res.name,
					filePath: res.filePath,
					wroteFile: res.wroteFile,
					// Honest signal: a rename leaves the original draft open (a new skill id was promoted).
					renamed
				}
			};
		} catch (err) {
			return promoteFail(err);
		}
	},

	/**
	 * REJECT — MARK the proposal rejected (G2 mark-don't-delete; retained for audit). rejectSkill records
	 * OPERATOR_ID as the deciding operator. An approved proposal is terminal here (named 409). Honest on
	 * every failure (named).
	 */
	reject: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { review: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const proposalId = validProposalId(form.get('proposalId'));
		if (!proposalId) return fail(400, { review: { error: 'invalid proposal id' } });

		try {
			const row = await rejectSkill(db, proposalId, OPERATOR_ID);
			return { review: { ok: true as const, action: 'reject', name: row.name } };
		} catch (err) {
			if (err instanceof SkillRejectNotFoundError) return fail(404, { review: { error: err.message } });
			if (err instanceof SkillRejectNotAllowedError) return fail(409, { review: { error: err.message } });
			return fail(500, { review: { error: (err as Error).message } });
		}
	}
};
