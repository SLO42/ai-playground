// HR-3 (HR-RECRUITER-SPEC §7.3) — the RECRUITER-DRIVEN CERT-LIFECYCLE ORCHESTRATOR.
//
// The recruiter AGENT drives this via launchSession, but the ORCHESTRATION logic here is
// DETERMINISTIC + unit-testable. It owns the cert lifecycle for a TARGET role end-to-end —
// draft → operator-approve key-SET → run gauntlet → collect → on-fail re-version + classify
// + propose a key fix — WITHOUT ever crossing the four integrity invariants:
//
//   • B1 — NO SELF-CERT. A role can never certify itself. This orchestrator REFUSES a target
//     whose slug is the recruiter's own (`recruiter`) — the recruiter never drives its own
//     gauntlet (it is operator-bootstrap-certified, day-0-style). Fail-closed + named.
//   • B2 — PROPOSE KEYS, NEVER CONFIRM. draftCertificationSet PREPARES fixtures + draft keys
//     into ONE operator approve-surface; it NEVER calls confirmLaunchKey (that stays
//     operator-gated). The run path REQUIRES an explicit operatorApprovedKeySet token — the
//     orchestrator cannot manufacture the approval (the operator's act, not the recruiter's).
//   • B3 — NEVER RESCORE. This orchestrator reads the run's deterministic results; it never
//     re-runs the scorer, never rescores a plant, never touches gauntlet_key contents.
//   • B4 — OPERATOR KEEPS THE HIRE/CERT GATE. It NEVER flips a lifecycle (no transitionLifecycle
//     call — that import is a READ-ONLY type reference for the cert-state it reports). On a
//     terminal FAIL it calls reversionFailedRole (a NEW draft, §2.2 — not an un-fail) and emits
//     a PROPOSAL; it never certifies, never staffs.
//
// FAIL CLASSIFICATION (the loop the operator hand-ran today): a terminal 'failed' run is one of
//   (1) candidate-miss — the candidate genuinely missed planted defects (recall short of bar);
//       recovery is re-version + (optionally) a higher tier. NO key change is proposed.
//   (2) KEY-DEFECT — an OVER-STRICT plant failed a behaviorally-correct candidate (the
//       authoritative-port-18789 class): the candidate found the substantive defects but the key
//       demanded a REDUNDANT finding it correctly omitted. Recovery is a key fix — but keys are
//       IMMUTABLE + content-bound (§2.1), so the orchestrator proposes a NEW-fixture/new-key
//       recommendation for OPERATOR approval; it NEVER silently re-keys.
//
// EVERY ERROR HAS A NAME: RecruiterIntegrityError (a B1/B2 boundary violation — fail loud, never
// silently spend) is the module's named gate error; upstream WorkforceInputError surfaces a
// missing/again-invalid target. A catch-all is a smell — each refusal names its trigger.

import type { Db } from '../db/client';
import {
	getInterviewRun,
	getRole,
	getRoleVersion,
	WorkforceInputError,
	type InterviewRunRow,
	type RoleRow,
	type RoleVersionRow,
	type Tier
} from './repo';
import { runGauntlet, type GauntletDeps, type GauntletOutcome } from './gauntlet';
import { reversionFailedRole, type ReversionResult } from './ceremony';
import { type DraftKeySpec } from './launch-fixtures';
// NB (B4): the orchestrator NEVER flips a lifecycle. repo.transitionLifecycle (the cert-flip
// write-path) is DELIBERATELY NOT imported here — certLifecycleOf only READS getRoleVersion.

// ── B1 — the recruiter's own slug (never certifies itself) ──────────────────────────

/** The GLOBAL recruiter role slug. A target whose slug equals this is REFUSED (B1 — no
 *  self-cert; the recruiter is operator-bootstrap-certified, never self-driven). */
export const RECRUITER_SLUG = 'recruiter';

/** Named gate error for a B1/B2 integrity-boundary violation — fail LOUD, never silently
 *  proceed (the recruiter must not certify itself nor confirm its own keys). */
export class RecruiterIntegrityError extends Error {
	override readonly name = 'RecruiterIntegrityError';
}

// ── Step 1 — DRAFT the certification key-SET (propose-only; B2) ──────────────────────

/** One drafted fixture+key the operator reviews in the approve-SET. PROPOSE-ONLY: this is the
 *  diff substrate (fixture slug + the draft plants/tolerance/justification); NOTHING here is a
 *  gauntlet_key — the operator confirms each via the operator-gated confirmLaunchKey. */
export interface DraftedKey {
	fixtureSlug: string;
	/** Machine-checkable plants drafted FROM the fixture source (scorer.ts shape). Never
	 *  confirmed here — the operator approves the SET, then confirms each (B2). */
	plants: Array<Record<string, unknown>>;
	fp_tolerance: number;
	fp_justification: string;
}

/** The single operator approve-surface for a target role's certification key-SET (B2): the
 *  target identity + every drafted fixture key. The operator reviews this ONE surface and
 *  approves/rejects the SET — the recruiter never confirms a key itself. */
export interface CertificationDraft {
	role: string;
	roleSlug: string;
	roleVersion: string;
	/** The default tier the gauntlet will run at (§3.8 — the role's actual tier). */
	tier: Tier;
	/** Every drafted fixture key for operator review (propose-only). May be empty (honest)
	 *  when the target has no drafted keys yet — the operator then has nothing to approve. */
	draftedKeys: DraftedKey[];
	/** Honest count: how many fixtures have a draft key in the SET. */
	keyCount: number;
}

export interface DraftCertificationInput {
	/** The role_version to certify (the gauntlet target). */
	roleVersionId: string;
	/** The drafted-from-source keys for this role's fixtures (e.g. RECRUITER_DRAFT_KEYS /
	 *  RESEARCHER_DRAFT_KEYS / a harvested set). PROPOSE-ONLY — never confirmed here. */
	draftKeys: readonly DraftKeySpec[];
}

/**
 * §7.3 STEP 1 — PREPARE the operator approve-surface for a target role's certification
 * key-SET. PROPOSE-ONLY (B2): assembles the drafted fixtures+keys into ONE CertificationDraft
 * the operator approves in a single pass. It NEVER calls confirmLaunchKey (operator-gated) and
 * writes NOTHING to gauntlet_key.
 *
 * B1 (no self-cert): a target whose role slug is the recruiter's own is REFUSED — the recruiter
 * never drafts/runs its OWN certification (it is operator-bootstrap-certified). Fail-closed.
 *
 * SHADOW PATHS: target not found → WorkforceInputError (named); role not found →
 * WorkforceInputError; EMPTY draftKeys → an honest empty SET (keyCount 0) — not an error, the
 * operator simply has nothing to approve (F-008 honest empty, never a fabricated key).
 */
export async function draftCertificationSet(
	db: Db,
	input: DraftCertificationInput
): Promise<CertificationDraft> {
	const { version, role } = await loadTarget(db, input.roleVersionId);
	assertNotRecruiterSelf(role, 'draft a certification key-set for');

	const draftedKeys: DraftedKey[] = input.draftKeys.map((k) => ({
		fixtureSlug: k.fixtureSlug,
		plants: k.plants,
		fp_tolerance: k.fp_tolerance,
		fp_justification: k.fp_justification
	}));

	return {
		role: role.id,
		roleSlug: role.slug,
		roleVersion: version.id,
		tier: version.default_tier,
		draftedKeys,
		keyCount: draftedKeys.length
	};
}

// ── Step 2 — RUN the gauntlet (reuse runGauntlet) on operator approval ───────────────

export interface RunCertificationInput {
	/** The target role_version to interview (must match the approved draft). */
	roleVersionId: string;
	tier: Tier;
	provider: string;
	modelId: string;
	/**
	 * B2 GATE: the operator's explicit approval of the drafted key-SET. The recruiter cannot
	 * manufacture this — without `operatorApprovedKeySet === true` the run is REFUSED. (The
	 * operator confirms each key via confirmLaunchKey FIRST; this token asserts that act
	 * happened, so the orchestrator never runs an unkeyed/unapproved gauntlet.)
	 */
	operatorApprovedKeySet: boolean;
}

/**
 * §7.3 STEP 2/3 — on operator approval of the key-SET (B2), RUN the certification gauntlet
 * and COLLECT the interview_run. REUSES runGauntlet (the bootstrap-interview path) — NOT
 * forked. The trigger is ALWAYS 'operator' (the operator's key-SET approval IS the spend
 * decision, §3.7): the recruiter never auto-spends a budget slot.
 *
 * B1: refuses a recruiter-self target. B2: refuses without operatorApprovedKeySet. The run can
 * still come back 'queued' (runGauntlet's own surface) — that path never happens for an
 * operator trigger, but the outcome is returned faithfully (no fabrication).
 */
export async function runCertificationGauntlet(
	deps: GauntletDeps,
	input: RunCertificationInput
): Promise<GauntletOutcome> {
	if (input.operatorApprovedKeySet !== true) {
		throw new RecruiterIntegrityError(
			`runCertificationGauntlet requires operatorApprovedKeySet:true — the recruiter PROPOSES the ` +
				`key-set; the operator APPROVES it (B2). The orchestrator never confirms keys nor runs an ` +
				`unapproved gauntlet.`
		);
	}
	const { role } = await loadTarget(deps.db, input.roleVersionId);
	assertNotRecruiterSelf(role, 'run a certification gauntlet for');

	return runGauntlet(deps, {
		roleVersionId: input.roleVersionId,
		tier: input.tier,
		provider: input.provider,
		modelId: input.modelId,
		trigger: 'operator' // §3.7 — the operator's key-SET approval is the spend decision
	});
}

// ── Step 4 — CLASSIFY a terminal FAIL + re-version + propose a fix ───────────────────

export type FailClassification = 'candidate_miss' | 'key_defect';

/** A proposed key FIX (B2 — propose-only, NEVER applied). Keys are immutable + content-bound
 *  (§2.1), so a fix is necessarily a NEW-fixture/new-key recommendation the operator authors —
 *  the orchestrator NEVER silently re-keys. */
export interface KeyFixProposal {
	/** The fixture whose key over-constrains. */
	fixtureSlug: string;
	/** The plant id(s) suspected over-strict (the redundant required findings). */
	suspectPlants: string[];
	/** Operator-facing rationale: why this looks like a key defect, not a candidate miss. */
	rationale: string;
	/** The recommended remedy (always: author a NEW fixture without the redundant plant —
	 *  a correction needs a new content_sha → a new key; the old key is immutable). */
	recommendation: string;
}

export interface CertificationFailResult {
	classification: FailClassification;
	/** The re-version recovery (a fresh draft cloning the failed version's content — §2.2). */
	reversion: ReversionResult;
	/** Present ONLY for a key_defect classification — a propose-only key fix (B2). */
	keyFix: KeyFixProposal | null;
	/** For a candidate_miss: the recommended next move (re-run / suggest a higher tier). null
	 *  for a key_defect (the fix is the key, not the candidate). */
	candidateRemedy: string | null;
	/** Operator-facing evidence summary: per-fixture found/missed plant ids (B3 — read-only;
	 *  never rescored). */
	evidence: Array<{ fixture: string; found: string[]; missed: string[] }>;
}

/**
 * §7.3 STEP 4 — on a TERMINAL 'failed' run (§2.2), CLASSIFY the fail and recover:
 *   1. call reversionFailedRole (a fresh draft cloning the failed content — never an un-fail);
 *   2. classify candidate-miss vs KEY-DEFECT from the run's DETERMINISTIC results (B3 read-only);
 *   3. for a key_defect ONLY, emit a propose-only KeyFixProposal (B2 — never applied; keys are
 *      immutable, so the fix is a NEW-fixture recommendation for operator approval).
 *
 * It NEVER flips a cert (B4 — no transitionLifecycle call). It NEVER rescores (B3). It NEVER
 * confirms a key (B2).
 *
 * CLASSIFICATION HEURISTIC (deterministic, evidence-based — not an LLM judgment): a fail is a
 * KEY-DEFECT when the candidate found at least one plant in a fixture but missed OTHER plant(s)
 * in that SAME fixture (the over-strict / redundant-required-plant signature — the candidate did
 * the substantive work but the key demanded a redundant finding). A fail where the candidate
 * missed ALL plants of every fixture it touched (found nothing) is a genuine candidate_miss.
 *
 * SHADOW PATHS: run not found → WorkforceInputError; run not terminal-'failed' →
 * WorkforceInputError (only a terminal fail is classified — an 'adjudicating'/'passed'/'error'
 * run has no fail to recover); recruiter-self target → RecruiterIntegrityError (B1); a fail with
 * NO scored results (e.g. a contract_violation: findings.json absent) → candidate_miss (the
 * candidate produced nothing scorable — that is a capability miss, never a key defect).
 */
export async function classifyCertificationFail(
	db: Db,
	runId: string,
	opts: { higherTier?: Tier } = {}
): Promise<CertificationFailResult> {
	const run = await getInterviewRun(db, runId);
	if (!run) throw new WorkforceInputError(`interview_run not found: ${runId}`);
	if (run.status !== 'failed') {
		throw new WorkforceInputError(
			`interview_run ${runId} is '${run.status}' — only a terminal 'failed' run is classified for recovery (§2.2)`
		);
	}
	const role = await getRole(db, run.role);
	if (!role) throw new WorkforceInputError(`role not found: ${run.role}`);
	assertNotRecruiterSelf(role, 'classify a certification fail for');

	// B3: read the run's DETERMINISTIC per-fixture results (found/missed). Never rescored.
	const fixtureResults = extractFixtureResults(run);
	const evidence = fixtureResults.map((r) => ({ fixture: r.fixture, found: r.found, missed: r.missed }));

	// KEY-DEFECT signature: a fixture where SOME plants were found AND SOME missed — the
	// candidate did substantive work but the key demanded a redundant finding (the over-strict
	// class). A fixture with zero found is a genuine miss in that fixture.
	const keyDefectFixtures = fixtureResults.filter((r) => r.found.length > 0 && r.missed.length > 0);
	const classification: FailClassification = keyDefectFixtures.length > 0 ? 'key_defect' : 'candidate_miss';

	// §2.2 recovery — a fresh draft cloning the failed version's content (NOT an un-fail). The
	// recruiter NEVER mutates the failed version nor flips a lifecycle (B4).
	const reversion = await reversionFailedRole(db, role.id);

	if (classification === 'key_defect') {
		const f = keyDefectFixtures[0];
		const keyFix: KeyFixProposal = {
			fixtureSlug: f.fixture,
			suspectPlants: f.missed,
			rationale:
				`fixture '${f.fixture}': the candidate FOUND ${f.found.length} plant(s) [${f.found.join(', ')}] but ` +
				`MISSED ${f.missed.length} [${f.missed.join(', ')}] — the substantive defects were caught while ` +
				`other plant(s) went unfound. This is the OVER-STRICT / redundant-required-plant signature (the ` +
				`authoritative-port-18789 class): the key likely demands a finding a behaviorally-correct candidate omits.`,
			recommendation:
				`keys are immutable + content-bound (§2.1) — DO NOT re-key. Author a NEW fixture for '${f.fixture}' ` +
				`whose key drops the redundant plant(s) [${f.missed.join(', ')}] (new work → new content_sha → new ` +
				`key), then operator-confirm it via confirmLaunchKey. The recruiter proposes; the operator approves (B2).`
		};
		return { classification, reversion, keyFix, candidateRemedy: null, evidence };
	}

	// candidate_miss — re-run on the fresh draft; optionally suggest a higher tier.
	const candidateRemedy = opts.higherTier
		? `genuine candidate miss — re-run the fresh draft, or try a higher tier ('${opts.higherTier}') if the ` +
			`current tier under-performs. No key change (the key is not at fault).`
		: `genuine candidate miss — re-run the fresh draft. No key change (the key is not at fault); if re-runs ` +
			`keep failing, consider a higher tier.`;
	return { classification, reversion, keyFix: null, candidateRemedy, evidence };
}

// ── Read-only cert-state reporting (B4 — reports, never flips) ───────────────────────

/** The target version's current cert lifecycle (READ-ONLY — B4: the recruiter NEVER flips it;
 *  the operator keeps the D-039 gate). Mirrors what transitionLifecycle would report AFTER an
 *  operator flip, but performs NO write. */
export async function certLifecycleOf(
	db: Db,
	roleVersionId: string
): Promise<{ roleVersion: string; lifecycle: RoleVersionRow['lifecycle'] }> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);
	return { roleVersion: version.id, lifecycle: version.lifecycle };
}

// ── Shared helpers ───────────────────────────────────────────────────────────────────

/** Load + validate the target (named errors at the boundary). */
async function loadTarget(db: Db, roleVersionId: string): Promise<{ version: RoleVersionRow; role: RoleRow }> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);
	const role = await getRole(db, version.role);
	if (!role) throw new WorkforceInputError(`role not found: ${version.role}`);
	return { version, role };
}

/** B1 — REFUSE the recruiter's own role as a certification target (no self-cert). Fail loud. */
function assertNotRecruiterSelf(role: RoleRow, action: string): void {
	if (role.slug === RECRUITER_SLUG) {
		throw new RecruiterIntegrityError(
			`B1 violation: the recruiter cannot ${action} itself (role '${role.slug}') — a role never certifies ` +
				`itself; the recruiter is operator-bootstrap-certified (day-0-style). Refused.`
		);
	}
}

interface ExtractedFixtureResult {
	fixture: string;
	found: string[];
	missed: string[];
}

/** B3 — extract the scorer's per-fixture found/missed from the run's persisted results.
 *  READ-ONLY: never rescores, never reads gauntlet_key. The scorer wrote FixtureResult rows
 *  ({ fixture, kind, found, missed, extra, evidence }); the verdict/adjudication rows lack a
 *  `found` array and are skipped. Tolerates the SHADOW shapes (no results / malformed entry). */
function extractFixtureResults(run: InterviewRunRow): ExtractedFixtureResult[] {
	const out: ExtractedFixtureResult[] = [];
	for (const raw of run.results ?? []) {
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.fixture !== 'string' || !Array.isArray(r.found) || !Array.isArray(r.missed)) continue;
		out.push({
			fixture: r.fixture,
			found: r.found.filter((x): x is string => typeof x === 'string'),
			missed: r.missed.filter((x): x is string => typeof x === 'string')
		});
	}
	return out;
}
