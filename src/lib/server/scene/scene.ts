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
// Scope (MEMORY + USAGE/JOBS + the interactive-graph wave's PROJECT + AGENT context):
//   NODE classes
//     memory  — `entity` rows (the knowledge-graph nodes `/memory` already renders) +
//               `memory` rows (the recall store).
//     job     — `session` rows (active/recent) + `work_item` rows (queue / firing jobs).
//     project — `project` rows (the atelier a job acts on); un-drops the session/work_item→
//               project edges that had no endpoint to draw to before.
//     agent   — DERIVED (no table): one node per distinct `session.agent` slot id (m0069) —
//               which agent ran a job. The slot id is an opaque identity, never content (D-026).
//   EDGE kinds
//     references     — entity↔entity + entity↔memory (REUSED from the /memory projection).
//     session_target — session↔{project, task} (who is working on what, now).
//     job_target     — work_item↔{project, session} (what a firing job is acting on).
//     agent          — session→agent (which agent ran the job; the synthetic agent:<slot> node).
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

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { loadSoul } from '../memory/soul';
import type { MaturityStage, MaturityGateResult, SoulMetrics } from '../memory/soul';
import { screenForDisplay } from '../memory/observability';
import { assertRecordIdOfTable } from '../db/validate';
import { sessionDisplayName, agentDisplayName } from '$lib/shared/naming';

/**
 * A node class in the scene. MEMORY (entity/memory) + JOB (session/work_item) are the original
 * fork-#2 scope; PROJECT (the atelier a job acts on) + AGENT (the slot that ran a job) were
 * layered in by the interactive-graph wave so the scene shows who-works-on-what end-to-end.
 * SELF (S4) is the single synthetic identity node — Atelier's derived soul (soul.ts loadSoul),
 * an anchor the dominant concepts it "knows about" attach to.
 */
export type SceneNodeClass = 'memory' | 'job' | 'project' | 'agent' | 'concept' | 'causal' | 'skill' | 'correction' | 'self';

/** The synthetic SELF node id (S4). Opaque, singular — there is no `self` table; it is DERIVED. */
export const SELF_NODE_ID = 'self:atelier';

/**
 * The soul/identity detail carried on the single SELF node (S4). A PROJECTION of loadSoul's
 * derived self-model — every field traces to real brain rows (F-008); a cold brain yields the
 * honest `nascent` stage with empty knowsAbout/values. All POJO (no datetime → no F-013 risk);
 * D-026: the concepts/values were screened at store time and loadSoul re-reads only clean rows.
 */
export interface SceneSelfDetail {
	/** nascent | developing | established — graduates on measurable brain-volume/quality gates. */
	maturityStage: MaturityStage;
	/** Recall competence in [0,1], or null when the outcome sample is too small (honest unknown). */
	competence: number | null;
	/** A one-line honest self-description composed deterministically from the counts. */
	summary: string;
	/** Dominant concept labels — what Atelier knows about (drives the `knows` edges). */
	knowsAbout: string[];
	/** Learned-value excerpts — what it learned NOT to do. */
	values: string[];
	/** Per-gate evidence for the NEXT maturity stage (provenance for the inspect panel). */
	gates: MaturityGateResult[];
	/** The raw honest brain-volume counts the model is derived from. */
	experience: SoulMetrics;
}

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
	/** Source record-id string (`entity:…`, `memory:…`, `session:…`, `work_item:…`,
	 *  `project:…`) or the SYNTHETIC `agent:<slot>` id for an agent node (no `agent` table —
	 *  the scene treats node ids as opaque strings; agent nodes are derived, not stored). */
	id: string;
	/** Node class — drives the scene's color family + icon. */
	class: SceneNodeClass;
	/** Concrete source table — drives within-class styling. */
	subclass: 'entity' | 'memory' | 'session' | 'work_item' | 'project' | 'agent' | 'concept' | 'causal' | 'skill' | 'correction' | 'self';
	/** Human label (already screen-clean for entity/memory; a short class label otherwise). */
	label: string;
	/**
	 * S3 — a concept node's SCREENED summary (concepts.ts screens label+summary before store, so
	 * this is clean text safe to surface in the inspect panel). Also carries the SELF node's honest
	 * one-line soul summary (S4). Omitted for every other node class.
	 */
	summary?: string;
	/** S4 — the SELF node's derived soul/identity detail (only present on the `self` node). */
	self?: SceneSelfDetail;
	/** Live lifecycle status off the source row (e.g. active | running | done | pending). */
	status: string;
	/** Owning project record-id, when the source row carries one (for a per-atelier lens). */
	project?: string;
	/** The agent slot that ran a job (session nodes; m0069) — for the inspect panel. */
	agent?: string;
	/** Linked task record-id (session nodes), when the row carries one — for the inspect panel. */
	task?: string;
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
	/** Max project nodes (most-recent first). Projects are few; a generous cap covers all. */
	projects?: number;
	/** Max concept nodes (S3 — most-salient first). */
	concepts?: number;
	/** Max causal_chain nodes (S3 — most-recent first). */
	causals?: number;
	/** Max skill nodes (S3 — most-recent first). */
	skills?: number;
	/** Max correction (high-importance flagged memory) nodes (S3). */
	corrections?: number;
	/** Max retrieval_outcome rows scanned for retrieved / grounded-on edges (S3). */
	outcomes?: number;
}

const DEFAULT_LIMITS: Required<SceneGraphLimits> = {
	entities: 300,
	memories: 150,
	sessions: 80,
	workItems: 80,
	projects: 60,
	concepts: 120,
	causals: 60,
	skills: 60,
	corrections: 60,
	outcomes: 200
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

/** Character cap for the task-title part of a scene node label (see `maxSubjectChars`). */
const SCENE_LABEL_SUBJECT_MAX = 56;

/** Short, content-free label for a work_item node (no raw row content leaks into the scene). */
function jobLabel(table: 'session' | 'work_item', row: Record<string, unknown>): string {
	const kind = typeof row.kind === 'string' ? row.kind : undefined;
	const workType = typeof row.work_type === 'string' ? row.work_type : undefined;
	const tag = kind ?? workType;
	const head = table === 'session' ? 'session' : 'work';
	return tag ? `${head}: ${tag}` : head;
}

/**
 * D-026 screen for a label sourced from a MUTABLE, agent-authored row (a task title, a role
 * name). Unlike `project.name` (operator-set) or `concept.label` (screened before store), these
 * were never screened at the write, so they pass the §3.1b display screen HERE before entering
 * the scene. A `quarantined` verdict drops the value entirely — the naming composer then falls
 * back one rung, so a poisoned title degrades the label rather than leaking (F-008 honesty: a
 * dropped title is an absent field, not a fabricated one). Redacted text is safe to render.
 */
function screenedLabel(v: unknown): string | undefined {
	if (typeof v !== 'string' || !v.trim()) return undefined;
	const { text, status } = screenForDisplay(v);
	if (status === 'quarantined') return undefined;
	const t = text.trim();
	return t ? t : undefined;
}

/**
 * Validate a batch of `table:id` link strings at the D-016 chokepoint and wrap them as record
 * links. A malformed id (the upstream-error shadow path — a corrupted link, a legacy string)
 * is DROPPED, not thrown on: one bad link must not blank the whole scene. The dropped row's
 * name simply falls back a rung, which is honest.
 */
function recordLinks(ids: readonly string[], table: string): StringRecordId[] {
	const out: StringRecordId[] = [];
	for (const id of ids) {
		try {
			out.push(new StringRecordId(assertRecordIdOfTable(id, table)));
		} catch {
			// named failure: an invalid/foreign-table record link — skipped, never interpolated.
		}
	}
	return out;
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
		  WHERE screen_status != "quarantined" AND (category IS NONE OR category != "correction")
		  ORDER BY importance DESC, created_at DESC LIMIT $memories;`,
		{ memories: lim.memories }
	);

	// ── USAGE / JOBS class ──────────────────────────────────────────────────────────
	// session nodes — active/recent jobs. Most-recent first (started_at DESC) so the window
	// is the live front, not stale history. status carries running/done/… for color/animate.
	//
	// NAMING (operator rule 2026-07-26): `role`, `specialist` and `granted_intent` are selected
	// alongside so a session/agent node can be named by PURPOSE instead of by the pool-SLOT id
	// (`session.agent` is `opus-1`/`sonnet-1` — F-046 leaking into the UI). F-020: every field the
	// projection reads is in the SELECT, and `started_at` (the ORDER BY key) already is.
	const [sessionRows] = await db.query<
		[
			Array<{
				id: unknown;
				kind: string;
				status: string;
				project?: unknown;
				task?: unknown;
				agent?: unknown;
				role?: unknown;
				specialist?: unknown;
				granted_intent?: unknown;
				started_at?: unknown;
			}>
		]
	>(
		`SELECT id, kind, status, project, task, agent, role, specialist, granted_intent, started_at
		   FROM session
		  ORDER BY started_at DESC LIMIT $sessions;`,
		{ sessions: lim.sessions }
	);

	// ── NAMING joins — bounded by the session window already fetched (≤ lim.sessions ids) ─────
	// A session's PURPOSE lives one hop away: `task.title` (what it is doing) and `role.name/slug`
	// (what it is). Both are resolved with a single id-bounded SELECT each (D-016 $param binding,
	// no interpolation) rather than a per-row lookup. Absent link / absent row → the field simply
	// stays undefined and the composer falls back a rung — never a fabricated title (F-008).
	const taskTitles = new Map<string, string>();
	const roleNames = new Map<string, { name?: string; slug?: string }>();
	const taskIds = [...new Set(sessionRows.map((s) => refOrUndef(s.task)).filter((v): v is string => !!v))];
	const roleIds = [...new Set(sessionRows.map((s) => refOrUndef(s.role)).filter((v): v is string => !!v))];
	const taskLinks = recordLinks(taskIds, 'task');
	const roleLinks = recordLinks(roleIds, 'role');
	if (taskLinks.length) {
		const [rows] = await db.query<[Array<{ id: unknown; title?: unknown }>]>(
			`SELECT id, title FROM task WHERE id IN $ids;`,
			{ ids: taskLinks }
		);
		for (const r of rows ?? []) {
			// A task title is AGENT-AUTHORED and unscreened at write → screen it here (D-026).
			const t = screenedLabel(r.title);
			if (t) taskTitles.set(String(r.id), t);
		}
	}
	if (roleLinks.length) {
		const [rows] = await db.query<[Array<{ id: unknown; name?: unknown; slug?: unknown }>]>(
			`SELECT id, name, slug FROM role WHERE id IN $ids;`,
			{ ids: roleLinks }
		);
		for (const r of rows ?? []) {
			roleNames.set(String(r.id), {
				...(screenedLabel(r.name) ? { name: screenedLabel(r.name)! } : {}),
				...(screenedLabel(r.slug) ? { slug: screenedLabel(r.slug)! } : {})
			});
		}
	}

	/** The naming fields for one session row, resolved through the two joins above. */
	const nameInputFor = (s: (typeof sessionRows)[number]) => {
		const role = roleNames.get(refOrUndef(s.role) ?? '');
		return {
			roleName: role?.name,
			roleSlug: role?.slug,
			role: refOrUndef(s.role),
			specialist: typeof s.specialist === 'string' ? s.specialist : undefined,
			taskTitle: taskTitles.get(refOrUndef(s.task) ?? ''),
			intent: typeof s.granted_intent === 'string' ? s.granted_intent : undefined,
			kind: s.kind
		};
	};

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

	// ── PROJECT class ─────────────────────────────────────────────────────────────────
	// project nodes — the atelier a job acts on. The scene previously had NO project nodes,
	// so every session→project / work_item→project edge was DROPPED (no endpoint to draw to);
	// adding them un-drops those edges. Bounded (projects are few; the cap covers all in
	// practice); status carries active/paused/archived for color. created_at → `at` (F-013).
	const [projectRows] = await db.query<
		[Array<{ id: unknown; name?: string; slug?: string; status?: string; created_at?: unknown }>]
	>(
		`SELECT id, name, slug, status, created_at FROM project
		  ORDER BY created_at DESC LIMIT $projects;`,
		{ projects: lim.projects }
	);

	// ── S3 COGNITIVE class — concept / causal / skill / correction ─────────────────────
	// concept nodes (S3) — the semantic distillate (m0073). label+summary were SCREENED before
	// store (concepts.ts), so both are clean to surface; quarantined concepts are EXCLUDED outright
	// (D-026, mirrors memory). Most-salient first (importance, then recency).
	const [conceptRows] = await db.query<
		[Array<{ id: unknown; label?: string; summary?: string; status: string; project?: unknown; importance?: number; created_at?: unknown }>]
	>(
		`SELECT id, label, summary, status, project, importance, created_at FROM concept
		  WHERE screen_status != "quarantined"
		  ORDER BY importance DESC, created_at DESC LIMIT $concepts;`,
		{ concepts: lim.concepts }
	);

	// causal node — a learned trigger→outcome chain (m0014). Content-free label (the kind only —
	// the trigger/outcome prose is NEVER surfaced, D-026); status from success. Most-recent first.
	const [causalRows] = await db.query<
		[Array<{ id: unknown; kind?: string; success?: boolean; session?: unknown; created_at?: unknown }>]
	>(
		`SELECT id, kind, success, session, created_at FROM causal_chain
		  ORDER BY created_at DESC LIMIT $causals;`,
		{ causals: lim.causals }
	);

	// skill node — a graduated procedure (m0014). The name was screened at graduation (loop.ts),
	// so it is clean to surface; archived/superseded returned flagged. Most-recent first.
	const [skillRows] = await db.query<
		[Array<{ id: unknown; name?: string; status: string; created_at?: unknown }>]
	>(
		`SELECT id, name, status, created_at FROM skill
		  ORDER BY created_at DESC LIMIT $skills;`,
		{ skills: lim.skills }
	);

	// correction node — a high-importance memory flagged category="correction" (m0073). Quarantined
	// excluded (D-026); content-free label (the kind), status from the memory row. Most-salient first.
	const [correctionRows] = await db.query<
		[Array<{ id: unknown; kind?: string; status: string; project?: unknown; importance?: number; created_at?: unknown }>]
	>(
		`SELECT id, kind, status, project, importance, created_at FROM memory
		  WHERE category = "correction" AND screen_status != "quarantined"
		  ORDER BY importance DESC, created_at DESC LIMIT $corrections;`,
		{ corrections: lim.corrections }
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
		const agent = typeof s.agent === 'string' && s.agent.trim() ? s.agent.trim() : undefined;
		nodes.push({
			id: String(s.id),
			class: 'job',
			subclass: 'session',
			// NAMING: purpose first, the pool-slot id demoted to a trailing qualifier. The old
			// `jobLabel('session', …)` rendered `session: task` for EVERY task session — a
			// content-free label repeated N times, which the standing operator rule classes as a
			// defect. When no purposeful field exists the composer returns an honest placeholder.
			// `maxSubjectChars`: live task titles run past 200 chars, which is unreadable as a graph
			// node label. The cap ellipsizes VISIBLY (`…`), and the legend carries the full label in
			// its `title` while the inspector links the task itself — truncated, never hidden.
			label: sessionDisplayName(
				{ ...nameInputFor(s), qualifier: agent },
				{ maxSubjectChars: SCENE_LABEL_SUBJECT_MAX }
			),
			status: s.status ?? 'running',
			...(refOrUndef(s.project) ? { project: refOrUndef(s.project)! } : {}),
			...(agent ? { agent } : {}),
			...(refOrUndef(s.task) ? { task: refOrUndef(s.task)! } : {}),
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

	// project nodes — label is the screen-clean project NAME (a project name is operator-set,
	// not screened content), status drives the color. created_at → `at` for the time scrubber.
	for (const p of projectRows) {
		const label = (typeof p.name === 'string' && p.name) || (typeof p.slug === 'string' && p.slug) || 'project';
		nodes.push({
			id: String(p.id),
			class: 'project',
			subclass: 'project',
			label,
			status: p.status ?? 'active',
			...(isoOrUndef(p.created_at) ? { at: isoOrUndef(p.created_at)! } : {})
		});
	}

	// ── Project the S3 cognitive nodes ─────────────────────────────────────────────────
	for (const c of conceptRows) {
		const label = (typeof c.label === 'string' && c.label.trim()) || 'concept';
		const summary = typeof c.summary === 'string' && c.summary.trim() ? c.summary.trim() : undefined;
		nodes.push({
			id: String(c.id),
			class: 'concept',
			subclass: 'concept',
			label,
			status: c.status ?? 'active',
			...(summary ? { summary } : {}),
			...(refOrUndef(c.project) ? { project: refOrUndef(c.project)! } : {}),
			...(isoOrUndef(c.created_at) ? { at: isoOrUndef(c.created_at)! } : {})
		});
	}
	for (const cc of causalRows) {
		const kind = typeof cc.kind === 'string' ? cc.kind : undefined;
		nodes.push({
			id: String(cc.id),
			class: 'causal',
			subclass: 'causal',
			label: kind ? `causal: ${kind}` : 'causal',
			// status drives the color/pulse: a successful chain reads 'done', a failed one 'failed'.
			status: cc.success === false ? 'failed' : 'done',
			...(isoOrUndef(cc.created_at) ? { at: isoOrUndef(cc.created_at)! } : {})
		});
	}
	for (const sk of skillRows) {
		nodes.push({
			id: String(sk.id),
			class: 'skill',
			subclass: 'skill',
			label: (typeof sk.name === 'string' && sk.name.trim()) || 'skill',
			status: sk.status ?? 'active',
			...(isoOrUndef(sk.created_at) ? { at: isoOrUndef(sk.created_at)! } : {})
		});
	}
	for (const cr of correctionRows) {
		const kind = typeof cr.kind === 'string' ? cr.kind : undefined;
		nodes.push({
			id: String(cr.id),
			class: 'correction',
			subclass: 'correction',
			label: kind ? `correction: ${kind}` : 'correction',
			status: cr.status ?? 'active',
			...(refOrUndef(cr.project) ? { project: refOrUndef(cr.project)! } : {}),
			...(isoOrUndef(cr.created_at) ? { at: isoOrUndef(cr.created_at)! } : {})
		});
	}

	// ── AGENT class (DERIVED, not stored) ─────────────────────────────────────────────
	// agent nodes are SYNTHESIZED from the distinct `session.agent` slot ids in the window —
	// there is no `agent` table (D-026: the slot id is an opaque identity, not content). One
	// node per slot clusters every job that agent ran. status = 'running' if any of its
	// windowed sessions is live, else 'idle'; `at` = its most-recent session start (scrubber).
	//
	// NAMING (operator rule 2026-07-26): the slot id is NOT the name — `sonnet-1` says which
	// TIER BUCKET ran the work, not what the work was. Each cluster is named by the PURPOSE of
	// the sessions inside it (roles → specialists → intents → kinds), the slot id demoted to a
	// trailing qualifier, and the cluster SPREAD disclosed (`code-write +2`) rather than one of
	// several shown at random. A cluster with no purposeful field at all reads
	// `unnamed agent · sonnet-1` — honest, and still never the slot id alone (F-008/F-046).
	const agentAcc = new Map<
		string,
		{ running: boolean; at?: string; roleNames: string[]; specialists: string[]; intents: string[]; kinds: string[] }
	>();
	for (const s of sessionRows) {
		const agent = typeof s.agent === 'string' && s.agent.trim() ? s.agent.trim() : undefined;
		if (!agent) continue;
		const acc =
			agentAcc.get(agent) ?? { running: false, roleNames: [], specialists: [], intents: [], kinds: [] };
		if ((s.status ?? 'running') === 'running') acc.running = true;
		const at = isoOrUndef(s.started_at);
		if (at && (!acc.at || at > acc.at)) acc.at = at;
		const n = nameInputFor(s);
		if (n.roleName ?? n.roleSlug) acc.roleNames.push((n.roleName ?? n.roleSlug)!);
		if (n.specialist) acc.specialists.push(n.specialist);
		if (n.intent) acc.intents.push(n.intent);
		if (n.kind) acc.kinds.push(n.kind);
		agentAcc.set(agent, acc);
	}
	for (const [agent, acc] of agentAcc) {
		nodes.push({
			id: `agent:${agent}`,
			class: 'agent',
			subclass: 'agent',
			label: agentDisplayName({
				slot: agent,
				roleNames: acc.roleNames,
				specialists: acc.specialists,
				intents: acc.intents,
				kinds: acc.kinds
			}),
			status: acc.running ? 'running' : 'idle',
			...(acc.at ? { at: acc.at } : {})
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
	// a target that is also a node in this graph. Project nodes now exist (above), so the
	// session→project edge draws; task nodes are still a later wave, so a session→task edge
	// no-ops cleanly until then (the endpoint guard drops it — never faked).
	for (const s of sessionRows) {
		const id = String(s.id);
		const proj = refOrUndef(s.project);
		const task = refOrUndef(s.task);
		if (proj && nodeIds.has(proj)) edges.push({ from: id, to: proj, kind: 'session_target' });
		if (task && nodeIds.has(task)) edges.push({ from: id, to: task, kind: 'session_target' });
		// session→agent (m0069) — which agent ran this job. The agent node is the synthetic
		// `agent:<slot>`, present iff this (or another windowed) session carried the slot id.
		const agent = typeof s.agent === 'string' && s.agent.trim() ? `agent:${s.agent.trim()}` : undefined;
		if (agent && nodeIds.has(agent)) edges.push({ from: id, to: agent, kind: 'agent' });
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

	// ── S3 concept edges (m0073 concept_edge) ──────────────────────────────────────────
	// about_concept renders as "extracted-from" (memory|session → concept); supersedes keeps its
	// name; the hierarchy kinds (narrower/broader/related_to) and the rest render under their own
	// kind. Endpoint-guarded (both ends must be in the window) so no dangling edge is emitted.
	const [conceptEdgeRows] = await db.query<[Array<{ in: unknown; out: unknown; kind: string }>]>(
		`SELECT in, out, kind FROM concept_edge;`
	);
	for (const r of conceptEdgeRows) {
		const from = String(r.in);
		const to = String(r.out);
		if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
		const kind = r.kind === 'about_concept' ? 'extracted-from' : r.kind;
		edges.push({ from, to, kind });
	}

	// retrieved / grounded-on — derive from retrieval_outcome (m0013): the SESSION that retrieved a
	// memory → that memory. An UTILIZED/cited outcome means the answer was grounded on it
	// ("grounded-on"); an un-utilized one is a plain "retrieved" link. Both ends must be windowed
	// nodes (the message query_turn is not a scene node, so the session is the query proxy).
	const [outcomeRows] = await db.query<
		[Array<{ session?: unknown; memory?: unknown; utilized?: boolean; cited?: boolean; created_at?: unknown }>]
	>(
		// created_at is SELECTed because it is the ORDER BY idiom (F-020 — ORDER BY requires the
		// field in the projection).
		`SELECT session, memory, utilized, cited, created_at FROM retrieval_outcome
		  ORDER BY created_at DESC LIMIT $outcomes;`,
		{ outcomes: lim.outcomes }
	);
	const seenOutcome = new Set<string>();
	for (const o of outcomeRows) {
		const sess = refOrUndef(o.session);
		const mem = refOrUndef(o.memory);
		if (!sess || !mem || !nodeIds.has(sess) || !nodeIds.has(mem)) continue;
		const kind = o.utilized === true || o.cited === true ? 'grounded-on' : 'retrieved';
		// Collapse duplicate parallel outcomes for the same (session, memory, kind) to one edge.
		const key = `${sess}|${mem}|${kind}`;
		if (seenOutcome.has(key)) continue;
		seenOutcome.add(key);
		edges.push({ from: sess, to: mem, kind });
	}

	// ── SELF / SOUL node (S4) — Atelier's derived identity, anchored in the living scene ──
	// Emitted ONLY when the brain already has other signal (nodes present): a truly cold/empty DB
	// still yields the honest-empty scene (F-008) rather than a lone fabricated self node. The soul
	// is a PROJECTION of live rows (loadSoul → deriveSoul): maturity graduates on measurable gates,
	// and a sparse brain reads honestly `nascent` with empty knows-about/values (never invented).
	// The dominant concepts it "knows about" REUSE the existing concept nodes (matched by their
	// already-screened label) via `knows` edges — no duplicate nodes, no new content surfaced (D-026).
	if (nodes.length > 0) {
		const soul = await loadSoul(db);
		nodes.push({
			id: SELF_NODE_ID,
			class: 'self',
			subclass: 'self',
			label: 'Atelier',
			// status carries the maturity stage so the UI colors the identity ring by stage.
			status: soul.maturityStage,
			summary: soul.summary,
			self: {
				maturityStage: soul.maturityStage,
				competence: soul.competence,
				summary: soul.summary,
				knowsAbout: soul.knowsAbout,
				values: soul.values,
				gates: soul.gates,
				experience: soul.experience
			}
		});
		// `knows` edges: SELF → each concept node already in the window whose (screened) label is in
		// the dominant set. Bounded to the dominant concepts; endpoint-guarded by construction (we
		// only link to concept nodes we actually returned). A dominant concept not in the window
		// (unlikely — both rank by importance) simply draws no edge (never a dangling link).
		if (soul.knowsAbout.length) {
			const want = new Set(soul.knowsAbout);
			for (const n of nodes) {
				if (n.class === 'concept' && want.has(n.label)) {
					edges.push({ from: SELF_NODE_ID, to: n.id, kind: 'knows' });
				}
			}
		}
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
