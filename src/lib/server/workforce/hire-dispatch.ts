// HR-RECRUITER (PM→HR dispatch, gaps A+B of the seam map) — the CONNECTIVE TISSUE between
// the project's capability HIRE-gaps (recommendStaffing.gaps, capability-match.ts:421) and the
// recruiter's cert-lifecycle orchestrator (recruiter.ts). Two halves, one module:
//
//   (A) PRODUCER — dispatchHireRequest: the operator/PM DISPATCH affordance on /projects/[id]
//       enqueues EXACTLY ONE `hire_request` work_item for a (project, needed-role) gap. Mirrors
//       review.ts maybeEnqueueReview: a producer that folds the per-unit discriminator into the
//       work_item dedup_key (§4.12) so the SAME gap can't double-enqueue. PROPOSE-ONLY: enqueuing
//       a hire_request spends NOTHING — it asks the recruiter to DRAFT a cert key-set the operator
//       will later approve (B2). It does NOT run a gauntlet and does NOT confirm a key.
//
//   (B) DRAIN HANDLER — runHireRequest: the orchestrator's #runItem dispatch (mirrors the
//       memory_review fork) consumes a claimed hire_request → resolves the needed role → calls
//       draftCertificationSet (recruiter.ts:118), PROPOSE-ONLY. The result is a CertificationDraft
//       (the operator's single B2 approve-surface). The drain NEVER calls runCertificationGauntlet
//       / runRecruiterCampaign (those fire ONLY post-approval, operatorApprovedKeySet===true) and
//       NEVER confirms a key. B1 (no self-cert) is enforced inside draftCertificationSet, which
//       refuses a recruiter-self target with RecruiterIntegrityError.
//
// EVERY ERROR HAS A NAME: HireDispatchError names a bad dispatch input (missing/blank project or
// role slug, no defect classes); WorkforceInputError surfaces an unknown role at draft time;
// RecruiterIntegrityError (from recruiter.ts) is the B1 self-cert refusal. A catch-all is a smell.
//
// SHADOW PATHS (all four, each named): nil/blank role slug or project → HireDispatchError at the
// producer boundary (never enqueued); EMPTY defectClasses → HireDispatchError (a hire with no need
// is meaningless — fail loud, F-008 honest, never enqueue a no-op); a duplicate gap → the dedup_key
// collapses the second enqueue to a no-op (enqueued:false, NOT an error); a role slug the catalog
// does NOT have → the DRAIN's draftCertificationSet path resolves no version and the handler returns
// an honest `unresolved` outcome (the operator must first draft the role version — named, never a
// fabricated draft). A role that exists but has NO drafted keys → an honest empty CertificationDraft
// (keyCount 0; the operator has the role but nothing to approve yet — spec-supported empty SET).
//
// DEFERRED WORK (written down, not a lie): this wave wires the DRAFT half end-to-end. The
// post-approval campaign (runRecruiterCampaign → raiseHireBrief → applyHireDecision → confirmStaffing
// → resolveStaff) is the NEXT seam — it fires only after the operator approves the key-SET (B2), so
// it is intentionally NOT triggered from the drain here. The drain stops at the propose-only draft.

import type { Db } from '../db/client';
import { enqueue } from '../orchestrator/workqueue';
import { getRoleBySlug, listRoleVersions, type RoleVersionRow } from './repo';
import { draftCertificationSet, type CertificationDraft } from './recruiter';
import { type DraftKeySpec } from './launch-fixtures';
import { screen } from '../memory/screen';

/** The new `work_item.work_type` for a recruiter hire-draft request. work_type is `TYPE string`
 *  with NO enum ASSERT (schema.ts m0012), so this is additive — NO migration is required. */
export const HIRE_REQUEST_WORK_TYPE = 'hire_request';

/** Bad caller input at the dispatch boundary — fail loud, fail closed (never enqueue a no-op or a
 *  hire-with-no-need). The route maps it to a 400. */
export class HireDispatchError extends Error {
	override readonly name = 'HireDispatchError';
}

// ── (A) PRODUCER — enqueue ONE hire_request for a (project, needed-role) gap ──────────

export interface DispatchHireInput {
	/** The project whose capability gap is being staffed (the work_item.project link). */
	projectId: string;
	/** The needed role's hyphenated slug (e.g. `security-reviewer`) — the role the recruiter will
	 *  draft a certification key-set for. The dedup discriminator (one open request per project|role). */
	roleSlug: string;
	/** The uncovered defect classes this hire must close (from recommendStaffing.gaps[].defectClass).
	 *  At least one is REQUIRED — a hire with no need is refused. Carried in the payload for the
	 *  recruiter + the operator's approve-surface; SCREENED (D-026) at this boundary. */
	defectClasses: string[];
}

/** The payload a hire_request work_item carries (read back by the drain handler). All strings are
 *  screened/validated at the producer boundary; record ids bind via the workqueue's StringRecordId. */
export interface HireRequestPayload {
	projectId: string;
	roleSlug: string;
	defectClasses: string[];
}

export interface DispatchHireResult {
	/** The enqueued work_item id — set ONLY when a NEW row was created. */
	workItemId?: string;
	/** False when the §4.12 dedup_key collapsed a duplicate enqueue (an active request for the SAME
	 *  project|role already exists) — the exactly-one-per-gap guarantee, NOT an error. */
	enqueued: boolean;
	/** The screened, distinct, sorted defect classes that were enqueued (honest echo). */
	defectClasses: string[];
}

/** Trim + screen + distinct + sort a raw string array (D-026 — a planted secret in a class string
 *  is redacted before it is stored; F-008 honest empties drop blanks). Pure. */
function screenClasses(values: string[]): string[] {
	const set = new Set<string>();
	for (const v of values) {
		const t = screen(String(v)).text.trim();
		if (t.length > 0) set.add(t);
	}
	return [...set].sort();
}

/**
 * (A) DISPATCH — enqueue EXACTLY ONE `hire_request` work_item for a project's capability gap. The
 * operator/PM triggers this from /projects/[id] when recommendStaffing surfaces a HIRE gap. The
 * dedup is scoped per (project|role) via `dedupScope`, so the SAME gap dispatched twice collapses
 * to one active request (§4.12) — a re-click never double-enqueues. PROPOSE-ONLY: this spends
 * nothing; it asks the recruiter to DRAFT a key-set the operator approves later (B2).
 *
 * SHADOW PATHS: blank project / blank role slug → HireDispatchError (never enqueued); empty
 * defectClasses (after screen) → HireDispatchError (a hire with no need is meaningless); duplicate
 * → enqueued:false (dedup no-op, honest, not an error).
 */
export async function dispatchHireRequest(
	db: Db,
	input: DispatchHireInput
): Promise<DispatchHireResult> {
	const roleSlug = (input.roleSlug ?? '').trim();
	if (!input.projectId?.trim()) {
		throw new HireDispatchError('hire_request requires a project id');
	}
	if (!roleSlug) {
		throw new HireDispatchError('hire_request requires a needed-role slug (name the role to hire)');
	}
	const defectClasses = screenClasses(input.defectClasses ?? []);
	if (defectClasses.length === 0) {
		throw new HireDispatchError(
			'hire_request requires at least one uncovered defect class (a hire with no capability need is a no-op)'
		);
	}

	const payload: HireRequestPayload = { projectId: input.projectId, roleSlug, defectClasses };
	const { id, enqueued } = await enqueue(db, {
		workType: HIRE_REQUEST_WORK_TYPE,
		// The workqueue payload is a structural Record; HireRequestPayload is a concrete interface
		// (no index signature), so widen it at the boundary — the shape is a plain JSON object.
		payload: payload as unknown as Record<string, unknown>,
		projectId: input.projectId,
		// Per-(project|role) dedup: the active-window UNIQUE key collapses a second dispatch of the
		// SAME gap to a no-op (the exactly-one-open-request guarantee, §4.12). The work_item carries
		// no session, so dedup_scope is the ONLY discriminator that keeps two DIFFERENT roles' gaps
		// on the same project from colliding.
		dedupScope: `${input.projectId}|${roleSlug}`
	});

	return enqueued ? { workItemId: id, enqueued, defectClasses } : { enqueued, defectClasses };
}

// ── (B) DRAIN HANDLER — draft the cert key-set for a claimed hire_request (PROPOSE-ONLY) ──

/** The terminal shape of a drained hire_request — exactly one, all honest:
 *   • 'drafted'    — the needed role exists + has a resolvable version → draftCertificationSet
 *                    produced the operator's B2 approve-surface (the CertificationDraft). keyCount
 *                    may be 0 (honest empty SET — the role exists but has no drafted keys yet).
 *   • 'unresolved' — the needed role slug is NOT in the catalog, OR it has no role_version to
 *                    certify. NO draft is fabricated (F-008): the operator must first draft the role
 *                    version; the drain names the reason. The work_item still completes (done) — the
 *                    request was honestly consumed, there is simply nothing to draft yet. */
export type HireRequestOutcome =
	| { kind: 'drafted'; roleSlug: string; draft: CertificationDraft }
	| { kind: 'unresolved'; roleSlug: string; reason: string };

/**
 * (B) DRAIN — consume ONE claimed `hire_request` work_item: resolve the needed role → call
 * draftCertificationSet (recruiter.ts:118), PROPOSE-ONLY (B2). REUSES the recruiter's draft path;
 * it does NOT fork a new draft mechanism. It NEVER runs the gauntlet (runCertificationGauntlet /
 * runRecruiterCampaign fire ONLY after the operator approves the key-SET) and NEVER confirms a key.
 * B1 (no self-cert) is enforced INSIDE draftCertificationSet (refuses a recruiter-self target).
 *
 * Resolution: getRoleBySlug → the role's active_version (the §2.3 incumbent) if set, else the
 * NEWEST role_version (listRoleVersions DESC). No version ⇒ 'unresolved' (honest — nothing to
 * certify yet). The drafted-from-source keys default to NONE: the generic gap-hire surfaces an
 * empty SET for the operator to author (the role-specific draft-key catalogs like
 * RECRUITER_DRAFT_KEYS are role-bound; a caller with a known set passes it via `draftKeys`).
 *
 * SHADOW PATHS: unknown role slug → 'unresolved' (named, no draft); role with no version →
 * 'unresolved'; recruiter-self target → RecruiterIntegrityError (B1, thrown — the orchestrator marks
 * the item failed and logs it, never silently completes). INTERRUPT CONTRACT: re-running the drain
 * on the same gap re-drafts the SAME propose-only surface (draftCertificationSet writes NOTHING — it
 * only reads + assembles), so a re-run is idempotent + side-effect-free.
 */
export async function runHireRequest(
	db: Db,
	payload: HireRequestPayload,
	draftKeys: readonly DraftKeySpec[] = []
): Promise<HireRequestOutcome> {
	const roleSlug = (payload.roleSlug ?? '').trim();
	if (!roleSlug) {
		return { kind: 'unresolved', roleSlug: '', reason: 'hire_request payload carried no role slug' };
	}

	const role = await getRoleBySlug(db, roleSlug);
	if (!role) {
		return {
			kind: 'unresolved',
			roleSlug,
			reason: `no catalog role with slug '${roleSlug}' — draft the role version first, then re-dispatch the hire`
		};
	}

	// Resolve the version to certify: the active incumbent (§2.3), else the newest version.
	let version: RoleVersionRow | null = null;
	if (role.active_version) {
		const versions = await listRoleVersions(db, role.id);
		version = versions.find((v) => v.id === role.active_version) ?? null;
	}
	if (!version) {
		const versions = await listRoleVersions(db, role.id); // DESC by version → [0] is newest.
		version = versions[0] ?? null;
	}
	if (!version) {
		return {
			kind: 'unresolved',
			roleSlug,
			reason: `role '${roleSlug}' has no role_version to certify — draft a version first (the recruiter certifies a version, not a bare role)`
		};
	}

	// PROPOSE-ONLY (B2): draftCertificationSet assembles the operator approve-surface and writes
	// NOTHING to gauntlet_key. B1 (no self-cert) is enforced inside it. An empty draftKeys set is a
	// spec-supported honest empty SET (keyCount 0).
	const draft = await draftCertificationSet(db, { roleVersionId: version.id, draftKeys });
	return { kind: 'drafted', roleSlug, draft };
}
