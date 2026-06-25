// TASK 2.4 — analytics: the agent fleet read model for /agents (UI-SPEC §198–200).
//
// /agents is the tier-centric usage LENS. Two read models, both from REAL rows (F-008):
//   • POOL — tier/role DEFINITIONS from `agent_slot` (a config/stat mirror, NOT live
//     allocation). We surface name/tier/role; we DO NOT read agent_slot.busy for
//     liveness (UI-SPEC §199 explicitly forbids it — it is not the source of truth).
//   • FLEET — running + recent `session` rows. Liveness comes from these (status =
//     running) — the same data the live AgentFleetGrid renders, never agent_slot.busy.
//
// These are plain READS off the DB singleton — NOT a second live query (§2.11). The page
// stays live by re-invalidating on the `session` watcher that hooks.server already runs.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A pool slot DEFINITION (config mirror — not live allocation). */
export interface PoolSlot {
	id: string;
	name: string;
	tier: string;
	role: string;
}

/** One running/recent session row for the fleet grid. */
export interface FleetSession {
	id: string;
	status: string;
	provider: string;
	modelId: string;
	tier: string | null;
	projectId: string | null;
	taskId: string | null;
	/**
	 * The session.kind discriminator (m0026/m0033: chat/task/review/release/discussion/interview),
	 * or null on a legacy row that predates the field. Drives the activity panel's "what kind of
	 * work is this?" label (a dev task vs a validation panel vs a PM lifecycle drive). Honest —
	 * an absent/unknown kind surfaces as a neutral label, never a fabricated one (F-008).
	 */
	kind: string | null;
	/** The workforce role slug the session ran AS (role.slug — pm / hr-recruiter / …), or null
	 *  for a session with no role link. The activity label combines it with `kind`. */
	roleSlug: string | null;
	/** The workforce role display name (role.name), or null. */
	roleName: string | null;
	startedAt: string;
	endedAt: string | null;
	/**
	 * The honest terminal note (session.note, m0027) — WHY a failed session failed, already
	 * D-026-SCREENED at the launch write (a secret in the reason was redacted before it landed).
	 * NULL on a clean/running session (option<string> stays NONE — never a fabricated reason, F-008).
	 * The fleet surfaces it on a `status === 'failed'` row so a failed spawn explains itself
	 * instead of showing a dead row with no reason (the live 6-ROUNDS observability gap).
	 */
	note: string | null;
}

/**
 * A fleet session with its project LABEL resolved — the cross-project fleet row for the
 * portfolio-wide session control surface on /claude-code (TASK 9.3). Same liveness rule
 * (`session.status`, never `agent_slot.busy`), with the owning project's name/slug joined
 * so the operator can see WHICH project each running session belongs to. A session with
 * no project link (a bare chat) carries `projectName: null` — an honest "no project", not
 * a fabricated label (F-008).
 */
export interface FleetSessionXP extends FleetSession {
	projectName: string | null;
	projectSlug: string | null;
	ccSessionId: string | null;
	/**
	 * WI-2 (WORKSPACE-ISOLATION-SPEC) — the per-session git worktree this WRITE session ran in,
	 * and the branch it committed on (session.worktree_path / worktree_branch, m0059). NULL for a
	 * READ-class session (shared project root — the option fields stay NONE), never a fabricated
	 * path (F-008). Lets the fleet UI show the isolated tree/branch honestly + WI-3 find the branch.
	 */
	worktreePath: string | null;
	worktreeBranch: string | null;
	/**
	 * UO-1 (USAGE-OBSERVABILITY-SPEC) — the GRANTED capability set persisted at spawn
	 * (session.granted_skills/agents/mcp/reserved + tool_allow + granted_intent, m0065). This is the
	 * ACTUAL composed/effective grant the session was launched with (NOT the static orchestration
	 * bundle — F-008), so UO-3 can answer "what was this session ALLOWED to wield?" and distinguish
	 * GRANTED from USED. A LEGACY row (predates m0065) carries NONE on every field → `granted: null`,
	 * the honest "not recorded" (never a fabricated empty grant). A session that WAS recorded but
	 * granted nothing in a dimension simply carries an empty array there. Capability/tool ids are
	 * opaque (D-026), already screened at the launch write.
	 */
	granted: GrantedCapabilities | null;
}

/**
 * UO-1 — the persisted granted-capability read model for ONE session. Mirrors the persisted
 * fields (m0065): the three catalog dimensions, the reserved runtime grants in effect (e.g.
 * 'peer-send'), the allow-listed tool names, and the resolved intent. Each list defaults to []
 * (a recorded-but-empty dimension), `intent` to null when absent. The WHOLE object is null on a
 * legacy/never-recorded row — the caller distinguishes "not recorded" (null) from "recorded,
 * empty" ([]). Honest: no fabricated grant (F-008).
 */
export interface GrantedCapabilities {
	skills: string[];
	agents: string[];
	mcp: string[];
	reserved: string[];
	toolAllow: string[];
	intent: string | null;
}

/** One scope (global / a project) that defines an agent type — the honest "where it lives". */
export interface AgentCatalogScope {
	/** 'global' or 'project'. */
	kind: string;
	/** The owning project's record id, or null for global / unlinked scopes. */
	projectId: string | null;
}

/**
 * One agent-TYPE catalog entry (UI-SPEC §198 "catalog of available agents"). Aggregated from
 * the cc_agent MIRROR (cc-config sync, 1.8/7.3): the same agent name may be defined in more
 * than one scope (global + a project), so entries are keyed by name and carry every scope that
 * defines it. `description`/`category` come from the agent file's frontmatter; capability-bundle
 * membership (which orchestration intents may provision this agent, D-036) is overlaid by the
 * loader from orchestration.yaml — it is NOT a session-attribution claim (the data model does
 * not record which cc_agent drove a given session, so we never fabricate per-session usage; F-008).
 */
export interface AgentCatalogEntry {
	/** The agent type name (cc_agent.name) — the catalog key. */
	name: string;
	/** Role / one-line description from the agent file frontmatter, or null if none. */
	description: string | null;
	/** Category from frontmatter (e.g. "swarm", "github"), or null. */
	category: string | null;
	/** Every scope (global / project) whose .claude defines this agent type. */
	scopes: AgentCatalogScope[];
}

/**
 * Read the agent-TYPE catalog from the cc_agent MIRROR (UI-SPEC §198). Every row is a REAL
 * synced agent definition (F-008) — no fabricated agents. Rows are grouped by `name` so an
 * agent defined in both global and a project scope is ONE catalog entry carrying both scopes
 * (the honest "where it's defined"). Sorted by name. Pure read of the mirror — no disk, no spawn.
 */
export async function listAgentCatalog(db: Db): Promise<AgentCatalogEntry[]> {
	// Join the agent's scope so each row carries its scope kind + owning project id. The mirror
	// is small (catalog), so the FETCH is cheap and there is no N+1.
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT name, description, category,
		        scope.kind AS scope_kind, scope.project AS scope_project
		   FROM cc_agent
		   ORDER BY name
		   FETCH scope;`
	);
	const byName = new Map<string, AgentCatalogEntry>();
	for (const r of rows ?? []) {
		const name = String(r.name ?? '').trim();
		if (!name) continue;
		const entry = byName.get(name) ?? {
			name,
			description: r.description == null ? null : String(r.description),
			category: r.category == null ? null : String(r.category),
			scopes: [] as AgentCatalogScope[]
		};
		// First non-null description/category wins (an entry seen in a later scope keeps the
		// first meaningful metadata rather than clobbering it with a null).
		if (entry.description == null && r.description != null) entry.description = String(r.description);
		if (entry.category == null && r.category != null) entry.category = String(r.category);
		entry.scopes.push({
			kind: String(r.scope_kind ?? 'unknown'),
			projectId: r.scope_project == null ? null : String(r.scope_project)
		});
		byName.set(name, entry);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the pool slot definitions (config/stat mirror, UI-SPEC §199). */
export async function listPoolSlots(db: Db): Promise<PoolSlot[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, name, tier, role FROM agent_slot ORDER BY tier, role;`
	);
	return (rows ?? []).map((r) => ({
		id: String(r.id),
		name: String(r.name ?? ''),
		tier: String(r.tier ?? 'unknown'),
		role: String(r.role ?? '')
	}));
}

/**
 * Coerce a persisted datetime to an ISO string, or '' when absent/unparseable (the honest-absent
 * sentinel the time-format util turns into '—'). The SurrealDB 2.x SDK returns datetime columns as a
 * non-POJO `DateTime` instance (NOT a JS Date, NOT a string) — the prior `instanceof Date`/`typeof
 * string` form fell through it to '', so the activity panel + session list rendered '—' for the start
 * AND elapsed of EVERY live session (CC-2 defect). `String(at)` yields the ISO text for a SurrealDB
 * DateTime, a JS Date, or a string alike; we then round-trip through `Date` so a non-date string still
 * collapses to '' (F-013 — never return a raw SDK datetime, never str(undefined)). This mirrors the
 * working `isoOrNull` in projects/[id]/+page.server.ts that already drives the task-board card.
 */
function iso(at: unknown): string {
	if (at == null) return '';
	if (at instanceof Date) return at.toISOString();
	const t = new Date(String(at)).getTime();
	return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

/** Coerce a persisted granted-id column to a clean string[] (raw SDK arrays may carry non-strings).
 *  An absent/NONE column → [] (the dimension was recorded-but-empty or the row predates the field;
 *  the OUTER null vs the inner [] is decided by {@link normGranted}). Never returns null itself. */
function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * UO-1 — normalize the persisted granted-capability columns into {@link GrantedCapabilities} or
 * null. A row where EVERY granted field is NONE/absent (a legacy row predating m0065, OR a session
 * that recorded nothing) reads as null — the honest "not recorded", never a fabricated empty grant
 * (F-008/F-013). When ANY granted field is present, the object is returned with each dimension
 * coerced ([] when that one dimension is absent). The intent is coerced to a string or null (never
 * str(undefined) — F-013 class).
 */
function normGranted(r: Record<string, unknown>): GrantedCapabilities | null {
	const present =
		r.granted_skills != null ||
		r.granted_agents != null ||
		r.granted_mcp != null ||
		r.granted_reserved != null ||
		r.tool_allow != null ||
		r.granted_intent != null;
	if (!present) return null;
	return {
		skills: strList(r.granted_skills),
		agents: strList(r.granted_agents),
		mcp: strList(r.granted_mcp),
		reserved: strList(r.granted_reserved),
		toolAllow: strList(r.tool_allow),
		intent: r.granted_intent == null ? null : String(r.granted_intent)
	};
}

/**
 * Read the live fleet: running sessions first (the active grid), then the most recent
 * finished ones for context. Liveness = `session.status`, never `agent_slot.busy` (§199).
 * `limit` bounds the recent tail.
 */
export async function listFleet(db: Db, limit = 30): Promise<FleetSession[]> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, kind, model, project, task, note, started_at, ended_at,
		        role.slug AS role_slug, role.name AS role_name
		   FROM session
		   ORDER BY started_at DESC LIMIT $lim
		   FETCH role;`,
		{ lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId: r.project ? String(r.project) : null,
			taskId: r.task ? String(r.task) : null,
			// Honest absent kind/role (option/legacy) → null, never a fabricated label (F-008).
			kind: r.kind == null ? null : String(r.kind),
			roleSlug: r.role_slug == null ? null : String(r.role_slug),
			roleName: r.role_name == null ? null : String(r.role_name),
			// Honest absent note (option<string> NONE) → null, never str(undefined) (F-013 class).
			note: r.note == null ? null : String(r.note),
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	// Running sessions float to the top (active grid), recent finished below.
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}

/**
 * Read the fleet scoped to ONE project — the same shape/ordering as {@link listFleet}
 * but only sessions whose `project` link matches. Used by the project detail page's
 * Sessions tab. Liveness = `session.status`, never `agent_slot.busy` (§199); every row
 * is a REAL session (F-008). The `project` id is validated/bound as a record link at the
 * D-016 chokepoint by the caller-supplied StringRecordId.
 */
export async function listFleetByProject(
	db: Db,
	projectId: string,
	limit = 30
): Promise<FleetSession[]> {
	const project = new StringRecordId(assertRecordId(projectId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, kind, model, project, task, note, started_at, ended_at,
		        role.slug AS role_slug, role.name AS role_name
		   FROM session
		   WHERE project = $project
		   ORDER BY started_at DESC LIMIT $lim
		   FETCH role;`,
		{ project, lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId: r.project ? String(r.project) : null,
			taskId: r.task ? String(r.task) : null,
			// Honest absent kind/role (option/legacy) → null, never a fabricated label (F-008).
			kind: r.kind == null ? null : String(r.kind),
			roleSlug: r.role_slug == null ? null : String(r.role_slug),
			roleName: r.role_name == null ? null : String(r.role_name),
			// Honest absent note (option<string> NONE) → null, never str(undefined) (F-013 class).
			note: r.note == null ? null : String(r.note),
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}

/**
 * Read the LIVE cross-project fleet for the portfolio-wide session-control surface
 * (TASK 9.3, /claude-code). Every running + recent `session` row ACROSS ALL projects, with
 * the owning project's name/slug joined via FETCH so each row carries its project LABEL.
 *
 * Liveness is `session.status` (UI-SPEC §199 — never `agent_slot.busy`), every row is a
 * REAL session (F-008): a session with no `project` link surfaces `projectName: null`
 * (an honest "no project", not an invented label). Running sessions float to the top
 * (the active fleet); the most recent finished ones follow for context, bounded by `limit`.
 */
export async function listFleetAcrossProjects(db: Db, limit = 40): Promise<FleetSessionXP[]> {
	// FETCH the linked project so name/slug come back inline — one query, no N+1. The
	// explicit `project_id` alias is the stable source for the raw id even after FETCH
	// expands `project` into the full object.
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, kind, model, project, task, note, cc_session_id, started_at, ended_at,
		        worktree_path, worktree_branch,
		        granted_skills, granted_agents, granted_mcp, granted_reserved, tool_allow, granted_intent,
		        project.id AS project_id, project.name AS project_name, project.slug AS project_slug,
		        role.slug AS role_slug, role.name AS role_name
		   FROM session
		   ORDER BY started_at DESC LIMIT $lim
		   FETCH project, role;`,
		{ lim: limit }
	);
	const sessions = (rows ?? []).map((r) => {
		const m = (r.model ?? {}) as Record<string, unknown>;
		const projectId = r.project_id ? String(r.project_id) : r.project ? String(r.project) : null;
		return {
			id: String(r.id),
			status: String(r.status ?? 'running'),
			provider: String(m.provider ?? 'unknown'),
			modelId: String(m.model_id ?? 'unknown'),
			tier: (m.tier as string) ?? null,
			projectId,
			projectName: r.project_name ? String(r.project_name) : null,
			projectSlug: r.project_slug ? String(r.project_slug) : null,
			taskId: r.task ? String(r.task) : null,
			// Honest absent kind/role → null, never a fabricated label (F-008).
			kind: r.kind == null ? null : String(r.kind),
			roleSlug: r.role_slug == null ? null : String(r.role_slug),
			roleName: r.role_name == null ? null : String(r.role_name),
			// Honest absent note (option<string> NONE) → null, never str(undefined) (F-013 class).
			note: r.note == null ? null : String(r.note),
			ccSessionId: r.cc_session_id ? String(r.cc_session_id) : null,
			// WI-2: honest worktree provenance — absent (READ session / option NONE) → null (F-008).
			worktreePath: r.worktree_path == null ? null : String(r.worktree_path),
			worktreeBranch: r.worktree_branch == null ? null : String(r.worktree_branch),
			// UO-1: honest granted set — legacy/never-recorded row → null, never a fabricated grant (F-008).
			granted: normGranted(r),
			startedAt: iso(r.started_at),
			endedAt: r.ended_at ? iso(r.ended_at) : null
		};
	});
	return sessions.sort((a, b) => {
		const ar = a.status === 'running' ? 0 : 1;
		const br = b.status === 'running' ? 0 : 1;
		if (ar !== br) return ar - br;
		return b.startedAt.localeCompare(a.startedAt);
	});
}

/**
 * Read ONE session's fleet metadata (status/model/project label) for the transcript-panel
 * header — the same projection as listFleetAcrossProjects, scoped to a single id so a session
 * OLDER than the recent-40 fleet window still gets an honest header. Returns null for an
 * unknown session (the panel renders the transcript with id-only meta, never a fabricated row,
 * F-008). The id flows through assertRecordId and binds as a StringRecordId (D-016 chokepoint);
 * no value is interpolated into the query.
 */
export async function getFleetSession(db: Db, sessionId: string): Promise<FleetSessionXP | null> {
	const sid = new StringRecordId(assertRecordId(sessionId));
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT id, status, kind, model, project, task, note, cc_session_id, started_at, ended_at,
		        worktree_path, worktree_branch,
		        granted_skills, granted_agents, granted_mcp, granted_reserved, tool_allow, granted_intent,
		        project.id AS project_id, project.name AS project_name, project.slug AS project_slug,
		        role.slug AS role_slug, role.name AS role_name
		   FROM session WHERE id = $sid LIMIT 1
		   FETCH project, role;`,
		{ sid }
	);
	const r = (rows ?? [])[0];
	if (!r) return null;
	const m = (r.model ?? {}) as Record<string, unknown>;
	const projectId = r.project_id ? String(r.project_id) : r.project ? String(r.project) : null;
	return {
		id: String(r.id),
		status: String(r.status ?? 'running'),
		provider: String(m.provider ?? 'unknown'),
		modelId: String(m.model_id ?? 'unknown'),
		tier: (m.tier as string) ?? null,
		projectId,
		projectName: r.project_name ? String(r.project_name) : null,
		projectSlug: r.project_slug ? String(r.project_slug) : null,
		taskId: r.task ? String(r.task) : null,
		// Honest absent kind/role → null, never a fabricated label (F-008).
		kind: r.kind == null ? null : String(r.kind),
		roleSlug: r.role_slug == null ? null : String(r.role_slug),
		roleName: r.role_name == null ? null : String(r.role_name),
		// Honest absent note (option<string> NONE) → null, never str(undefined) (F-013 class).
		note: r.note == null ? null : String(r.note),
		ccSessionId: r.cc_session_id ? String(r.cc_session_id) : null,
		// WI-2: honest worktree provenance — absent (READ session / option NONE) → null (F-008).
		worktreePath: r.worktree_path == null ? null : String(r.worktree_path),
		worktreeBranch: r.worktree_branch == null ? null : String(r.worktree_branch),
		// UO-1: honest granted set — legacy/never-recorded row → null, never a fabricated grant (F-008).
		granted: normGranted(r),
		startedAt: iso(r.started_at),
		endedAt: r.ended_at ? iso(r.ended_at) : null
	};
}
