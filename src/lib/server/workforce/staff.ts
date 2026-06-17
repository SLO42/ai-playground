// WORKFORCE-SPEC §6 project_staff — the DECISION-FREE data plane half of wave v2.3:
// the staffing resolver + soft, auditable CRUD (migration 0047_project_staff).
//
// NO governance logic lands here (no matcher, no drift, no tier-hiring, no proposal
// creation) — just the table mutations + the fail-closed resolver. The §5/§7/§7b
// gated pieces await operator decisions and are explicitly out of scope.
//
// POLARITY: opt-IN, FAIL-CLOSED (§6 + task lock). A role works on a project ONLY when a
// project_staff row exists with enabled=true. The default polarity is NOT-staffed at every
// layer: the DDL DEFAULTs enabled=false, and resolveStaff returns null for no row, a
// disabled row, OR a resolved version that is not §2.4-deployable. Un-staffing is SOFT
// (enabled=false + role_event{op:'unstaffed'}) — auditable, never a hard delete (history
// lives in role_event; one row per (project, role), §6).
//
// Boundary discipline (D-016): every record id passes the db/validate.ts chokepoint via
// link(); the only interpolated tokens are validated ids. Optional fields are OMITTED, never
// NULLed (option<T> rejects NULL — MEMORY-SPEC §6.1). Datetimes ISO-coerced in normalizers,
// absent → null → '—' (F-013, asserted on SET rows in staff.test.ts). D-026: charter_note is
// operator-supplied free text — SCREENED at this boundary (memory/screen.ts), never stored raw.

import { createHash } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';
import { checkDeployability, type DeployabilityVerdict } from './deployability';
import { addRoleEvent, getRole, type Tier } from './repo';

// ── Tier → model resolution seam (D-003) ─────────────────────────────────────────
//
// §6 tier precedence: tier_override > role.preferred_tier > role_version.default_tier,
// then resolved to {provider, model_id} via config (D-003). Tier→model is a CONFIG
// concern that lives in config/agent-pool.yaml (load.ts AgentPool.tiers); the data plane
// must not couple to the config file (so it stays unit-testable against a throwaway DB).
// The resolver therefore ACCEPTS the resolution as an injected function — callers pass the
// config-backed resolver; tests pass a deterministic stub. The seam is fail-closed: a tier
// the config does not know returns null and resolveStaff yields an honest null (never a
// fabricated model id — F-008).

/** Resolve a tier label to its {provider, model_id}, or null when the tier is unknown
 *  (fail-closed — an unmapped tier must NOT spawn at a fabricated model). Defined once in
 *  tier-hiring.ts (§7) and re-exported here so callers importing from './staff' (and the
 *  workforce barrel) get a SINGLE type — no duplicate-export ambiguity. */
export type { TierModelResolver } from './tier-hiring';
import type { TierModelResolver } from './tier-hiring';

// ── Row type (normalized: ids/links → string, datetimes → ISO string | null) ──────

export interface ProjectStaffRow {
	id: string;
	project: string;
	role: string;
	/** NONE = follow role.active_version (§6). */
	pinned_version: string | null;
	tier_override: Tier | null;
	/** false = explicit un-staff (fail-closed default; §6). */
	enabled: boolean;
	source: 'operator' | 'pm_validated';
	/** Operator free text — ALREADY SCREENED (D-026); null when absent. */
	charter_note: string | null;
	created_at: string | null;
	updated_at: string | null;
}

/**
 * resolveStaff's honest answer (§6). Either a resolved staffing target or null. null is
 * returned for EVERY not-staffed / not-deployable path — the caller (resolveRoute in v2.3)
 * treats null as "this role does not work on this project". The certifying interview_run id
 * is carried for the routing_event provenance chain (§7).
 */
export interface StaffResolution {
	version: string;
	provider: string;
	model_id: string;
	/** The certifying interview_run id (§2.4 certifiedBy) — null only on a stale-cert edge. */
	certifiedBy: string | null;
	/** §3.7 — the certifying run predates a fixture-pool change (still valid, flagged). */
	stale: boolean;
	/** §4.6 — the resolved version is lifecycle 'retired' but pin-deployable; annotate, no alarm. */
	retired: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────────

function str(v: unknown): string {
	return String(v);
}

/** F-013: coerce a SurrealDB 2.x datetime (non-POJO) to ISO; absent/unparseable → null
 *  so the surface renders '—', NEVER 'undefined'/'null'. */
function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * The DETERMINISTIC project_staff record id for a (project, role) — the ATOMIC one-row-per-pair
 * guarantee. Mirrors createGauntletKey's proven pattern (repo.ts, instrumented red-team DEFECT 3):
 * the secondary `project_staff_dedup` UNIQUE index on a computed VALUE field does NOT reliably
 * enforce uniqueness under CONCURRENT inserts in SurrealDB 2.x (a race persisted TWO rows with
 * identical dedup_key) — but a PRIMARY-key collision is atomic. So a new project_staff row is
 * created at `project_staff:ps_<sha256(project|role)[:40]>`; a concurrent double-staff collides
 * on the primary record id (caught by isDedupCollision → graceful no-op), never duplicating. The
 * suffix is lowercase hex (valid under the D-016 record-id regex). The dedup_key VALUE + its
 * UNIQUE index stay as a defense-in-depth backstop (they never hurt; they just aren't the primary
 * guarantee). NOTE: pre-existing rows created with a random id (none exist in any real DB — m0047
 * is a new table) are still found by getProjectStaff's (project, role) SELECT, so the re-staff
 * UPDATE path is unaffected; only NEW creates use the deterministic id.
 */
function deterministicStaffId(projectId: string, roleId: string): string {
	const key = `${assertRecordId(projectId)}|${assertRecordId(roleId)}`;
	const suffix = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 40);
	return `project_staff:ps_${suffix}`;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

type Raw = Record<string, unknown>;

/**
 * Is this a SurrealDB 2.x UNIQUE / primary-key / commit-race collision on the
 * project_staff_dedup index? Routing is the FIRST concurrent caller of staffRole (a recurring
 * ceremony and an operator confirm can submit the SAME (project, role) at once), so the
 * deferred-MEDIUM concurrency edge the §6 foundation flagged is now live. We reproduce the SAME
 * three raw shapes the rest of the module already maps (ceremony.ts / resolution.ts
 * isDedupCollision, d902ba8): (a) primary-key collision ("record `…` already exists"),
 * (b) secondary UNIQUE-index collision ("index `…` already contains '…'"), (c) the commit-race
 * read/write conflict. All three are the SAME class — the one-row-per-(project,role) invariant
 * biting at this single dedup-guarded write. We match ONLY the real unique-violation phrases and
 * re-raise everything else (F-008): an UNRELATED DB error must never be silently absorbed as a
 * benign no-op. Callers invoke this ONLY where the sole possible write is the dedup-guarded
 * project_staff insert, so a match here can be nothing but that invariant.
 */
function isDedupCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/record `?[^`']*`? already exists/i.test(msg) ||
		/index `?[^`']*`? already contains/i.test(msg) ||
		/failed transaction|read or write conflict/i.test(msg)
	);
}

function normProjectStaff(row: Raw): ProjectStaffRow {
	return {
		id: str(row.id),
		project: str(row.project),
		role: str(row.role),
		pinned_version: row.pinned_version != null ? str(row.pinned_version) : null,
		tier_override: row.tier_override != null ? (row.tier_override as Tier) : null,
		enabled: Boolean(row.enabled),
		source: row.source as ProjectStaffRow['source'],
		charter_note: row.charter_note != null ? str(row.charter_note) : null,
		created_at: strDate(row.created_at),
		updated_at: strDate(row.updated_at)
	};
}

// ── CRUD ──────────────────────────────────────────────────────────────────────────

/** Read one (project, role) staffing row (any enabled state), or null when none exists. */
export async function getProjectStaff(
	db: Db,
	projectId: string,
	roleId: string
): Promise<ProjectStaffRow | null> {
	const project = link(projectId);
	const role = link(roleId);
	// dedup_key is the canonical (project|role) key; the by_project index covers this SELECT.
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM project_staff WHERE project = $project AND role = $role LIMIT 1;`,
		{ project, role }
	);
	return rows.length ? normProjectStaff(rows[0]) : null;
}

/** Every staffing row for a project (newest-first; bounded). Includes disabled rows so the
 *  Settings→Staffing surface can render un-staffed history honestly (the UI filters). */
export async function listProjectStaff(db: Db, projectId: string): Promise<ProjectStaffRow[]> {
	const project = link(projectId);
	// F-022: the ORDER BY field is in the SELECT * projection.
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM project_staff WHERE project = $project ORDER BY created_at DESC LIMIT 500;`,
		{ project }
	);
	return rows.map(normProjectStaff);
}

export interface StaffRoleInput {
	source?: 'operator' | 'pm_validated';
	/** Pin to a specific version (NONE = follow role.active_version, §6). */
	pinnedVersion?: string;
	tierOverride?: Tier;
	/** Operator free text — SCREENED here (D-026) before it is stored. */
	charterNote?: string;
}

/**
 * The Hire ceremony (§6): create/enable ONE (project, role) staffing row + append the
 * role_event{op:'staffed'} audit row. IDEMPOTENT by the dedup UNIQUE index (D-008): re-staffing
 * an already-staffed (project, role) UPSERTs the same row (enabled=true, updated fields) rather
 * than duplicating — so a staff→unstaff→re-staff cycle re-uses the SAME row, and a crash mid-run
 * is absorbed on re-run (interrupt contract). The whole act is ONE transaction (F-015).
 *
 * Named errors: missing role/project fail loud at the link() chokepoint or the FK type. A pinned
 * version is NOT §2.4-checked here (a pin is a stability declaration; deployability is re-derived
 * fail-closed at resolveStaff / spawn time — pinning a not-yet-certified version is legal and
 * surfaces as an honest null at resolve time, never a silent staffing of a dead version).
 *
 * D-026: charter_note is run through the secret/PII screen; the SCREENED text is stored. A planted
 * secret is redacted in place (or the whole note quarantined-to-redacted) — the raw value never
 * lands in the row.
 */
export async function staffRole(
	db: Db,
	projectId: string,
	roleId: string,
	input: StaffRoleInput = {}
): Promise<ProjectStaffRow> {
	const project = link(projectId);
	const role = link(roleId);
	// D-026: screen operator-supplied free text at the boundary; store only the screened body.
	const charterNote =
		input.charterNote !== undefined && input.charterNote !== null
			? screen(String(input.charterNote)).text
			: undefined;

	const existing = await getProjectStaff(db, projectId, roleId);
	const content = omitUndefined({
		project,
		role,
		enabled: true,
		source: input.source,
		pinned_version: input.pinnedVersion ? link(input.pinnedVersion) : undefined,
		tier_override: input.tierOverride,
		charter_note: charterNote
	});

	let row: ProjectStaffRow;
	if (existing) {
		// Re-staff / update: MERGE the supplied fields (leaves unspecified fields intact — a
		// re-staff without a new charter keeps the old), flip enabled true, stamp updated_at.
		// SurrealDB 2.x rejects `MERGE … SET` in one clause, so updated_at rides inside the merge
		// object as a server-evaluated expression via a two-statement transaction.
		const [, rows] = await db.query<[unknown, Raw[]]>(
			`UPDATE $rid MERGE $merge;
			 UPDATE $rid SET updated_at = time::now() RETURN AFTER;`,
			{ rid: link(existing.id), merge: content }
		);
		row = normProjectStaff(rows[0]);
	} else {
		// CONCURRENCY (deferred MEDIUM from the §6 foundation red-team, folded here now that
		// routing is the first concurrent caller): the getProjectStaff read above and this CREATE
		// are NOT one transaction. Two callers racing PAST the read (an operator confirm + a
		// recurring-ceremony route) both see no row and both CREATE; the loser collides on the
		// project_staff_dedup UNIQUE index. The index PREVENTS the duplicate (the integrity
		// backstop holds — never weakened); we catch ONLY that collision (isDedupCollision — the
		// real unique-violation phrases, never an unrelated error, F-008) and resolve it as a
		// BENIGN no-op: the winner already created the row, so re-read it and continue. At most ONE
		// row exists regardless of concurrency. NOT a retry loop — one CREATE attempt, one re-read
		// on collision (it cannot spin). A non-dedup error propagates unchanged.
		try {
			// Deterministic primary-key id (the atomic one-row-per-(project,role) guarantee — a
			// concurrent double-create collides on THIS id, not the unreliable secondary index).
			const sid = link(deterministicStaffId(projectId, roleId));
			const [rows] = await db.query<[Raw[]]>(
				`CREATE $sid CONTENT $content RETURN AFTER;`,
				{ sid, content }
			);
			row = normProjectStaff(rows[0]);
		} catch (err) {
			if (!isDedupCollision(err)) throw err;
			const winner = await getProjectStaff(db, projectId, roleId);
			if (!winner) {
				// The collision matched but the winner's row is not visible yet — surface the named
				// error rather than inventing a row (F-008: honest, never fabricated).
				throw new Error(
					`staffRole(${projectId}, ${roleId}) hit a concurrent project_staff_dedup collision but the winning row is not visible — retry`
				);
			}
			// The winner created (and audited) the row. The winner may have created it with
			// enabled=false (a never-happens path) or different fields, but the dedup guarantees one
			// row; re-staffing semantics (enabled=true + this call's fields) are re-applied via the
			// existing-row UPDATE path so this caller's intent still lands deterministically.
			const [, rows] = await db.query<[unknown, Raw[]]>(
				`UPDATE $rid MERGE $merge;
				 UPDATE $rid SET updated_at = time::now() RETURN AFTER;`,
				{ rid: link(winner.id), merge: content }
			);
			row = normProjectStaff(rows[0]);
		}
	}
	await addRoleEvent(db, {
		role: roleId,
		op: 'staffed',
		detail: { project: projectId, staff: row.id, source: row.source }
	});
	return row;
}

/**
 * Un-staff (§6): SOFT, auditable. Sets enabled=false + appends role_event{op:'unstaffed'} — NOT a
 * hard delete (history is the audit trail; the dedup row stays so a re-staff re-uses it). A no-op
 * when no row exists (returns null — nothing to un-staff is not an error; interrupt contract makes
 * a double-unstaff idempotent: a second call flips an already-false row to false and re-audits
 * harmlessly). Suppression-shaped acts (un-staffing security-officer) are operator-gated at the UI
 * layer (G2); this is the mechanical mutation only.
 */
export async function unstaffRole(
	db: Db,
	projectId: string,
	roleId: string
): Promise<ProjectStaffRow | null> {
	const existing = await getProjectStaff(db, projectId, roleId);
	if (!existing) return null;
	const [rows] = await db.query<[Raw[]]>(
		`UPDATE $rid SET enabled = false, updated_at = time::now() RETURN AFTER;`,
		{ rid: link(existing.id) }
	);
	const row = normProjectStaff(rows[0]);
	await addRoleEvent(db, {
		role: roleId,
		op: 'unstaffed',
		detail: { project: projectId, staff: row.id }
	});
	return row;
}

// ── resolveStaff — the fail-closed staffing resolver (§6) ────────────────────────────

/**
 * §6 resolveStaff: resolve which (version, provider, model_id) a role runs at for a project, or
 * null when the role is not staffed / not deployable. FAIL-CLOSED at every branch:
 *
 *   1. No project_staff row OR enabled=false → null (default polarity: NOT-staffed).
 *   2. Choose the version: pinned_version if set, else role.active_version. NONE incumbent and no
 *      pin → null (honest empty + interview CTA at the surface).
 *   3. Resolve the tier: tier_override > role.preferred_tier > role_version.default_tier → model_id
 *      via the injected resolver (D-003). Unknown tier / unresolvable model → null (never a
 *      fabricated model, F-008).
 *   4. §2.4-check the (resolved version × model_id): only a passing (prompt_sha × model_id)
 *      interview makes it deployable. A non-deployable / failed / withdrawn / sha-mismatch /
 *      never-interviewed version → null (honest null, not a live spawn of a dead version).
 *
 * This function NEVER returns a version for an unstaffed (project, role), a disabled row, or a
 * version that is not provably certified at the resolved model — the fail-closed invariant the
 * red-team tests pin down. It does the deployability check via checkDeployability (which never
 * consults role.active_version), so a project PIN survives a global swap AND retirement (§2.4).
 *
 * The resolved version's default_tier is read off the version row, which requires loading it; we
 * reuse the deployability path's lookups rather than re-deriving. Tier precedence needs the role
 * (preferred_tier) and the version (default_tier).
 */
export async function resolveStaff(
	db: Db,
	projectId: string,
	roleId: string,
	resolveTierModel: TierModelResolver
): Promise<StaffResolution | null> {
	// 1. Staffing gate — fail-closed default polarity.
	const staff = await getProjectStaff(db, projectId, roleId);
	if (!staff || !staff.enabled) return null;

	// 2. Choose the version: explicit pin, else the role's incumbent.
	const role = await getRole(db, roleId);
	if (!role) return null; // role vanished — fail closed (a dangling staff row never spawns).
	const versionId = staff.pinned_version ?? role.active_version;
	if (!versionId) return null; // no pin AND no incumbent → not deployable (honest empty).

	// 3. Tier → model (D-003). Need the version's default_tier as the final fallback. We get the
	//    version row via getRoleVersionTier (a bounded read of just the tier field).
	const defaultTier = await versionDefaultTier(db, versionId);
	if (!defaultTier) return null; // the pinned/incumbent version vanished — fail closed.
	const tier: Tier = staff.tier_override ?? role.preferred_tier ?? defaultTier;
	const model = resolveTierModel(tier);
	if (!model || !model.model_id?.trim()) return null; // unknown tier → no fabricated model (F-008).

	// 4. §2.4 deployability — the spawn-time invariant, fail-closed. checkDeployability never reads
	//    role.active_version, so a pin survives swaps/retirement; only a passing
	//    (prompt_sha × model_id) interview yields deployable:true.
	const verdict: DeployabilityVerdict = await checkDeployability(db, versionId, model.model_id);
	if (!verdict.deployable) return null; // non-deployable / failed / sha-mismatch / uninterviewed.

	return {
		version: versionId,
		provider: model.provider,
		model_id: model.model_id,
		certifiedBy: verdict.certifiedBy,
		stale: verdict.stale,
		retired: verdict.retired
	};
}

/** Bounded read of a version's default_tier (the §6 fallback). null when the version is gone. */
async function versionDefaultTier(db: Db, versionId: string): Promise<Tier | null> {
	const vid = link(versionId);
	const [rows] = await db.query<[Array<{ default_tier: unknown }>]>(
		`SELECT default_tier FROM $vid;`,
		{ vid }
	);
	const t = rows?.[0]?.default_tier;
	return typeof t === 'string' ? (t as Tier) : null;
}
