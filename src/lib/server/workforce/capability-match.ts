// CAPABILITY-MATCH-SPEC (BL-3) — project capability-needs + PM role-matching (wave v2.3).
//
// Makes "does an existing role fill this project's needs, or must we hire?" DATA-DRIVEN, not
// vibes. Three pieces (CAPABILITY-MATCH-SPEC §3-7):
//
//   1. THE VOCABULARY (listDefectClassVocabulary) — the curated defect-class enum. It is NOT a
//      separate registry: it is the distinct `plant.class` set across OPERATOR-CONFIRMED
//      gauntlet_key rows (author='operator'). A new class only EXISTS once a key using it is
//      confirmed (mirrors §3.8 gauntlet-key authorship; LOCKED 2026-06-16). No free-form drift.
//   2. THE NEEDS (get/setCapabilityNeeds) — {languages, frameworks, defect_classes} on project
//      (m0048). Setting defect_classes VALIDATES each against the vocabulary — an unknown class
//      is REJECTED (CapabilityNeedsError), never silently stored to "match" later (enum-closed).
//      Operator free text is SCREENED at this boundary (D-026).
//   3. roleProvenCoverage — the union of plant.class over a role's fixtures that have a PASSING
//      interview_run at the role's CURRENT (active) version (§3.8 PROVEN, not claimed: a class
//      the role has not actually PASSED on is NOT covered — the §2 invariant).
//   4. THE MATCHER (recommendStaffing) — per catalog role, coverage ∩ needs.defect_classes →
//      REUSE (covers all) / EXTEND (covers some, same methodology) / HIRE (gap). Cost-ranked by
//      tier. Evidence-cited (which classes covered/missing). PROPOSE-ONLY: it RETURNS
//      recommendations; it NEVER staffs, hires, certifies, or opens a proposal (§2.2/§4.4 —
//      that is the operator's D-039 act). resolveStaff/the catalog are untouched.
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated tokens are
// record ids validated at the db/validate.ts chokepoint. F-013: datetimes are ISO-coerced /
// absent → null in normalizers (capability_needs carries none, but the project rows we read do).
// F-008: honest empty (no needs → empty arrays; no coverage → empty set), never a fabricated
// match. Optional fields OMITTED, never NULLed (option<T> rejects NULL — MEMORY-SPEC §6.1).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';
import { getRole, listRoles, type RoleRow, type Tier } from './repo';

// ── Named errors (every error has a name; the message names what triggered it) ───────

/** Bad caller input at the capability-needs boundary — most importantly an UNKNOWN
 *  defect_class (one NOT in the operator-confirmed vocabulary). Fail loud, fail closed:
 *  an unknown class is REJECTED here, never stored to silently match later (enum-closed,
 *  §3 D4). The route maps it to a 400. */
export class CapabilityNeedsError extends Error {
	override readonly name = 'CapabilityNeedsError';
	/** The classes that were rejected (not in the vocabulary), for the surface's honesty. */
	readonly unknownClasses: string[];
	constructor(message: string, unknownClasses: string[] = []) {
		super(message);
		this.unknownClasses = unknownClasses;
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** The tier cost ladder, cheapest → dearest (the §5 ranking axis). -1 ⇒ unknown tier
 *  (sorted last — never treated as cheaper than a known tier). */
const TIER_RANK: Record<Tier, number> = { local: 0, haiku: 1, sonnet: 2, opus: 3 };
function tierRank(tier: Tier | null): number {
	return tier != null && tier in TIER_RANK ? TIER_RANK[tier] : Number.MAX_SAFE_INTEGER;
}

/** Distinct, sorted, trimmed-non-empty string set from a raw value array. Pure. */
function distinctStrings(values: unknown[]): string[] {
	const set = new Set<string>();
	for (const v of values) {
		if (typeof v === 'string') {
			const t = v.trim();
			if (t.length > 0) set.add(t);
		}
	}
	return [...set].sort();
}

// ── 1. THE VOCABULARY — the operator-confirmed defect-class enum ──────────────────────

/**
 * §3 D4 — the curated defect-class vocabulary: the distinct `plant.class` set across
 * OPERATOR-CONFIRMED gauntlet_key rows (author='operator'). This IS the enum — there is no
 * separate registry table (§3.8: a class only exists once a key using it is confirmed). A
 * key authored by 'fixing_commit_diff' is NOT yet operator-confirmed and does NOT contribute
 * to the vocabulary (so a class cannot enter via an auto-derived key the operator never saw).
 *
 * Bounded read of the keys (the plants live inside the row); the distinct-class fold runs in
 * JS (the classes are a small set, and SurrealDB array-unnest + DISTINCT over a nested object
 * field is brittle across 2.x). Returns sorted, de-duplicated, non-empty class strings. Empty
 * when no operator key carries a class (honest empty, never a fabricated default class).
 */
export async function listDefectClassVocabulary(db: Db): Promise<string[]> {
	const [rows] = await db.query<[Array<{ plants?: unknown }>]>(
		`SELECT plants FROM gauntlet_key WHERE author = 'operator' LIMIT 5000;`
	);
	const classes: unknown[] = [];
	for (const row of rows ?? []) {
		const plants = Array.isArray(row.plants) ? row.plants : [];
		for (const plant of plants) {
			if (plant && typeof plant === 'object') {
				const cls = (plant as Record<string, unknown>).class;
				if (cls !== undefined) classes.push(cls);
			}
		}
	}
	return distinctStrings(classes);
}

// ── 2. THE NEEDS — capability_needs on project (m0048) ────────────────────────────────

export interface CapabilityNeeds {
	languages: string[];
	frameworks: string[];
	defect_classes: string[];
}

/** The empty-but-honest needs (a project that has declared nothing). F-008: empty arrays,
 *  never a fabricated default. */
function emptyNeeds(): CapabilityNeeds {
	return { languages: [], frameworks: [], defect_classes: [] };
}

/** Normalize the raw capability_needs object off a project row → the three string arrays.
 *  Absent / non-array fields → [] (honest empty, never str(undefined)). Pure. */
function normNeeds(raw: unknown): CapabilityNeeds {
	if (!raw || typeof raw !== 'object') return emptyNeeds();
	const obj = raw as Record<string, unknown>;
	return {
		languages: distinctStrings(Array.isArray(obj.languages) ? obj.languages : []),
		frameworks: distinctStrings(Array.isArray(obj.frameworks) ? obj.frameworks : []),
		defect_classes: distinctStrings(Array.isArray(obj.defect_classes) ? obj.defect_classes : [])
	};
}

/**
 * Read a project's declared capability_needs (§3a). Returns the honest empty needs when the
 * project has none (capability_needs NONE) — never null-throws. Throws CapabilityNeedsError
 * when the project itself does not exist (a caller bug, not an empty state).
 */
export async function getCapabilityNeeds(db: Db, projectId: string): Promise<CapabilityNeeds> {
	const pid = link(projectId);
	const [rows] = await db.query<[Array<{ capability_needs?: unknown }>]>(
		`SELECT capability_needs FROM $pid;`,
		{ pid }
	);
	if (!rows.length) {
		throw new CapabilityNeedsError(`project not found: ${projectId} — cannot read capability_needs`);
	}
	return normNeeds(rows[0].capability_needs);
}

export interface SetCapabilityNeedsInput {
	languages?: string[];
	frameworks?: string[];
	defect_classes?: string[];
}

/**
 * Set a project's capability_needs (§3a), VALIDATING + SCREENING at this boundary:
 *
 *   • defect_classes — every class MUST be a member of the operator-confirmed vocabulary
 *     (listDefectClassVocabulary). An unknown class is REJECTED with a named
 *     CapabilityNeedsError (enum-closed, §3 D4) — it is NEVER stored to silently match later.
 *     The check is done AFTER screening so a redacted/garbled class can't sneak past.
 *   • languages / frameworks — operator-supplied free text; SCREENED (D-026) at this boundary
 *     (a planted secret in a "framework" string is redacted/quarantined before it is stored).
 *
 * Only the supplied keys are written (MERGE), so setting just `defect_classes` leaves
 * languages/frameworks intact. Stores the screened, distinct, sorted arrays. Returns the
 * resulting needs (the full object after the merge). Throws CapabilityNeedsError when the
 * project does not exist OR an unknown defect_class is supplied (fail-closed — no partial
 * write happens on rejection: validation runs BEFORE the DB write).
 */
export async function setCapabilityNeeds(
	db: Db,
	projectId: string,
	input: SetCapabilityNeedsInput
): Promise<CapabilityNeeds> {
	const pid = link(projectId);
	// Existence check first — a needs-set for a missing project is a caller bug, not empty state.
	const [exists] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM $pid;`, { pid });
	if (!exists.length) {
		throw new CapabilityNeedsError(`project not found: ${projectId} — cannot set capability_needs`);
	}

	// D-026: screen operator free text BEFORE validation/storage (a screened class is what we
	// validate against the vocabulary, so a redaction can't change a known class into an unknown
	// one undetected — if screening alters a class string it correctly becomes "not in vocabulary").
	const screenArr = (vals: string[]): string[] =>
		distinctStrings(vals.map((v) => screen(String(v)).text));

	const patch: Record<string, unknown> = {};
	if (input.languages !== undefined) patch.languages = screenArr(input.languages);
	if (input.frameworks !== undefined) patch.frameworks = screenArr(input.frameworks);

	if (input.defect_classes !== undefined) {
		const screened = screenArr(input.defect_classes);
		// ENUM-CLOSED (§3 D4): reject any class not in the operator-confirmed vocabulary. This is
		// the single point that keeps an unknown/free-form class from entering needs and silently
		// matching — the red-team invariant. We compute the vocabulary fresh (it grows as keys are
		// confirmed) and refuse the WHOLE set when any member is unknown (no partial silent drop).
		const vocab = new Set(await listDefectClassVocabulary(db));
		const unknown = screened.filter((c) => !vocab.has(c));
		if (unknown.length > 0) {
			throw new CapabilityNeedsError(
				`capability_needs.defect_classes contains ${unknown.length} class(es) not in the ` +
					`operator-confirmed vocabulary: ${unknown.map((c) => JSON.stringify(c)).join(', ')} ` +
					`— a new defect class enters ONLY via a confirmed gauntlet key (§3.8); REJECTED, not stored`,
				unknown
			);
		}
		patch.defect_classes = screened;
	}

	// MERGE only the supplied keys onto capability_needs (untouched sub-keys survive). The nested
	// object is built by merging into the existing capability_needs (read-modify-write in one
	// MERGE — SurrealDB MERGE of a nested object replaces the whole sub-object, so we merge the
	// PRIOR needs with the patch ourselves to preserve untouched keys).
	const prior = await getCapabilityNeeds(db, projectId);
	const merged: CapabilityNeeds = {
		languages: (patch.languages as string[]) ?? prior.languages,
		frameworks: (patch.frameworks as string[]) ?? prior.frameworks,
		defect_classes: (patch.defect_classes as string[]) ?? prior.defect_classes
	};
	await db.query(`UPDATE $pid MERGE { capability_needs: $needs, updated_at: time::now() };`, {
		pid,
		needs: merged
	});
	return merged;
}

// ── 3. roleProvenCoverage — PROVEN defect-class coverage of a role ────────────────────

/**
 * §3.8 — a role's PROVEN coverage: the union of `plant.class` over the role's gauntlet
 * fixtures that have a PASSING interview_run at the role's CURRENT (active) version. "Proven,
 * not claimed" (§2 invariant): a class only counts when the role's active version actually
 * PASSED a gauntlet whose key plants that class — a failed / uninterviewed / never-keyed
 * fixture's class is NOT covered. A role with no active version (NONE incumbent) covers
 * NOTHING (honest empty — it is not deployable, so it has proven nothing).
 *
 * Resolution (all bounded reads, fold in JS):
 *   1. role.active_version — the §2.3 incumbency pointer. NONE ⇒ empty coverage.
 *   2. the PASSING interview_run rows at that version ⇒ the fixture_set_sha(s) that passed.
 *      §3.8: coverage is over fixtures PROVEN by a passing run. A passing run certifies the
 *      role's fixtures AS A SET (the gauntlet is run over the active fixture pool); so a class
 *      is proven when (a) the role's ACTIVE version has ≥1 passing run AND (b) a confirmed key
 *      for one of the role's ACTIVE fixtures plants that class. No passing run ⇒ nothing proven.
 *   3. the role's ACTIVE fixtures + their gauntlet_key plants ⇒ the plant.class union.
 *
 * Returns sorted, distinct class strings. Empty (honest) for: no active version, no passing
 * run, no active fixtures, or no keyed class.
 */
export async function roleProvenCoverage(db: Db, roleId: string): Promise<string[]> {
	const role = await getRole(db, roleId);
	if (!role || !role.active_version) return []; // not deployable ⇒ proves nothing (§2.3).

	// A PASSING interview_run must exist at the active version — otherwise nothing is PROVEN
	// (§3.8: claimed ≠ proven). One bounded existence read.
	const vid = link(role.active_version);
	const [passRows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM interview_run WHERE role_version = $vid AND status = 'passed' LIMIT 1;`,
		{ vid }
	);
	if (!passRows.length) return []; // active version never passed a gauntlet ⇒ no proven coverage.

	// The role's ACTIVE fixtures (the pool the passing gauntlet was run over) + their confirmed
	// keys' plant classes. We read the active fixtures, then their operator-confirmed keys.
	const rid = link(role.id);
	const [fixtureRows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM gauntlet_fixture WHERE role = $rid AND status = 'active' LIMIT 5000;`,
		{ rid }
	);
	const fixtureIds = (fixtureRows ?? [])
		.map((f) => (f.id != null ? String(f.id) : null))
		.filter((id): id is string => id !== null);
	if (fixtureIds.length === 0) return [];

	const [keyRows] = await db.query<[Array<{ plants?: unknown }>]>(
		`SELECT plants FROM gauntlet_key WHERE fixture IN $fids AND author = 'operator' LIMIT 5000;`,
		{ fids: fixtureIds.map((id) => link(id)) }
	);
	const classes: unknown[] = [];
	for (const row of keyRows ?? []) {
		const plants = Array.isArray(row.plants) ? row.plants : [];
		for (const plant of plants) {
			if (plant && typeof plant === 'object') {
				const cls = (plant as Record<string, unknown>).class;
				if (cls !== undefined) classes.push(cls);
			}
		}
	}
	return distinctStrings(classes);
}

// ── 4. THE MATCHER — recommendStaffing (PROPOSE-ONLY) ─────────────────────────────────

/** The recommendation kind for one catalog role against a project's needs (§3b/§5). */
export type StaffingMatch = 'reuse' | 'extend' | 'hire';

/** One catalog role's evidence-cited recommendation against the project's defect-class needs. */
export interface RoleRecommendation {
	role: string;
	roleSlug: string;
	roleName: string;
	/** The role's PROVEN coverage (§3.8) — sorted distinct classes; [] when nothing proven. */
	coverage: string[];
	/** Needed classes this role PROVES (coverage ∩ needs). */
	covered: string[];
	/** Needed classes this role does NOT prove (needs − coverage). */
	missing: string[];
	/** REUSE: covers all needed classes · EXTEND: covers some (≥1) · HIRE handled at the summary
	 *  level (a class no role covers). Per-role, this is reuse | extend | (none → not listed as a
	 *  candidate for that class). */
	match: StaffingMatch;
	/** The role's current operating tier (preferred_tier ?? active version default) for cost rank;
	 *  null when not resolvable (honest — sorted last). */
	tier: Tier | null;
	/** Human, honest evidence line (which classes it proves / leaves uncovered). */
	evidence: string;
}

/** A genuine GAP: a needed defect_class NO catalog role proves → HIRE (§3b). */
export interface HireGap {
	defectClass: string;
	match: 'hire';
	evidence: string;
}

/** The full match result for a project (§6 surface feed). PROPOSE-ONLY — pure recommendations,
 *  no staffing/hiring/proposal side effects. */
export interface StaffingRecommendation {
	project: string;
	needs: CapabilityNeeds;
	/** The operator-confirmed vocabulary at match time (the set the needs were validated against). */
	vocabulary: string[];
	/** Per-role REUSE/EXTEND candidates, cost-ranked (cheapest tier first); only roles that prove
	 *  ≥1 needed class appear. A role that proves NONE of the needs is not a candidate. */
	candidates: RoleRecommendation[];
	/** Needed classes NO role proves → HIRE recommendations (one per uncovered class). */
	gaps: HireGap[];
	/** True when every needed defect_class is covered by ≥1 candidate (no gap). */
	fullyCovered: boolean;
}

/** Resolve a role's operating tier for cost ranking: preferred_tier, else the active version's
 *  default_tier, else null (honest — unresolved tiers sort last). One bounded read of the
 *  version when needed. */
async function roleOperatingTier(db: Db, role: RoleRow): Promise<Tier | null> {
	if (role.preferred_tier) return role.preferred_tier;
	if (!role.active_version) return null;
	const vid = link(role.active_version);
	const [rows] = await db.query<[Array<{ default_tier: unknown }>]>(
		`SELECT default_tier FROM $vid;`,
		{ vid }
	);
	const t = rows?.[0]?.default_tier;
	return typeof t === 'string' && t in TIER_RANK ? (t as Tier) : null;
}

/**
 * §3b/§5 — THE MATCHER. For a project's declared defect-class needs, score every catalog role's
 * PROVEN coverage against the needs and recommend REUSE / EXTEND / HIRE, cost-ranked, evidence-
 * cited. PROPOSE-ONLY: returns the recommendation object; it NEVER staffs, hires, certifies, or
 * opens a review_proposal — the operator does that (D-039 / §4.4). resolveStaff + the catalog
 * are untouched.
 *
 *   • REUSE — the role's coverage ⊇ ALL needed classes (covers everything the project needs).
 *   • EXTEND — the role proves SOME (≥1) but not all needed classes (same methodology, would
 *     need added fixtures + re-cert to close the gap). Both REUSE + EXTEND roles are candidates.
 *   • HIRE — a needed class NO catalog role proves at all → a per-class gap recommendation.
 *
 * Cost rank (§5): candidates sorted by operating tier ascending (local < haiku < sonnet < opus;
 * unresolved tier last), then by classes-covered descending, then by slug for determinism.
 *
 * SHADOW PATHS: a project with NO declared defect_classes ⇒ empty candidates + empty gaps +
 * fullyCovered:true (nothing needed is trivially fully covered — honest). An empty catalog ⇒
 * every needed class is a HIRE gap. A role with no proven coverage simply isn't a candidate.
 *
 * Throws CapabilityNeedsError when the project does not exist (via getCapabilityNeeds).
 */
export async function recommendStaffing(
	db: Db,
	projectId: string
): Promise<StaffingRecommendation> {
	const needs = await getCapabilityNeeds(db, projectId);
	const vocabulary = await listDefectClassVocabulary(db);
	const needed = needs.defect_classes; // already distinct+sorted from the normalizer.

	// No declared defect-class needs → nothing to match. Honest empty (F-008): no fabricated
	// candidate, no fabricated gap; fullyCovered is vacuously true.
	if (needed.length === 0) {
		return {
			project: assertRecordId(projectId),
			needs,
			vocabulary,
			candidates: [],
			gaps: [],
			fullyCovered: true
		};
	}

	const neededSet = new Set(needed);
	const roles = await listRoles(db);

	const candidates: RoleRecommendation[] = [];
	// Track which needed classes are covered by ANY role (REUSE or EXTEND) — the remainder are HIRE.
	const coveredByAny = new Set<string>();

	for (const role of roles) {
		const coverage = await roleProvenCoverage(db, role.id);
		const covered = coverage.filter((c) => neededSet.has(c)).sort();
		if (covered.length === 0) continue; // proves none of the needs → not a candidate.
		const missing = needed.filter((c) => !coverage.includes(c));
		for (const c of covered) coveredByAny.add(c);
		const match: StaffingMatch = missing.length === 0 ? 'reuse' : 'extend';
		const tier = await roleOperatingTier(db, role);
		const evidence =
			match === 'reuse'
				? `proves all ${covered.length} needed class(es): ${covered.join(', ')}`
				: `proves ${covered.length} of ${needed.length} needed: covers [${covered.join(', ')}], ` +
					`missing [${missing.join(', ')}] — EXTEND with added fixtures + re-cert`;
		candidates.push({
			role: role.id,
			roleSlug: role.slug,
			roleName: role.name,
			coverage,
			covered,
			missing,
			match,
			tier,
			evidence
		});
	}

	// Cost rank (§5): cheapest tier first, then most-needs-covered, then slug for determinism.
	candidates.sort(
		(a, b) =>
			tierRank(a.tier) - tierRank(b.tier) ||
			b.covered.length - a.covered.length ||
			a.roleSlug.localeCompare(b.roleSlug)
	);

	// HIRE gaps: needed classes NO role proves (a genuine gap → propose a new specialized role).
	const gaps: HireGap[] = needed
		.filter((c) => !coveredByAny.has(c))
		.map((c) => ({
			defectClass: c,
			match: 'hire' as const,
			evidence: `no catalog role proves '${c}' — HIRE a specialized role + its operator-gated gauntlet (§3b)`
		}));

	return {
		project: assertRecordId(projectId),
		needs,
		vocabulary,
		candidates,
		gaps,
		fullyCovered: gaps.length === 0
	};
}
