// TASK 16.3 — W-D7a: workforce data plane (WORKFORCE-SPEC §2) — row types,
// normalizers, and the harness-only mutation functions for role / role_version /
// interview_run / gauntlet_fixture / gauntlet_key / panel_verdict / role_event
// (migration 0031_workforce).
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated;
// the only interpolated tokens are record ids validated at the db/validate.ts
// chokepoint. Optional fields are OMITTED, never NULLed (option<T> rejects NULL —
// MEMORY-SPEC §6.1). Every datetime is ISO-coerced in the row normalizers, absent
// → null → '—' (F-013 — asserted on SET rows in repo.test.ts). Every ORDER BY
// field appears in its SELECT projection (F-022).
//
// §2.2 rulings encoded here (G4 — do not re-decide):
//   • lifecycle records the CERTIFICATION CAMPAIGN only — finalizeInterviewRun
//     mutates a version's lifecycle ONLY while it is 'interviewing'; runs against
//     an already-passed version are EVIDENCE rows and never demote.
//   • panel_verdict.outcome closure is mechanical, harness-only, server-stamped
//     (D-035): closePanelVerdictOutcome is the sole writer — never PM/LLM judgment.
//   • §2.3 incumbency: role.active_version is the single source of truth; a swap is
//     ONE pointer write + ONE append-only role_event in ONE transaction (F-015).

import { createHash } from 'node:crypto';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	assertRunTransition,
	assertTransition,
	INTERVIEWABLE_LIFECYCLES,
	type InterviewRunStatus,
	type RoleVersionLifecycle
} from './lifecycle';

// ── Named errors (every error has a name — what triggers it is in the message) ───

/** Bad caller input at the workforce boundary (invalid slug, empty prompt core,
 * missing error_reason, cross-role version, missing row…). Fail loud, named. */
export class WorkforceInputError extends Error {
	override readonly name = 'WorkforceInputError';
}

// ── Shared enums (mirror the 0031 DDL asserts) ──────────────────────────────────

export type Tier = 'local' | 'haiku' | 'sonnet' | 'opus';
export type RoleVersionSource = 'operator' | 'pm_proposal' | 'import';
export type InterviewErrorReason = 'env_timeout' | 'spawn_failure' | 'scorer_error';
export type GauntletFixtureKind =
	| 'planted_defect'
	| 'planted_absence'
	| 'hallucination_bait'
	| 'clean_control'
	| 'scorer_control';
export type PanelArtifactKind = 'task' | 'review_proposal' | 'fixture_proposal';
export type PanelVerdictValue = 'approve' | 'pushback';
export type PanelOutcome = 'upheld' | 'overridden_by_operator' | 'revised' | 'withdrawn';
export type RoleEventOp =
	| 'created'
	| 'interviewed'
	| 'swap'
	| 'retired'
	| 'archived'
	| 'tier_changed'
	| 'staffed'
	| 'unstaffed'
	| 'fixture_activated'
	| 'stale_marked';

// ── Row types (normalized: ids/links → string, datetimes → ISO string | null) ───

export interface RoleRow {
	id: string;
	/** Hyphenated display slug (`code-reviewer`); the record id uses underscores. */
	slug: string;
	name: string;
	purpose: string;
	provenance?: string;
	/** THE incumbency pointer (§2.3). null = not deployable (honest empty). */
	active_version: string | null;
	preferred_tier?: Tier;
	status: 'active' | 'archived';
	created_at: string | null;
	updated_at: string | null;
}

export interface RoleVersionRow {
	id: string;
	role: string;
	version: number;
	prompt_core: string;
	prompt_sha: string;
	capabilities: Record<string, unknown>;
	default_tier: Tier;
	source: RoleVersionSource;
	proposal?: string;
	lifecycle: RoleVersionLifecycle;
	/** Informational swap stamp — never read for incumbency (§2.3). */
	activated_at: string | null;
	retired_at: string | null;
	created_at: string | null;
}

export interface InterviewRunRow {
	id: string;
	role: string;
	role_version: string;
	/** COPIED from the version at run start (defense in depth, §2.1). */
	prompt_sha: string;
	tier: Tier;
	provider: string;
	model_id: string;
	fixture_set_sha: string;
	bundle_digest: string;
	session?: string;
	status: InterviewRunStatus;
	error_reason?: InterviewErrorReason;
	retry_of?: string;
	planted_total: number;
	planted_found: number;
	false_positives: number;
	ambiguous: Array<Record<string, unknown>>;
	results: Array<Record<string, unknown>>;
	pass_criteria: Record<string, unknown>;
	stale: boolean;
	/** Σ from PRICED agent_event rows only (F-008); null until priced. */
	cost_usd: number | null;
	started_at: string | null;
	ended_at: string | null;
}

export interface GauntletFixtureRow {
	id: string;
	role: string;
	slug: string;
	kind: GauntletFixtureKind;
	work: Record<string, unknown>;
	content_sha: string;
	sentinel: string;
	provenance?: string;
	status: 'proposed' | 'active' | 'retired';
	created_at: string | null;
}

export interface GauntletKeyRow {
	id: string;
	fixture: string;
	content_sha: string;
	plants: Array<Record<string, unknown>>;
	fp_tolerance: number;
	fp_justification?: string;
	author: 'operator' | 'fixing_commit_diff';
	reference_runs: Array<Record<string, unknown>>;
	created_at: string | null;
}

/** PM-SPEC §4.5 decision class, logged ON the verdict (migration 0032 additive). */
export type PanelClassification = 'mechanical' | 'taste' | 'operator_challenge';

export interface PanelVerdictRow {
	id: string;
	/** null for project-less workforce artifacts (global role revisions). */
	project: string | null;
	artifact: string;
	artifact_kind: PanelArtifactKind;
	validator_session: string;
	validator_kind: 'inline' | 'catalog_role';
	role?: string;
	role_version?: string;
	verdict: PanelVerdictValue;
	reasons: string[];
	confidence?: 'low' | 'medium' | 'high';
	/** §4.5 decision class (TASK 16.4) — absent on pre-0032 rows (honest). */
	classification?: PanelClassification;
	/** Closed later, mechanically (§2.2). null = still open. */
	outcome: PanelOutcome | null;
	at: string | null;
}

export interface RoleEventRow {
	id: string;
	role: string;
	role_version?: string;
	op: RoleEventOp;
	detail?: Record<string, unknown>;
	at: string | null;
}

// ── Helpers (mirror projects/pm-repo.ts discipline) ─────────────────────────────

function str(v: unknown): string {
	return String(v);
}

/** F-013 + F-008: coerce a SurrealDB 2.x datetime (non-POJO) to an ISO string;
 * absent/unparseable → null so the surface renders '—', NEVER 'undefined'. */
function strDate(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

// ── Canonical hashing (prompt_sha / content_sha) ────────────────────────────────

/** Deterministic canonical JSON: object keys sorted recursively (same discipline
 * as adapters/driver.ts canonicalJson — kept local so the workforce data plane
 * does not couple to the adapters module graph). Array ORDER is preserved here;
 * id-array sorting for prompt_sha happens in sortIdArrays (spec: "capabilities
 * w/ sorted id arrays" — only the capability id lists are order-insensitive). */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const obj = value as Record<string, unknown>;
	const entries = Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
	return `{${entries.join(',')}}`;
}

/** Recursively sort every all-string array (the D-036 {skills, agents, mcp} id
 * lists) so capability ORDER never changes the certification hash. */
function sortIdArrays(value: unknown): unknown {
	if (Array.isArray(value)) {
		const mapped = value.map(sortIdArrays);
		return mapped.every((x) => typeof x === 'string')
			? [...(mapped as string[])].sort()
			: mapped;
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sortIdArrays(v);
		return out;
	}
	return value;
}

/** §2.1 role_version.prompt_sha: sha256 over canonical JSON
 * `{prompt_core, capabilities w/ sorted id arrays}` — the content address every
 * verdict traces back to. */
export function computePromptSha(
	promptCore: string,
	capabilities: Record<string, unknown> = {}
): string {
	return createHash('sha256')
		.update(
			canonicalJson({ prompt_core: promptCore, capabilities: sortIdArrays(capabilities) }),
			'utf8'
		)
		.digest('hex');
}

/** §2.1 gauntlet_fixture.content_sha: sha256 over the canonical work object —
 * computed mechanically here (never caller-supplied). */
export function computeWorkSha(work: Record<string, unknown>): string {
	return createHash('sha256').update(canonicalJson(work), 'utf8').digest('hex');
}

// ── Role identity ────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Slug-derived record id (§2 conventions): `code-reviewer` → `role:code_reviewer`.
 * The display slug keeps the hyphen; the id passes the D-016 chokepoint. */
export function roleIdForSlug(slug: string): string {
	if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
		throw new WorkforceInputError(
			`invalid role slug: ${JSON.stringify(slug)} (lowercase hyphenated, e.g. 'code-reviewer')`
		);
	}
	return assertRecordId(`role:${slug.replace(/-/g, '_')}`);
}

// ── Normalizers (F-013: datetimes ISO; links → string; absent → null/undefined) ──

type Raw = Record<string, unknown>;

function normRole(row: Raw): RoleRow {
	return {
		id: str(row.id),
		slug: str(row.slug),
		name: str(row.name),
		purpose: str(row.purpose),
		...(row.provenance != null ? { provenance: str(row.provenance) } : {}),
		active_version: row.active_version != null ? str(row.active_version) : null,
		...(row.preferred_tier != null ? { preferred_tier: row.preferred_tier as Tier } : {}),
		status: row.status as RoleRow['status'],
		created_at: strDate(row.created_at),
		updated_at: strDate(row.updated_at)
	};
}

function normRoleVersion(row: Raw): RoleVersionRow {
	return {
		id: str(row.id),
		role: str(row.role),
		version: Number(row.version),
		prompt_core: str(row.prompt_core),
		prompt_sha: str(row.prompt_sha),
		capabilities: (row.capabilities ?? {}) as Record<string, unknown>,
		default_tier: row.default_tier as Tier,
		source: row.source as RoleVersionSource,
		...(row.proposal != null ? { proposal: str(row.proposal) } : {}),
		lifecycle: row.lifecycle as RoleVersionLifecycle,
		activated_at: strDate(row.activated_at),
		retired_at: strDate(row.retired_at),
		created_at: strDate(row.created_at)
	};
}

function normInterviewRun(row: Raw): InterviewRunRow {
	return {
		id: str(row.id),
		role: str(row.role),
		role_version: str(row.role_version),
		prompt_sha: str(row.prompt_sha),
		tier: row.tier as Tier,
		provider: str(row.provider),
		model_id: str(row.model_id),
		fixture_set_sha: str(row.fixture_set_sha),
		bundle_digest: str(row.bundle_digest),
		...(row.session != null ? { session: str(row.session) } : {}),
		status: row.status as InterviewRunStatus,
		...(row.error_reason != null ? { error_reason: row.error_reason as InterviewErrorReason } : {}),
		...(row.retry_of != null ? { retry_of: str(row.retry_of) } : {}),
		planted_total: Number(row.planted_total ?? 0),
		planted_found: Number(row.planted_found ?? 0),
		false_positives: Number(row.false_positives ?? 0),
		ambiguous: (row.ambiguous ?? []) as Array<Record<string, unknown>>,
		results: (row.results ?? []) as Array<Record<string, unknown>>,
		pass_criteria: (row.pass_criteria ?? {}) as Record<string, unknown>,
		stale: Boolean(row.stale),
		cost_usd: typeof row.cost_usd === 'number' ? row.cost_usd : null,
		started_at: strDate(row.started_at),
		ended_at: strDate(row.ended_at)
	};
}

function normGauntletFixture(row: Raw): GauntletFixtureRow {
	return {
		id: str(row.id),
		role: str(row.role),
		slug: str(row.slug),
		kind: row.kind as GauntletFixtureKind,
		work: (row.work ?? {}) as Record<string, unknown>,
		content_sha: str(row.content_sha),
		sentinel: str(row.sentinel),
		...(row.provenance != null ? { provenance: str(row.provenance) } : {}),
		status: row.status as GauntletFixtureRow['status'],
		created_at: strDate(row.created_at)
	};
}

function normGauntletKey(row: Raw): GauntletKeyRow {
	return {
		id: str(row.id),
		fixture: str(row.fixture),
		content_sha: str(row.content_sha),
		plants: (row.plants ?? []) as Array<Record<string, unknown>>,
		fp_tolerance: Number(row.fp_tolerance ?? 0),
		...(row.fp_justification != null ? { fp_justification: str(row.fp_justification) } : {}),
		author: row.author as GauntletKeyRow['author'],
		reference_runs: (row.reference_runs ?? []) as Array<Record<string, unknown>>,
		created_at: strDate(row.created_at)
	};
}

function normPanelVerdict(row: Raw): PanelVerdictRow {
	return {
		id: str(row.id),
		project: row.project != null ? str(row.project) : null,
		artifact: str(row.artifact),
		artifact_kind: row.artifact_kind as PanelArtifactKind,
		validator_session: str(row.validator_session),
		validator_kind: row.validator_kind as PanelVerdictRow['validator_kind'],
		...(row.role != null ? { role: str(row.role) } : {}),
		...(row.role_version != null ? { role_version: str(row.role_version) } : {}),
		verdict: row.verdict as PanelVerdictValue,
		reasons: (row.reasons ?? []) as string[],
		...(row.confidence != null ? { confidence: row.confidence as PanelVerdictRow['confidence'] } : {}),
		...(row.classification != null
			? { classification: row.classification as PanelClassification }
			: {}),
		outcome: row.outcome != null ? (row.outcome as PanelOutcome) : null,
		at: strDate(row.at)
	};
}

function normRoleEvent(row: Raw): RoleEventRow {
	return {
		id: str(row.id),
		role: str(row.role),
		...(row.role_version != null ? { role_version: str(row.role_version) } : {}),
		op: row.op as RoleEventOp,
		...(row.detail != null ? { detail: row.detail as Record<string, unknown> } : {}),
		at: strDate(row.at)
	};
}

// ── role CRUD ────────────────────────────────────────────────────────────────────

export interface CreateRoleInput {
	slug: string;
	name: string;
	purpose: string;
	provenance?: string;
	preferred_tier?: Tier;
}

/** Create a role at its slug-derived id (`role:code_reviewer`) + the 'created'
 * audit event. A duplicate slug collides loudly on the UNIQUE index (D-008) —
 * re-run callers absorb via getRoleBySlug first (interrupt contract). */
export async function createRole(db: Db, input: CreateRoleInput): Promise<RoleRow> {
	const idPart = roleIdForSlug(input.slug).slice('role:'.length);
	const content = omitUndefined({
		slug: input.slug,
		name: input.name,
		purpose: input.purpose,
		provenance: input.provenance,
		preferred_tier: input.preferred_tier
	});
	const [rows] = await db.query<[Raw[]]>(
		`CREATE type::thing('role', $idPart) CONTENT $content RETURN AFTER;`,
		{ idPart, content }
	);
	const role = normRole(rows[0]);
	await addRoleEvent(db, { role: role.id, op: 'created' });
	return role;
}

export async function getRole(db: Db, roleId: string): Promise<RoleRow | null> {
	const rid = link(roleId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normRole(rows[0]) : null;
}

export async function getRoleBySlug(db: Db, slug: string): Promise<RoleRow | null> {
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM role WHERE slug = $slug LIMIT 1;`, {
		slug
	});
	return rows.length ? normRole(rows[0]) : null;
}

export async function listRoles(db: Db): Promise<RoleRow[]> {
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM role ORDER BY slug ASC LIMIT 500;`);
	return rows.map(normRole);
}

// ── role_version ─────────────────────────────────────────────────────────────────

export interface CreateRoleVersionInput {
	role: string;
	prompt_core: string;
	capabilities?: Record<string, unknown>;
	default_tier: Tier;
	source?: RoleVersionSource;
	proposal?: string;
}

/**
 * Create the role's NEXT version row (monotonic per role; concurrent creators
 * collide on the role_version_dedup UNIQUE index, D-008). prompt_sha is computed
 * here, mechanically (D-035 — never caller-supplied). Content fields are IMMUTABLE
 * after creation (§2.1) — no update path for them exists in this module.
 */
export async function createRoleVersion(
	db: Db,
	input: CreateRoleVersionInput
): Promise<RoleVersionRow> {
	if (!input.prompt_core?.trim()) {
		throw new WorkforceInputError(
			'role_version.prompt_core must be non-empty — the methodology text IS the product row (§2.1)'
		);
	}
	const role = link(input.role);
	const [maxRows] = await db.query<[Array<{ v: number | null }>]>(
		`SELECT math::max(version) AS v FROM role_version WHERE role = $role GROUP ALL;`,
		{ role }
	);
	const version = (maxRows?.[0]?.v ?? 0) + 1;
	const capabilities = input.capabilities ?? {};
	const content = omitUndefined({
		role,
		version,
		prompt_core: input.prompt_core,
		prompt_sha: computePromptSha(input.prompt_core, capabilities),
		capabilities,
		default_tier: input.default_tier,
		source: input.source,
		proposal: input.proposal ? link(input.proposal) : undefined
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE role_version CONTENT $content RETURN AFTER;`, {
		content
	});
	return normRoleVersion(rows[0]);
}

export async function getRoleVersion(db: Db, versionId: string): Promise<RoleVersionRow | null> {
	const rid = link(versionId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normRoleVersion(rows[0]) : null;
}

export async function listRoleVersions(db: Db, roleId: string): Promise<RoleVersionRow[]> {
	const role = link(roleId);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM role_version WHERE role = $role ORDER BY version DESC LIMIT 500;`,
		{ role }
	);
	return rows.map(normRoleVersion);
}

// ── §2.2 lifecycle as code ───────────────────────────────────────────────────────

/**
 * Move a version through the §2.2 state machine (lifecycle.ts is the single
 * transition table). 'retired' additionally stamps retired_at + appends the
 * role_event{op:'retired'} audit row. Throws LifecycleError on an illegal move,
 * WorkforceInputError when the version does not exist.
 */
export async function transitionLifecycle(
	db: Db,
	versionId: string,
	to: RoleVersionLifecycle
): Promise<RoleVersionRow> {
	const v = await getRoleVersion(db, versionId);
	if (!v) throw new WorkforceInputError(`role_version not found: ${versionId}`);
	assertTransition(v.lifecycle, to);
	const rid = link(v.id);
	const retire = to === 'retired' ? `, retired_at = time::now()` : '';
	const [rows] = await db.query<[Raw[]]>(
		`UPDATE $rid SET lifecycle = $to${retire} RETURN AFTER;`,
		{ rid, to }
	);
	const updated = normRoleVersion(rows[0]);
	if (to === 'retired') {
		await addRoleEvent(db, { role: v.role, role_version: v.id, op: 'retired' });
	}
	return updated;
}

/** Operator act: retire a passed version (terminal; §4.6 drains are session-side). */
export async function retireRoleVersion(db: Db, versionId: string): Promise<RoleVersionRow> {
	return transitionLifecycle(db, versionId, 'retired');
}

/** Withdraw a version (legal from draft, passed, or unretried error — §2.2). */
export async function withdrawRoleVersion(db: Db, versionId: string): Promise<RoleVersionRow> {
	return transitionLifecycle(db, versionId, 'withdrawn');
}

// ── §2.3 incumbency ──────────────────────────────────────────────────────────────

/**
 * Swap the incumbency pointer (§2.3): ONE pointer write + ONE append-only
 * role_event{op:'swap', detail:{from, to, operator_confirmed:true}} + the
 * INFORMATIONAL activated_at stamp — all in ONE transaction (F-015: assume the
 * process can die mid-apply; the transaction makes the swap atomic). Nothing else
 * is load-bearing: deployability always re-derives from interview_run rows (§2.4).
 *
 * Fail-closed preconditions (named errors): the version must exist, belong to the
 * role, and be lifecycle 'passed' (there is no other deployable lifecycle to point
 * at — draft/failed/etc. would make the pointer a lie).
 */
export async function swapActiveVersion(
	db: Db,
	roleId: string,
	toVersionId: string
): Promise<RoleRow> {
	const role = await getRole(db, roleId);
	if (!role) throw new WorkforceInputError(`role not found: ${roleId}`);
	const to = await getRoleVersion(db, toVersionId);
	if (!to) throw new WorkforceInputError(`role_version not found: ${toVersionId}`);
	if (to.role !== role.id) {
		throw new WorkforceInputError(
			`swap target ${to.id} belongs to ${to.role}, not ${role.id} — cross-role swap refused`
		);
	}
	if (to.lifecycle !== 'passed') {
		throw new WorkforceInputError(
			`swap target ${to.id} is lifecycle '${to.lifecycle}' — only a 'passed' version may take incumbency (§2.3)`
		);
	}
	const rid = link(role.id);
	const vid = link(to.id);
	await db.query(
		`BEGIN;
		 UPDATE $rid SET active_version = $vid, updated_at = time::now();
		 CREATE role_event CONTENT {
			role: $rid, role_version: $vid, op: 'swap',
			detail: { from: $from, to: $toStr, operator_confirmed: true }
		 };
		 UPDATE $vid SET activated_at = time::now();
		 COMMIT;`,
		{ rid, vid, from: role.active_version, toStr: to.id }
	);
	const after = await getRole(db, role.id);
	if (!after) throw new WorkforceInputError(`role vanished mid-swap: ${role.id}`);
	return after;
}

// ── interview_run (the data-plane half; the runner engine is W-D7b) ──────────────

export interface CreateInterviewRunInput {
	role_version: string;
	tier: Tier;
	provider: string;
	model_id: string;
	fixture_set_sha: string;
	/** §2.6 — settings-scope digest where available, literal 'unhashed' else. */
	bundle_digest?: string;
	session?: string;
	retry_of?: string;
	planted_total?: number;
	/** SNAPSHOT of config/workforce.yaml gauntlet.* in effect (§2.1). */
	pass_criteria?: Record<string, unknown>;
}

/**
 * Open an interview run against a version. prompt_sha is COPIED from the version
 * row at run start (defense in depth, §2.1). Campaign coupling (§2.2): a 'draft'
 * version enters 'interviewing'; an 'error' version re-enters 'interviewing'
 * (retry, §3.6); a 'passed'/'retired' version is untouched (EVIDENCE run);
 * 'failed'/'withdrawn' versions are refused — a fix is a NEW version.
 */
export async function createInterviewRun(
	db: Db,
	input: CreateInterviewRunInput
): Promise<InterviewRunRow> {
	const version = await getRoleVersion(db, input.role_version);
	if (!version) throw new WorkforceInputError(`role_version not found: ${input.role_version}`);
	if (!INTERVIEWABLE_LIFECYCLES.includes(version.lifecycle)) {
		throw new WorkforceInputError(
			`role_version ${version.id} is lifecycle '${version.lifecycle}' — not interviewable ` +
				`(a fix is a NEW version, §2.2)`
		);
	}
	if (version.lifecycle === 'draft' || version.lifecycle === 'error') {
		await transitionLifecycle(db, version.id, 'interviewing');
	}
	const content = omitUndefined({
		role: link(version.role),
		role_version: link(version.id),
		prompt_sha: version.prompt_sha,
		tier: input.tier,
		provider: input.provider,
		model_id: input.model_id,
		fixture_set_sha: input.fixture_set_sha,
		bundle_digest: input.bundle_digest,
		session: input.session ? link(input.session) : undefined,
		retry_of: input.retry_of ? link(input.retry_of) : undefined,
		planted_total: input.planted_total,
		pass_criteria: input.pass_criteria
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE interview_run CONTENT $content RETURN AFTER;`, {
		content
	});
	return normInterviewRun(rows[0]);
}

export async function getInterviewRun(db: Db, runId: string): Promise<InterviewRunRow | null> {
	const rid = link(runId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normInterviewRun(rows[0]) : null;
}

export interface FinalizeInterviewRunInput {
	status: Exclude<InterviewRunStatus, 'running'>;
	/** REQUIRED when status='error' (§3.6 — mechanically classified, never LLM). */
	error_reason?: InterviewErrorReason;
	planted_total?: number;
	planted_found?: number;
	false_positives?: number;
	results?: Array<Record<string, unknown>>;
	ambiguous?: Array<Record<string, unknown>>;
	/** Σ from PRICED agent_event rows only (F-008) — omit when nothing was priced. */
	cost_usd?: number;
}

/**
 * Record a run's scorer outcome. Run-status machine: running → adjudicating |
 * passed | failed | error; adjudicating → passed | failed (operator resolution,
 * §3.4). ended_at is server-stamped (D-035) when the run leaves 'running'.
 *
 * §2.2 campaign coupling — THE re-run-never-demotes ruling: the version's
 * lifecycle is mutated ONLY when it is currently 'interviewing' (a certification
 * campaign in flight). A terminal run against an already-'passed' version is an
 * EVIDENCE row: it flags honestly on the card but never demotes the version and
 * never breaks pins. Terminal runs append role_event{op:'interviewed'}.
 */
export async function finalizeInterviewRun(
	db: Db,
	runId: string,
	input: FinalizeInterviewRunInput
): Promise<InterviewRunRow> {
	const run = await getInterviewRun(db, runId);
	if (!run) throw new WorkforceInputError(`interview_run not found: ${runId}`);
	assertRunTransition(run.status, input.status);
	if (input.status === 'error' && !input.error_reason) {
		throw new WorkforceInputError(
			`interview_run ${runId}: error_reason is REQUIRED when status='error' ` +
				`(env_timeout | spawn_failure | scorer_error — §3.6)`
		);
	}
	if (input.status !== 'error' && input.error_reason) {
		throw new WorkforceInputError(
			`interview_run ${runId}: error_reason is only legal with status='error' (got '${input.status}')`
		);
	}

	const sets: string[] = ['status = $status'];
	const binds: Record<string, unknown> = { rid: link(run.id), status: input.status };
	if (run.status === 'running') sets.push('ended_at = time::now()');
	if (input.error_reason) {
		sets.push('error_reason = $reason');
		binds.reason = input.error_reason;
	}
	for (const k of ['planted_total', 'planted_found', 'false_positives', 'cost_usd'] as const) {
		if (input[k] !== undefined) {
			sets.push(`${k} = $${k}`);
			binds[k] = input[k];
		}
	}
	if (input.results !== undefined) {
		sets.push('results = $results');
		binds.results = input.results;
	}
	if (input.ambiguous !== undefined) {
		sets.push('ambiguous = $ambiguous');
		binds.ambiguous = input.ambiguous;
	}
	const [rows] = await db.query<[Raw[]]>(
		`UPDATE $rid SET ${sets.join(', ')} RETURN AFTER;`,
		binds
	);
	const updated = normInterviewRun(rows[0]);

	if (input.status === 'passed' || input.status === 'failed' || input.status === 'error') {
		const version = await getRoleVersion(db, run.role_version);
		if (version && version.lifecycle === 'interviewing') {
			await transitionLifecycle(db, version.id, input.status);
		}
		await addRoleEvent(db, {
			role: run.role,
			role_version: run.role_version,
			op: 'interviewed',
			detail: { run: run.id, status: input.status }
		});
	}
	return updated;
}

/** §3.7 — mark a passing run stale (fixture pool changed since it ran). Honest
 * flag, NOT revocation: the certification stays valid (§2.4) and the role card
 * surfaces it. Appends role_event{op:'stale_marked'}. */
export async function markInterviewRunStale(db: Db, runId: string): Promise<InterviewRunRow> {
	const run = await getInterviewRun(db, runId);
	if (!run) throw new WorkforceInputError(`interview_run not found: ${runId}`);
	const [rows] = await db.query<[Raw[]]>(`UPDATE $rid SET stale = true RETURN AFTER;`, {
		rid: link(run.id)
	});
	await addRoleEvent(db, {
		role: run.role,
		role_version: run.role_version,
		op: 'stale_marked',
		detail: { run: run.id }
	});
	return normInterviewRun(rows[0]);
}

// ── gauntlet_fixture / gauntlet_key ──────────────────────────────────────────────

export interface CreateGauntletFixtureInput {
	role: string;
	slug: string;
	kind: GauntletFixtureKind;
	/** {relative_path: content}; NO answer-key material, EVER (§2.1). */
	work: Record<string, unknown>;
	/** Unique ULID embedded in work — leak tripwire (§4.2; injected at activation by W-D7b/c). */
	sentinel: string;
	provenance?: string;
}

/** Create a fixture (status 'proposed'). content_sha is computed here from the
 * canonical work — mechanically, never caller-supplied. Duplicate (role, slug)
 * collides on the dedup UNIQUE index (D-008). */
export async function createGauntletFixture(
	db: Db,
	input: CreateGauntletFixtureInput
): Promise<GauntletFixtureRow> {
	if (!input.work || Object.keys(input.work).length === 0) {
		throw new WorkforceInputError(
			`gauntlet_fixture '${input.slug}': work must be a non-empty {relative_path: content} object`
		);
	}
	const content = omitUndefined({
		role: link(input.role),
		slug: input.slug,
		kind: input.kind,
		work: input.work,
		content_sha: computeWorkSha(input.work),
		sentinel: input.sentinel,
		provenance: input.provenance
	});
	const [rows] = await db.query<[Raw[]]>(
		`CREATE gauntlet_fixture CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normGauntletFixture(rows[0]);
}

export interface CreateGauntletKeyInput {
	fixture: string;
	plants?: Array<Record<string, unknown>>;
	fp_tolerance?: number;
	fp_justification?: string;
	author?: 'operator' | 'fixing_commit_diff';
	reference_runs?: Array<Record<string, unknown>>;
}

/** Create the fixture's ANSWER KEY. content_sha is bound mechanically from the
 * fixture row (content-addressed to the work it answers — §2.1); one key per
 * fixture. Authorship is operator/fixing_commit_diff only (§4.4 — the DDL ASSERT
 * enforces it; the PM has no write OR read path here).
 *
 * DEDUP IS PRIMARY-KEY-ENFORCED (red-team DEFECT 3, instrumented): the key's record id
 * is derived DETERMINISTICALLY from the fixture (`gauntlet_key:<fixture-suffix>`), so a
 * concurrent double-create collides ATOMICALLY on the primary record id. The secondary
 * `gauntlet_key_dedup` UNIQUE index on a computed VALUE field was reproduced NOT enforcing
 * uniqueness under concurrent inserts in SurrealDB 2.x (25/40 races persisted TWO rows with
 * identical dedup_key); the primary-key collision is the atomic guarantee (0/40 races
 * duplicate). One fixture maps to exactly one key id — re-running is idempotent-by-collision
 * (interrupt contract). The collision surfaces as a raw transaction-conflict; callers that
 * must absorb it map it to a named error (see ceremony.confirmLaunchKey). */
export async function createGauntletKey(
	db: Db,
	input: CreateGauntletKeyInput
): Promise<GauntletKeyRow> {
	const fid = link(input.fixture);
	const [fixtures] = await db.query<[Raw[]]>(`SELECT * FROM $fid;`, { fid });
	if (!fixtures.length) {
		throw new WorkforceInputError(`gauntlet_fixture not found: ${input.fixture} — a key must answer real work`);
	}
	const fixture = normGauntletFixture(fixtures[0]);
	const content = omitUndefined({
		fixture: fid,
		content_sha: fixture.content_sha,
		plants: input.plants,
		fp_tolerance: input.fp_tolerance,
		fp_justification: input.fp_justification,
		author: input.author,
		reference_runs: input.reference_runs
	});
	// Deterministic key id bound to the fixture — the atomic one-key-per-fixture guarantee.
	const keyId = link(`gauntlet_key:${assertRecordId(fixture.id).split(':')[1]}`);
	const [rows] = await db.query<[Raw[]]>(`CREATE $kid CONTENT $content RETURN AFTER;`, {
		kid: keyId,
		content
	});
	return normGauntletKey(rows[0]);
}

/**
 * THE single gauntlet_key read path (§2.1/§4.4): the deterministic scorer (W-D7b),
 * product code running OUTSIDE any session — keys never enter a transcript. No
 * session, briefing, recall, PM snapshot, or export path may import this function;
 * the repo.test.ts read-path fixture asserts this module is the table's only reader.
 * Returns null (with no side effects) when the fixture has no key yet.
 */
export async function readGauntletKeyForScoring(
	db: Db,
	fixtureId: string
): Promise<GauntletKeyRow | null> {
	const fid = link(fixtureId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM gauntlet_key WHERE fixture = $fid LIMIT 1;`, {
		fid
	});
	return rows.length ? normGauntletKey(rows[0]) : null;
}

// ── panel_verdict (§2.5 management-validation artifacts ONLY) ────────────────────

export interface AddPanelVerdictInput {
	/** Omit for project-less workforce artifacts (global role revisions). */
	project?: string;
	artifact: string;
	artifact_kind: PanelArtifactKind;
	validator_session: string;
	/** Default 'inline' (§9 bootstrap bridge). */
	validator_kind?: 'inline' | 'catalog_role';
	role?: string;
	role_version?: string;
	verdict: PanelVerdictValue;
	reasons?: string[];
	confidence?: 'low' | 'medium' | 'high';
	/** §4.5 — the decision class the validator took (TASK 16.4). */
	classification?: PanelClassification;
}

/** Record one validator's verdict on one artifact. Dedup: ONE verdict per
 * (artifact, validator_session) — D-008 VALUE+UNIQUE, concurrent double-writes
 * collide loudly. validator_kind='catalog_role' requires the role identity. */
export async function addPanelVerdict(db: Db, input: AddPanelVerdictInput): Promise<PanelVerdictRow> {
	if (input.validator_kind === 'catalog_role' && (!input.role || !input.role_version)) {
		throw new WorkforceInputError(
			`panel_verdict: validator_kind='catalog_role' requires role + role_version ` +
				`(inline validators leave them unset — §9)`
		);
	}
	const content = omitUndefined({
		project: input.project ? link(input.project) : undefined,
		artifact: link(input.artifact),
		artifact_kind: input.artifact_kind,
		validator_session: link(input.validator_session),
		validator_kind: input.validator_kind,
		role: input.role ? link(input.role) : undefined,
		role_version: input.role_version ? link(input.role_version) : undefined,
		verdict: input.verdict,
		reasons: input.reasons,
		confidence: input.confidence,
		classification: input.classification
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE panel_verdict CONTENT $content RETURN AFTER;`, {
		content
	});
	return normPanelVerdict(rows[0]);
}

export async function getPanelVerdict(db: Db, verdictId: string): Promise<PanelVerdictRow | null> {
	const rid = link(verdictId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normPanelVerdict(rows[0]) : null;
}

/** Every verdict recorded against one artifact (the panel history of a proposal),
 *  oldest first (F-022: the ORDER BY field is in the SELECT * projection). */
export async function listPanelVerdictsForArtifact(
	db: Db,
	artifactId: string
): Promise<PanelVerdictRow[]> {
	const aid = link(artifactId);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM panel_verdict WHERE artifact = $aid ORDER BY at ASC LIMIT 200;`,
		{ aid }
	);
	return rows.map(normPanelVerdict);
}

/**
 * §2.2 bulk closure (TASK 16.4): close every still-OPEN verdict on one artifact with
 * the same mechanical outcome. Harness-only, like {@link closePanelVerdictOutcome}
 * (the per-row writer it composes — already-closed rows are skipped, so a crash
 * mid-loop re-runs clean: interrupt contract). Returns the number newly closed.
 */
export async function closeOpenPanelVerdictsForArtifact(
	db: Db,
	artifactId: string,
	outcome: PanelOutcome
): Promise<number> {
	const open = (await listPanelVerdictsForArtifact(db, artifactId)).filter(
		(v) => v.outcome == null
	);
	for (const v of open) await closePanelVerdictOutcome(db, v.id, outcome);
	return open.length;
}

/**
 * §2.2 — outcome closure: MECHANICAL, HARNESS-ONLY, server-stamped (D-035). This
 * function is the sole writer of panel_verdict.outcome; it is called by harness
 * machinery on mechanical signals (operator gate action → 'overridden_by_operator';
 * proposal pipeline → 'revised'/'withdrawn'; task terminal done-unmodified →
 * 'upheld') — NEVER from PM/LLM judgment. Re-closing with the SAME outcome is an
 * absorbed no-op (interrupt contract); a DIFFERENT outcome is refused (closure is
 * append-once — relabeling history would corrupt the calibration record).
 */
export async function closePanelVerdictOutcome(
	db: Db,
	verdictId: string,
	outcome: PanelOutcome
): Promise<PanelVerdictRow> {
	const v = await getPanelVerdict(db, verdictId);
	if (!v) throw new WorkforceInputError(`panel_verdict not found: ${verdictId}`);
	if (v.outcome != null) {
		if (v.outcome === outcome) return v; // idempotent re-run absorbs prior work
		throw new WorkforceInputError(
			`panel_verdict ${verdictId} outcome already closed as '${v.outcome}' — refusing relabel to '${outcome}'`
		);
	}
	const [rows] = await db.query<[Raw[]]>(`UPDATE $rid SET outcome = $outcome RETURN AFTER;`, {
		rid: link(v.id),
		outcome
	});
	return normPanelVerdict(rows[0]);
}

// ── role_event audit feed ────────────────────────────────────────────────────────

export interface AddRoleEventInput {
	role: string;
	role_version?: string;
	op: RoleEventOp;
	detail?: Record<string, unknown>;
}

/** Append one audit event (single producer = the functions in THIS module plus
 * future harness machinery — never sessions/agents, §4.4). */
export async function addRoleEvent(db: Db, input: AddRoleEventInput): Promise<RoleEventRow> {
	const content = omitUndefined({
		role: link(input.role),
		role_version: input.role_version ? link(input.role_version) : undefined,
		op: input.op,
		detail: input.detail
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE role_event CONTENT $content RETURN AFTER;`, {
		content
	});
	return normRoleEvent(rows[0]);
}

export async function listRoleEvents(db: Db, roleId: string, limit = 100): Promise<RoleEventRow[]> {
	const role = link(roleId);
	const cap = Math.min(Math.max(limit, 1), 500);
	// F-022: the ORDER BY field is in the projection (SELECT *).
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM role_event WHERE role = $role ORDER BY at DESC LIMIT ${cap};`,
		{ role }
	);
	return rows.map(normRoleEvent);
}

// ── §2.6 bundle_digest honesty ───────────────────────────────────────────────────

/**
 * The capability-bundle digest recorded on an interview run (§2.6). v2.1 covers
 * exactly what the cc-config mirror has digested: the SETTINGS scope
 * (cc_settings.sync_digest — per-skill/agent file digests arrive with v2.2b). The
 * returned value is self-describing about its coverage:
 *   • `settings:<sha256 over the sorted per-scope digests>` when ≥1 scope digest exists
 *   • the honest literal `'unhashed'` when the mirror has digested nothing
 * Never a fabricated hash, never a silent claim of more coverage than was digested
 * (F-008 — drift warnings downstream cover exactly this surface).
 */
export async function currentBundleDigest(db: Db): Promise<string> {
	const [rows] = await db.query<[Array<{ sync_digest: unknown }>]>(
		`SELECT sync_digest FROM cc_settings WHERE sync_digest != NONE LIMIT 1000;`
	);
	const digests = (rows ?? [])
		.map((r) => r.sync_digest)
		.filter((d): d is string => typeof d === 'string' && d.length > 0)
		.sort();
	if (digests.length === 0) return 'unhashed';
	return `settings:${createHash('sha256').update(digests.join('\n'), 'utf8').digest('hex')}`;
}
