// TASK 1.2 — project + plan CRUD (ARCHITECTURE §2; DATA-MODEL §4.1; depends on: db).
//
// DB-backed CRUD for the project plan hierarchy: the `project` row + its embedded
// Project-Plan-v3 object, plus the four child plan tables (release / phase /
// feature / sprint) that link back to the project. The scanner module (1.1) owns
// the *upsert-from-detection* path; THIS module owns explicit create/read/update/
// delete + plan editing used by the UI/API.
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated.
// The ONLY interpolated tokens are record ids / table names, each validated at the
// chokepoint in db/validate.ts FIRST. Optional fields are OMITTED, never set to an
// explicit NULL (SurrealDB's option<T> rejects NULL — MEMORY-SPEC §6.1); MERGE is
// used for updates so untouched columns survive (mirrors scanner/registry.ts).
//
// Record links (`record<project>` / `option<record<release>>`) are bound as a
// `StringRecordId` value, which the SDK serializes as a true record link — a bare
// string in CONTENT would be rejected by the SCHEMAFULL `record<…>` field type.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId, assertTableName } from '../db/validate';

// ── Row shapes (what the DB persists/returns; SDK RecordId/Date coerced to JSON) ──

/** A persisted `project` row including the embedded Project-Plan-v3 object. */
export interface ProjectRow {
	id: string;
	slug: string;
	name: string;
	root_path: string;
	ecosystem: string[];
	build_tool?: string;
	test_command?: string;
	repo_url?: string;
	status: string;
	plan?: ProjectPlan;
}

/** Project-Plan-v3 embedded object (DATA-MODEL §4.1). All fields optional. */
export interface ProjectPlan {
	purpose?: string;
	long_term_vision?: string;
	role?: string;
	definition_of_done?: string;
}

export interface ReleaseRow {
	id: string;
	project: string;
	version: string;
	title?: string;
	status: string;
	shipped_at?: string;
}

export interface PhaseRow {
	id: string;
	project: string;
	release?: string;
	name: string;
	order: number;
	status: string;
}

export interface FeatureRow {
	id: string;
	project: string;
	release?: string;
	title: string;
	detail?: string;
	status: string;
}

export interface SprintRow {
	id: string;
	project: string;
	name: string;
	starts?: string;
	ends?: string;
	/** Sprint lifecycle (migration 0023_pm): "active" | "completed". */
	status?: string;
	completed_at?: string;
}

// ── Input shapes ──────────────────────────────────────────────────────────────

export interface CreateProjectInput {
	slug: string;
	name: string;
	root_path: string;
	ecosystem?: string[];
	build_tool?: string;
	test_command?: string;
	repo_url?: string;
	status?: string;
}

export type UpdateProjectInput = Partial<Omit<CreateProjectInput, 'slug'>>;

export interface CreateReleaseInput {
	project: string;
	version: string;
	title?: string;
	status?: string;
}
export type UpdateReleaseInput = Partial<Omit<CreateReleaseInput, 'project'>>;

export interface CreatePhaseInput {
	project: string;
	release?: string;
	name: string;
	order?: number;
	status?: string;
}
export type UpdatePhaseInput = Partial<Omit<CreatePhaseInput, 'project'>>;

export interface CreateFeatureInput {
	project: string;
	release?: string;
	title: string;
	detail?: string;
	status?: string;
}
export type UpdateFeatureInput = Partial<Omit<CreateFeatureInput, 'project'>>;

export interface CreateSprintInput {
	project: string;
	name: string;
	starts?: Date;
	ends?: Date;
}
export type UpdateSprintInput = Partial<Omit<CreateSprintInput, 'project'>>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/** Coerce the SDK's RecordId/StringRecordId shape on a field into a plain string. */
function str(v: unknown): string {
	return String(v);
}

/**
 * Validate a `table:id` link string at the D-016 chokepoint, then wrap it as a
 * `StringRecordId` so the SDK serializes it as a record link (not a plain string,
 * which a `record<…>` SCHEMAFULL field would reject).
 */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function normProject(row: ProjectRow & { id: unknown }): ProjectRow {
	return { ...row, id: str(row.id) };
}
function normRelease(row: ReleaseRow & { id: unknown; project: unknown }): ReleaseRow {
	return { ...row, id: str(row.id), project: str(row.project) };
}
function normPhase(
	row: PhaseRow & { id: unknown; project: unknown; release?: unknown }
): PhaseRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		release: row.release != null ? str(row.release) : undefined
	};
}
function normFeature(
	row: FeatureRow & { id: unknown; project: unknown; release?: unknown }
): FeatureRow {
	return {
		...row,
		id: str(row.id),
		project: str(row.project),
		release: row.release != null ? str(row.release) : undefined
	};
}
/** Coerce a SurrealDB datetime (Date / wrapped) to a plain ISO string, or omit it. */
function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (v instanceof Date) return v.toISOString();
	return String(v);
}
function normSprint(
	row: SprintRow & { id: unknown; project: unknown; starts?: unknown; ends?: unknown; completed_at?: unknown }
): SprintRow {
	const out: SprintRow = { ...(row as SprintRow), id: str(row.id), project: str(row.project) };
	// SurrealDB returns datetime fields as non-POJO Date-likes; coerce to ISO strings so the
	// row is SvelteKit-serializable (omit when absent — option<datetime> stays NONE, §6.1).
	const starts = isoOrUndef(row.starts);
	const ends = isoOrUndef(row.ends);
	const completed = isoOrUndef(row.completed_at);
	if (starts !== undefined) out.starts = starts;
	else delete out.starts;
	if (ends !== undefined) out.ends = ends;
	else delete out.ends;
	if (completed !== undefined) out.completed_at = completed;
	else delete out.completed_at;
	return out;
}

// ── Generic single-record fetch/delete (validated id, bound as $param) ─────────

async function selectById<R>(db: Db, id: string): Promise<R | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[R[]]>(`SELECT * FROM $rid;`, { rid });
	return rows.length ? rows[0] : null;
}

async function deleteById(db: Db, id: string): Promise<boolean> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[unknown[]]>(`DELETE $rid RETURN BEFORE;`, { rid });
	return rows.length > 0;
}

/** Shared child UPDATE…MERGE, returning the normalized row or null. */
async function updateMerge<R>(
	db: Db,
	id: string,
	content: Record<string, unknown>,
	norm: (row: R & { id: unknown }) => R
): Promise<R | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[(R & { id: unknown })[]]>(
		`UPDATE $rid MERGE $content RETURN AFTER;`,
		{ rid, content }
	);
	return rows.length ? norm(rows[0]) : null;
}

/** CREATE a child row in a validated table with a generated id; bind all values. */
async function createChild<R>(
	db: Db,
	table: string,
	content: Record<string, unknown>
): Promise<R> {
	const t = assertTableName(table);
	const [rows] = await db.query<[R[]]>(`CREATE type::table($t) CONTENT $content RETURN AFTER;`, {
		t,
		content
	});
	return rows[0];
}

/** SELECT all rows in a validated table whose `project` link matches `projectId`. */
async function listByProject<R>(db: Db, table: string, projectId: string): Promise<R[]> {
	const t = assertTableName(table);
	const project = link(projectId);
	const [rows] = await db.query<[R[]]>(
		`SELECT * FROM type::table($t) WHERE project = $project;`,
		{ t, project }
	);
	return rows;
}

// ── Project ───────────────────────────────────────────────────────────────────

/**
 * Create a `project:<slug>` row. The slug becomes the record id (DATA-MODEL §3,
 * meaningful ids where natural) and is validated through the D-016 chokepoint
 * before it can name the record. Optional fields are omitted, not nulled (§6.1).
 */
export async function createProject(db: Db, input: CreateProjectInput): Promise<ProjectRow> {
	const rid = new StringRecordId(assertRecordId(`project:${input.slug}`));
	const content = omitUndefined({
		slug: input.slug,
		name: input.name,
		root_path: input.root_path,
		ecosystem: input.ecosystem,
		build_tool: input.build_tool,
		test_command: input.test_command,
		repo_url: input.repo_url,
		status: input.status
	});
	const [rows] = await db.query<[(ProjectRow & { id: unknown })[]]>(
		`CREATE $rid CONTENT $content RETURN AFTER;`,
		{ rid, content }
	);
	return normProject(rows[0]);
}

export async function getProject(db: Db, id: string): Promise<ProjectRow | null> {
	const row = await selectById<ProjectRow & { id: unknown }>(db, id);
	return row ? normProject(row) : null;
}

export async function listProjects(db: Db): Promise<ProjectRow[]> {
	const [rows] = await db.query<[(ProjectRow & { id: unknown })[]]>(
		`SELECT * FROM project ORDER BY name;`
	);
	return rows.map(normProject);
}

/**
 * Update mutable project columns (slug/id are immutable). MERGE preserves
 * untouched columns + the `plan` object; touches `updated_at` on every write.
 */
export async function updateProject(
	db: Db,
	id: string,
	patch: UpdateProjectInput
): Promise<ProjectRow | null> {
	const content = omitUndefined({ ...patch, updated_at: new Date() });
	return updateMerge<ProjectRow>(db, id, content, normProject);
}

/**
 * Patch the embedded Project-Plan-v3 object. MERGE on `plan` so a partial update
 * keeps previously-set plan keys; absent keys are omitted (never NULL, §6.1).
 */
export async function updateProjectPlan(
	db: Db,
	id: string,
	plan: ProjectPlan
): Promise<ProjectRow | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const planPatch = omitUndefined({ ...plan });
	const [rows] = await db.query<[(ProjectRow & { id: unknown })[]]>(
		`UPDATE $rid MERGE { plan: $plan, updated_at: $now } RETURN AFTER;`,
		{ rid, plan: planPatch, now: new Date() }
	);
	return rows.length ? normProject(rows[0]) : null;
}

export async function deleteProject(db: Db, id: string): Promise<boolean> {
	return deleteById(db, id);
}

// ── Release ─────────────────────────────────────────────────────────────────

export async function createRelease(db: Db, input: CreateReleaseInput): Promise<ReleaseRow> {
	const content = omitUndefined({
		project: link(input.project),
		version: input.version,
		title: input.title,
		status: input.status
	});
	const row = await createChild<ReleaseRow & { id: unknown; project: unknown }>(
		db,
		'release',
		content
	);
	return normRelease(row);
}

export async function getRelease(db: Db, id: string): Promise<ReleaseRow | null> {
	const row = await selectById<ReleaseRow & { id: unknown; project: unknown }>(db, id);
	return row ? normRelease(row) : null;
}

export async function listReleases(db: Db, projectId: string): Promise<ReleaseRow[]> {
	const rows = await listByProject<ReleaseRow & { id: unknown; project: unknown }>(
		db,
		'release',
		projectId
	);
	return rows.map(normRelease);
}

export async function updateRelease(
	db: Db,
	id: string,
	patch: UpdateReleaseInput
): Promise<ReleaseRow | null> {
	return updateMerge<ReleaseRow>(db, id, omitUndefined({ ...patch }), normRelease);
}

export async function deleteRelease(db: Db, id: string): Promise<boolean> {
	return deleteById(db, id);
}

// ── Phase ─────────────────────────────────────────────────────────────────────

export async function createPhase(db: Db, input: CreatePhaseInput): Promise<PhaseRow> {
	const content = omitUndefined({
		project: link(input.project),
		release: input.release ? link(input.release) : undefined,
		name: input.name,
		order: input.order,
		status: input.status
	});
	const row = await createChild<PhaseRow & { id: unknown; project: unknown; release?: unknown }>(
		db,
		'phase',
		content
	);
	return normPhase(row);
}

export async function getPhase(db: Db, id: string): Promise<PhaseRow | null> {
	const row = await selectById<PhaseRow & { id: unknown; project: unknown; release?: unknown }>(
		db,
		id
	);
	return row ? normPhase(row) : null;
}

export async function listPhases(db: Db, projectId: string): Promise<PhaseRow[]> {
	const rows = await listByProject<
		PhaseRow & { id: unknown; project: unknown; release?: unknown }
	>(db, 'phase', projectId);
	return rows.map(normPhase);
}

export async function updatePhase(
	db: Db,
	id: string,
	patch: UpdatePhaseInput
): Promise<PhaseRow | null> {
	const content = omitUndefined({
		...patch,
		release: patch.release ? link(patch.release) : undefined
	});
	return updateMerge<PhaseRow>(db, id, content, normPhase);
}

export async function deletePhase(db: Db, id: string): Promise<boolean> {
	return deleteById(db, id);
}

// ── Feature ─────────────────────────────────────────────────────────────────

export async function createFeature(db: Db, input: CreateFeatureInput): Promise<FeatureRow> {
	const content = omitUndefined({
		project: link(input.project),
		release: input.release ? link(input.release) : undefined,
		title: input.title,
		detail: input.detail,
		status: input.status
	});
	const row = await createChild<
		FeatureRow & { id: unknown; project: unknown; release?: unknown }
	>(db, 'feature', content);
	return normFeature(row);
}

export async function getFeature(db: Db, id: string): Promise<FeatureRow | null> {
	const row = await selectById<FeatureRow & { id: unknown; project: unknown; release?: unknown }>(
		db,
		id
	);
	return row ? normFeature(row) : null;
}

export async function listFeatures(db: Db, projectId: string): Promise<FeatureRow[]> {
	const rows = await listByProject<
		FeatureRow & { id: unknown; project: unknown; release?: unknown }
	>(db, 'feature', projectId);
	return rows.map(normFeature);
}

export async function updateFeature(
	db: Db,
	id: string,
	patch: UpdateFeatureInput
): Promise<FeatureRow | null> {
	const content = omitUndefined({
		...patch,
		release: patch.release ? link(patch.release) : undefined
	});
	return updateMerge<FeatureRow>(db, id, content, normFeature);
}

export async function deleteFeature(db: Db, id: string): Promise<boolean> {
	return deleteById(db, id);
}

// ── Sprint ──────────────────────────────────────────────────────────────────

export async function createSprint(db: Db, input: CreateSprintInput): Promise<SprintRow> {
	const content = omitUndefined({
		project: link(input.project),
		name: input.name,
		starts: input.starts,
		ends: input.ends
	});
	const row = await createChild<SprintRow & { id: unknown; project: unknown }>(
		db,
		'sprint',
		content
	);
	return normSprint(row);
}

export async function getSprint(db: Db, id: string): Promise<SprintRow | null> {
	const row = await selectById<SprintRow & { id: unknown; project: unknown }>(db, id);
	return row ? normSprint(row) : null;
}

export async function listSprints(db: Db, projectId: string): Promise<SprintRow[]> {
	const rows = await listByProject<SprintRow & { id: unknown; project: unknown }>(
		db,
		'sprint',
		projectId
	);
	return rows.map(normSprint);
}

export async function updateSprint(
	db: Db,
	id: string,
	patch: UpdateSprintInput
): Promise<SprintRow | null> {
	return updateMerge<SprintRow>(db, id, omitUndefined({ ...patch }), normSprint);
}

export async function deleteSprint(db: Db, id: string): Promise<boolean> {
	return deleteById(db, id);
}
