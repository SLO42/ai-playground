// MEMORY-SCENE-SPEC §7.2 — the read-only scene AGGREGATOR (the node/edge TRUTH).
//
// What this is (and is NOT):
//   • This is the LIVE node/edge projection that the living-brain scene renders. It
//     DERIVES the graph from the existing source tables on every read — it keeps NO
//     denormalized, mutable copy of node state (F-008: that is exactly the
//     stale-shown-as-live trap the live-query work just closed). Every node's lifecycle
//     status comes from the live row; nothing is fabricated.
//   • It pairs with the MS-1 `scene_event` projector (projector.ts): scene_event is the
//     append-only ANIMATION feed ("what just happened"); THIS aggregator is the current
//     node/edge TRUTH ("what exists right now"). The UI wave (§7.3) colors/animates the
//     truth from this aggregator and pulses it off the scene_event feed.
//
// Scope (operator fork #2 — MEMORY + USAGE/JOBS only; hires/PMs/ateliers are a later wave):
//   NODE classes
//     memory  — `entity` rows (the knowledge-graph nodes `/memory` already renders) +
//               `memory` rows (the recall store).
//     job     — `session` rows (active/recent) + `work_item` rows (queue / firing jobs).
//   EDGE kinds
//     references     — entity↔entity + entity↔memory (REUSED from the /memory projection).
//     session_target — session↔{project, task} (who is working on what, now).
//     job_target     — work_item↔{project, session} (what a firing job is acting on).
//
// READ-ONLY INVARIANT (grep-provable): this module issues ONLY `SELECT` queries. There is
// no CREATE / UPDATE / DELETE / RELATE / UPSERT / INSERT anywhere in it — the aggregator
// derives, it never writes. (A test asserts the source text contains no mutating verb.)
//
// BOUNDED: every source query is `LIMIT`-ed to a recent/active window (not all-history) so
// the scene stays renderable; edges are filtered to the node set we actually returned, so a
// dangling edge to a pruned node is never emitted.
//
// HONEST EMPTY (F-008): an empty / disconnected DB yields `{nodes:[], edges:[]}` — the UI
// renders "no active memory / jobs yet", never a faked graph.
//
// Boundary discipline (D-016): the only value bound is the integer window cap, via $param;
// no id is interpolated. Datetimes are coerced to ISO strings in the projection (F-013);
// an absent datetime becomes `undefined` (omitted) → the UI renders '—', never str(NONE).

import type { Db } from '../db/client';

/** A node class in the v1 scene scope (operator fork #2: MEMORY + USAGE/JOBS only). */
export type SceneNodeClass = 'memory' | 'job';

/**
 * One recent scene_event row — the "what's happening now" activity feed (MEMORY-SCENE-SPEC
 * §5). DERIVED, append-only, rolling: each row mirrors a real observed row-change (the MS-1
 * projector wrote it). The feed is the text-equivalent / replay of the scene's animation
 * timeline. `meta` is already D-026-SCREENED at write time (projector); we surface it as-is.
 */
export interface SceneEvent {
	/** scene_event record-id string. */
	id: string;
	/** The event kind (job_fired | memory_added | connection_formed | …). */
	kind: string;
	/** The record that changed (a free-form ref string, e.g. 'session:abc'). */
	ref: string;
	/** The source table the changed row belongs to. */
	source: string;
	/** Owning project record-id string, when the changed row carried one. */
	project?: string;
	/** When the event landed, ISO (F-013) — omitted when absent (never str(NONE)). */
	at?: string;
	/** Bounded, pre-screened label meta (status/kind/label/…); never raw row content. */
	meta?: Record<string, unknown>;
}

/**
 * One node in the derived scene graph. `status` is the LIVE lifecycle status off the source
 * row (e.g. session running/done) so the UI wave can color/animate it; `subclass` is the
 * concrete source table (entity|memory|session|work_item) so the UI can style within a class.
 */
export interface SceneNode {
	/** Source record-id string (`entity:…`, `memory:…`, `session:…`, `work_item:…`). */
	id: string;
	/** v1 node class — drives the scene's color family. */
	class: SceneNodeClass;
	/** Concrete source table — drives within-class styling. */
	subclass: 'entity' | 'memory' | 'session' | 'work_item';
	/** Human label (already screen-clean for entity/memory; a short class label otherwise). */
	label: string;
	/** Live lifecycle status off the source row (e.g. active | running | done | pending). */
	status: string;
	/** Owning project record-id, when the source row carries one (for a per-atelier lens). */
	project?: string;
	/** Last-known activity time, ISO (F-013) — omitted when the source datetime is absent. */
	at?: string;
}

/** A derived edge between two scene nodes. `from`/`to` are source record-id strings. */
export interface SceneEdge {
	from: string;
	to: string;
	/** references | session_target | job_target — the relation class. */
	kind: string;
}

/** The full derived scene graph (the node/edge TRUTH for the living-brain scene). */
export interface SceneGraph {
	nodes: SceneNode[];
	edges: SceneEdge[];
}

/** Per-class window caps so the scene stays renderable (recent/active, not all-history). */
export interface SceneGraphLimits {
	/** Max entity nodes. */
	entities?: number;
	/** Max memory nodes. */
	memories?: number;
	/** Max session nodes (most-recent first). */
	sessions?: number;
	/** Max work_item nodes (most-recent first). */
	workItems?: number;
}

const DEFAULT_LIMITS: Required<SceneGraphLimits> = {
	entities: 300,
	memories: 150,
	sessions: 80,
	workItems: 80
};

/** Coerce a SurrealDB datetime/string to an ISO string, or undefined when absent (F-013). */
function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	const d = new Date(String(v));
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Coerce a record-link field to a `table:id` string, or undefined when absent/blank. */
function refOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	const s = String(v);
	return s.includes(':') ? s : undefined;
}

/** Short, content-free label for a job node (no raw row content leaks into the scene). */
function jobLabel(table: 'session' | 'work_item', row: Record<string, unknown>): string {
	const kind = typeof row.kind === 'string' ? row.kind : undefined;
	const workType = typeof row.work_type === 'string' ? row.work_type : undefined;
	const tag = kind ?? workType;
	const head = table === 'session' ? 'session' : 'work';
	return tag ? `${head}: ${tag}` : head;
}

/**
 * Build the derived scene graph (MEMORY-SCENE-SPEC §7.2). READ-ONLY: every query is a
 * SELECT; the function derives the node/edge truth live and returns it — it writes nothing.
 *
 * Shadow paths, all four, all named:
 *   • happy   — real rows across the four tables → classed nodes + filtered edges.
 *   • nil     — `db` is null/undefined (caller never connected) → honest empty graph.
 *   • empty   — connected but no rows in any table → `{nodes:[],edges:[]}` (F-008).
 *   • upstream error — a query throws (DB drops / IAM expiry) → the error propagates to the
 *     LOADER, which already degrades to connected:false + empty (we do NOT swallow it here
 *     into a fake-empty graph: an empty graph means "nothing exists", not "the DB broke").
 */
export async function buildSceneGraph(
	db: Db | null | undefined,
	limits: SceneGraphLimits = {}
): Promise<SceneGraph> {
	// Nil shadow path: no DB → honest empty (the loader renders the disconnected state).
	if (!db) return { nodes: [], edges: [] };

	const lim = { ...DEFAULT_LIMITS, ...limits };

	// ── MEMORY class ────────────────────────────────────────────────────────────────
	// entity nodes (the knowledge-graph nodes /memory renders) — archived/superseded are
	// RETURNED flagged (the UI dims them, UI-SPEC §156), not hidden. Bounded + ordered so
	// the window is deterministic (active first, then by label).
	const [entityRows] = await db.query<
		[Array<{ id: unknown; label: string; type: string; status: string; project?: unknown }>]
	>(
		`SELECT id, label, type, status, project FROM entity
		  ORDER BY status ASC, label ASC LIMIT $entities;`,
		{ entities: lim.entities }
	);

	// memory nodes — the recall store. Quarantined rows are EXCLUDED outright (D-026 — a
	// quarantined secret is never surfaced); archived/superseded returned flagged. Ranked
	// by importance then recency so the window holds the most salient rows.
	const [memoryRows] = await db.query<
		[
			Array<{
				id: unknown;
				kind: string;
				status: string;
				project?: unknown;
				importance?: number;
				created_at?: unknown;
			}>
		]
	>(
		`SELECT id, kind, status, project, importance, created_at FROM memory
		  WHERE screen_status != "quarantined"
		  ORDER BY importance DESC, created_at DESC LIMIT $memories;`,
		{ memories: lim.memories }
	);

	// ── USAGE / JOBS class ──────────────────────────────────────────────────────────
	// session nodes — active/recent jobs. Most-recent first (started_at DESC) so the window
	// is the live front, not stale history. status carries running/done/… for color/animate.
	const [sessionRows] = await db.query<
		[
			Array<{
				id: unknown;
				kind: string;
				status: string;
				project?: unknown;
				task?: unknown;
				started_at?: unknown;
			}>
		]
	>(
		`SELECT id, kind, status, project, task, started_at FROM session
		  ORDER BY started_at DESC LIMIT $sessions;`,
		{ sessions: lim.sessions }
	);

	// work_item nodes — the queue / firing jobs. Most-recent first; status carries
	// pending/processing/done/failed for the firing animation.
	const [workItemRows] = await db.query<
		[
			Array<{
				id: unknown;
				work_type: string;
				status: string;
				project?: unknown;
				session?: unknown;
				created_at?: unknown;
			}>
		]
	>(
		`SELECT id, work_type, status, project, session, created_at FROM work_item
		  ORDER BY created_at DESC LIMIT $workItems;`,
		{ workItems: lim.workItems }
	);

	// ── Project the nodes ─────────────────────────────────────────────────────────────
	const nodes: SceneNode[] = [];

	for (const e of entityRows) {
		nodes.push({
			id: String(e.id),
			class: 'memory',
			subclass: 'entity',
			label: e.label ?? 'entity',
			status: e.status ?? 'active',
			...(refOrUndef(e.project) ? { project: refOrUndef(e.project)! } : {})
		});
	}
	for (const m of memoryRows) {
		nodes.push({
			id: String(m.id),
			class: 'memory',
			subclass: 'memory',
			label: m.kind ? `memory: ${m.kind}` : 'memory',
			status: m.status ?? 'active',
			...(refOrUndef(m.project) ? { project: refOrUndef(m.project)! } : {}),
			...(isoOrUndef(m.created_at) ? { at: isoOrUndef(m.created_at)! } : {})
		});
	}
	for (const s of sessionRows) {
		nodes.push({
			id: String(s.id),
			class: 'job',
			subclass: 'session',
			label: jobLabel('session', s),
			status: s.status ?? 'running',
			...(refOrUndef(s.project) ? { project: refOrUndef(s.project)! } : {}),
			...(isoOrUndef(s.started_at) ? { at: isoOrUndef(s.started_at)! } : {})
		});
	}
	for (const w of workItemRows) {
		nodes.push({
			id: String(w.id),
			class: 'job',
			subclass: 'work_item',
			label: jobLabel('work_item', w),
			status: w.status ?? 'pending',
			...(refOrUndef(w.project) ? { project: refOrUndef(w.project)! } : {}),
			...(isoOrUndef(w.created_at) ? { at: isoOrUndef(w.created_at)! } : {})
		});
	}

	const nodeIds = new Set(nodes.map((n) => n.id));

	// ── Derive the edges ──────────────────────────────────────────────────────────────
	const edges: SceneEdge[] = [];

	// references — entity↔entity + entity↔memory (REUSED from the /memory projection). The
	// `references` RELATION is typed IN/OUT memory|entity (schema.ts §301), so both the
	// knowledge-link (entity↔entity) and the memory↔entity link surface here. Each edge is
	// kept only when BOTH endpoints are in the returned node window (no dangling edges).
	const [refRows] = await db.query<[Array<{ in: unknown; out: unknown; kind: string }>]>(
		`SELECT in, out, kind FROM references;`
	);
	for (const r of refRows) {
		const from = String(r.in);
		const to = String(r.out);
		if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
		edges.push({ from, to, kind: 'references' });
	}

	// session_target — session↔{project, task}: who is working on what, NOW. We only draw to
	// a target that is also a node in this graph (project/task nodes are layered in a later
	// wave; until then a session→project edge whose project isn't a node is dropped, not
	// faked). task targets land when a future wave adds task nodes; today they no-op cleanly.
	for (const s of sessionRows) {
		const id = String(s.id);
		const proj = refOrUndef(s.project);
		const task = refOrUndef(s.task);
		if (proj && nodeIds.has(proj)) edges.push({ from: id, to: proj, kind: 'session_target' });
		if (task && nodeIds.has(task)) edges.push({ from: id, to: task, kind: 'session_target' });
	}

	// job_target — work_item↔{project, session}: what a firing job is acting on. work_item→
	// session is the common live link (a queued job tied to its running session); both
	// endpoints must be present in the window or the edge is dropped (no dangling edge).
	for (const w of workItemRows) {
		const id = String(w.id);
		const proj = refOrUndef(w.project);
		const sess = refOrUndef(w.session);
		if (proj && nodeIds.has(proj)) edges.push({ from: id, to: proj, kind: 'job_target' });
		if (sess && nodeIds.has(sess)) edges.push({ from: id, to: sess, kind: 'job_target' });
	}

	return { nodes, edges };
}

/** Default activity-feed window — the recent slice the "what's happening now" panel shows. */
const DEFAULT_FEED_LIMIT = 40;

/**
 * List the most-recent scene_event rows for the activity feed (MEMORY-SCENE-SPEC §5). READ-
 * ONLY: a single SELECT, newest-first, bounded — the feed is a live window, not the audit log
 * (agent_event audits; the projector already prunes scene_event to its rolling cap). The
 * node/edge TRUTH still derives from buildSceneGraph; this is purely the activity stream.
 *
 * Shadow paths, all four, all named:
 *   • happy   — real scene_event rows → normalized, newest-first, capped.
 *   • nil     — `db` null/undefined → honest empty `[]` (the loader renders the empty feed).
 *   • empty   — connected, no events → `[]` ("no recent activity", F-008 — never a fake line).
 *   • upstream error — the SELECT throws (DB drop / IAM expiry) → propagates to the LOADER,
 *     which degrades to connected:false (we do NOT swallow a DB failure into a fake-empty feed).
 *
 * F-013: `at` is coerced to an ISO string (absent → omitted → the UI renders '—'); `project`
 * to a `table:id` string. `meta` was D-026-screened at WRITE time (projector) — surfaced as-is.
 */
export async function listSceneEvents(
	db: Db | null | undefined,
	limit = DEFAULT_FEED_LIMIT
): Promise<SceneEvent[]> {
	// Nil shadow path: no DB → honest empty feed.
	if (!db) return [];
	// Boundary (D-016): the only bound value is the integer limit, via $param — no id interpolated.
	const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_FEED_LIMIT;
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				kind: string;
				ref: string;
				source: string;
				project?: unknown;
				at?: unknown;
				meta?: Record<string, unknown> | null;
			}>
		]
	>(`SELECT id, kind, ref, source, project, at, meta FROM scene_event ORDER BY at DESC LIMIT $lim;`, {
		lim
	});
	return rows.map((r) => ({
		id: String(r.id),
		kind: r.kind,
		ref: r.ref,
		source: r.source,
		...(refOrUndef(r.project) ? { project: refOrUndef(r.project)! } : {}),
		...(isoOrUndef(r.at) ? { at: isoOrUndef(r.at)! } : {}),
		...(r.meta && typeof r.meta === 'object' ? { meta: r.meta } : {})
	}));
}
