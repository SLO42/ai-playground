// RC-3 (REPO-CREATION-SPEC) — the PM-PROPOSED trigger path onto the RC-2 gate.
//
// The PM can RECOMMEND "this project needs a GitHub repo" — but a PM/agent code path may reach AT
// MOST a PROPOSAL, NEVER the RC-2 outward driver (B4/D-039 — the SAME rail as publish/hire). This
// module is that rail:
//
//   • proposeRepoCreate    — the PM-reachable boundary. It raises a `repo_create` decision_brief (the
//                            EXISTING operator-decision surface — WORKFORCE §8 canonical brief, the same
//                            surface cert_hire uses) recommending a repo be created. It records the
//                            recommendation as DATA and STOPS. It NEVER sets consent, NEVER derives a
//                            confirm token, NEVER calls runRepoCreationGate. A repo-create is not a
//                            §4.1 task-contract (it has no acceptance-criteria a build agent executes),
//                            so it routes through the brief surface rather than proposeTask — the
//                            "closest existing operator-decision surface" the spec permits.
//
//   • applyRepoCreateDecision — the OPERATOR-only decide-effect, dispatched from /api/briefs on the
//                            `repo_create` artifact_kind (mirroring applyHireDecision for cert_hire).
//                            approve (operatorConfirmed REQUIRED — B4) is the SOLE place the PM-proposed
//                            path crosses into RC-2: it records the operator's consent server-side and
//                            drives runRepoCreationGate with a server-derived confirm token. reject
//                            withdraws the brief, creates nothing. The brief row records the ceremony;
//                            the EFFECT (the outward create) lives HERE — the documented brief/effect
//                            split (briefs.ts top-comment; cert_hire precedent).
//
// INTEGRITY (red-team): there is NO path from a PM/agent context to runRepoCreationGate through this
// module. proposeRepoCreate's only output is a brief (data). Only applyRepoCreateDecision reaches the
// gate, and it (a) is reached only from the loopback /api/briefs decide endpoint the OPERATOR drives,
// (b) requires operatorConfirmed:true (fail-closed — a missing/false confirm refuses BEFORE consent is
// recorded and BEFORE the gate runs), and (c) records consent + derives the token ITSELF (the PM never
// supplies either). Private-first + the full D-037 gate (consent + token + auth + private re-assert)
// still hold inside runRepoCreationGate on this path exactly as on operator-create.

import type { Db } from '../db/client';
import type { GitHubClient } from '../sync/gh-client';
import type { CommandRunner } from '../orchestrator/post-task';
import { assertRepoName } from '../sync/gh-client';
import { getProject } from './repo';
import { getPm, setPmRepoCreatePreauthorized } from './pm-repo';
import {
	createDecisionBrief,
	getBrief,
	getOpenBriefForArtifact,
	markBriefDecided,
	type DecisionBriefRow
} from './briefs';
import {
	runRepoCreationGate,
	repoCreateConfirmToken,
	type RepoCreateGateResult
} from './repo-creation-gate';

// ── Named errors ──────────────────────────────────────────────────────────────────

/** The PM repo-create proposal boundary was violated (no hired PM, observe-only authority,
 *  repo already configured, a malformed repo name). Loud + named — never a silent half-create. */
export class RepoProposalError extends Error {
	override readonly name = 'RepoProposalError';
}

/** The operator decide-path on a repo_create brief was violated (wrong artifact_kind, an
 *  approve without operatorConfirmed, a vanished project). Loud + named (route → 409). */
export class RepoCreateGateError extends Error {
	override readonly name = 'RepoCreateGateError';
}

// ── The structural fingerprint (anti-spam parity with pm-proposals) ────────────────

/** The structural identity of a repo-create matter: the project (one repo per project). A
 *  cosmetic re-name cannot dodge an operator's defer window — the matter IS "create THIS
 *  project's repo". Used so a deferred repo-create ask is not re-raised inside its window. */
export function repoCreateFingerprint(projectId: string): string {
	return `repo-create:${projectId}`;
}

// ── PATH B step 1: the PM recommendation → a brief (DATA, never the gate) ───────────

export interface ProposeRepoCreateInput {
	project: string;
	/** The bare repo name the PM recommends (validated at the boundary — D-008). */
	name: string;
	/** Optional org/user login to create under; defaults to the authed user when omitted. */
	owner?: string;
	/** Why the PM recommends a repo now (ties to plan/charter/finding). Surfaced on the brief. */
	rationale?: string;
}

export interface ProposeRepoCreateResult {
	/** The raised (or absorbed standing) operator brief — the PM's reach ENDS here. */
	brief: DecisionBriefRow;
	/** True when this call raised a fresh brief; false when an open brief was absorbed. */
	raised: boolean;
}

/**
 * The PM-reachable boundary: RECOMMEND a repo be created by raising a `repo_create` operator brief.
 * Fail-closed preconditions, each a named error:
 *   • the project must have a HIRED PM (no implicit PM may propose) — RepoProposalError;
 *   • pm.authority must be 'propose' or 'act' — an 'observe' PM recommends nothing — RepoProposalError;
 *   • the project must NOT already have a repo_url (idempotent — nothing to propose) — RepoProposalError;
 *   • the recommended name must be a valid bare repo name — RepoProposalError.
 *
 * This NEVER sets consent, NEVER derives a confirm token, NEVER touches GitHub. Its ONLY output is a
 * brief (data). Interrupt contract: an OPEN brief already standing for this project's repo is absorbed
 * (createDecisionBrief's per-artifact open-brief absorb) — a re-run returns the standing ask, never a
 * duplicate. The artifact is the PROJECT row (the matter is "create this project's repo").
 */
export async function proposeRepoCreate(
	db: Db,
	input: ProposeRepoCreateInput
): Promise<ProposeRepoCreateResult> {
	const pm = await getPm(db, input.project);
	if (!pm) {
		throw new RepoProposalError(
			`project ${input.project} has no hired PM — a repo-create recommendation requires the hired identity (PM-SPEC §1)`
		);
	}
	if (pm.authority !== 'propose' && pm.authority !== 'act') {
		throw new RepoProposalError(
			`PM authority is '${pm.authority}' — an observe-only PM records observations, it does not recommend a repo (PM-SPEC §4)`
		);
	}

	const project = await getProject(db, input.project);
	if (!project) throw new RepoProposalError(`project not found: ${input.project}`);
	if (project.repo_url && project.repo_url.trim()) {
		throw new RepoProposalError(
			`project ${input.project} already has a repo (${project.repo_url}) — nothing to propose (idempotent)`
		);
	}

	// Validate the recommended name at the boundary — a malformed name is refused HERE, never carried
	// into a brief the operator might approve into a doomed gate run.
	let name: string;
	try {
		name = assertRepoName(input.name);
	} catch (err) {
		throw new RepoProposalError(`invalid recommended repo name: ${(err as Error).message}`);
	}
	const owner = input.owner?.trim() || undefined;
	const slug = owner ? `${owner}/${name}` : name;
	const rationale = input.rationale?.trim() || 'The PM recommends creating a private GitHub repo to back this project.';

	// Honest `raised`: was there already an OPEN brief on this project before we asked? createDecisionBrief
	// absorbs an existing open brief (one ask per artifact) — distinguish a fresh raise from an absorb.
	const priorOpen = await getOpenBriefForArtifact(db, input.project);

	const brief = await createDecisionBrief(db, {
		project: input.project,
		// The artifact of record is the PROJECT row (the matter is "create THIS project's repo"). The
		// repo name/owner travel in the challenge payload so applyRepoCreateDecision can drive the gate.
		artifact: input.project,
		artifact_kind: 'repo_create',
		classification: 'confirm',
		ask: `Create a private GitHub repo (${slug}) for "${project.name}"?`,
		issue:
			`${pm.name} (the project PM) recommends creating a PRIVATE GitHub repo for this project. ` +
			`${rationale} Approving records your consent and creates the repo private-first behind the ` +
			`RC-2 gate (consent + confirm-token + gh-auth + private re-assert); rejecting creates nothing.`,
		effort: { apply: 'one outward gh repo create (private) + push of the local scaffold', wrongness: '—' },
		// 2–4 real links: the project + the PM identity (both real rows — F-008).
		evidence: [input.project, pm.id],
		falsifier:
			`The project may be intended to stay local-only, or you may want a different name/owner/visibility — ` +
			`repos are PRIVATE-first here and public is never created.`,
		// The repo name + owner ride in the challenge payload (the gate reads them on approve). This reuses
		// the existing FLEXIBLE option<object> challenge column — no new field/migration for the payload.
		challenge: {
			operator_said: '—',
			recommendation: `Create private repo ${slug}`,
			why: rationale,
			context_we_might_be_missing: owner ? `owner=${owner}` : 'owner=(authenticated user)',
			cost_if_wrong: `repo:${name}` // the bare name the gate re-validates (parsed back on approve)
		},
		options: [
			{
				id: 'approve',
				label: `Create the private repo (${slug})`,
				pro: 'Backs the project with a private remote; the local scaffold commits are pushed.',
				con: 'Creates a real outward GitHub resource (private). Reversible only by deleting it on GitHub.',
				recommended: `${pm.name} recommends it: ${rationale}`
			},
			{
				id: 'reject',
				label: 'Do not create a repo',
				pro: 'The project stays local-only; no outward resource is created.',
				con: 'Release/publish targets that need a remote stay unconfigured.'
			}
		],
		net_tradeoff:
			'Net: approving creates a private remote (one outward, reversible-by-delete act); rejecting keeps the project local.',
		fingerprint: repoCreateFingerprint(input.project)
	});

	// raised iff no open brief stood for this project before this call (else createDecisionBrief absorbed
	// the standing one — interrupt-contract idempotency, never a duplicate ask).
	const raised = priorOpen === null;
	return { brief, raised };
}

// ── PATH B step 2: the operator's decide-effect (the ONLY crossing into RC-2) ──────

export interface ApplyRepoCreateInput {
	/** The operator's explicit B4 confirm. REQUIRED true for approve — fail-closed, NO auto-create. */
	operatorConfirmed: boolean;
	/** The branch to push (defaults to 'main'). */
	branch?: string;
	/** TEST SEAM: inject a stubbed GitHub client — NO real network in tests. */
	client?: GitHubClient;
	/** TEST SEAM: inject a stubbed outward git runner — NO real remote/push in tests. */
	gitRunner?: CommandRunner;
}

export interface ApplyRepoCreateResult {
	brief: DecisionBriefRow;
	/** The RC-2 gate verdict when approve drove it (null on reject — nothing ran). */
	gate: RepoCreateGateResult | null;
	/** The resolved repo URL on a successful create (null on reject or a red gate). */
	repoUrl: string | null;
}

/** Recover the bare repo name + owner the proposal stowed on the brief's challenge payload. */
function repoTargetFromBrief(brief: DecisionBriefRow): { name: string; owner?: string } {
	// name: the proposal stowed it as `repo:<name>` in cost_if_wrong (a non-secret, re-validated below).
	const costField = brief.challenge?.cost_if_wrong ?? '';
	const m = /^repo:(.+)$/.exec(costField.trim());
	if (!m) {
		throw new RepoCreateGateError(
			`repo_create brief ${brief.id} is missing its repo target payload — refusing to guess a repo name`
		);
	}
	const name = assertRepoName(m[1].trim()); // re-validate at the boundary (D-008) before the gate runs
	// owner: stowed as `owner=<login>` in context_we_might_be_missing, else the authed user (absent).
	const ctx = brief.challenge?.context_we_might_be_missing ?? '';
	const om = /^owner=(.+)$/.exec(ctx.trim());
	const owner = om && om[1].trim() && om[1].trim() !== '(authenticated user)' ? om[1].trim() : undefined;
	return owner !== undefined ? { name, owner } : { name };
}

/**
 * §B4 WRITE-PATH — apply the operator's answer to an OPEN `repo_create` brief. The SOLE place the
 * PM-proposed path crosses into the RC-2 outward gate.
 *
 *   approve → (operatorConfirmed REQUIRED — fail closed BEFORE any consent/gate) record the operator's
 *             consent (setPmRepoCreatePreauthorized true — operator identity is server-resolved: this
 *             runs from the loopback /api/briefs decide endpoint the operator drives, NOT a PM/agent
 *             context), derive the confirm token SERVER-side (repoCreateConfirmToken — the PM never
 *             supplies it), and drive runRepoCreationGate. The gate re-asserts consent + token + auth +
 *             private-first and performs the real PRIVATE create + push. Marks the brief 'approved'
 *             ONLY when the gate reports created:true; a RED gate leaves the brief OPEN (re-decidable)
 *             with the honest failedAt surfaced — the consent stays recorded (it is a true operator
 *             opt-in), but no fake success is recorded.
 *   reject  → NO consent, NO token, NO gate. Marks the brief 'rejected'. Creates nothing.
 *
 * INTERRUPT CONTRACT: the gate is idempotent (already-exists / already-set-origin absorb), and
 * markBriefDecided absorbs a same-action re-decide. A crash between the gate's create and the
 * brief-mark re-runs cleanly: the gate re-run absorbs the existing repo, then the brief-mark completes.
 *
 * Shadow paths, each NAMED: brief not found → RepoCreateGateError; brief not artifact_kind
 * 'repo_create' → RepoCreateGateError; approve without operatorConfirmed → RepoCreateGateError (B4,
 * fail-closed BEFORE consent); approve on a brief the operator already DECIDED → RepoCreateGateError
 * (rejected/superseded never re-drive the gate) or an idempotent absorb (already-approved, gate:null,
 * the recorded repo_url) — the status guard runs BEFORE consent + the gate; a RED gate → result.gate
 * carries the honest failedAt, the brief stays OPEN.
 */
export async function applyRepoCreateDecision(
	db: Db,
	briefId: string,
	action: 'approve' | 'reject',
	input: ApplyRepoCreateInput = { operatorConfirmed: false }
): Promise<ApplyRepoCreateResult> {
	const brief = await getBrief(db, briefId);
	if (!brief) throw new RepoCreateGateError(`decision brief not found: ${briefId}`);
	if (brief.artifact_kind !== 'repo_create') {
		throw new RepoCreateGateError(
			`brief ${briefId} targets '${brief.artifact_kind}', not 'repo_create' — applyRepoCreateDecision only applies a repo-create brief`
		);
	}

	// REJECT — withdraw the ask, change NOTHING (no consent, no token, no gate). markBriefDecided guards
	// the open→decided transition (absorbs a same-action re-decide, refuses a relabel).
	if (action === 'reject') {
		const decided = await markBriefDecided(db, brief.id, 'rejected');
		return { brief: decided, gate: null, repoUrl: null };
	}

	// APPROVE — B4 fail-closed: an approve WITHOUT the explicit operator confirm is refused BEFORE any
	// consent is recorded and BEFORE the gate runs (no auto-create; the PM proposes, the operator
	// disposes). This is the integrity wall: a PM/agent cannot reach the gate because it cannot set
	// operatorConfirmed (the route sets it from the operator's loopback request, not from agent text).
	if (input.operatorConfirmed !== true) {
		throw new RepoCreateGateError(
			`approving a repo-create requires an explicit operator confirm (operatorConfirmed:true) — there is NO auto-create; ` +
				`the PM proposes, the operator disposes (B4/D-039)`
		);
	}

	// STATUS GUARD — the brief MUST still be 'open' BEFORE consent is recorded and BEFORE the outward gate
	// runs. This is the integrity wall: a brief the operator already DECIDED (rejected / superseded) must
	// NEVER resurrect the irreversible outward create. Without this check, the only 'open' guard is
	// markBriefDecided — which runs AFTER runRepoCreationGate, so a decided brief re-approved would fire a
	// REAL create + push + consent write, THEN throw on the brief-mark (the operator's reject silently
	// overridden — a private repo created anyway). The check happens HERE, before any side effect.
	//   • already 'approved' → idempotent absorb: the gate already ran on the first approve; do NOT re-drive
	//     it. Return the decided brief with the recorded repo_url (gate:null — nothing ran this call).
	//   • any OTHER terminal status (rejected / superseded / deferred) → refuse loudly (named). A decided
	//     repo-create never re-drives the gate; the operator's disposal stands (B4/D-039).
	if (brief.status !== 'open') {
		if (brief.status === 'approved') {
			const proj = await getProject(db, brief.artifact);
			const repoUrl = proj?.repo_url && proj.repo_url.trim() ? proj.repo_url.trim() : null;
			return { brief, gate: null, repoUrl };
		}
		throw new RepoCreateGateError(
			`repo-create brief ${briefId} is already '${brief.status}' — refusing to re-drive the outward create on a decided brief ` +
				`(the operator's decision stands; the PM proposes, the operator disposes — B4/D-039)`
		);
	}

	const projectId = brief.artifact; // the artifact IS the project row (proposeRepoCreate)
	const { name, owner } = repoTargetFromBrief(brief);

	// Record the operator's consent SERVER-side. Operator identity is server-resolved (this runs from the
	// operator-driven loopback decide endpoint), so a PM/agent context can never reach this write. A
	// no-PM project cannot have produced a repo_create brief in the first place (proposeRepoCreate
	// requires a hired PM) — but guard anyway (fail-closed, named) rather than silently skip consent.
	const consented = await setPmRepoCreatePreauthorized(db, projectId, true);
	if (!consented) {
		throw new RepoCreateGateError(
			`project ${projectId} has no hired PM to record repo-create consent on — cannot proceed (the brief is stale)`
		);
	}

	// Derive the confirm token SERVER-side (the PM never supplies it) and drive the RC-2 gate.
	const confirmToken = repoCreateConfirmToken(owner !== undefined ? { projectId, name, owner } : { projectId, name });
	const gate = await runRepoCreationGate({
		db,
		projectId,
		consent: true,
		confirmToken,
		name,
		...(owner !== undefined ? { owner } : {}),
		...(input.branch ? { branch: input.branch } : {}),
		...(input.client ? { client: input.client } : {}),
		...(input.gitRunner ? { gitRunner: input.gitRunner } : {})
	});

	// Only a GREEN gate (the repo really exists private-first AND is backed) marks the brief approved.
	// A RED gate leaves the brief OPEN (re-decidable) — no fake approval is recorded (F-008). The
	// consent stays recorded (it is a genuine operator opt-in — the operator DID consent on this click).
	if (!gate.created) {
		return { brief, gate, repoUrl: null };
	}
	const decided = await markBriefDecided(db, brief.id, 'approved');
	return { brief: decided, gate, repoUrl: gate.repoUrl };
}
