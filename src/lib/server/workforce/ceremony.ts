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
	addRoleEvent,
	createGauntletKey,
	createRoleVersion,
	getRole,
	getRoleVersion,
	listRoles,
	listRoleVersions,
	readGauntletKeyForScoring,
	WorkforceInputError,
	type GauntletFixtureRow,
	type GauntletKeyRow,
	type RoleRow,
	type RoleVersionRow,
	type Tier
} from './repo';
import { isCeremonySelectable } from './lifecycle';
import { runGauntlet, type GauntletDeps, type GauntletOutcome } from './gauntlet';
import { checkDeployability } from './deployability';
import { activateGauntletFixture, isSentinelShape, newSentinelUlid } from './activation';
import { parsePlant, ScorerKeyError, KNOWN_PASS_PATH } from './scorer';
import { parseFindingsFile } from './findings';

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
	if (input.plants !== undefined && canon(normPlants(input.plants)) !== canon(normPlants(existing.plants))) {
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

/** Normalize the path-shaped fields of each plant the SAME way parsePlant does before a
 *  drift compare, so a path-separator (`\` vs `/`) or surrounding-whitespace-only diff in
 *  `detection.file` never false-reports changed:true. parsePlant canonicalizes
 *  `detection.file` as `trim().replace(/\\/g, '/')` (scorer.ts) and persists the operator's
 *  RAW plants, so a stored `f.ts` vs a re-confirmed `f\ts` / `f.ts ` are scoring-identical.
 *  Path-only: every other field is left byte-identical so a REAL plant change still drifts.
 *  Non-object / nil entries pass through untouched (shadow paths: empty array, nil, malformed
 *  plant) so canon still compares them faithfully. */
function normPlants(plants: unknown): unknown {
	if (!Array.isArray(plants)) return plants;
	return plants.map((p) => {
		if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
		const plant = p as Record<string, unknown>;
		const det = plant.detection;
		if (!det || typeof det !== 'object' || Array.isArray(det)) return plant;
		const d = det as Record<string, unknown>;
		if (typeof d.file !== 'string') return plant;
		return { ...plant, detection: { ...d, file: d.file.trim().replace(/\\/g, '/') } };
	});
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

// ── scorer_control readiness (§3.4) — mechanically-derived control key + activation ──

/** Escape a literal string so it matches itself when compiled as a RegExp source. The
 *  absence plant's artifact_pattern is a regex (scorer compiles it); the control's
 *  known-fail report carries the literal artifact name, so we escape it to a FULL,
 *  unambiguous literal match (no accidental metacharacter behavior). */
function escapeRegex(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * §3.4 PER-BATCH POSITIVE CONTROL READINESS. Make the role's scorer_control fixture
 * keyed + active so every gauntlet run can control-verify the scorer BEFORE it judges a
 * candidate (runGauntlet → runPositiveControl). Idempotent — safe to call before every run.
 *
 * WHY THE CONTROL KEY IS MECHANICALLY DERIVED (not operator-authored): a scorer_control's
 * key is NOT a matter of operator judgment. The fixture SHIPS its own answer — its static
 * `known-pass.findings.json` IS, by construction, the report a correct scorer must score as
 * "all plants found". So the control's plants are mechanically derivable FROM that report:
 * each known-pass finding becomes the plant it must match. §4.4 explicitly blesses such
 * mechanically-derived keys (author:'fixing_commit_diff'). This closes the ceremony/§3.4
 * CONTRADICTION: the operator key-authoring + activation flow (confirmLaunchKey /
 * ceremonyAuthoringState / activeKeyedFixtures) deliberately EXCLUDES scorer_control
 * (kind != 'scorer_control'), which left every control 'proposed' with no key, so every
 * interview failed scorer_error ("no active scorer_control fixture (with key)"). Deriving
 * the key here — outside the operator flow, from the fixture's own shipped report — is the
 * correct authorship and makes the control ready without operator action.
 *
 * Detection is FILE+LINES ONLY for presence (no evidence_pattern): the control demands a
 * FULL match against the known-pass finding with ZERO ambiguity (runPositiveControl rejects
 * any ambiguous/partial), and the known-fail (empty report) must miss it. file+lines gives a
 * clean full match on known-pass and no match on known-fail; an extra evidence_pattern would
 * risk a partial match and break the control.
 */
export async function ensureScorerControlReady(db: Db, roleId: string): Promise<void> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM gauntlet_fixture
		  WHERE role = $role AND kind = 'scorer_control'
		  ORDER BY slug ASC LIMIT 1;`,
		{ role: link(roleId) }
	);
	if (!rows.length) {
		throw new WorkforceInputError(
			`role '${roleId}' has no scorer_control fixture — the scorer cannot be control-verified (§3.4)`
		);
	}
	const control = normFixture(rows[0]);

	// CHECK-THEN-CREATE (idempotency): only derive+create when there is no key yet. We do
	// NOT rely on createGauntletKey's deterministic-id collision to skip — we skip cleanly.
	const existingKey = await readGauntletKeyForScoring(db, control.id);
	if (!existingKey) {
		const passRaw = control.work[KNOWN_PASS_PATH];
		if (typeof passRaw !== 'string') {
			throw new WorkforceInputError(
				`scorer_control '${control.slug}' carries no ${KNOWN_PASS_PATH} in its work — ` +
					`cannot mechanically derive the control key (§3.4)`
			);
		}
		const parsed = parseFindingsFile(passRaw);
		if (!parsed.ok) {
			throw new WorkforceInputError(
				`scorer_control '${control.slug}' ${KNOWN_PASS_PATH} is unparseable: ${parsed.reason}`
			);
		}
		const plants: Array<Record<string, unknown>> = parsed.findings.map((f, i) => {
			const id = (f.kind === 'presence' && f.class) || `control-${i}`;
			if (f.kind === 'absence') {
				return {
					id,
					detection: { mode: 'absence', artifact_pattern: escapeRegex(f.artifact) }
				};
			}
			// presence — file + lines ONLY (zero-ambiguity full match; no evidence_pattern).
			return {
				id,
				...(f.class ? { class: f.class } : {}),
				detection: {
					mode: 'presence',
					...(f.file ? { file: f.file } : {}),
					...(f.lines ? { lines: f.lines } : {})
				}
			};
		});
		if (plants.length === 0) {
			throw new WorkforceInputError(
				`scorer_control '${control.slug}' ${KNOWN_PASS_PATH} has no findings — ` +
					`a control with no plants has no teeth (§3.4)`
			);
		}
		// Mechanically derived from the fixture's own shipped known-pass report (§4.4).
		await createGauntletKey(db, {
			fixture: control.id,
			plants,
			author: 'fixing_commit_diff'
		});
	}

	// Mint the leak-tripwire sentinel BEFORE activating (§4.2 / F-025). seedLaunchPool ships
	// every launch fixture with sentinel='' so an authoring transcript can never trip its own
	// sweep; the ULID is minted server-side AT activation, after all authoring. activation
	// REJECTS a malformed (empty/short/low-entropy) sentinel — an empty needle match-alls the
	// sweep — so a proposed control with no valid ULID must be re-minted here. This mirrors the
	// candidate-activate route's ensureSentinel exactly (the route mints before activating; this
	// direct caller must too). Idempotent: skip if already active (sentinel is immutable once
	// active — the engine's idempotent-absorb returns first) or already a valid ULID.
	if (control.status !== 'active' && !isSentinelShape(control.sentinel)) {
		await db.query(`UPDATE $fid SET sentinel = $s;`, { fid: link(control.id), s: newSentinelUlid() });
	}

	// Activation is idempotent (an already-active fixture absorbs it — §3.7/§4.2).
	if (control.status !== 'active') {
		await activateGauntletFixture(db, control.id);
	}
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
	const { db } = deps;
	// §3.4: guarantee a keyed+active scorer_control BEFORE the run, so the scorer is
	// control-verified for this batch (else runGauntlet records scorer_error). Resolve the
	// roleId from the role_version being interviewed. A failure here is a named, honest stop.
	const version = await getRoleVersion(db, input.roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${input.roleVersionId}`);
	await ensureScorerControlReady(db, version.role);
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

	// §3.4: guarantee a keyed+active scorer_control BEFORE the run (else runGauntlet records
	// scorer_error). A failure here is a named, honest stop — never silently swallowed.
	await ensureScorerControlReady(db, role.id);

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

// ── Recovery — re-version a role whose newest version is terminally FAILED ──────────
//
// §2.2: a 'failed' role_version is TERMINAL and IMMUTABLE — a verdict can never be
// laundered by mutating/un-failing the row. The legitimate recovery path is a NEW version
// (correct-by-construction): createRoleVersion clones the failed version's CONTENT
// (prompt_core + capabilities + default_tier) into the role's next version, which starts at
// the §2.2 INITIAL state ('draft'). The new prompt_sha is computed mechanically by
// createRoleVersion (D-035 — NEVER hand-rolled here); since the prompt_core+capabilities are
// identical, the sha is identical BY CONSTRUCTION (intended — content-address stability).
// The fresh version is UN-certified and must EARN its own passing run; the failed version is
// left exactly as it was. The provenance ('re-version of the failed vN') is recorded as an
// append-only role_event{op:'created'} — there is no free-text provenance field on
// role_version (SCHEMAFULL), so the audit row carries it.

export interface ReversionResult {
	/** true when a NEW version was created; false when reversion was a guarded no-op (the
	 *  role already has a newer selectable version, or its newest version is not failed). */
	reversioned: boolean;
	/** The newly-created version (when reversioned); else the existing newest selectable
	 *  version the operator should drive instead. null only when the role has no version. */
	version: RoleVersionRow | null;
	/** The terminal failed version this recovers from (when reversioned); null otherwise. */
	from: RoleVersionRow | null;
	/** Honest named reason for a no-op (else null). */
	reason: string | null;
}

/**
 * §8 RECOVERY: when a role's NEWEST version is terminally 'failed' (the scorer-bug case —
 * a now-fixed bug left v1 failed, terminal), create a fresh version cloning its content so
 * the ceremony has a drivable target again. Guards (idempotent / fail-closed):
 *   • role not found / no versions          → WorkforceInputError (named).
 *   • role already has a selectable version  → NO-OP (reversioned:false) — the picker is
 *     already targeting a live version; a second click does not spawn an unbounded chain.
 *   • newest version is NOT failed           → NO-OP (reversioned:false) — only a failed
 *     newest is the recovery trigger (a draft/error/passed newest is already drivable, and a
 *     withdrawn/retired newest is an explicit operator end-state, not a scorer accident).
 * The double-submit guard is the "already has a selectable version" check: the first
 * reversion creates v2(draft) → selectable, so the second click no-ops.
 * NEVER mutates the failed version (§2.2 immutability) — only createRoleVersion + addRoleEvent.
 */
export async function reversionFailedRole(db: Db, roleId: string): Promise<ReversionResult> {
	const role = await getRole(db, roleId);
	if (!role) throw new WorkforceInputError(`role not found: ${roleId}`);
	const versions = await listRoleVersions(db, role.id);
	if (versions.length === 0) {
		throw new WorkforceInputError(
			`role ${role.slug} has no versions to re-version — seed a draft first (§8 ①)`
		);
	}

	// Double-submit / no-op guard: if a drivable version already exists, the picker is
	// targeting it — do NOT create another (bounds the version chain; interrupt-safe).
	const existingSelectable = pickLaunchVersion(versions);
	if (existingSelectable) {
		return {
			reversioned: false,
			version: existingSelectable,
			from: null,
			reason: `role ${role.slug} already has a drivable version (v${existingSelectable.version}, ${existingSelectable.lifecycle}) — no re-version needed`
		};
	}

	const newest = newestVersion(versions);
	// existingSelectable is null ⇒ newest is failed/withdrawn/retired. Recovery applies ONLY
	// to a FAILED newest (the scorer-bug case). A withdrawn/retired newest is an operator
	// end-state — surfaced honestly, not silently re-versioned.
	if (!newest || newest.lifecycle !== 'failed') {
		return {
			reversioned: false,
			version: null,
			from: newest,
			reason: newest
				? `role ${role.slug} newest version (v${newest.version}) is '${newest.lifecycle}', not 'failed' — re-version applies only to a failed terminal`
				: `role ${role.slug} has no version to recover`
		};
	}

	// Correct-by-construction recovery: a NEW version cloning the failed version's CONTENT.
	// createRoleVersion auto-increments version (max+1) and computes prompt_sha mechanically
	// (D-035). source:'operator' (an operator-initiated recovery). The failed row is untouched.
	const created = await createRoleVersion(db, {
		role: role.id,
		prompt_core: newest.prompt_core,
		capabilities: newest.capabilities,
		default_tier: newest.default_tier,
		source: 'operator'
	});

	// Append-only provenance: this version is a re-version of the failed prior (audit feed).
	await addRoleEvent(db, {
		role: role.id,
		role_version: created.id,
		op: 'created',
		detail: {
			reason: 'reversion',
			of_version: newest.version,
			of_role_version: newest.id,
			of_lifecycle: newest.lifecycle,
			of_prompt_sha: newest.prompt_sha
		}
	});

	return { reversioned: true, version: created, from: newest, reason: null };
}

/** Read-only: the reversion AFFORDANCE state for a role — whether the operator should be
 *  offered a 're-version & retry'. reversionable iff the role has NO ceremony-selectable
 *  version AND its newest version is terminally 'failed'. Honest empties: a role with a live
 *  version, or whose newest is withdrawn/retired, is NOT reversionable (null reason). */
export interface ReversionState {
	reversionable: boolean;
	/** The failed version being recovered from (id + version), or null. */
	failedVersion: { id: string; version: number } | null;
	/** Honest reason when not reversionable; null when reversionable. */
	reason: string | null;
}

function reversionStateFor(versions: RoleVersionRow[]): ReversionState {
	if (pickLaunchVersion(versions)) {
		return { reversionable: false, failedVersion: null, reason: 'has a drivable version' };
	}
	const newest = newestVersion(versions);
	if (newest && newest.lifecycle === 'failed') {
		return {
			reversionable: true,
			failedVersion: { id: newest.id, version: newest.version },
			reason: null
		};
	}
	return {
		reversionable: false,
		failedVersion: null,
		reason: newest ? `newest version is '${newest.lifecycle}'` : 'no version'
	};
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
		// Newest ceremony-selectable version (never a failed/withdrawn/retired terminal) —
		// the same picker the execution card + triggers use, so readiness can never count a
		// terminally-failed version as the launch candidate (cert-integrity §2.2).
		const launch = pickLaunchVersion(versions);
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

// ── Authoring state (read-only) — the DRIVER UI's steps ①+② substrate ────────────────
//
// The day-0 ceremony DRIVER (W-D7c CER1) authoring half renders, per launch role: its
// prompt-core review (step ①) and every candidate-facing fixture's key-authoring state
// (step ②). This is a READ-ONLY aggregator over the existing mechanism — promptCoreDiffStep
// for ①, the role's proposed/active fixtures + readGauntletKeyForScoring for ② — so the UI
// never re-implements gate logic (G4). Honest empties throughout (F-008): a role with no
// version surfaces null; a fixture with no key surfaces keyed:false.

export interface FixtureAuthoringState {
	fixture: string;
	slug: string;
	kind: GauntletFixtureRow['kind'];
	status: GauntletFixtureRow['status'];
	provenance: string | null;
	/** The fixture's GENUINE work (the diff's left side the operator keys against). NO key
	 *  material — the work never carries plants (§2.1). */
	work: Record<string, unknown>;
	content_sha: string;
	/** True once the operator has confirmed a key for this fixture (idempotent surface). */
	keyed: boolean;
	/** The confirmed key's diff, when present — work + key + tolerance + justification (§8). */
	keyDiff: LaunchKeyDiff | null;
	/** This fixture kind REQUIRES ≥1 plant to have teeth (DEFECT 4) — drives the UI guard. */
	requiresPlants: boolean;
	/** hallucination_bait fixtures want a mode:'noncompliance'+compliance_pattern plant (A8) —
	 *  the UI surfaces this affordance so the operator authors a scoreable bait key. */
	isBait: boolean;
}

export interface RoleAuthoringState {
	role: string;
	roleSlug: string;
	name: string;
	purpose: string;
	/** The launch role_version's prompt-core review (step ①), or null when none. */
	promptCore: PromptCoreDiffStep | null;
	/** Every candidate-facing fixture (scorer_control excluded — it is the scorer's own
	 *  substrate, not an operator-keyed admission fixture) with its key-authoring state. */
	fixtures: FixtureAuthoringState[];
}

export interface CeremonyAuthoringState {
	/** True once seedLaunchPool has run (≥1 launch role exists). The empty surface (no
	 *  roles) is the DRIVER's day-0 entry point — the operator seeds from there. */
	seeded: boolean;
	roles: RoleAuthoringState[];
	/** Count of fixtures still awaiting an operator key (across all roles) — the step-②
	 *  progress figure. 0 with seeded:true = every launch key authored. */
	keysOutstanding: number;
}

/**
 * Read the authoring half of the day-0 ceremony (steps ①+②) for the DRIVER UI. READ-ONLY:
 * no writes, no gauntlet_key WRITE — only readGauntletKeyForScoring (the sanctioned read
 * path) to surface whether each fixture is already keyed. Reuses promptCoreDiffStep for ①.
 * Honest day-0 empties (F-008): before seeding, `seeded:false` + no roles.
 */
export async function ceremonyAuthoringState(db: Db): Promise<CeremonyAuthoringState> {
	const roles = await listRoles(db);
	// Only the launch roles (the day-0 pool). A role with no version is still surfaced so
	// the operator sees an honest 'no draft version' rather than a silently dropped role.
	const out: RoleAuthoringState[] = [];
	let keysOutstanding = 0;
	for (const role of roles) {
		const versions = await listRoleVersions(db, role.id);
		const launch = pickLaunchVersion(versions);
		const promptCore = launch ? await promptCoreDiffStep(db, launch.id) : null;
		const fixtures = await listCandidateFixtures(db, role.id);
		const fixtureStates: FixtureAuthoringState[] = [];
		for (const f of fixtures) {
			const key = await readGauntletKeyForScoring(db, f.id);
			const keyed = key !== null;
			if (!keyed) keysOutstanding += 1;
			fixtureStates.push({
				fixture: f.id,
				slug: f.slug,
				kind: f.kind,
				status: f.status,
				provenance: f.provenance ?? null,
				work: f.work,
				content_sha: f.content_sha,
				keyed,
				keyDiff: key
					? diffFor(f, key.plants, key.fp_tolerance, key.fp_justification ?? null)
					: null,
				requiresPlants: PLANTED_KINDS.has(f.kind),
				isBait: f.kind === 'hallucination_bait'
			});
		}
		out.push({
			role: role.id,
			roleSlug: role.slug,
			name: role.name,
			purpose: role.purpose,
			promptCore,
			fixtures: fixtureStates
		});
	}
	return { seeded: roles.length > 0, roles: out, keysOutstanding };
}

/**
 * The ceremony TARGET version = the role's NEWEST still-drivable version (highest `version`
 * among the ceremony-selectable lifecycles: draft/interviewing/error/passed — never
 * failed/withdrawn/retired). This is the version every ceremony control (reference-run,
 * interview, flip) operates on. The newest-selectable rule is what makes recovery work: a
 * role whose v1 is terminally FAILED has no selectable version until reversion creates a
 * fresh v2 (draft); the moment it exists, v2 (higher version) becomes the target and the
 * dead v1 is NEVER re-driven (cert-integrity: a failed version can never be flipped to
 * certified — §2.2). Returns null honestly when the role has NO selectable version (its
 * only versions are failed/withdrawn/retired) — that null is the reversion affordance's
 * trigger, surfaced via reversionStateFor.
 */
function pickLaunchVersion(versions: RoleVersionRow[]): RoleVersionRow | null {
	const selectable = versions.filter((v) => isCeremonySelectable(v.lifecycle));
	if (selectable.length === 0) return null;
	return [...selectable].sort((a, b) => b.version - a.version)[0];
}

/** The role's NEWEST version overall (any lifecycle), or null when it has none. Used to
 *  detect the reversion trigger: a failed/terminal newest with no selectable version. */
function newestVersion(versions: RoleVersionRow[]): RoleVersionRow | null {
	if (versions.length === 0) return null;
	return [...versions].sort((a, b) => b.version - a.version)[0];
}

/** The role's candidate-facing fixtures the operator keys at step ② — scorer_control is
 *  EXCLUDED (its key is the scorer's own control substrate, authored separately, §3.4).
 *  Stable slug order for reviewability. */
async function listCandidateFixtures(db: Db, roleId: string): Promise<GauntletFixtureRow[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM gauntlet_fixture
		  WHERE role = $role AND kind != 'scorer_control'
		  ORDER BY slug ASC LIMIT 200;`,
		{ role: link(roleId) }
	);
	return rows.map(normFixture);
}

// ── Execution state (read-only) — the DRIVER UI's steps ③+④+⑤ substrate ───────────────
//
// The day-0 ceremony DRIVER (W-D7c CER2) execution half renders, per launch role: whether
// the role is RUNNABLE (every candidate fixture active + keyed — the §3.8 precondition the
// gauntlet sampler enforces), the admission reference-run proofs recorded on its keys
// (§3.8, provisional-aware), the latest TERMINAL interview line (found N/T · k FP · status),
// and its §2.4 deployability. Plus the §8 step ⑤ readiness echo (all five certified) for
// the panel-flip gate. READ-ONLY aggregator over the existing engine (no writes, no fork,
// G4); honest empties throughout (F-008): no runs → 'not yet interviewed', no proofs → [].

/** One admission reference-run proof recorded on a fixture's key (§3.8), surfaced for the
 *  operator. The `provisional` caveat ('plants proven findable by the draft itself') rides
 *  along so the recall floor's justification is rendered as strong as its prover. */
export interface ReferenceProof {
	/** The fixture slug this proof was recorded against. */
	fixtureSlug: string;
	tier: string;
	model_id: string;
	interview_run: string;
	at: string | null;
	/** §3.8 — true when the draft itself proved (brand-new role, no certified incumbent). */
	provisional: boolean;
}

/** The latest TERMINAL interview_run distilled to the execution-line fields (mirrors the
 *  §8 interview line on the role card — model_id rendered straight from the row, never
 *  hardcoded). null = 'not yet interviewed' (honest day-0 empty). */
export interface CeremonyInterviewLine {
	run: string;
	/** Full interview_run status set (schema: running|adjudicating|passed|failed|error) so a
	 *  newer non-terminal run is shown honestly, not masked by a stale terminal error. */
	status: 'running' | 'adjudicating' | 'passed' | 'failed' | 'error';
	/** 'env_timeout' | 'spawn_failure' | 'scorer_error' when status='error'; else null. */
	errorReason: string | null;
	tier: string;
	model_id: string;
	provider: string;
	plantedFound: number;
	plantedTotal: number;
	falsePositives: number;
	/** §3.7 honest flag — the certifying run predates a fixture-pool change. */
	stale: boolean;
	/** The candidate session (kind='interview') for the transcript link; null if none. */
	session: string | null;
	at: string | null;
}

export interface RoleExecutionState {
	role: string;
	roleSlug: string;
	name: string;
	/** The launch role_version row id, or null when the role has no non-withdrawn version. */
	roleVersion: string | null;
	version: number | null;
	lifecycle: RoleVersionRow['lifecycle'] | null;
	/** The role's default tier (the §3.8 admission runs execute at this) — drives the UI's
	 *  effort/cost label and the tier→model resolve the route does. null when no version. */
	defaultTier: Tier | null;
	/** Candidate fixtures still PROPOSED (not yet activated) — the §3.8 sampler refuses to
	 *  interview until they are active. The UI surfaces 'activate N fixture(s)' before ③/④. */
	fixturesProposed: number;
	/** The id of the FIRST still-proposed candidate fixture (slug order) — the activation
	 *  control acts on it; the operator re-clicks to activate each in turn. null when none. */
	firstProposedFixture: string | null;
	/** Candidate fixtures ACTIVE (sentinel-injected, keyed) — the runnable substrate. */
	fixturesActive: number;
	/** Candidate fixtures still missing an operator key (§8 ② not done) — interviewing is
	 *  blocked until every candidate fixture is keyed (the sampler's plant floor). */
	fixturesUnkeyed: number;
	/** RUNNABLE iff ≥1 active candidate fixture AND zero unkeyed/proposed candidate fixtures
	 *  — the honest precondition for steps ③/④ (the sampler refuses otherwise). */
	runnable: boolean;
	/** Honest reason when not runnable (named: 'no version' | 'N fixture(s) not activated' |
	 *  'N key(s) outstanding'); null when runnable. */
	notRunnableReason: string | null;
	/** Admission reference-run proofs recorded on this role's keys (§3.8); [] = none yet. */
	referenceProofs: ReferenceProof[];
	/** The latest interview line (any status); null = 'not yet interviewed'. */
	interview: CeremonyInterviewLine | null;
	/** Total interview_run rows for the launch version (any status) — sample-size context. */
	interviewRuns: number;
	/** §2.4 existential deployability over REAL runs (a passing run at this prompt_sha). */
	certified: boolean;
	/** Named honest reason when not certified; null when certified. */
	notCertifiedReason: string | null;
	/** RECOVERY (§8): true when the role has NO drivable version AND its newest version is
	 *  terminally 'failed' — the operator should be offered a 're-version & retry' (a NEW
	 *  version cloning the failed content; the failed row is never mutated, §2.2). */
	reversionable: boolean;
	/** The failed version being recovered from (id + version) when reversionable; else null. */
	reversionFrom: { id: string; version: number } | null;
}

export interface CeremonyExecutionState {
	/** True once seedLaunchPool has run (≥1 launch role exists) — the day-0 entry gate. */
	seeded: boolean;
	roles: RoleExecutionState[];
	/** §8 step ⑤ precondition: every launch role is certified (all five passed). The panel
	 *  composition flip is operator-confirmed (D-010), NEVER automatic — this only REPORTS. */
	allCertified: boolean;
	/** Convenience for the step-③/④ progress figure: roles with a certified version. */
	certifiedCount: number;
}

/**
 * Read the execution half of the day-0 ceremony (steps ③+④+⑤) for the DRIVER UI. READ-ONLY:
 * no writes, no gauntlet_key WRITE — only readGauntletKeyForScoring (the sanctioned read
 * path, §4.4) to surface each fixture's key + reference-run proofs, and a bounded
 * interview_run SELECT for the line. Honest day-0 empties (F-008): before seeding,
 * `seeded:false` + no roles; a role with no runs surfaces interview:null ('not yet
 * interviewed'); a key with no proofs surfaces [].
 */
export async function ceremonyExecutionState(db: Db): Promise<CeremonyExecutionState> {
	const roles = await listRoles(db);
	const out: RoleExecutionState[] = [];
	for (const role of roles) {
		const versions = await listRoleVersions(db, role.id);
		const launch = pickLaunchVersion(versions);
		const reversion = reversionStateFor(versions);
		const fixtures = await listCandidateFixtures(db, role.id);

		let fixturesProposed = 0;
		let fixturesActive = 0;
		let fixturesUnkeyed = 0;
		let firstProposedFixture: string | null = null;
		const referenceProofs: ReferenceProof[] = [];
		for (const f of fixtures) {
			if (f.status === 'active') fixturesActive += 1;
			else if (f.status === 'proposed') {
				fixturesProposed += 1;
				if (firstProposedFixture === null) firstProposedFixture = f.id; // slug order (listCandidateFixtures)
			}
			const key = await readGauntletKeyForScoring(db, f.id);
			if (!key) {
				fixturesUnkeyed += 1;
			} else {
				for (const proof of key.reference_runs) referenceProofs.push(refProof(f.slug, proof));
			}
		}

		const runnable =
			launch !== null && fixturesActive > 0 && fixturesUnkeyed === 0 && fixturesProposed === 0;
		const notRunnableReason = runnable
			? null
			: !launch
				? reversion.reversionable
					? `latest version (v${reversion.failedVersion?.version}) failed — re-version to retry (§2.2: a new version, not a reset)`
					: 'no version'
				: fixturesUnkeyed > 0
					? `${fixturesUnkeyed} key(s) outstanding — author every fixture key first (§8 ②)`
					: fixturesProposed > 0
						? `${fixturesProposed} fixture(s) not activated — activate the pool before interviewing (§3.8)`
						: 'no active candidate fixtures';

		let interview: CeremonyInterviewLine | null = null;
		let interviewRuns = 0;
		let certified = false;
		let notCertifiedReason: string | null = launch
			? 'not yet interviewed'
			: reversion.reversionable
				? `latest version (v${reversion.failedVersion?.version}) failed — re-version to retry`
				: 'no version';
		if (launch) {
			const runs = await launchRuns(db, launch.id);
			interviewRuns = runs.length;
			interview = latestRunLine(runs);
			const verdict = certifiedFromRuns(launch, runs);
			certified = verdict.certified;
			notCertifiedReason = verdict.reason;
		}

		out.push({
			role: role.id,
			roleSlug: role.slug,
			name: role.name,
			roleVersion: launch?.id ?? null,
			version: launch?.version ?? null,
			lifecycle: launch?.lifecycle ?? null,
			defaultTier: launch?.default_tier ?? null,
			fixturesProposed,
			firstProposedFixture,
			fixturesActive,
			fixturesUnkeyed,
			runnable,
			notRunnableReason,
			referenceProofs,
			interview,
			interviewRuns,
			certified,
			notCertifiedReason,
			reversionable: reversion.reversionable,
			reversionFrom: reversion.failedVersion
		});
	}
	const certifiedCount = out.filter((r) => r.certified).length;
	return {
		seeded: roles.length > 0,
		roles: out,
		allCertified: out.length > 0 && out.every((r) => r.certified),
		certifiedCount
	};
}

/** Distill one stored reference_runs entry into the operator-facing proof shape. Every
 *  field defends against a malformed stored entry (shadow path: nil/partial proof). */
function refProof(fixtureSlug: string, raw: Record<string, unknown>): ReferenceProof {
	const at = raw.at;
	return {
		fixtureSlug,
		tier: typeof raw.tier === 'string' ? raw.tier : '—',
		model_id: typeof raw.model_id === 'string' ? raw.model_id : '—',
		interview_run: raw.interview_run != null ? str(raw.interview_run) : '—',
		at: typeof at === 'string' && at.trim() ? at : null,
		provisional: raw.provisional === true
	};
}

/** Bounded read of the launch version's interview_run rows (newest-first) — the execution
 *  line + deployability source. Mirrors panel.ts (no fork of the row shape; only the fields
 *  the line needs). */
async function launchRuns(db: Db, versionId: string): Promise<RawCeremonyRun[]> {
	const [rows] = await db.query<[RawCeremonyRun[]]>(
		`SELECT id, status, error_reason, tier, model_id, provider, prompt_sha,
		        planted_found, planted_total, false_positives, stale, session, started_at
		   FROM interview_run WHERE role_version = $vid
		  ORDER BY started_at DESC LIMIT 500;`,
		{ vid: link(versionId) }
	);
	return rows ?? [];
}

interface RawCeremonyRun {
	id: unknown;
	status: string;
	error_reason?: string | null;
	tier: string;
	model_id: string;
	provider: string;
	prompt_sha: string;
	planted_found: number;
	planted_total: number;
	false_positives: number;
	stale: boolean;
	session?: unknown;
	started_at: unknown;
}

function isoOrNull(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

/**
 * Latest run → the execution interview line, regardless of status. `runs` is newest-first
 * (launchRuns ORDERs BY started_at DESC), so it is runs[0]; the status maps straight through
 * so a newer adjudicating/running run is shown honestly instead of being masked by an older
 * terminal error. Display only — certification stays gated on a passing run
 * (certifiedFromRuns, unchanged). null = zero runs ('not yet interviewed').
 */
function latestRunLine(runs: RawCeremonyRun[]): CeremonyInterviewLine | null {
	const r = runs[0];
	if (!r) return null;
	return {
		run: str(r.id),
		status: r.status as CeremonyInterviewLine['status'],
		errorReason: r.error_reason ?? null,
		tier: r.tier,
		model_id: r.model_id,
		provider: r.provider,
		plantedFound: r.planted_found,
		plantedTotal: r.planted_total,
		falsePositives: r.false_positives,
		stale: r.stale,
		session: r.session != null ? str(r.session) : null,
		at: isoOrNull(r.started_at)
	};
}

/** §2.4 existential deployability over REAL rows (a passing run at the version's current
 *  prompt_sha). The honest day-0 surface: no passing run → not certified, named reason. */
function certifiedFromRuns(
	version: RoleVersionRow,
	runs: RawCeremonyRun[]
): { certified: boolean; reason: string | null } {
	if (version.lifecycle === 'failed' || version.lifecycle === 'withdrawn') {
		return { certified: false, reason: `lifecycle '${version.lifecycle}' — a fix is a new version (§2.2)` };
	}
	const passing = runs.filter((r) => r.status === 'passed' && r.prompt_sha === version.prompt_sha);
	if (passing.length === 0) {
		if (runs.some((r) => r.status === 'passed')) {
			return {
				certified: false,
				reason: 'prompt core changed since the last passing interview — re-interview required (§2.4)'
			};
		}
		return { certified: false, reason: 'not yet interviewed' };
	}
	return { certified: true, reason: null };
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
