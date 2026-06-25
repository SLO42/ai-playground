// LG-2 (LIFECYCLE-GRAPH-SPEC §LG-2) — the lifecycle READ MODEL: assemble the live causal
// node-graph of a task/project lifecycle. A PURE READ model — NO write path (grep-provable:
// only SELECT queries; never CREATE/UPDATE/DELETE/RELATE/UPSERT/INSERT). It DERIVES the graph
// on every read from the already-persisted substrate; it keeps NO denormalized mutable copy
// (F-008: that is the stale-shown-as-live trap the live-query/scene work already closed).
//
// THE GRAPH (operator goal): Continue node → the agent/session nodes it spawned (task name,
// role/title, hire, tool-call count, active skills) → on finish they report to a PM node (PM
// state/reason/decisions) → the PM's new task nodes extend the chain. Live + animated (the
// LG-3 UI animates this off the existing onDbChange SSE — this module is the truth it renders).
//
// SOURCES (all REAL rows — never fabricated; F-008):
//   • scene_event (LG-1 markers + job_fired/job_done) — the live spine. `continue`/`batch_drained`
//     root a Continue node; `pm_tick` roots a PM node (projector.ts SceneEventKind; m0066).
//   • session rows — role/role_version (title/hire), tool_iter_count (toolCount), granted_skills
//     (active skills, UO-1/m0065), status, started_at/ended_at (elapsed), task (→ task.title).
//   • task rows — label (title), status; proposed_by (→ PM) + provenance.kind='pm_proposal'
//     (the EXPLICIT pm→task edge); revision_of/parent (the EXPLICIT follow-up edge).
//   • agent_event — type='spawn' (session↔cause) + type='completion' (session→outcome);
//     parent_event_id (m0067) — the EXPLICIT causal back-link a spawn carries to its trigger.
//
// EXPLICIT vs INFERRED edges (HONEST — F-008): an edge backed by a real link (proposed_by /
// revision_of / a resolved parent_event_id) is `inferred:false`; an edge derived from the
// documented same-project + timestamp-window heuristic (Continue→session when no parent link
// resolves; session→PM, which the in-memory re-tick never persisted) is `inferred:true`. A
// missing causal link is rendered honest-unknown (the edge is simply absent), never invented.
//
// BOUNDED (F-014): every source query carries an explicit LIMIT — NEVER an unbounded
// scene_event/message/task scan. The node window is capped per class; edges are filtered to the
// node set we actually returned (no dangling edge to a pruned node). Truncation is surfaced
// (capped flags) so a partial read is honest, not silently complete.
//
// BEST-EFFORT (D-019/F-014/F-048): each source read is isolated — a source that THROWS yields a
// PARTIAL graph (the source named in `failedSources`), never a thrown page and never a crash that
// could block a caller. A graph READ never writes, never blocks the orchestrator/PM/drain.
//
// BOUNDARY (D-016): the project id flows through assertRecordId and binds as a StringRecordId;
// the ONLY interpolation is a parameterized integer cap (never a value).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

// ── Node / Edge shape (LIFECYCLE-GRAPH-SPEC §LG-2) ──────────────────────────────────────

/** The four node classes in the lifecycle graph. */
export type LifecycleNodeKind = 'continue' | 'session' | 'pm' | 'task';

/** The four causal edge kinds. */
export type LifecycleEdgeKind = 'spawned' | 'reported-to' | 'proposed' | 'follow-up';

/**
 * One node in the causal lifecycle graph. Every field derives from a REAL row (F-008); an
 * absent attribute is OMITTED (never str(undefined) / a fabricated value).
 */
export interface LifecycleNode {
	/** Stable id — the source record-id (`session:…` / `task:…` / `scene_event:…`). */
	id: string;
	/** Node class — drives the UI's node family + lane. */
	kind: LifecycleNodeKind;
	/** Human label (task name for a session/task node; a short marker label otherwise). Screened. */
	label: string;
	/** The workforce role record-id the session ran AS (the role/title), when present. */
	role?: string;
	/** The role_version record-id (the concrete "hire"), when present. */
	hire?: string;
	/** Tool-call count (session.tool_iter_count) — the live "how busy" signal. Omitted when absent. */
	toolCount?: number;
	/** Active skills (UO-1 granted_skills) — the capabilities the session was launched with. */
	skills?: string[];
	/** Live lifecycle status off the source row (running/done/failed/… ; a marker kind otherwise). */
	status: string;
	/** When this node started, ISO (F-013) — omitted when the source datetime is absent. */
	startedAt?: string;
	/** Wall-clock ms from start to end (or to now for a live node); omitted when start is absent. */
	elapsed?: number;
}

/**
 * One causal edge. `from`/`to` are node ids (both endpoints are guaranteed present in the
 * returned node set — no dangling edges). `inferred` distinguishes a real-link edge
 * (false) from a timestamp/heuristic-derived one (true) — HONEST (F-008), never presented
 * as certain when it is a guess.
 */
export interface LifecycleEdge {
	from: string;
	to: string;
	kind: LifecycleEdgeKind;
	/** True ⇒ derived by the documented same-project + timestamp inference (not a real link). */
	inferred: boolean;
}

/** Which substrate source a read folded (for the honest-partial `failedSources`). */
export type LifecycleSource = 'scene_event' | 'session' | 'task' | 'agent_event';

/** The assembled lifecycle graph for one project (or honest-empty). */
export interface LifecycleGraph {
	/** The project this graph was assembled for (echoed back). */
	project: string;
	/** The causal nodes, oldest-first (the chain grows forward). At most the per-class caps. */
	nodes: LifecycleNode[];
	/** The causal edges; both endpoints are always in `nodes`. */
	edges: LifecycleEdge[];
	/** True when every source read succeeded; false ⇒ a PARTIAL graph (sources in failedSources). */
	complete: boolean;
	/** Sources that FAILED this read (honest partial — F-008). Empty when complete. */
	failedSources: LifecycleSource[];
	/** True when ANY source hit its window cap (more rows exist than were folded — F-014). */
	capped: boolean;
}

/** Per-class window caps so the graph stays renderable (recent/active, not all-history). */
export interface LifecycleGraphLimits {
	/** Max Continue/PM marker scene_event rows (most-recent first). */
	markers?: number;
	/** Max session nodes (most-recent first). */
	sessions?: number;
	/** Max task nodes (most-recent first). */
	tasks?: number;
	/** Max agent_event rows scanned for edge resolution (spawn/completion). */
	agentEvents?: number;
	/** Inference window in ms: a Continue→session / session→PM heuristic edge only links nodes
	 *  whose start times fall within this window of each other. */
	inferenceWindowMs?: number;
}

const DEFAULT_LIMITS: Required<LifecycleGraphLimits> = {
	markers: 100,
	sessions: 200,
	tasks: 200,
	agentEvents: 2000,
	// 30 min — a Continue drain's sessions spawn within minutes; a session→PM re-tick fires on
	// the task-terminal change. A generous-but-bounded window keeps the heuristic honest.
	inferenceWindowMs: 30 * 60 * 1000
};

/** The scene_event PM marker kind that roots the PM node (LG-1; m0066). The Continue roots
 *  (`continue`/`batch_drained`) are matched inline at read; this names the PM kind once. */
const PM_KIND = 'pm_tick';

// ── Coercion helpers (mirror scene.ts / timeline.ts — F-013, never str(NONE)) ────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** SurrealDB 2.x datetime/string → ISO string, or undefined when absent/unparseable (F-013). */
function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	const d = v instanceof Date ? v : new Date(String(v));
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A record-link field → `table:id` string, or undefined when absent/blank (no fabricated id). */
function refOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	const s = String(v);
	return s.includes(':') ? s : undefined;
}

/** A finite, non-negative int → itself, else undefined (an absent count is omitted, not 0). */
function intOrUndef(v: unknown): number | undefined {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
	return Math.floor(v);
}

/** A string[] column → cleaned non-empty strings, or undefined when none (never a fake empty). */
function strListOrUndef(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
	return out.length ? out : undefined;
}

/** Elapsed ms from `start` to `end` (or now when live); undefined when start absent / negative. */
function elapsedMs(startIso: string | undefined, endIso: string | undefined): number | undefined {
	if (!startIso) return undefined;
	const start = new Date(startIso).getTime();
	if (Number.isNaN(start)) return undefined;
	const end = endIso ? new Date(endIso).getTime() : Date.now();
	if (Number.isNaN(end)) return undefined;
	const ms = end - start;
	return ms >= 0 ? ms : undefined;
}

/** Bounded short label off a scene_event marker — never raw row content (meta was screened at write). */
function markerLabel(kind: string, meta: Record<string, unknown> | undefined): string {
	if (kind === PM_KIND) {
		const state = meta && typeof meta.state === 'string' ? meta.state : undefined;
		return state ? `PM: ${state}` : 'PM tick';
	}
	// continue / batch_drained
	const ready = meta && typeof meta.readyCount === 'number' ? meta.readyCount : undefined;
	return ready != null ? `Continue (${ready} ready)` : 'Continue';
}

// ── Raw row shapes the source readers project ────────────────────────────────────────────

interface RawMarker {
	id: unknown;
	kind: string;
	at?: unknown;
	meta?: Record<string, unknown> | null;
}
interface RawSession {
	id: unknown;
	task?: unknown;
	role?: unknown;
	role_version?: unknown;
	status?: string;
	tool_iter_count?: unknown;
	granted_skills?: unknown;
	started_at?: unknown;
	ended_at?: unknown;
	ttitle?: unknown; // joined task.title
}
interface RawTask {
	id: unknown;
	title?: string;
	status?: string;
	proposed_by?: unknown;
	provenance?: Record<string, unknown> | null;
	revision_of?: unknown;
	parent?: unknown;
	created_at?: unknown;
}
interface RawAgentEvent {
	id: unknown;
	session?: unknown;
	type: string;
	parent_event_id?: unknown;
	at?: unknown;
}

// ── Bounded source readers (each: own LIMIT, project-scoped, newest-first) ────────────────

/** Continue/PM marker scene_events for the project (most-recent first, capped). */
async function readMarkers(db: Db, project: StringRecordId, lim: number): Promise<RawMarker[]> {
	const [rows] = await db.query<[RawMarker[]]>(
		`SELECT id, kind, at, meta FROM scene_event
		  WHERE project = $project
		    AND kind IN ["continue","batch_drained","pm_tick"]
		  ORDER BY at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/** Session rows for the project (most-recent first, capped) with the task title joined. */
async function readSessions(db: Db, project: StringRecordId, lim: number): Promise<RawSession[]> {
	const [rows] = await db.query<[RawSession[]]>(
		`SELECT id, task, role, role_version, status, tool_iter_count, granted_skills,
		        started_at, ended_at, task.title AS ttitle
		   FROM session
		  WHERE project = $project
		  ORDER BY started_at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/** Task rows for the project (most-recent first, capped) with provenance/succession links. */
async function readTasks(db: Db, project: StringRecordId, lim: number): Promise<RawTask[]> {
	const [rows] = await db.query<[RawTask[]]>(
		`SELECT id, title, status, proposed_by, provenance, revision_of, parent, created_at
		   FROM task
		  WHERE project = $project
		  ORDER BY created_at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/** spawn/completion agent_events for the project (most-recent first, capped) — for edge resolution. */
async function readAgentEvents(db: Db, project: StringRecordId, lim: number): Promise<RawAgentEvent[]> {
	const [rows] = await db.query<[RawAgentEvent[]]>(
		`SELECT id, session, type, parent_event_id, at FROM agent_event
		  WHERE project = $project AND type IN ["spawn","completion"]
		  ORDER BY at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/**
 * Assemble the lifecycle node-graph for one project. PURE READ — every query is a SELECT; the
 * function derives the graph live and returns it (it writes nothing).
 *
 * Shadow paths, all four, all named:
 *   • happy   — real markers/sessions/tasks/events → classed nodes + explicit-and-inferred edges.
 *   • nil     — `db` is null/undefined → honest empty graph (the loader renders disconnected).
 *   • empty   — connected but a project with no activity → `{nodes:[],edges:[]}` (F-008).
 *   • upstream error — a source query throws (DB drop / IAM expiry) → that source is isolated
 *     (named in failedSources, complete:false) and the rest of the graph is still returned; a
 *     read NEVER crashes a caller (best-effort, D-019/F-048). An empty graph means "no activity",
 *     NOT "the DB broke" — the partial flags carry the honest distinction.
 *
 * BOUNDARY: a malformed projectId throws at the assertRecordId chokepoint (a bad id is a bug,
 * fail-loud — not an honest-empty case).
 */
export async function buildLifecycleGraph(
	db: Db | null | undefined,
	projectId: string,
	limits: LifecycleGraphLimits = {}
): Promise<LifecycleGraph> {
	const lim = { ...DEFAULT_LIMITS, ...limits };
	// Validate EARLY at the boundary (fail-loud) — even for the nil-db path the id shape is a bug.
	const safeProject = assertRecordId(projectId);

	// Nil shadow path: no DB → honest empty graph (the loader renders the disconnected state).
	if (!db) {
		return {
			project: safeProject,
			nodes: [],
			edges: [],
			complete: true,
			failedSources: [],
			capped: false
		};
	}

	const project = link(safeProject);

	// Each source independently — a per-source failure is isolated (best-effort posture, F-048).
	// We fetch cap+1 so truncation is detected honestly without a second COUNT.
	const failedSources: LifecycleSource[] = [];
	const run = async <T>(source: LifecycleSource, fn: () => Promise<T[]>): Promise<T[]> => {
		try {
			return await fn();
		} catch (err) {
			failedSources.push(source);
			console.warn(
				`[lifecycle] source "${source}" failed (partial graph): ${(err as Error).message}`
			);
			return [];
		}
	};

	const [rawMarkers, rawSessions, rawTasks, rawEvents] = await Promise.all([
		run('scene_event', () => readMarkers(db, project, lim.markers + 1)),
		run('session', () => readSessions(db, project, lim.sessions + 1)),
		run('task', () => readTasks(db, project, lim.tasks + 1)),
		run('agent_event', () => readAgentEvents(db, project, lim.agentEvents + 1))
	]);

	// Detect + trim per-source truncation (F-014 — honest cap, never a silent partial).
	const markersCapped = rawMarkers.length > lim.markers;
	const sessionsCapped = rawSessions.length > lim.sessions;
	const tasksCapped = rawTasks.length > lim.tasks;
	const eventsCapped = rawEvents.length > lim.agentEvents;
	const markers = markersCapped ? rawMarkers.slice(0, lim.markers) : rawMarkers;
	const sessions = sessionsCapped ? rawSessions.slice(0, lim.sessions) : rawSessions;
	const tasks = tasksCapped ? rawTasks.slice(0, lim.tasks) : rawTasks;
	const events = eventsCapped ? rawEvents.slice(0, lim.agentEvents) : rawEvents;
	const capped = markersCapped || sessionsCapped || tasksCapped || eventsCapped;

	// ── Project the nodes ──────────────────────────────────────────────────────────────
	const nodes: LifecycleNode[] = [];

	// Continue + PM marker nodes (the causal roots / PM hubs).
	for (const m of markers) {
		const id = String(m.id);
		const meta = m.meta && typeof m.meta === 'object' ? m.meta : undefined;
		const kind: LifecycleNodeKind = m.kind === PM_KIND ? 'pm' : 'continue';
		const at = isoOrUndef(m.at);
		nodes.push({
			id,
			kind,
			label: markerLabel(m.kind, meta),
			status: m.kind === PM_KIND ? 'tick' : 'drained',
			...(at ? { startedAt: at } : {})
		});
	}

	// Session nodes — the agents the Continue spawned. task name + role/title + hire + toolCount +
	// active skills (all REAL columns; absent → omitted — never fabricated).
	for (const s of sessions) {
		const id = String(s.id);
		const started = isoOrUndef(s.started_at);
		const ended = isoOrUndef(s.ended_at);
		const title = typeof s.ttitle === 'string' && s.ttitle.trim() ? s.ttitle.trim() : undefined;
		const elapsed = elapsedMs(started, ended);
		const skills = strListOrUndef(s.granted_skills);
		const toolCount = intOrUndef(s.tool_iter_count);
		nodes.push({
			id,
			kind: 'session',
			label: title ? `session: ${title}` : 'session',
			status: s.status ?? 'running',
			...(refOrUndef(s.role) ? { role: refOrUndef(s.role)! } : {}),
			...(refOrUndef(s.role_version) ? { hire: refOrUndef(s.role_version)! } : {}),
			...(toolCount != null ? { toolCount } : {}),
			...(skills ? { skills } : {}),
			...(started ? { startedAt: started } : {}),
			...(elapsed != null ? { elapsed } : {})
		});
	}

	// Task nodes — the work the Continue drained + the new tasks the PM proposed.
	for (const t of tasks) {
		const id = String(t.id);
		const created = isoOrUndef(t.created_at);
		const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : undefined;
		nodes.push({
			id,
			kind: 'task',
			label: title ? title : 'task',
			status: t.status ?? 'backlog',
			...(created ? { startedAt: created } : {})
		});
	}

	const nodeIds = new Set(nodes.map((n) => n.id));
	// Index session start times (for the inference windows) + the task→session reverse lookup.
	const sessionStart = new Map<string, number>();
	const sessionTask = new Map<string, string>(); // sessionId → taskId (the work it ran for)
	for (const s of sessions) {
		const id = String(s.id);
		const st = isoOrUndef(s.started_at);
		if (st) sessionStart.set(id, new Date(st).getTime());
		const taskRef = refOrUndef(s.task);
		if (taskRef) sessionTask.set(id, taskRef);
	}
	const markerAt = new Map<string, { kind: LifecycleNodeKind; ms: number | undefined }>();
	for (const m of markers) {
		const id = String(m.id);
		const at = isoOrUndef(m.at);
		markerAt.set(id, {
			kind: m.kind === PM_KIND ? 'pm' : 'continue',
			ms: at ? new Date(at).getTime() : undefined
		});
	}

	// ── Derive the edges (explicit first; then inference where no real link exists) ─────────
	const edges: LifecycleEdge[] = [];
	// Dedup key so a session never gets both an explicit AND an inferred spawned/reported edge.
	const haveSpawned = new Set<string>(); // sessionId that already has an incoming `spawned`
	const haveReported = new Set<string>(); // sessionId that already has an outgoing `reported-to`
	const pushEdge = (from: string, to: string, kind: LifecycleEdgeKind, inferred: boolean) => {
		if (!nodeIds.has(from) || !nodeIds.has(to)) return; // no dangling edge (F-008)
		edges.push({ from, to, kind, inferred });
	};

	// (1) PM → task  — EXPLICIT (task.proposed_by is the PM, provenance.kind='pm_proposal'). The
	// proposed_by points at a `pm` row, NOT a pm_tick scene_event node; we draw the edge from the
	// MOST-RECENT PM marker node when one exists (the visible PM hub), since the pm_tick is the
	// observable PM node and a pm row has no node in this graph. When there is no PM marker, the
	// proposal is real but its PM hub is not in-window → honest-unknown (no fabricated edge).
	const pmNodes = nodes.filter((n) => n.kind === 'pm');
	const latestPm = pmNodes.length ? pmNodes[0].id : undefined; // markers are newest-first
	for (const t of tasks) {
		const tid = String(t.id);
		const prov = t.provenance && typeof t.provenance === 'object' ? t.provenance : undefined;
		const isPmProposal =
			refOrUndef(t.proposed_by) != null ||
			(prov && typeof prov.kind === 'string' && prov.kind === 'pm_proposal');
		if (isPmProposal && latestPm) {
			pushEdge(latestPm, tid, 'proposed', false);
		}
	}

	// (2) task → task  — EXPLICIT follow-up/revision (revision_of / parent). from = the ORIGINAL,
	// to = the follow-up (the chain extends forward).
	for (const t of tasks) {
		const tid = String(t.id);
		const orig = refOrUndef(t.revision_of) ?? refOrUndef(t.parent);
		if (orig) pushEdge(orig, tid, 'follow-up', false);
	}

	// (3) Continue → session  — EXPLICIT where a spawn agent_event carries parent_event_id pointing
	// at a Continue/marker node (m0067: the cause threaded at spawn). The spawn's parent is the
	// triggering work_item today, NOT a scene_event id — so an explicit Continue→session edge only
	// resolves when parent_event_id IS one of our marker nodes. Otherwise we fall back to inference.
	for (const ev of events) {
		if (ev.type !== 'spawn') continue;
		const sess = refOrUndef(ev.session);
		const parent = typeof ev.parent_event_id === 'string' ? ev.parent_event_id.trim() : '';
		if (!sess || !parent) continue;
		if (markerAt.has(parent) && markerAt.get(parent)!.kind === 'continue') {
			pushEdge(parent, sess, 'spawned', false);
			haveSpawned.add(sess);
		}
	}

	// (3b) Continue → session  — INFERRED (the common case: the spawn's parent is a work_item, not a
	// marker). Attach each session WITHOUT an explicit spawned edge to the NEAREST PRECEDING Continue
	// marker within the inference window (same project; the marker rooted the drain that spawned it).
	const continueNodes = nodes
		.filter((n) => n.kind === 'continue')
		.map((n) => ({ id: n.id, ms: markerAt.get(n.id)?.ms }))
		.filter((c): c is { id: string; ms: number } => c.ms != null)
		.sort((a, b) => a.ms - b.ms);
	for (const s of sessions) {
		const sid = String(s.id);
		if (haveSpawned.has(sid)) continue;
		const sms = sessionStart.get(sid);
		if (sms == null || !continueNodes.length) continue;
		// Nearest Continue at/before the session start, within the window.
		let best: { id: string; ms: number } | undefined;
		for (const c of continueNodes) {
			if (c.ms <= sms && sms - c.ms <= lim.inferenceWindowMs) {
				if (!best || c.ms > best.ms) best = c;
			}
		}
		if (best) {
			pushEdge(best.id, sid, 'spawned', true);
			haveSpawned.add(sid);
		}
	}

	// (4) session → outcome  — the completion agent_event links the session to its terminal outcome.
	// The terminal STATE already lives on the session node (status); the completion is the evidence.
	// We DON'T add a node for the completion (it is not a lifecycle node) — its role is to mark a
	// session as a finisher so (5) can attach the reported-to edge to the PM only for FINISHED work.
	const finished = new Set<string>();
	for (const ev of events) {
		if (ev.type !== 'completion') continue;
		const sess = refOrUndef(ev.session);
		if (sess && nodeIds.has(sess)) finished.add(sess);
	}

	// (5) session → PM  — INFERRED (the pm-autonomous re-tick is in-memory only; no persisted link —
	// LIFECYCLE-GRAPH-SPEC §Edges-INFERRED). On finish, a session reports to the NEAREST FOLLOWING PM
	// marker within the window. Only FINISHED sessions report (an in-flight session has not reported
	// yet). Marked inferred=true — honest (F-008), never presented as a real link.
	const pmMarkers = nodes
		.filter((n) => n.kind === 'pm')
		.map((n) => ({ id: n.id, ms: markerAt.get(n.id)?.ms }))
		.filter((p): p is { id: string; ms: number } => p.ms != null)
		.sort((a, b) => a.ms - b.ms);
	for (const sid of finished) {
		if (haveReported.has(sid)) continue;
		const sms = sessionStart.get(sid);
		if (sms == null || !pmMarkers.length) continue;
		// Nearest PM tick at/after the session start, within the window (the tick fired on its done).
		let best: { id: string; ms: number } | undefined;
		for (const p of pmMarkers) {
			if (p.ms >= sms && p.ms - sms <= lim.inferenceWindowMs) {
				if (!best || p.ms < best.ms) best = p;
			}
		}
		if (best) {
			pushEdge(sid, best.id, 'reported-to', true);
			haveReported.add(sid);
		}
	}

	// Stable, deterministic order: nodes oldest-first (the chain grows forward); a node without a
	// timestamp sorts last (id-tiebroken) so the order is reproducible across reads.
	nodes.sort((a, b) => {
		const am = a.startedAt ? new Date(a.startedAt).getTime() : Number.POSITIVE_INFINITY;
		const bm = b.startedAt ? new Date(b.startedAt).getTime() : Number.POSITIVE_INFINITY;
		if (am !== bm) return am - bm;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	edges.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
		if (a.from !== b.from) return a.from < b.from ? -1 : 1;
		return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
	});

	return {
		project: safeProject,
		nodes,
		edges,
		complete: failedSources.length === 0,
		failedSources,
		capped
	};
}
