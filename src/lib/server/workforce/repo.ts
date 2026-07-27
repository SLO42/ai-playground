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
	assertProposalTransition,
	assertRunTransition,
	assertTransition,
	INTERVIEWABLE_LIFECYCLES,
	isProposalTerminal,
	type InterviewRunStatus,
	type ProposalStatus,
	type RoleVersionLifecycle
} from './lifecycle';
// COMPLETION-LEDGER Wave A — the hire/cert event funnel. NOTE the deliberate module cycle
// (repo → hire-events → repo, for addRoleEvent): both sides reference the other ONLY inside
// function bodies, never at module-evaluation time, so ESM's live bindings resolve it cleanly.
// The alternative (duplicating the role_event append here) would be a second writer — F-055.
import { emitGauntletScored, emitGauntletStarted } from './hire-events';

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
/** The role_event audit vocabulary (matches the schema ASSERT — m0031 + m0083).
 *  COMPLETION-LEDGER Wave A (m0083) added the six previously-UNAUDITED hire/cert moments:
 *  a gauntlet OPENING, an adjudication, a re-version, and the whole hire gate
 *  (considered → hired | hire_rejected). Emitted through workforce/hire-events.ts. */
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
	| 'stale_marked'
	| 'gauntlet_started'
	| 'adjudicated'
	| 'reversioned'
	| 'candidate_considered'
	| 'hired'
	| 'hire_rejected';

/** The hire + certification lifecycle ops (m0083) — the subset the /agents hiring-activity
 *  feed renders. 'interviewed'/'staffed' predate the wave but ARE part of the story, so they
 *  are included; 'created'/'swap'/'retired'/… are role-admin, not a hire, and are excluded. */
export const HIRE_LIFECYCLE_OPS: readonly RoleEventOp[] = [
	'gauntlet_started',
	'interviewed',
	'adjudicated',
	'reversioned',
	'candidate_considered',
	'hired',
	'hire_rejected',
	'staffed'
] as const;

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
	const created = normInterviewRun(rows[0]);

	// COMPLETION-LEDGER Wave A — a certification campaign OPENING is a first-class, durable fact.
	// Before this wave a gauntlet START left NO trace at all: the operator saw a run appear with no
	// record of what it was about to be judged against. Emitted HERE (the one chokepoint every run
	// creation funnels through) with the inputs the verdict will rest on. Best-effort in full — the
	// slug lookup and both appends are swallowed together, so telemetry NEVER fails a run (F-048).
	try {
		const role = await getRole(db, version.role);
		await emitGauntletStarted(db, {
			role: version.role,
			roleSlug: role?.slug ?? version.role,
			roleVersion: version.id,
			run: created.id,
			tier: input.tier,
			provider: input.provider,
			modelId: input.model_id,
			fixtureSetSha: input.fixture_set_sha,
			...(input.planted_total !== undefined ? { plantedTotal: input.planted_total } : {}),
			// The lifecycle as it was BEFORE this call's campaign transition above — the honest record
			// of whether this run started a campaign, retried one, or is evidence against a cert.
			lifecycleBefore: version.lifecycle,
			...(input.retry_of ? { retryOf: input.retry_of } : {})
		});
	} catch (err) {
		console.warn(
			`[workforce] gauntlet_started trace failed for ${created.id} (the run is unaffected): ${(err as Error).message}`
		);
	}
	return created;
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

	// The version's lifecycle BEFORE any campaign transition — half of the honest "did this verdict
	// actually move the campaign, or was it absorbed as evidence" record (§2.2 re-run-never-demotes).
	const version = await getRoleVersion(db, run.role_version);
	const lifecycleBefore = version?.lifecycle ?? '(missing)';
	let lifecycleAfter = lifecycleBefore;

	if (input.status === 'passed' || input.status === 'failed' || input.status === 'error') {
		if (version && version.lifecycle === 'interviewing') {
			await transitionLifecycle(db, version.id, input.status);
			lifecycleAfter = input.status;
		}
	}

	// COMPLETION-LEDGER Wave A — the scorer's verdict becomes a first-class, durable fact carrying
	// the FULL basis it rested on (recall + its numerator/denominator, false positives, the mechanical
	// error class, cost, and whether the campaign actually moved). This REPLACES the previous thin
	// `role_event{op:'interviewed', detail:{run,status}}` write — a flat status with no WHY, which is
	// exactly the defect class this wave exists to fix. It is emitted for EVERY finalize status, not
	// only the terminal ones: an 'adjudicating' outcome previously left NO trace at all, so the
	// operator could not see that a run was parked waiting on THEM. Best-effort (F-048): a telemetry
	// fault never changes a run's recorded outcome.
	try {
		const role = await getRole(db, run.role);
		await emitGauntletScored(db, {
			role: run.role,
			roleSlug: role?.slug ?? run.role,
			roleVersion: run.role_version,
			run: run.id,
			status: input.status,
			...(input.planted_total !== undefined ? { plantedTotal: input.planted_total } : {}),
			...(input.planted_found !== undefined ? { plantedFound: input.planted_found } : {}),
			...(input.false_positives !== undefined ? { falsePositives: input.false_positives } : {}),
			...(input.error_reason ? { errorReason: input.error_reason } : {}),
			...(input.cost_usd !== undefined ? { costUsd: input.cost_usd } : {}),
			ambiguousCount: input.ambiguous?.length ?? 0,
			lifecycleBefore,
			lifecycleAfter
		});
	} catch (err) {
		console.warn(
			`[workforce] gauntlet_scored trace failed for ${run.id} (the run outcome is unaffected): ${(err as Error).message}`
		);
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

/** A recent role_event with the role's display identity joined — for the workforce activity
 *  surface (the project command-center HR/role pulse). `role_slug`/`role_name` are the
 *  human-readable role identity, or null when the link is dangling (honest — never fabricated;
 *  the renderer runs them through the shared naming composer so a dangling role reads as
 *  `probe_fit`, not `role:probe_fit_1781894354268`). */
export interface RecentRoleEventRow extends RoleEventRow {
	role_slug: string | null;
	role_name: string | null;
}

/**
 * The most-recent workforce role_events ACROSS all roles (newest-first, bounded). role_event has no
 * project column — workforce lifecycle (created/swap/staffed/retired/cert/flip) is project-less — so
 * this is the GLOBAL recent-HR-activity feed the project command-center surfaces (the operator wants
 * hires/cert/swaps visible alongside dev + PM activity).
 *
 * Bounded by construction (F-014): newest-first + a hard-clamped LIMIT — never an unbounded scan. The
 * role.slug is joined in the projection (F-022: the ORDER BY field `at` is selected). datetime → ISO
 * string in normRoleEvent (F-013); a dangling role link yields role_slug:null (honest, F-008).
 *
 * `ops` (COMPLETION-LEDGER Wave A) OPTIONALLY narrows the feed to a set of audit ops — the
 * /agents hiring-activity surface passes HIRE_LIFECYCLE_OPS so role-admin noise (created/swap/
 * tier_changed) does not drown the hire story. Bound as a $param (D-016 — never interpolated).
 * Omitted ⇒ every op (the existing command-center behaviour, byte-identical).
 *
 * SHADOW PATHS: no role_events ⇒ [] (honest empty — the surface shows "HR idle"); a row with a
 * dangling role ⇒ role_slug:null (shown as the raw id, never dropped); limit≤0 ⇒ clamped to 1;
 * `ops: []` ⇒ [] (an EMPTY filter selects nothing — honest, never silently "all").
 */
export async function listRecentRoleEvents(
	db: Db,
	limit = 20,
	ops?: readonly RoleEventOp[]
): Promise<RecentRoleEventRow[]> {
	const cap = Math.min(Math.max(limit, 1), 200);
	// Empty-input shadow path: an explicitly EMPTY op filter matches nothing. Returning early
	// keeps that honest (a `WHERE op IN []` is a needless round-trip) and can never be confused
	// with the unfiltered case, which passes `ops: undefined`.
	if (ops && ops.length === 0) return [];
	const where = ops ? 'WHERE op IN $ops' : '';
	// F-020: the ORDER BY field (`at`) is in the projection — `SELECT *` covers it.
	const [rows] = await db.query<[Array<Raw & { role_slug?: unknown; role_name?: unknown }>]>(
		`SELECT *, role.slug AS role_slug, role.name AS role_name
		   FROM role_event ${where} ORDER BY at DESC LIMIT ${cap};`,
		ops ? { ops: [...ops] } : {}
	);
	return (rows ?? []).map((row) => ({
		...normRoleEvent(row),
		role_slug: row.role_slug != null ? str(row.role_slug) : null,
		role_name: row.role_name != null ? str(row.role_name) : null
	}));
}

// ── The hiring & certification LEDGER read model (operator review 2026-07-26 §5 + §13) ──
//
// The /agents "HIRING & CERTIFICATION ACTIVITY" card rendered 36 near-identical rows, every one
// `Gauntlet scored … recall —`. Three separate defects, all fixed here rather than in the markup:
//
//   (i)  `recall —` was HONEST but needlessly blind. The 36 live rows carry the PRE-WAVE flat
//        detail `{run, status}`, so the page had no planted_found/planted_total to show — yet the
//        numbers exist ONE FETCH away: every `interview_run` row has planted_total / planted_found
//        / false_positives / pass_criteria / status / tier / model_id, and the ledger row already
//        stores the pointer in `detail.run`. We join it.
//   (ii) The feed was a FLAT list. A gauntlet ceremony emits several events against ONE run
//        (started → scored → adjudicated → re-versioned); grouping by run turns 36 loose rows into
//        threads that read as what actually happened.
//   (iii) 19 of the 36 runs BROKE (§13: 15 spawn_failure + 4 scorer_error, of which 9 are duplicate
//        auto-retries), so the operator's view was dominated by dead noise. The rows are CLASSIFIED
//        here (`errored` / `isRetry`) and the SURFACE defaults to hiding them behind an honest,
//        counted disclosure. Nothing is deleted and nothing is dropped from the read model —
//        filtering is a VIEW choice the operator can reverse, not data loss.

/** The run facts joined onto a ceremony — the numbers `recall —` was standing in for. */
export interface HiringRunFacts {
	id: string;
	/** The certification axis (§2.4): the tier + resolved model the gauntlet actually ran at. */
	tier: string | null;
	model_id: string | null;
	provider: string | null;
	/** running | adjudicating | passed | failed | error. */
	status: string | null;
	/** env_timeout | spawn_failure | scorer_error. Set iff status='error' (repo invariant). */
	error_reason: string | null;
	/** The run this one auto-retried (§3.6), or null. 9 of the 19 live errors are retries. */
	retry_of: string | null;
	planted_total: number | null;
	planted_found: number | null;
	false_positives: number | null;
	/**
	 * planted_found / planted_total, or NULL when the run planted nothing. A run with 0 plants has
	 * an UNDEFINED recall — not 0, not 1. Computing it here keeps the honest-null decision in one
	 * place instead of re-deriving it in the markup (F-008).
	 */
	recall: number | null;
	/** The pass-bar SNAPSHOT the run was judged against ({} when the run recorded none). */
	pass_criteria: Record<string, unknown>;
	/** Fixture pool changed since the run (§3.7) — an honest staleness flag, NOT a revocation. */
	stale: boolean;
	started_at: string | null;
	ended_at: string | null;
}

/** One gauntlet/hire ceremony: the events that belong to one run, plus that run's facts. */
export interface HiringCeremony {
	/** `interview_run:…` when the thread has a run, else `event:<role_event id>` (a singleton). */
	key: string;
	/** The joined run, or null — see {@link runMissing} for WHY it is null. */
	run: HiringRunFacts | null;
	/**
	 * TRUE when the events pointed at a run that no longer resolves (deleted / dangling pointer).
	 * Distinguishes "this ceremony has no run" (an op like `staffed` that never had one) from
	 * "the run it named is GONE" — two different truths that must not render identically.
	 */
	runMissing: boolean;
	/** The role the ceremony was about (raw link + the joined identity; any may be null). */
	role: string | null;
	role_slug: string | null;
	role_name: string | null;
	/** The ledger events in the thread, newest-first. Never empty. */
	events: RecentRoleEventRow[];
	/** The newest event time in the thread (ISO) — the sort key. null when unrecorded. */
	at: string | null;
	/** The run BROKE (status='error'). The surface hides these by default, counted + reversible. */
	errored: boolean;
	/** The run is an auto-retry of an earlier one (§3.6) — duplicate noise, badged not hidden. */
	isRetry: boolean;
}

/** The whole hiring feed: threads + the honest totals the surface discloses. */
export interface HiringActivity {
	/** Ceremony threads, newest-first. */
	ceremonies: HiringCeremony[];
	/** How many raw ledger events were folded (the pre-grouping count). */
	totalEvents: number;
	/** How many ceremonies rest on a BROKEN run (§13) — surfaced, never silently dropped. */
	erroredCount: number;
	/** How many ceremonies are auto-retries of an earlier run. */
	retryCount: number;
}

/** Max interview_run rows hydrated for one feed read (F-014 — bounded, never a scan). */
const HIRING_RUN_FETCH_CAP = 200;

/** A finite number, or null. A missing/NaN count is UNKNOWN, never silently 0 (F-008). */
function numOrNull(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize one interview_run row into {@link HiringRunFacts} (datetimes → ISO, F-013). */
function normHiringRun(row: Raw): HiringRunFacts {
	const plantedTotal = numOrNull(row.planted_total);
	const plantedFound = numOrNull(row.planted_found);
	return {
		id: str(row.id),
		tier: row.tier != null ? str(row.tier) : null,
		model_id: row.model_id != null ? str(row.model_id) : null,
		provider: row.provider != null ? str(row.provider) : null,
		status: row.status != null ? str(row.status) : null,
		error_reason: row.error_reason != null ? str(row.error_reason) : null,
		retry_of: row.retry_of != null ? str(row.retry_of) : null,
		planted_total: plantedTotal,
		planted_found: plantedFound,
		false_positives: numOrNull(row.false_positives),
		// A run that planted nothing has an UNDEFINED recall — null, never 0 (F-008).
		recall:
			plantedTotal != null && plantedTotal > 0 && plantedFound != null
				? plantedFound / plantedTotal
				: null,
		pass_criteria: (row.pass_criteria ?? {}) as Record<string, unknown>,
		stale: row.stale === true,
		started_at: strDate(row.started_at),
		ended_at: strDate(row.ended_at)
	};
}

/**
 * The subject pointer a ledger row groups by — the thing the ceremony is ABOUT.
 *
 * TWO SHAPES EXIST ON THE LIVE TABLE, and joining on only one is a trap:
 *   • PRE-WAVE rows (all 36 live `interviewed` rows, newest 2026-06-19) carry the flat
 *     `detail.run` written by the old thin `role_event{op:'interviewed', detail:{run,status}}`.
 *   • POST-m0083 rows carry `detail.ref` — `hire-events.ts` emitHireEvent stamps
 *     `detail: { ...detail, ref: input.ref }` on EVERY hire moment and never writes `run`.
 * Reading only `detail.run` would light up the historical rows and then go dark the instant a
 * gauntlet next runs. Both are accepted; `run` wins when a row somehow carries both.
 *
 * A `ref` is not always an interview_run (a hire decision refs a `decision_brief:`), which is
 * fine — grouping a hire ceremony by its brief is still the right thread. Only a pointer that
 * actually names `interview_run` is handed to {@link isRunPointer} for hydration.
 */
function ceremonyPointer(detail: Record<string, unknown> | undefined): string | null {
	for (const key of ['run', 'ref'] as const) {
		const v = detail?.[key];
		if (typeof v !== 'string') continue;
		const s = v.trim();
		if (s !== '') return s;
	}
	return null;
}

/** Whether a ceremony pointer names an `interview_run` row (⇒ it can be hydrated with facts). */
function isRunPointer(pointer: string | null): pointer is string {
	return pointer != null && pointer.startsWith('interview_run:');
}

/**
 * The /agents HIRING & CERTIFICATION feed: the HIRE_LIFECYCLE_OPS ledger, joined to the
 * `interview_run` rows it points at, grouped into ceremony threads, newest-first.
 *
 * BOUNDED (F-014): the ledger read is the existing clamped {@link listRecentRoleEvents}; the run
 * hydration is a point read over the DISTINCT run pointers in that window, itself capped at
 * {@link HIRING_RUN_FETCH_CAP}. Neither is a table scan. Params are bound (D-016). No `ORDER BY`
 * on the run lookup, so there is no F-020 order-idiom obligation there; the ledger query's
 * `ORDER BY at` field is already in its projection.
 *
 * SHADOW PATHS, all four, all named:
 *   • happy          — events + resolvable runs → threads carrying recall / FP / tier / model.
 *   • empty          — no ledger rows ⇒ `{ceremonies: [], totalEvents: 0, …}`; the surface shows
 *                      its honest "nothing hired or certified yet" state (F-008).
 *   • nil-ish input  — `limit ≤ 0` is clamped by listRecentRoleEvents; an event whose pointer is
 *                      absent / not a string becomes its OWN singleton ceremony rather than
 *                      being dropped or merged into a bogus shared thread.
 *   • upstream error — a run pointer that no longer resolves (deleted run) yields
 *                      `run: null, runMissing: true`; the thread still renders, honestly labelled.
 *                      A fault in either query PROPAGATES to the page-level catch — a local
 *                      best-effort catch here would render an empty feed on a healthy-looking
 *                      page, which is exactly the defect the F-020 sweep exists to prevent.
 */
export async function listHiringActivity(db: Db, limit = 60): Promise<HiringActivity> {
	const events = await listRecentRoleEvents(db, limit, HIRE_LIFECYCLE_OPS);
	if (events.length === 0) {
		return { ceremonies: [], totalEvents: 0, erroredCount: 0, retryCount: 0 };
	}

	// Distinct interview_run pointers across the window → one bounded point read.
	const runIds: string[] = [];
	const seenRun = new Set<string>();
	for (const ev of events) {
		const p = ceremonyPointer(ev.detail);
		if (!isRunPointer(p) || seenRun.has(p)) continue;
		seenRun.add(p);
		if (runIds.length < HIRING_RUN_FETCH_CAP) runIds.push(p);
	}

	const runById = new Map<string, HiringRunFacts>();
	if (runIds.length > 0) {
		const links: StringRecordId[] = [];
		for (const id of runIds) {
			try {
				links.push(link(id));
			} catch {
				// IdentifierError on a malformed pointer → that ONE ceremony reports runMissing.
				continue;
			}
		}
		if (links.length > 0) {
			const [rows] = await db.query<[Raw[]]>(
				`SELECT id, role, role_version, tier, provider, model_id, status, error_reason, retry_of,
				        planted_total, planted_found, false_positives, pass_criteria, stale,
				        started_at, ended_at
				   FROM interview_run WHERE id IN $ids LIMIT $lim;`,
				{ ids: links, lim: links.length }
			);
			for (const r of rows ?? []) runById.set(str(r.id), normHiringRun(r));
		}
	}

	// Group into ceremonies. `events` is already newest-first, so first-seen order IS newest-first
	// and the thread's `at` is its newest event — no re-sort needed (and none that could reorder
	// two threads whose newest events tie).
	const byKey = new Map<string, HiringCeremony>();
	for (const ev of events) {
		const pointer = ceremonyPointer(ev.detail);
		const key = pointer ?? `event:${ev.id}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.events.push(ev);
			// A thread inherits the first non-null role identity it sees — a later event in the same
			// ceremony can carry the slug when an earlier one's link was dangling.
			existing.role ??= ev.role ?? null;
			existing.role_slug ??= ev.role_slug;
			existing.role_name ??= ev.role_name;
			continue;
		}
		const run = isRunPointer(pointer) ? (runById.get(pointer) ?? null) : null;
		byKey.set(key, {
			key,
			run,
			// Only an interview_run pointer can be "missing" — a `decision_brief:` ref was never
			// expected to hydrate into run facts, so it must not be reported as a broken link.
			runMissing: isRunPointer(pointer) && run == null,
			role: ev.role ?? null,
			role_slug: ev.role_slug,
			role_name: ev.role_name,
			events: [ev],
			at: ev.at,
			errored: run?.status === 'error',
			isRetry: run?.retry_of != null
		});
	}

	const ceremonies = [...byKey.values()];
	return {
		ceremonies,
		totalEvents: events.length,
		erroredCount: ceremonies.filter((c) => c.errored).length,
		retryCount: ceremonies.filter((c) => c.isRetry).length
	};
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

// ── review_proposal (§5 performance-review loop — the m0046 table CRUD) ────────────
//
// The m0046 migration made the table real but shipped NO row-creation path. This is
// it: createReviewProposal (the auto-raise + operator-initiated entry point) plus the
// bounded reads the §5 anti-spam cap (open-per-(role,kind)) and cooldown depend on.
// A proposal is ONLY ever born status='proposed' here — it NEVER mutates a role,
// swaps a version, or authors a challenger prompt (§5: the challenger is created later,
// on panel validation; the swap is a separate operator-gated act, §2.3). The status
// state machine (validated/diff_review/…/swapped) lives in the v2.3 governance code
// that consumes these rows; this module only OPENS and READS them.

export type ReviewProposalKind = 'prompt_revision' | 'tier_change' | 'retire' | 'staffing';
/** Aliased to the lifecycle module's ProposalStatus — the §5 status machine (m0046 enum)
 *  lives in lifecycle.ts as the single transition table; this is the same set of names. */
export type ReviewProposalStatus = ProposalStatus;

/** The OPEN statuses (an in-flight proposal the operator has not yet disposed of).
 *  The anti-spam cap (§5 max_open_proposals) counts these; a row in any other status
 *  is disposed (swapped/rejected/withdrawn) and no longer occupies the (role,kind) slot. */
export const OPEN_PROPOSAL_STATUSES: readonly ReviewProposalStatus[] = [
	'proposed',
	'validated',
	'diff_review',
	'interviewing',
	'compared'
] as const;

/** A terminal REJECTION (cooldown anchor — §5: don't re-raise the same trigger right
 *  after the operator rejected it). rejected_by_panel/rejected_by_operator/withdrawn. */
export const REJECTED_PROPOSAL_STATUSES: readonly ReviewProposalStatus[] = [
	'rejected_by_panel',
	'rejected_by_operator',
	'withdrawn'
] as const;

export interface ReviewProposalRow {
	id: string;
	role: string;
	kind: ReviewProposalKind;
	/** The incumbent version the proposal targets. null = none (e.g. a fresh staffing). */
	incumbent: string | null;
	/** Created later (draft, source=pm_proposal) on validation (§5). null until then. */
	challenger: string | null;
	/** null = operator-initiated (§5). */
	pm: string | null;
	/** {signal, evidence:[ids], config_snapshot} — PM-SPEC §4.1 provenance (§5). */
	trigger: Record<string, unknown>;
	status: ReviewProposalStatus;
	comparison: Record<string, unknown> | null;
	decided_at: string | null;
	created_at: string | null;
}

function normReviewProposal(row: Raw): ReviewProposalRow {
	return {
		id: str(row.id),
		role: str(row.role),
		kind: row.kind as ReviewProposalKind,
		incumbent: row.incumbent != null ? str(row.incumbent) : null,
		challenger: row.challenger != null ? str(row.challenger) : null,
		pm: row.pm != null ? str(row.pm) : null,
		trigger: (row.trigger ?? {}) as Record<string, unknown>,
		status: row.status as ReviewProposalStatus,
		comparison: row.comparison != null ? (row.comparison as Record<string, unknown>) : null,
		decided_at: strDate(row.decided_at),
		created_at: strDate(row.created_at)
	};
}

export interface CreateReviewProposalInput {
	role: string;
	kind?: ReviewProposalKind;
	incumbent?: string;
	pm?: string;
	/** PM-SPEC §4.1 provenance: {signal, evidence:[real ids], config_snapshot}. The
	 *  evidence MUST be real cited rows (F-008) — the caller composes it; this layer
	 *  stores it verbatim (it is harness-authored, never agent free-text → no screen). */
	trigger?: Record<string, unknown>;
}

/**
 * OPEN a review_proposal at status='proposed' (§5). This is the SOLE creation path —
 * the auto-raise (drift.ts) and operator-initiated flows both land here. It NEVER
 * mutates the role/version, NEVER swaps, NEVER authors a challenger prompt; it records
 * the TRIGGER for the operator. NOTE: m0046 stores `dedup_key` (role|kind|incumbent) as
 * a VALUE field but does NOT add a UNIQUE index on it — a hard UNIQUE would forbid the
 * legitimate post-cooldown re-raise (the fingerprint repeats over the version's lifetime
 * by design). The §5 anti-spam guarantee is therefore enforced by the auto-raise caller's
 * in-pass + cross-pass open-check + cooldown (drift.ts autoRaiseForVersion), NOT by a DB
 * constraint. This function performs no dedup of its own.
 */
export async function createReviewProposal(
	db: Db,
	input: CreateReviewProposalInput
): Promise<ReviewProposalRow> {
	const content = omitUndefined({
		role: link(input.role),
		kind: input.kind,
		incumbent: input.incumbent ? link(input.incumbent) : undefined,
		pm: input.pm ? link(input.pm) : undefined,
		trigger: input.trigger
	});
	const [rows] = await db.query<[Raw[]]>(`CREATE review_proposal CONTENT $content RETURN AFTER;`, {
		content
	});
	return normReviewProposal(rows[0]);
}

export async function getReviewProposal(
	db: Db,
	proposalId: string
): Promise<ReviewProposalRow | null> {
	const rid = link(proposalId);
	const [rows] = await db.query<[Raw[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? normReviewProposal(rows[0]) : null;
}

/** Every proposal for a role, newest first (F-022: ORDER BY field is in SELECT *). */
export async function listReviewProposalsForRole(
	db: Db,
	roleId: string,
	limit = 200
): Promise<ReviewProposalRow[]> {
	const role = link(roleId);
	const cap = Math.min(Math.max(limit, 1), 500);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM review_proposal WHERE role = $role ORDER BY created_at DESC LIMIT ${cap};`,
		{ role }
	);
	return rows.map(normReviewProposal);
}

/** Every OPEN proposal across ALL roles (the §8 RightTray decisions-inbox feed). Newest
 *  first (F-022: ORDER BY field projected by SELECT *); bounded. Open = any non-terminal
 *  status (proposed/validated/diff_review/interviewing/compared). */
export async function listOpenProposals(db: Db, limit = 200): Promise<ReviewProposalRow[]> {
	const cap = Math.min(Math.max(limit, 1), 500);
	const [rows] = await db.query<[Raw[]]>(
		`SELECT * FROM review_proposal
		  WHERE status IN $open ORDER BY created_at DESC LIMIT ${cap};`,
		{ open: OPEN_PROPOSAL_STATUSES as unknown as string[] }
	);
	return rows.map(normReviewProposal);
}

// ── review_proposal status machine writers (§5 governance — resolution.ts consumes) ─
//
// These are the SOLE status-mutation path for a review_proposal. Each move is checked
// against the §5 transition table (lifecycle.ts assertProposalTransition — the single
// source of legal moves) BEFORE the write, so an illegal jump (e.g. proposed→swapped,
// skipping the diff + re-gauntlet + comparison) is refused with a NAMED ProposalStatusError.
// Terminal moves stamp decided_at server-side (D-035). NONE of these mutate a role, swap a
// version, or author a prompt — that governance lives in resolution.ts which composes them
// with createRoleVersion / runGauntlet / swapActiveVersion.

/**
 * Move a proposal to a new status, transition-checked (§5). Optionally set the
 * challenger (on diff approval) and/or the comparison (after the re-gauntlet) in the
 * SAME write — a partial write can never leave the row in a status whose required field
 * is missing (interrupt contract). A terminal target stamps decided_at. Idempotent
 * re-target to the SAME status is an absorbed no-op (interrupt-safe re-run).
 */
export interface SetProposalStatusInput {
	to: ProposalStatus;
	/** Set when moving into diff_review/interviewing: the freshly-authored challenger. */
	challenger?: string;
	/** Set when moving into 'compared': the re-gauntlet comparison object (§5). */
	comparison?: Record<string, unknown>;
}

export async function setProposalStatus(
	db: Db,
	proposalId: string,
	input: SetProposalStatusInput
): Promise<ReviewProposalRow> {
	const p = await getReviewProposal(db, proposalId);
	if (!p) throw new WorkforceInputError(`review_proposal not found: ${proposalId}`);
	if (p.status === input.to) {
		// Idempotent absorb (interrupt contract): re-applying the same status, optionally
		// folding in a challenger/comparison the prior partial write missed.
		const sets: string[] = [];
		const binds: Record<string, unknown> = { rid: link(p.id) };
		if (input.challenger && p.challenger == null) {
			sets.push('challenger = $challenger');
			binds.challenger = link(input.challenger);
		}
		if (input.comparison !== undefined && p.comparison == null) {
			sets.push('comparison = $comparison');
			binds.comparison = input.comparison;
		}
		if (sets.length === 0) return p;
		const [rows] = await db.query<[Raw[]]>(`UPDATE $rid SET ${sets.join(', ')} RETURN AFTER;`, binds);
		return normReviewProposal(rows[0]);
	}
	assertProposalTransition(p.status, input.to);
	const sets: string[] = ['status = $to'];
	const binds: Record<string, unknown> = { rid: link(p.id), to: input.to };
	if (input.challenger !== undefined) {
		sets.push('challenger = $challenger');
		binds.challenger = link(input.challenger);
	}
	if (input.comparison !== undefined) {
		sets.push('comparison = $comparison');
		binds.comparison = input.comparison;
	}
	if (isProposalTerminal(input.to)) sets.push('decided_at = time::now()');
	const [rows] = await db.query<[Raw[]]>(`UPDATE $rid SET ${sets.join(', ')} RETURN AFTER;`, binds);
	return normReviewProposal(rows[0]);
}
