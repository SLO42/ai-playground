// TASK 16.7 (W-D7c) — the DAY-0 BOOTSTRAP CEREMONY MECHANISM (WORKFORCE-SPEC §8,
// UNEXECUTED). The five ceremony steps as server-side WRITE-PATHS, every one behind the
// operator gate and INERT until the operator acts:
//
//   ① prompt-core review        — promptCoreDiffStep: the draft prompt_core + its
//      harvested provenance (the §8 "diff vs harvested source" substrate). READ-ONLY.
//   ② key diff+confirm          — confirmLaunchKey: the operator-authored answer key
//      write-path (createGauntletKey under the hood). The diff it confirms = work + key
//      + fp_tolerance + justification. We NEVER author a key here (operator gate) — this
//      is the engine the operator's confirm calls. Authorship is 'operator' only (§4.4).
//   ③ admission reference-runs  — triggerAdmissionReferenceRun: run the gauntlet at a
//      role's actual (tier, model_id) and RECORD the proof in gauntlet_key.reference_runs
//      (§3.8). Behind the gate; auto-trigger respects the §3.7 budget (null = inert).
//   ④ bootstrap interviews      — triggerBootstrapInterview: run the certification
//      gauntlet at (tier, model_id). Reuses 16.6's runGauntlet — NOT forked.
//   ⑤ panel flip (on 5 passes)  — ceremonyReadiness reports it; the FLIP itself is a
//      v2.1 panel-composition concern recorded as role_event elsewhere (out of scope —
//      declared deferred in the build summary).
//
// THE WHOLE POINT (§8): everything here is a MECHANISM. Nothing auto-spends. The
// operator-trigger paths require an explicit `operatorConfirmed:true` (the click IS the
// budget decision, §3.7); the auto-trigger paths pass through 16.6's checkInterviewBudget
// whose shipped default (budget.max_auto_interviews_per_day: null) means NOTHING runs —
// the would-be run is counted-and-surfaced (F-008: no invented spend).
//
// §3.4 ADJUDICATION WRITE-PATH (deliverable #3): adjudicateInterviewRun already exists in
// gauntlet.ts (operator resolution appends to interview_run.results and flips
// adjudicating→passed/failed against the SNAPSHOT pass bar — incl. ambiguous→passed via
// confirm_hit and ambiguous→failed via dismiss/false_positive). It is RE-EXPORTED here as
// the ceremony's adjudication surface — do NOT fork it.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	createGauntletKey,
	getRole,
	getRoleVersion,
	listRoleVersions,
	readGauntletKeyForScoring,
	WorkforceInputError,
	type GauntletFixtureRow,
	type GauntletKeyRow,
	type RoleRow,
	type RoleVersionRow,
	type Tier
} from './repo';
import { runGauntlet, type GauntletDeps, type GauntletOutcome } from './gauntlet';
import { checkDeployability } from './deployability';
import { parsePlant, ScorerKeyError } from './scorer';

/** Fixture kinds whose whole POINT is teeth — a key MUST carry ≥1 plant or it can never
 *  catch anything (DEFECT 4). clean_control / scorer_control legitimately carry zero. */
const PLANTED_KINDS: ReadonlySet<GauntletFixtureRow['kind']> = new Set([
	'planted_defect',
	'planted_absence',
	'hallucination_bait'
]);

// Deliverable #3: the §3.4 adjudication write-path (adjudicateInterviewRun + its
// AdjudicationInput / AmbiguousResolution types) lives in gauntlet.ts and is already on
// the workforce barrel (index.ts `export * from './gauntlet'`). Operator resolution
// appends to interview_run.results and flips adjudicating→passed/failed against the
// SNAPSHOT pass bar (ambiguous→passed via confirm_hit; ambiguous→failed via
// dismiss/false_positive). It is the ceremony's adjudication surface — NOT forked here.

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function str(v: unknown): string {
	return String(v);
}

/** Named error for an operator-gate violation (a ceremony step that requires an explicit
 *  operator action was called without one). Fail loud — never silently spend (§8/§3.7). */
export class CeremonyGateError extends Error {
	override readonly name = 'CeremonyGateError';
}

// ── Step ① — prompt-core review (diff vs harvested source) ──────────────────────────

export interface PromptCoreDiffStep {
	role: string;
	roleSlug: string;
	roleVersion: string;
	version: number;
	/** The draft prompt-core text the operator reviews. */
	promptCore: string;
	/** 'harvested: gstack <path>, MIT' — the source the operator diffs against (§8). */
	provenance: string | null;
	prompt_sha: string;
	/** Honest gate state: a draft version is reviewed BEFORE it can ever interview. */
	lifecycle: RoleVersionRow['lifecycle'];
}

/**
 * §8 step ①: the read-only data for the operator's prompt-core review — the draft
 * prompt_core, its harvested provenance (the diff substrate), and the content address.
 * READ-ONLY: reviewing changes nothing; the operator's APPROVAL is a separate act (a
 * draft version simply becomes interviewable — there is no prompt edit here, content
 * fields are IMMUTABLE, §2.1). A revision is a NEW version.
 */
export async function promptCoreDiffStep(
	db: Db,
	roleVersionId: string
): Promise<PromptCoreDiffStep> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);
	const role = await getRole(db, version.role);
	if (!role) throw new WorkforceInputError(`role not found: ${version.role}`);
	return {
		role: role.id,
		roleSlug: role.slug,
		roleVersion: version.id,
		version: version.version,
		promptCore: version.prompt_core,
		provenance: role.provenance ?? null,
		prompt_sha: version.prompt_sha,
		lifecycle: version.lifecycle
	};
}

// ── Step ② — key diff+confirm write-path (operator-authored) ────────────────────────

export interface LaunchKeyConfirmInput {
	fixture: string;
	/** Operator-authored machine-checkable plants (scorer.ts shape). EMPTY is legal for
	 *  clean_control / hallucination_bait fixtures (they carry no plants). */
	plants?: Array<Record<string, unknown>>;
	/** Per-fixture operator-authored FP tolerance (§3.5). */
	fp_tolerance?: number;
	fp_justification?: string;
	/** The operator's explicit confirm of the diff+confirm ceremony (§8). REQUIRED. */
	operatorConfirmed: boolean;
	/** DEFECT 4 escape hatch: an explicit operator override to confirm a teethless key
	 *  (empty plants) on a planted/bait fixture. Requires a justification — the operator
	 *  is on record that this fixture intentionally has no machine-checkable teeth. */
	allowEmptyPlants?: boolean;
	/** Required WHEN allowEmptyPlants is set — why a planted/bait key has no plants. */
	emptyPlantsJustification?: string;
}

export interface LaunchKeyDiff {
	fixtureSlug: string;
	/** The work the key answers (the diff's left side). */
	work: Record<string, unknown>;
	/** The key the operator is confirming (the diff's right side). */
	plants: Array<Record<string, unknown>>;
	fp_tolerance: number;
	fp_justification: string | null;
	/** Content-bound: the key's content_sha equals the fixture's (§2.1). */
	content_sha: string;
}

export interface LaunchKeyConfirmResult {
	key: GauntletKeyRow;
	/** The diff the operator confirmed (work + key + tolerance + justification — §8). */
	diff: LaunchKeyDiff;
	/** false when a key already existed (idempotent absorb — interrupt contract). */
	created: boolean;
	/** DEFECT 2: true when a key already existed AND the incoming plants/tolerance DIFFER
	 *  from what is stored — the correction was NOT applied (keys are content-bound +
	 *  immutable; a correction needs a NEW fixture). Absent/false on a clean idempotent
	 *  re-confirm where the incoming key matches the stored one. */
	changed?: boolean;
	/** DEFECT 2: the named reason the operator's re-confirm was a no-op (only when
	 *  changed:true). The operator LEARNS the correction did not land and why. */
	reason?: string;
}

/**
 * §8 step ②: the operator's answer-key diff+confirm WRITE-PATH. The operator authors the
 * key (plants + fp_tolerance + justification); this records it via createGauntletKey
 * (author='operator' — §4.4: keys are operator-authored, never PM/agent) and returns the
 * confirmed diff (work + key + tolerance + justification, §8). content_sha is bound
 * mechanically to the fixture's work inside createGauntletKey (§2.1).
 *
 * GATE (fail-closed): `operatorConfirmed` MUST be true — without it this throws
 * CeremonyGateError (the diff+confirm ceremony has not happened).
 *
 * VALIDATION (DEFECT 1 — D-026 trust boundary): operator-authored plants are DATA. Every
 * plant is parsed/validated through the scorer's parsePlant BEFORE persist; a malformed
 * plant raises a named WorkforceInputError naming which plant + why — it never reaches
 * the DB to fail (silently) as a ScorerKeyError at SCORING time.
 *
 * TEETH (DEFECT 4): a planted_defect / planted_absence / hallucination_bait key with an
 * EMPTY plants array can never catch anything. We reject it (WorkforceInputError) unless
 * the operator passes an explicit allowEmptyPlants override + emptyPlantsJustification.
 *
 * INTERRUPT CONTRACT + STALE-KEY SIGNAL (DEFECT 2): a key already present for the fixture
 * is an idempotent absorb (created:false). BUT keys are content-bound + immutable — if the
 * incoming plants/tolerance/justification DIFFER from the stored key, the correction was
 * NOT applied; we return created:false + changed:true + a named reason so the operator
 * learns a NEW fixture is required (the stored key is returned unchanged).
 *
 * CONCURRENCY (DEFECT 3): a concurrent double-confirm races past the detect-first read and
 * collides on the gauntlet_key_dedup UNIQUE index. We catch that raw InternalError and map
 * it to a named CeremonyGateError ('key already confirmed for this fixture'); final state
 * stays exactly one key.
 */
export async function confirmLaunchKey(
	db: Db,
	input: LaunchKeyConfirmInput
): Promise<LaunchKeyConfirmResult> {
	if (input.operatorConfirmed !== true) {
		throw new CeremonyGateError(
			`confirmLaunchKey requires an explicit operator confirm — the §8 key diff+confirm ceremony is operator-gated`
		);
	}
	const fid = link(input.fixture);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $fid;`, { fid });
	if (!rows.length) throw new WorkforceInputError(`gauntlet_fixture not found: ${input.fixture}`);
	const fixture = normFixture(rows[0]);

	const plants = input.plants ?? [];

	// DEFECT 1 — D-026 pre-flight: validate operator-authored plants at the boundary, NOT
	// at scoring time. parsePlant is the scorer's own contract; we surface its ScorerKeyError
	// as a named WorkforceInputError (operator input is DATA — validate where it enters).
	// Always validate the plants the operator authored on THIS call, before any persist or
	// drift comparison — a malformed correction must be rejected even if a key already exists.
	if (input.plants !== undefined) validatePlantsForConfirm(fixture, plants);

	const existing = await readGauntletKeyForScoring(db, fixture.id);
	if (existing) {
		// DEFECT 2 — stale-key signal: the key is immutable + content-bound. If the operator
		// re-confirms with a CORRECTION that differs from what is stored, the correction did
		// NOT land — say so loudly instead of silently returning the stale key.
		const drift = keyDrift(input, existing);
		return {
			key: existing,
			diff: diffFor(fixture, existing.plants, existing.fp_tolerance, existing.fp_justification ?? null),
			created: false,
			...(drift
				? {
						changed: true,
						reason:
							`a key already exists for fixture '${fixture.slug}' and keys are immutable + ` +
							`content-bound (§2.1) — the re-confirmed ${drift} was NOT applied; a correction ` +
							`requires a NEW fixture (new work → new content_sha → new key)`
					}
				: {})
		};
	}

	// DEFECT 4 — teeth (create path only): a planted/bait key with no plants can never catch
	// anything. Reject unless the operator explicitly overrides with a justification (on
	// record). Enforced HERE, after the existing-key check, so a plain idempotent re-confirm
	// (plants omitted, key already present) is never spuriously rejected.
	assertHasTeeth(fixture, plants, input);

	let key: GauntletKeyRow;
	try {
		key = await createGauntletKey(db, {
			fixture: fixture.id,
			plants,
			...(input.fp_tolerance !== undefined ? { fp_tolerance: input.fp_tolerance } : {}),
			...(input.fp_justification !== undefined ? { fp_justification: input.fp_justification } : {}),
			author: 'operator'
		});
	} catch (err) {
		// DEFECT 3 — concurrency: a parallel confirm won the dedup race between our read and
		// this write. The UNIQUE index throws a RAW 'InternalError: Database index
		// `gauntlet_key_dedup` already contains …'. Map it into the module taxonomy.
		if (isDedupCollision(err)) {
			throw new CeremonyGateError(
				`a key was already confirmed for fixture '${fixture.slug}' by a concurrent confirm — ` +
					`one key per fixture (dedup UNIQUE); re-read before re-confirming`
			);
		}
		throw err;
	}
	return {
		key,
		diff: diffFor(fixture, key.plants, key.fp_tolerance, key.fp_justification ?? null),
		created: true
	};
}

/** DEFECT 1 — validate every operator-authored plant through the scorer's own parsePlant
 *  at the confirm boundary (D-026: operator input is DATA). A malformed plant surfaces as a
 *  named WorkforceInputError naming WHICH plant (by index + id when present) and WHY,
 *  wrapping the scorer's ScorerKeyError message — never persisted to fail at scoring time. */
function validatePlantsForConfirm(
	fixture: GauntletFixtureRow,
	plants: Array<Record<string, unknown>>
): void {
	plants.forEach((raw, i) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new WorkforceInputError(
				`fixture '${fixture.slug}': plant[${i}] must be an object (machine-checkable plant, §2.1)`
			);
		}
		try {
			parsePlant(raw, fixture.slug);
		} catch (err) {
			if (err instanceof ScorerKeyError) {
				const idPart = typeof raw.id === 'string' && raw.id.trim() ? ` (id '${raw.id.trim()}')` : '';
				throw new WorkforceInputError(
					`fixture '${fixture.slug}': plant[${i}]${idPart} is not machine-checkable — ${err.message} ` +
						`(D-026: operator key input is validated at confirm, not at scoring)`
				);
			}
			throw err;
		}
	});
}

/** DEFECT 4 — a planted_defect / planted_absence / hallucination_bait key with NO plants
 *  is teethless: it can never catch anything (e.g. an A8 bait would be keyed but NEVER
 *  scored). Require ≥1 plant, unless the operator explicitly overrides with a justification.
 *  For bait fixtures the meaningful plant is mode:'noncompliance'+compliance_pattern — warn
 *  (do not hard-block) when a bait key has plants but none are noncompliance. */
function assertHasTeeth(
	fixture: GauntletFixtureRow,
	plants: Array<Record<string, unknown>>,
	input: LaunchKeyConfirmInput
): void {
	if (!PLANTED_KINDS.has(fixture.kind)) return; // clean_control / scorer_control: zero is legal
	if (plants.length === 0) {
		if (input.allowEmptyPlants === true) {
			if (typeof input.emptyPlantsJustification !== 'string' || !input.emptyPlantsJustification.trim()) {
				throw new WorkforceInputError(
					`fixture '${fixture.slug}' (${fixture.kind}): allowEmptyPlants requires emptyPlantsJustification — ` +
						`an empty-plant key has no teeth; the operator must justify it on record`
				);
			}
			return; // operator is on record that this fixture intentionally has no teeth
		}
		throw new WorkforceInputError(
			`fixture '${fixture.slug}' (${fixture.kind}) needs ≥1 plant — a key with empty plants can never ` +
				`catch anything (teethless); pass allowEmptyPlants:true + emptyPlantsJustification to override`
		);
	}
	if (fixture.kind === 'hallucination_bait') {
		const hasNoncompliance = plants.some(
			(p) => (p?.detection as Record<string, unknown> | undefined)?.mode === 'noncompliance'
		);
		if (!hasNoncompliance) {
			// Advisory only (not a hard stop): bait teeth are USUALLY noncompliance, but a bait
			// may legitimately also carry a presence/absence plant. Surface via a named warning.
			console.warn(
				`[confirmLaunchKey] fixture '${fixture.slug}' is hallucination_bait but no plant uses ` +
					`detection.mode:'noncompliance'+compliance_pattern — A8 bait is normally scored report-wide ` +
					`via a noncompliance plant; confirm this is intentional`
			);
		}
	}
}

/** DEFECT 2 — does the incoming confirm DIFFER from the stored key? Returns a short label
 *  of WHAT drifted (for the operator-facing reason), or null when the incoming matches the
 *  stored key (a clean idempotent re-confirm). Plants compared by canonical JSON; tolerance
 *  + justification by value. An OMITTED field in the incoming input is "no change" (the
 *  operator did not re-author it), so it never counts as drift. */
function keyDrift(input: LaunchKeyConfirmInput, existing: GauntletKeyRow): string | null {
	const drifts: string[] = [];
	if (input.plants !== undefined && canon(input.plants) !== canon(existing.plants)) {
		drifts.push('plants');
	}
	if (input.fp_tolerance !== undefined && input.fp_tolerance !== existing.fp_tolerance) {
		drifts.push('fp_tolerance');
	}
	if (
		input.fp_justification !== undefined &&
		input.fp_justification !== (existing.fp_justification ?? undefined)
	) {
		drifts.push('fp_justification');
	}
	return drifts.length ? drifts.join('+') : null;
}

/** Stable canonical JSON (object keys sorted) so plant-equality is order-insensitive on
 *  keys but order-sensitive on the plants array (plant order is meaningful). */
function canon(value: unknown): string {
	return JSON.stringify(value, (_k, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
			: v
	);
}

/** DEFECT 3 — is this the one-key-per-fixture collision? Reproduced THREE raw shapes from
 *  SurrealDB 2.x (instrumented under serial + concurrent load, all InternalError):
 *    (a) PRIMARY-KEY collision — the deterministic key id already exists (createGauntletKey
 *        derives gauntlet_key:<fixture-suffix>, so a double-create hits the SAME record id):
 *        "Database record `gauntlet_key:…` already exists";
 *    (b) SECONDARY-index collision on the gauntlet_key_dedup UNIQUE index (serial path):
 *        "Database index `gauntlet_key_dedup` already contains '…', with record '…'";
 *    (c) COMMIT-race conflict when two writers reach commit together:
 *        "The query was not executed due to a failed transaction. Failed to commit
 *         transaction due to a read or write conflict. This transaction can be retried".
 *  All three are the SAME invariant ("one key per fixture") biting at this single write. We
 *  call this ONLY in confirmLaunchKey's createGauntletKey catch, where the ONLY write is the
 *  key insert, so any of these here can be nothing else. Match on shape (resilient to the
 *  surrounding text), not the error class — the raw class is InternalError for all three. */
function isDedupCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/record `?gauntlet_key:[^`']*`? already exists/i.test(msg) ||
		/index `?gauntlet_key_dedup`? already contains/i.test(msg) ||
		/failed transaction|read or write conflict/i.test(msg)
	);
}

function diffFor(
	fixture: GauntletFixtureRow,
	plants: Array<Record<string, unknown>>,
	fpTolerance: number,
	fpJustification: string | null
): LaunchKeyDiff {
	return {
		fixtureSlug: fixture.slug,
		work: fixture.work,
		plants,
		fp_tolerance: fpTolerance,
		fp_justification: fpJustification,
		content_sha: fixture.content_sha
	};
}

// ── Steps ③/④ — admission reference-run + bootstrap-interview triggers ──────────────

export interface CeremonyRunInput {
	roleVersionId: string;
	tier: Tier;
	provider: string;
	modelId: string;
	/**
	 * Spend authority (§3.7): 'operator' (the click IS the budget decision — bypasses the
	 * budget gate) or 'auto' (must pass checkInterviewBudget; the shipped null cap means
	 * nothing runs — the would-be run is counted-and-surfaced). An operator trigger MUST
	 * carry operatorConfirmed:true — the gate is fail-closed.
	 */
	trigger: 'operator' | 'auto';
	/** REQUIRED true when trigger='operator' — no silent operator spend (§8). */
	operatorConfirmed?: boolean;
}

/**
 * §8 step ④: run the BOOTSTRAP INTERVIEW (the certification gauntlet) at a role's actual
 * (tier, model_id). A thin, gated wrapper over 16.6's runGauntlet — NOT a fork. The
 * runner does all the work (confinement, sterile spawn, scoring, budget); this layer only
 * enforces the operator gate so the ceremony can never auto-spend by accident (§8/§3.7).
 */
export async function triggerBootstrapInterview(
	deps: GauntletDeps,
	input: CeremonyRunInput
): Promise<GauntletOutcome> {
	assertSpendAuthority(input);
	return runGauntlet(deps, {
		roleVersionId: input.roleVersionId,
		tier: input.tier,
		provider: input.provider,
		modelId: input.modelId,
		trigger: input.trigger
	});
}

export interface ReferenceRunResult {
	outcome: GauntletOutcome;
	/** The fixtures whose key recorded this run as an admission proof (§3.8). When the
	 *  run did not PASS, or a fixture has no key yet, nothing is recorded (honest). */
	recordedFor: string[];
	/** true when the proof used the draft itself as prover (brand-new role) — the §3.8
	 *  provisional caveat ('plants proven findable at <tier>, by the draft itself'). */
	provisional: boolean;
}

/**
 * §8 step ③: trigger an ADMISSION REFERENCE-RUN at a role's actual (tier, model_id) and,
 * on a PASS, record the proof in each sampled fixture's gauntlet_key.reference_runs
 * (§3.8). The prover is the role's CURRENT certified incumbent at that (tier, model_id);
 * for a brand-new role (no certified incumbent) the draft itself proves, marked
 * `provisional:true` (the recall floor's justification is only as strong as its prover).
 *
 * INERT BY DEFAULT: identical gate to step ④. Recording is idempotent — a reference-run
 * entry for the same (key, interview_run) is never duplicated (interrupt contract).
 */
export async function triggerAdmissionReferenceRun(
	deps: GauntletDeps,
	input: CeremonyRunInput
): Promise<ReferenceRunResult> {
	assertSpendAuthority(input);
	const { db } = deps;
	const version = await getRoleVersion(db, input.roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${input.roleVersionId}`);
	const role = await getRole(db, version.role);
	if (!role) throw new WorkforceInputError(`role not found: ${version.role}`);

	// Provisional iff the role has no certified incumbent at this (prompt_sha × model_id).
	const provisional = await isProvisionalProver(db, role, input.modelId);

	const outcome = await runGauntlet(deps, {
		roleVersionId: input.roleVersionId,
		tier: input.tier,
		provider: input.provider,
		modelId: input.modelId,
		trigger: input.trigger
	});

	// Record the proof ONLY on a genuine pass — a reference-run that did not certify is
	// not an admission proof (F-008: never record a proof the run did not establish).
	const recordedFor: string[] = [];
	if (outcome.kind === 'ran' && outcome.run.status === 'passed') {
		const proof = {
			tier: input.tier,
			model_id: input.modelId,
			interview_run: outcome.run.id,
			at: new Date().toISOString(),
			...(provisional ? { provisional: true } : {})
		};
		// Append to every keyed fixture of the role (the admission set §3.8). Idempotent.
		const fixtures = await activeKeyedFixtures(db, role.id);
		for (const f of fixtures) {
			const recorded = await recordReferenceRun(db, f.id, outcome.run.id, proof);
			if (recorded) recordedFor.push(f.slug);
		}
	}
	return { outcome, recordedFor, provisional };
}

/** Append a reference-run proof to a fixture's key (§3.8). Idempotent: a proof for the
 *  same interview_run is never added twice. Returns true iff a NEW proof was recorded. */
export async function recordReferenceRun(
	db: Db,
	fixtureId: string,
	interviewRunId: string,
	proof: Record<string, unknown>
): Promise<boolean> {
	const key = await readGauntletKeyForScoring(db, fixtureId);
	if (!key) return false; // no key yet — nothing to record against (honest)
	const already = key.reference_runs.some((r) => str(r.interview_run) === interviewRunId);
	if (already) return false;
	await db.query(
		`UPDATE gauntlet_key SET reference_runs += $proof WHERE fixture = $fid;`,
		{ fid: link(fixtureId), proof }
	);
	return true;
}

/** A role is a provisional prover iff it has NO certified incumbent at this model_id —
 *  i.e. no active_version, or its active version is not deployable at (prompt_sha ×
 *  model_id). The draft-proves-itself case (§3.8). */
async function isProvisionalProver(db: Db, role: RoleRow, modelId: string): Promise<boolean> {
	if (!role.active_version) return true;
	const verdict = await checkDeployability(db, role.active_version, modelId);
	return !verdict.deployable;
}

/** The role's active candidate-facing fixtures that already carry a key (the admission
 *  set whose proofs a reference-run records — §3.8). scorer_control excluded. */
async function activeKeyedFixtures(db: Db, roleId: string): Promise<GauntletFixtureRow[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM gauntlet_fixture
		  WHERE role = $role AND status = 'active' AND kind != 'scorer_control'
		  ORDER BY slug ASC LIMIT 200;`,
		{ role: link(roleId) }
	);
	const out: GauntletFixtureRow[] = [];
	for (const r of rows) {
		const f = normFixture(r);
		const key = await readGauntletKeyForScoring(db, f.id);
		if (key) out.push(f);
	}
	return out;
}

/** Fail-closed spend-authority gate (§8/§3.7): an operator trigger MUST carry an explicit
 *  confirm. The click IS the budget decision — a missing confirm is a gate violation, not
 *  a silent spend. Auto triggers are gated downstream by checkInterviewBudget. */
function assertSpendAuthority(input: CeremonyRunInput): void {
	if (input.trigger === 'operator' && input.operatorConfirmed !== true) {
		throw new CeremonyGateError(
			`an operator-triggered ceremony run requires operatorConfirmed:true — no silent operator spend (§8/§3.7)`
		);
	}
}

// ── Step ⑤ — ceremony readiness (the panel-flip precondition, read-only) ────────────

export interface RoleCeremonyState {
	role: string;
	roleSlug: string;
	/** The role's launch (draft/interviewing/passed) version, if any. */
	roleVersion: string | null;
	version: number | null;
	lifecycle: RoleVersionRow['lifecycle'] | null;
	/** Deployable at its default tier's model? (the §2.4 existential check.) */
	certified: boolean;
	/** Honest reason when not certified (the §2.4 named reason or 'no version'). */
	reason: string | null;
}

export interface CeremonyReadiness {
	roles: RoleCeremonyState[];
	/** §8 step ⑤ precondition: every launch role has a certified version. The FLIP itself
	 *  (panel composition → catalog roles) is recorded elsewhere — readiness only REPORTS. */
	allCertified: boolean;
}

/**
 * §8 step ⑤ (read-only): report each launch role's certification state and whether the
 * five-pass precondition for the panel flip is met. We resolve deployability per role at
 * the model its default tier maps to — but tier→model is a config concern (D-003), so we
 * accept the resolved modelId per role from the caller. Honest empties throughout (F-008).
 */
export async function ceremonyReadiness(
	db: Db,
	roleModelIds: Record<string, string>
): Promise<CeremonyReadiness> {
	const [roleRows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, slug, active_version FROM role WHERE status = 'active' ORDER BY slug ASC LIMIT 100;`
	);
	const roles: RoleCeremonyState[] = [];
	for (const r of roleRows) {
		const roleId = str(r.id);
		const slug = str(r.slug);
		const versions = await listRoleVersions(db, roleId);
		const launch = versions.find((v) => v.lifecycle !== 'withdrawn') ?? null;
		if (!launch) {
			roles.push({
				role: roleId,
				roleSlug: slug,
				roleVersion: null,
				version: null,
				lifecycle: null,
				certified: false,
				reason: 'no version'
			});
			continue;
		}
		const modelId = roleModelIds[slug] ?? roleModelIds[roleId] ?? '';
		const verdict = await checkDeployability(db, launch.id, modelId);
		roles.push({
			role: roleId,
			roleSlug: slug,
			roleVersion: launch.id,
			version: launch.version,
			lifecycle: launch.lifecycle,
			certified: verdict.deployable,
			reason: verdict.reason
		});
	}
	return {
		roles,
		allCertified: roles.length > 0 && roles.every((r) => r.certified)
	};
}

// ── shared normalizer ───────────────────────────────────────────────────────────────

function normFixture(row: Record<string, unknown>): GauntletFixtureRow {
	return {
		id: str(row.id),
		role: str(row.role),
		slug: str(row.slug),
		kind: row.kind as GauntletFixtureRow['kind'],
		work: (row.work ?? {}) as Record<string, unknown>,
		content_sha: str(row.content_sha),
		sentinel: str(row.sentinel),
		...(row.provenance != null ? { provenance: str(row.provenance) } : {}),
		status: row.status as GauntletFixtureRow['status'],
		created_at: null
	};
}
