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

/**
 * The causal edge kinds plus the lateral DATA-SHARED kind:
 *   • spawned / reported-to / proposed / follow-up — the causal CHAIN (vertical lineage).
 *   • messaged — a peer_message agent↔agent data-share (LATERAL, not causal). It is a REAL
 *     link (a persisted peer_message row), so `inferred:false`; the UI styles it distinctly
 *     ("data-shared") and EXCLUDES it from causal-lineage focus so a sideways data hop never
 *     reads as an ancestor/descendant in the chain (GUX-4 — honest, F-008).
 */
export type LifecycleEdgeKind = 'spawned' | 'reported-to' | 'proposed' | 'follow-up' | 'messaged';

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
	/** The task description (task node, or the session's task) — screened at source (D-026). Omitted
	 *  when absent (F-008: never str(undefined)). Bounded — the popover truncates for display. */
	description?: string;
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
export type LifecycleSource =
	| 'scene_event'
	| 'session'
	| 'task'
	| 'agent_event'
	| 'tool_use'
	| 'peer_message';

/** One tool name + the count of times a session invoked it (per-tool breakdown). */
export interface LifecycleToolCount {
	/** The opaque tool name (tool_call.name) — e.g. "Bash", "Read", an mcp__ id. D-026 opaque. */
	tool: string;
	/** How many tool_use rows in this session named this tool. Always ≥ 1. */
	count: number;
}

/**
 * Per-session DETAIL threaded onto a session node for the LG-3 popover (LIFECYCLE-GRAPH-SPEC):
 * token usage + cost + a per-tool breakdown, all DERIVED from REAL rows (F-008). Every field is
 * OMITTED when its source row is absent — never str(undefined), never a fabricated 0/$ (an unpriced
 * model leaves `costUsd` absent; a session that called no tools has an empty `tools` + total 0).
 */
export interface LifecycleNodeDetail {
	/** Σ tokens_in across the session's agent_event rows; omitted when none recorded. */
	tokensIn?: number;
	/** Σ tokens_out across the session's agent_event rows; omitted when none recorded. */
	tokensOut?: number;
	/** Σ cost_usd across PRICED agent_event rows only (F-008); omitted when nothing priced. */
	costUsd?: number;
	/** Σ duration_ms across the session's agent_event rows; omitted when none recorded. */
	durationMs?: number;
	/** Per-tool call counts (desc by count then name), from tool_use message rows. Empty when none. */
	tools: LifecycleToolCount[];
	/** Σ of all tool calls (the breakdown total). 0 for a session that called nothing (honest). */
	toolTotal: number;
	/** True when the per-tool scan hit its row cap — the counts are an honest lower bound (F-014). */
	toolsCapped: boolean;
}

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
	/**
	 * Per-session DETAIL keyed by session node id — token usage / cost / per-tool breakdown for
	 * the LG-3 popover. ONLY session nodes get an entry, and ONLY when at least one detail signal
	 * exists (an absent key ⇒ the node has no recorded usage yet → the popover shows honest '—').
	 */
	details: Record<string, LifecycleNodeDetail>;
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
	/** Max tool_use message rows scanned across ALL in-window sessions for the per-tool breakdown. */
	toolRows?: number;
	/** Max peer_message rows scanned (most-recent first) for the lateral data-shared edges. */
	peerMessages?: number;
}

const DEFAULT_LIMITS: Required<LifecycleGraphLimits> = {
	markers: 100,
	sessions: 200,
	tasks: 200,
	agentEvents: 2000,
	// 30 min — a Continue drain's sessions spawn within minutes; a session→PM re-tick fires on
	// the task-terminal change. A generous-but-bounded window keeps the heuristic honest.
	inferenceWindowMs: 30 * 60 * 1000,
	// The per-tool breakdown scans tool_use rows ACROSS every in-window session in one bounded
	// query — capped so a busy project never triggers an unbounded message-table scan (F-014).
	toolRows: 20_000,
	// The lateral data-shared (peer_message) edges scan recent peer rows for the project — capped
	// (F-014); only rows whose BOTH endpoints are session nodes IN the graph become edges.
	peerMessages: 500
};

/**
 * The scene_event PM marker kinds that root a PM node.
 *   • `pm_tick`   (LG-1; m0066) — "the PM woke up" (an autonomous re-tick outcome).
 *   • `pm_review` (m0085; COMPLETION-LEDGER Wave A) — "the PM read the project and decided". The
 *     substantive pass: it examines live tasks/findings/risks, writes typed memories, and proposes.
 *     It emitted no scene_event at all before this wave, so the PM's actual THINKING was absent
 *     from the graph of the PM's own lifecycle.
 * Both project onto the same `pm` node family (same lane, same edge rules); they differ in label
 * and status so a reader can tell a wake from a decision. The Continue roots (`continue`/
 * `batch_drained`) are matched inline at read.
 */
const PM_TICK_KIND = 'pm_tick';
const PM_REVIEW_KIND = 'pm_review';
const PM_KINDS: ReadonlySet<string> = new Set([PM_TICK_KIND, PM_REVIEW_KIND]);

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

/** A finite, non-negative number → itself, else undefined (an absent figure is omitted, not 0). */
function numOrUndef(v: unknown): number | undefined {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
	return v;
}

/** Extract the opaque tool name from a tool_use row's tool_call blob; null when malformed/absent. */
function toolNameOf(toolCall: unknown): string | null {
	if (!toolCall || typeof toolCall !== 'object') return null;
	const name = (toolCall as Record<string, unknown>).name;
	if (typeof name !== 'string') return null;
	const t = name.trim();
	return t === '' ? null : t;
}

/** A free-text description column → trimmed non-empty string, or undefined when absent/blank.
 *  Screened at source (D-026); never str(undefined) (F-008). Length is left to the UI to bound. */
function descOrUndef(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const t = v.trim();
	return t === '' ? undefined : t;
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
	if (kind === PM_REVIEW_KIND) {
		// The review's OWN verdict, in the PM's terms: what it wrote and what it proposed. Falls back
		// to the bare kind when the meta is absent — never a fabricated count (F-008).
		const wrote = typeof meta?.memoriesWritten === 'number' ? meta.memoriesWritten : undefined;
		const proposed = typeof meta?.proposalsMade === 'number' ? meta.proposalsMade : undefined;
		if (wrote === undefined && proposed === undefined) return 'PM review';
		return `PM review: ${wrote ?? 0} memo, ${proposed ?? 0} proposed`;
	}
	if (kind === PM_TICK_KIND) {
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
	tdesc?: unknown; // joined task.description
}
interface RawTask {
	id: unknown;
	title?: string;
	description?: string;
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
/** A token/cost/duration row off agent_event (for the per-session usage detail). */
interface RawUsage {
	session?: unknown;
	tokens_in?: unknown;
	tokens_out?: unknown;
	cost_usd?: unknown;
	duration_ms?: unknown;
	at?: unknown; // selected only to satisfy the ORDER BY idiom (F-020); never read in the fold
}
/** A tool_use message row off the message table (for the per-session tool breakdown). */
interface RawToolUse {
	session?: unknown;
	tool_call?: unknown;
}
/** A peer_message row off the fleet bus (for the lateral data-shared edges). Body is NEVER
 *  selected — only the routing coordinates (D-026: no transcript/secret leaks to the graph). */
interface RawPeer {
	from_session?: unknown;
	to_session?: unknown;
	status?: unknown;
}

// ── Bounded source readers (each: own LIMIT, project-scoped, newest-first) ────────────────

/** Continue/PM marker scene_events for the project (most-recent first, capped). */
async function readMarkers(db: Db, project: StringRecordId, lim: number): Promise<RawMarker[]> {
	const [rows] = await db.query<[RawMarker[]]>(
		// F-020: `at` is BOTH the ORDER BY idiom AND in the projection. Do not remove it.
		// `pm_review` (m0085) joins the marker vocabulary — without it here the emitted rows exist
		// in the table and are still invisible in the graph, i.e. only half the fix.
		`SELECT id, kind, at, meta FROM scene_event
		  WHERE project = $project
		    AND kind IN ["continue","batch_drained","pm_tick","pm_review"]
		  ORDER BY at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/** Session rows for the project (most-recent first, capped) with the task title joined. */
async function readSessions(db: Db, project: StringRecordId, lim: number): Promise<RawSession[]> {
	const [rows] = await db.query<[RawSession[]]>(
		`SELECT id, task, role, role_version, status, tool_iter_count, granted_skills,
		        started_at, ended_at, task.title AS ttitle, task.description AS tdesc
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
		`SELECT id, title, description, status, proposed_by, provenance, revision_of, parent, created_at
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

/** Token/cost/duration agent_event rows for the project (capped) — folded per-session for detail. */
async function readUsage(db: Db, project: StringRecordId, lim: number): Promise<RawUsage[]> {
	// F-020: every ORDER BY idiom (`at`) MUST appear in the SELECT projection or SurrealDB throws
	// "Missing order idiom" at parse — so `at` is selected even though the fold never reads it.
	const [rows] = await db.query<[RawUsage[]]>(
		`SELECT session, tokens_in, tokens_out, cost_usd, duration_ms, at FROM agent_event
		  WHERE project = $project
		    AND (tokens_in != NONE OR tokens_out != NONE OR cost_usd != NONE OR duration_ms != NONE)
		  ORDER BY at DESC LIMIT $lim;`,
		{ project, lim }
	);
	return rows ?? [];
}

/**
 * tool_use message rows for a bounded set of sessions (the in-window session ids), in ONE query.
 * F-020: `seq`/`at` would need to be SELECTed if ordered by; we don't ORDER (we only count names),
 * so a bare project-scoped session-IN scan with a hard LIMIT is correct + bounded (F-014).
 */
async function readToolUse(
	db: Db,
	sessionIds: StringRecordId[],
	lim: number
): Promise<RawToolUse[]> {
	if (sessionIds.length === 0) return [];
	const [rows] = await db.query<[RawToolUse[]]>(
		`SELECT session, tool_call FROM message
		  WHERE kind = "tool_use" AND session IN $sids
		  LIMIT $lim;`,
		{ sids: sessionIds, lim }
	);
	return rows ?? [];
}

/**
 * Recent peer_message rows for the project (most-recent first, capped) — the LATERAL data-shared
 * edges. Selects ONLY the routing coordinates (from_session, to_session, status) — NEVER `body`
 * (D-026: no screened-or-not transcript reaches the graph; the routing endpoints are opaque ids).
 * F-020: the ORDER BY idiom (`created_at`) is in the SELECT projection. Both endpoints must be
 * session nodes in the graph for a row to become an edge (filtered in the fold — no dangling edge).
 */
async function readPeerMessages(db: Db, project: StringRecordId, lim: number): Promise<RawPeer[]> {
	const [rows] = await db.query<[Array<RawPeer & { created_at?: unknown }>]>(
		`SELECT from_session, to_session, status, created_at FROM peer_message
		  WHERE project = $project AND to_session != NONE
		  ORDER BY created_at DESC LIMIT $lim;`,
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
			capped: false,
			details: {}
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

	const [rawMarkers, rawSessions, rawTasks, rawEvents, rawUsage, rawPeers] = await Promise.all([
		run('scene_event', () => readMarkers(db, project, lim.markers + 1)),
		run('session', () => readSessions(db, project, lim.sessions + 1)),
		run('task', () => readTasks(db, project, lim.tasks + 1)),
		run('agent_event', () => readAgentEvents(db, project, lim.agentEvents + 1)),
		run('agent_event', () => readUsage(db, project, lim.agentEvents + 1)),
		run('peer_message', () => readPeerMessages(db, project, lim.peerMessages + 1))
	]);

	// Detect + trim per-source truncation (F-014 — honest cap, never a silent partial).
	const markersCapped = rawMarkers.length > lim.markers;
	const sessionsCapped = rawSessions.length > lim.sessions;
	const tasksCapped = rawTasks.length > lim.tasks;
	const eventsCapped = rawEvents.length > lim.agentEvents;
	const peersCapped = rawPeers.length > lim.peerMessages;
	const markers = markersCapped ? rawMarkers.slice(0, lim.markers) : rawMarkers;
	const sessions = sessionsCapped ? rawSessions.slice(0, lim.sessions) : rawSessions;
	const tasks = tasksCapped ? rawTasks.slice(0, lim.tasks) : rawTasks;
	const events = eventsCapped ? rawEvents.slice(0, lim.agentEvents) : rawEvents;
	const peers = peersCapped ? rawPeers.slice(0, lim.peerMessages) : rawPeers;
	const capped = markersCapped || sessionsCapped || tasksCapped || eventsCapped || peersCapped;

	// ── Project the nodes ──────────────────────────────────────────────────────────────
	const nodes: LifecycleNode[] = [];

	// Continue + PM marker nodes (the causal roots / PM hubs).
	for (const m of markers) {
		const id = String(m.id);
		const meta = m.meta && typeof m.meta === 'object' ? m.meta : undefined;
		const kind: LifecycleNodeKind = PM_KINDS.has(m.kind) ? 'pm' : 'continue';
		const at = isoOrUndef(m.at);
		nodes.push({
			id,
			kind,
			label: markerLabel(m.kind, meta),
			// A wake ('tick') and a decision ('review') are different PM moments — the status keeps
			// them distinguishable on the node without needing a second node family.
			status: m.kind === PM_REVIEW_KIND ? 'review' : m.kind === PM_TICK_KIND ? 'tick' : 'drained',
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
		const desc = descOrUndef(s.tdesc);
		nodes.push({
			id,
			kind: 'session',
			label: title ? `session: ${title}` : 'session',
			status: s.status ?? 'running',
			...(desc ? { description: desc } : {}),
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
		const desc = descOrUndef(t.description);
		nodes.push({
			id,
			kind: 'task',
			label: title ? title : 'task',
			status: t.status ?? 'backlog',
			...(desc ? { description: desc } : {}),
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
			kind: PM_KINDS.has(m.kind) ? 'pm' : 'continue',
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

	// (6) session → session  — DATA-SHARED (peer_message, the CV/BL-4 fleet bus). A LATERAL, REAL
	// link (inferred:false): the operator's "what data flowed between nodes" read. ONLY rows whose
	// BOTH endpoints resolve to session nodes IN this graph become edges (no dangling, no fabricated
	// connection — F-008); a self-message (from==to) and a duplicate pair are collapsed to ONE edge
	// (the graph shows THAT two sessions exchanged data, not how many times). Body is never read
	// (D-026 — the reader never SELECTs it).
	const haveMessaged = new Set<string>(); // `from→to` already drawn (collapse repeats)
	for (const p of peers) {
		const from = refOrUndef(p.from_session);
		const to = refOrUndef(p.to_session);
		if (!from || !to || from === to) continue; // need both endpoints; never a self-loop
		if (!nodeIds.has(from) || !nodeIds.has(to)) continue; // both must be in-graph nodes
		const key = `${from} ${to}`;
		if (haveMessaged.has(key)) continue;
		haveMessaged.add(key);
		pushEdge(from, to, 'messaged', false);
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

	// ── Per-session DETAIL (popover): token usage / cost / per-tool breakdown ───────────────
	// All DERIVED from REAL rows (F-008). A session with no recorded usage gets NO entry (the
	// popover then shows honest '—'); an unpriced model leaves costUsd absent (never fake $).
	const sessionNodeIds = new Set(nodes.filter((n) => n.kind === 'session').map((n) => n.id));

	// (a) Token/cost/duration — fold the usage rows per session (Σ each signal; cost only when priced).
	interface UsageAcc { tokensIn: number; tokensOut: number; costUsd: number; durationMs: number;
		hasIn: boolean; hasOut: boolean; hasCost: boolean; hasDur: boolean; }
	const usageBy = new Map<string, UsageAcc>();
	for (const u of rawUsage) {
		const sid = refOrUndef(u.session);
		if (!sid || !sessionNodeIds.has(sid)) continue; // only sessions IN the rendered node set
		const acc = usageBy.get(sid) ?? {
			tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0,
			hasIn: false, hasOut: false, hasCost: false, hasDur: false
		};
		const ti = intOrUndef(u.tokens_in);
		const to = intOrUndef(u.tokens_out);
		const c = numOrUndef(u.cost_usd);
		const d = intOrUndef(u.duration_ms);
		if (ti != null) { acc.tokensIn += ti; acc.hasIn = true; }
		if (to != null) { acc.tokensOut += to; acc.hasOut = true; }
		if (c != null) { acc.costUsd += c; acc.hasCost = true; }
		if (d != null) { acc.durationMs += d; acc.hasDur = true; }
		usageBy.set(sid, acc);
	}

	// (b) Per-tool breakdown — ONE bounded tool_use scan over the in-window session ids (F-014).
	const sessionLinks: StringRecordId[] = [];
	for (const id of sessionNodeIds) {
		try {
			sessionLinks.push(link(id));
		} catch {
			// A session id that doesn't pass the record-id guard is skipped (defensive — node ids
			// come from real rows so this should never fire; never throws the whole read).
		}
	}
	let rawTools: RawToolUse[] = [];
	if (sessionLinks.length > 0) {
		rawTools = await run('tool_use', () => readToolUse(db, sessionLinks, lim.toolRows + 1));
	}
	const toolsCappedAll = rawTools.length > lim.toolRows;
	const scannedTools = toolsCappedAll ? rawTools.slice(0, lim.toolRows) : rawTools;
	const toolsBy = new Map<string, Map<string, number>>();
	for (const r of scannedTools) {
		const sid = refOrUndef(r.session);
		if (!sid || !sessionNodeIds.has(sid)) continue;
		const name = toolNameOf(r.tool_call);
		if (name == null) continue; // malformed/absent → skip, never a fabricated bucket (F-008)
		const m = toolsBy.get(sid) ?? new Map<string, number>();
		m.set(name, (m.get(name) ?? 0) + 1);
		toolsBy.set(sid, m);
	}

	// (c) Assemble the details map — only for sessions with at least one detail signal.
	const details: Record<string, LifecycleNodeDetail> = {};
	const detailSessions = new Set<string>([...usageBy.keys(), ...toolsBy.keys()]);
	for (const sid of detailSessions) {
		const u = usageBy.get(sid);
		const tm = toolsBy.get(sid);
		const tools: LifecycleToolCount[] = tm
			? [...tm.entries()]
					.map(([tool, count]) => ({ tool, count }))
					.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
			: [];
		const toolTotal = tools.reduce((s, t) => s + t.count, 0);
		details[sid] = {
			...(u?.hasIn ? { tokensIn: u.tokensIn } : {}),
			...(u?.hasOut ? { tokensOut: u.tokensOut } : {}),
			...(u?.hasCost ? { costUsd: u.costUsd } : {}),
			...(u?.hasDur ? { durationMs: u.durationMs } : {}),
			tools,
			toolTotal,
			toolsCapped: toolsCappedAll
		};
	}

	return {
		project: safeProject,
		nodes,
		edges,
		complete: failedSources.length === 0,
		failedSources,
		capped: capped || toolsCappedAll,
		details
	};
}
