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

/**
 * The canonical `project.status` vocabulary (DATA-MODEL §4.1 — the schema ASSERTs
 * $value IN this set). The settings boundary validates against this list so an invalid
 * status fails honestly at the app edge instead of relying on the DB ASSERT's raw error.
 */
export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

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
	/**
	 * Create-with-AI materialization state (migration 0049, CA-H2). NONE/absent = not created via
	 * Create-with-AI (or pre-CA-H2) — treat as complete. 'complete' = all writers landed. 'incomplete'
	 * = registered + scaffolded but a post-register writer threw (honestly marked, NOT a wedged slug).
	 */
	create_status?: string;
	plan?: ProjectPlan;
	/**
	 * OPTIONAL, operator-set live game-mod verification harness descriptor (GAME-VERIFY-SPEC,
	 * migration 0068). Absent/NONE = capability disabled (like `test_command`). Stored as a
	 * FLEXIBLE option<object>; the runner/orchestrator validate it via {@link parseGameVerifyConfig}
	 * (a malformed config disables the harness rather than throwing). Passed through normProject
	 * as a plain POJO — the descriptor holds no datetime/RecordId so no F-013 coercion is needed.
	 */
	game_verify?: GameVerifyConfig;
}

/** Project-Plan-v3 embedded object (DATA-MODEL §4.1). All fields optional. */
export interface ProjectPlan {
	purpose?: string;
	long_term_vision?: string;
	role?: string;
	definition_of_done?: string;
}

// ── GAME-VERIFY harness descriptor (GAME-VERIFY-SPEC) ────────────────────────────
//
// The OPTIONAL, operator-set config that opts a project into live game-mod verification
// (deploy built artifact → launch the game → poll its log for a ready signal → structured
// verdict → MANDATORY kill → feed back to the build loop). Persisted as project.game_verify
// (FLEXIBLE option<object>, schema m0068); absent ⇒ capability DISABLED, like `test_command`.
// This module owns the TYPE + the validator; the runner (GAME-VERIFY GV-2) and the
// orchestrator step import them from here (post-task.ts / orchestrator.ts already import this
// module, so it is the established shared home for project/orchestrator config types).
//
// SHAPE NOTE: launch_command (and the optional pre_launch/post_kill) is a steam:// (or any)
// string OR an { exe, args } object. deploy/log paths point OUTSIDE the project root by design —
// they are explicit, operator-configured, named paths (the game install), not arbitrary FS.

/** A launch/exec spec: a bare command string (e.g. `steam://rungameid/<appid>`) or an exe+args. */
export type GameVerifyLaunch = string | { exe: string; args?: string[] };

/** One deploy hop: copy a built-artifact glob to an absolute target path under the game install. */
export interface GameVerifyDeploy {
	source: string;
	target: string;
}

/** The operator-set game-verify harness descriptor (project.game_verify). */
export interface GameVerifyConfig {
	/** How to launch the game: a `steam://…` (or other) command string, or `{ exe, args }`. */
	launch_command: GameVerifyLaunch;
	/** Process image name for the MANDATORY kill (e.g. `ROUNDS.exe`). */
	process_name: string;
	/** Absolute path of the log to poll/read (e.g. `<game>/BepInEx/LogOutput.log`). */
	log_path: string;
	/** Regex (source string) signalling load finished (e.g. `Chainloader startup complete`). */
	ready_pattern: string;
	/** Optional artifact deploy hops run before launch. */
	deploy?: GameVerifyDeploy[];
	/** Optional regexes whose matches count as success signals (load line). */
	success_patterns?: string[];
	/** Optional regexes whose matches count as errors (NRE / MissingMethod / …). */
	error_patterns?: string[];
	/** Wall-clock cap for the poll (default applied by the runner; spec default ~120000). */
	timeout_ms?: number;
	/** How many log lines to capture after each error class (stack-trace context). */
	stack_capture_lines?: number;
	/** Optional cleanup/setup run before launch. */
	pre_launch?: GameVerifyLaunch;
	/** Optional cleanup run after the mandatory kill. */
	post_kill?: GameVerifyLaunch;
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0;
}

/** A valid launch spec: a non-empty string, or `{ exe: <non-empty string>, args?: string[] }`. */
function parseLaunch(v: unknown): GameVerifyLaunch | null {
	if (isNonEmptyString(v)) return v;
	if (v != null && typeof v === 'object' && !Array.isArray(v)) {
		const o = v as Record<string, unknown>;
		if (!isNonEmptyString(o.exe)) return null;
		if (o.args !== undefined) {
			if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string')) return null;
			return { exe: o.exe, args: o.args as string[] };
		}
		return { exe: o.exe };
	}
	return null;
}

function parseStringArray(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null;
	if (!v.every((s) => typeof s === 'string')) return null;
	return v as string[];
}

/**
 * Validate a raw `project.game_verify` value into a {@link GameVerifyConfig}, or `null` when the
 * block is absent/malformed (⇒ capability disabled). BOTH the runner and the orchestrator call
 * this, so a malformed operator config DISABLES the harness instead of throwing mid-task (F-008 —
 * honest off, never a fabricated launch). Required: launch_command, process_name, log_path,
 * ready_pattern. Optional fields are validated when present and dropped when malformed-but-absent.
 *
 * Shadow paths (all return null, never throw): nil/non-object input; empty-string required field;
 * wrong-typed required field; a deploy entry missing source/target; a non-string-array pattern list.
 */
export function parseGameVerifyConfig(raw: unknown): GameVerifyConfig | null {
	if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;

	const launch_command = parseLaunch(r.launch_command);
	if (launch_command === null) return null;
	if (!isNonEmptyString(r.process_name)) return null;
	if (!isNonEmptyString(r.log_path)) return null;
	if (!isNonEmptyString(r.ready_pattern)) return null;

	const cfg: GameVerifyConfig = {
		launch_command,
		process_name: r.process_name,
		log_path: r.log_path,
		ready_pattern: r.ready_pattern
	};

	if (r.deploy !== undefined) {
		if (!Array.isArray(r.deploy)) return null;
		const deploy: GameVerifyDeploy[] = [];
		for (const d of r.deploy) {
			if (d == null || typeof d !== 'object' || Array.isArray(d)) return null;
			const dd = d as Record<string, unknown>;
			if (!isNonEmptyString(dd.source) || !isNonEmptyString(dd.target)) return null;
			deploy.push({ source: dd.source, target: dd.target });
		}
		cfg.deploy = deploy;
	}

	if (r.success_patterns !== undefined) {
		const p = parseStringArray(r.success_patterns);
		if (p === null) return null;
		cfg.success_patterns = p;
	}
	if (r.error_patterns !== undefined) {
		const p = parseStringArray(r.error_patterns);
		if (p === null) return null;
		cfg.error_patterns = p;
	}
	if (r.timeout_ms !== undefined) {
		if (typeof r.timeout_ms !== 'number' || !Number.isFinite(r.timeout_ms) || r.timeout_ms <= 0)
			return null;
		cfg.timeout_ms = r.timeout_ms;
	}
	if (r.stack_capture_lines !== undefined) {
		if (
			typeof r.stack_capture_lines !== 'number' ||
			!Number.isInteger(r.stack_capture_lines) ||
			r.stack_capture_lines < 0
		)
			return null;
		cfg.stack_capture_lines = r.stack_capture_lines;
	}
	if (r.pre_launch !== undefined) {
		const p = parseLaunch(r.pre_launch);
		if (p === null) return null;
		cfg.pre_launch = p;
	}
	if (r.post_kill !== undefined) {
		const p = parseLaunch(r.post_kill);
		if (p === null) return null;
		cfg.post_kill = p;
	}

	return cfg;
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
	/**
	 * OPTIONAL, operator-set game-verify harness descriptor (GAME-VERIFY-SPEC). Set via CONTENT on
	 * create. A config descriptor has REPLACE (not deep-merge) semantics: updateProject SETs this
	 * object whole when present, so a partial edit (shorter `deploy`, changed patterns) leaves NO
	 * stale sub-keys from the prior descriptor. Absent in a patch ⇒ left untouched (no-op). Absent on
	 * create ⇒ omitted (option<object> stays NONE, §6.1) ⇒ capability disabled.
	 */
	game_verify?: GameVerifyConfig;
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
	// Coerce SurrealDB datetime fields (created_at/updated_at) to plain ISO strings — they are
	// non-POJO Date-likes that break SvelteKit's load serializer if forwarded raw (F-013). The
	// load forwards only a field subset today, but the normalized row must be serializable.
	const out = { ...row, id: str(row.id) } as ProjectRow & {
		created_at?: unknown;
		updated_at?: unknown;
	};
	if (out.created_at != null) out.created_at = isoOrUndef(out.created_at);
	else delete out.created_at;
	if (out.updated_at != null) out.updated_at = isoOrUndef(out.updated_at);
	else delete out.updated_at;
	// game_verify (FLEXIBLE option<object>, m0068): pass the descriptor through as the plain POJO the
	// SDK returns (no datetime/RecordId inside ⇒ no F-013 coercion). Absent/NONE ⇒ OMIT the key so the
	// capability reads as disabled (F-008 — never a fabricated/empty config). Validation is deferred to
	// parseGameVerifyConfig at the runner/orchestrator boundary, not here (the raw row stays faithful).
	if (out.game_verify == null) delete out.game_verify;
	return out as ProjectRow;
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
		status: input.status,
		game_verify: input.game_verify
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
 *
 * `game_verify` is special-cased: it is a config DESCRIPTOR with replace (not
 * deep-merge) semantics. MERGE would recursively merge the nested object, so a
 * partial edit (a shorter `deploy` array, different patterns) would leave STALE
 * sub-keys from the prior descriptor. When the patch includes `game_verify` we
 * therefore SET the whole field (full overwrite) in a second statement, keeping
 * MERGE semantics for every other scalar column. An absent `game_verify` in the
 * patch is a no-op (the field is never wiped when it is not being edited).
 */
export async function updateProject(
	db: Db,
	id: string,
	patch: UpdateProjectInput
): Promise<ProjectRow | null> {
	const { game_verify, ...rest } = patch;
	const content = omitUndefined({ ...rest, updated_at: new Date() });
	if (game_verify === undefined) {
		return updateMerge<ProjectRow>(db, id, content, normProject);
	}
	// MERGE the scalar patch, then SET game_verify whole (replace, not deep-merge). Two statements
	// in one query: the first MERGE updates untouched-preserving columns + updated_at; the second
	// `SET game_verify = $gv` (`=`, not `+=`) overwrites the entire object, dropping any old sub-keys.
	const rid = new StringRecordId(assertRecordId(id));
	const [, after] = await db.query<[unknown, (ProjectRow & { id: unknown })[]]>(
		`UPDATE $rid MERGE $content; UPDATE $rid SET game_verify = $gv RETURN AFTER;`,
		{ rid, content, gv: game_verify }
	);
	return after.length ? normProject(after[0]) : null;
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
