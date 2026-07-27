// UO-2 (USAGE-OBSERVABILITY-SPEC) — the usage READ MODEL: aggregate the EXISTING persisted
// data to answer "what agents/hires/tasks use what tools/skills?". NO new write path — this
// module only READS two already-persisted sources and folds them:
//
//   • The GRANTED set — `session.granted_*` / `tool_allow` / `granted_intent` (UO-1, m0065):
//     the ACTUAL composed/effective grant a session was launched with (NOT the static
//     orchestration bundle — F-008). Read + normalized via {@link normGrantedRow}, mirroring
//     analytics/fleet's normGranted so granted-but-never-recorded reads as null, never a
//     fabricated empty grant.
//   • The USED set — `tool_use` `message` rows (launch.ts eventToMessage: kind='tool_use',
//     tool_call.name = the tool the agent actually invoked). The raw rows exist per session;
//     `session.tool_iter_count` is the TOTAL; this module computes the per-NAME breakdown that
//     never existed, plus a cross-session roll-up.
//
// Two read models:
//   (a) sessionToolBreakdown(db, sessionId) — ONE session's tool_use rows folded into
//       tool-name → count (+ the grand total). Honest-empty for a session that called no tools.
//   (b) usageRollup(db, opts) — the CROSS-SESSION attribution. For every GRANTED capability
//       (skill / agent / mcp / reserved / tool-allow) it lists the sessions/tasks/agents it was
//       granted to; for every USED tool it lists the sessions it ran in + a call count. A
//       capability that was GRANTED but never appears in any tool_use row is surfaced
//       distinctly (used=false / 0 calls) — the operator's "dead grant" view. GRANTED and USED
//       are kept rigorously DISTINCT: granting a skill never invents a usage row, and using a
//       tool never invents a grant.
//
// BOUNDED (F-014): every query carries an explicit LIMIT — NEVER an unbounded message-table
// scan. The session window and the per-session tool-row scan are both capped + the cap is
// surfaced on the result so a truncated read is HONEST (capped=true), not silently partial.
//
// These are plain READS off the DB singleton (§2.11) — no second live query. Capability/tool
// ids are opaque (D-026) and were already screened at the launch write; this layer only reads.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { GrantedCapabilities } from '../analytics/fleet';

/** Default cap on tool_use rows scanned for a single session's breakdown (F-014). */
export const DEFAULT_SESSION_TOOL_ROW_CAP = 5_000;
/** Default cap on sessions scanned for the cross-session roll-up (F-014). */
export const DEFAULT_ROLLUP_SESSION_CAP = 500;
/** Default cap on tool_use rows scanned across the roll-up window (F-014). */
export const DEFAULT_ROLLUP_TOOL_ROW_CAP = 50_000;

/** One tool's call count within a session. */
export interface ToolCount {
	/** The opaque tool name (tool_call.name) — e.g. "Bash", "Read", an mcp__ id. */
	tool: string;
	/** How many tool_use rows in this session named this tool. Always ≥ 1. */
	count: number;
}

/** The per-session tool-usage breakdown — the dimension `tool_iter_count` never had. */
export interface SessionToolBreakdown {
	sessionId: string;
	/** tool-name → count, sorted desc by count then name. Empty when the session called no tools. */
	tools: ToolCount[];
	/** Σ of all tool calls (the breakdown total). 0 for a session that called nothing (honest). */
	total: number;
	/**
	 * True when the scan hit the row cap (F-014) — the counts are a HONEST lower bound, not the
	 * whole session. The caller can raise `cap` or page. False when the session's full tool_use
	 * set fit under the cap.
	 */
	capped: boolean;
}

/**
 * A reference to a session that touched a capability/tool, with attribution labels.
 *
 * CHIP-WALL FIX (operator review 2026-07-26 §2): the /agents "granted to" / "used by" chips
 * rendered ~30 IDENTICAL `code-write` labels because the only discriminating field the UI could
 * reach was `intent` — `role` is unset on orchestrator-drained sessions (0/32 live). The rows
 * were never duplicates; the LABEL was. Every field below except `sessionId`/`taskId`/`roleId`/
 * `intent` was added to make the chips honestly distinguishable:
 *   • `startedAt`  — already in the roll-up's SELECT projection, previously dropped on the floor.
 *   • `taskTitle`  — the strongest discriminator (100% populated where a task exists), resolved
 *                    by ONE bounded lookup over the window's distinct task ids.
 *   • `roleName` / `roleSlug` — so the shared naming composer ($lib/shared/naming) can render a
 *                    PURPOSE, not a raw `role:…` record id (the standing operator naming rule).
 * Every one is honestly null when absent — never `str(undefined)` (F-013).
 */
export interface SessionRef {
	sessionId: string;
	/** The task record id the session ran for, or null (a workflow-step session has no task). */
	taskId: string | null;
	/**
	 * `task.title` for {@link taskId}, resolved by a bounded second lookup. null when the session
	 * has no task, when the task row was deleted (dangling link — honest, never fabricated), or
	 * when the title is blank.
	 */
	taskTitle: string | null;
	/**
	 * The workforce role record id the session ran AS (session.role — pm / hr-recruiter / coder),
	 * the "what agent" attribution, or null on a session with no role link (a plain task session).
	 * The session row carries no agent-slot field; role is the persisted agent identity (schema
	 * ON session role, m-role). Honest null when absent — never str(undefined) (F-013).
	 */
	roleId: string | null;
	/** `role.name` for {@link roleId} (bounded lookup); null when absent/dangling/blank. */
	roleName: string | null;
	/** `role.slug` for {@link roleId} (bounded lookup); null when absent/dangling/blank. */
	roleSlug: string | null;
	/** The resolved intent slug the session ran as (session.granted_intent, UO-1), or null. */
	intent: string | null;
	/** `session.started_at`, ISO-coerced (F-013). null when the column is absent/unparseable. */
	startedAt: string | null;
}

/** The capability dimension a granted id belongs to. */
export type CapabilityDimension = 'skill' | 'agent' | 'mcp' | 'reserved' | 'tool-allow';

/** One GRANTED capability rolled up across sessions — "skill X granted to sessions A/B/C". */
export interface GrantedCapabilityRollup {
	dimension: CapabilityDimension;
	/** The opaque capability id (skill/agent/mcp/reserved id, or an allow-listed tool name). */
	id: string;
	/** Distinct sessions this capability was GRANTED to (deduped, capped by the session window). */
	grantedTo: SessionRef[];
	/** Count of distinct sessions granted this capability. */
	grantedSessionCount: number;
	/**
	 * Whether this granted id was ever actually USED — only meaningful for the `tool-allow`
	 * dimension (the only granted dimension whose ids map 1:1 onto tool_use names). For
	 * skill/agent/mcp/reserved this is null (we cannot honestly map a granted skill id onto a
	 * tool_use row name — F-008, no fabricated linkage). A `tool-allow` id with used=false is a
	 * DEAD grant (granted, never invoked).
	 */
	used: boolean | null;
	/** Σ tool calls observed for this id across the window — only for `tool-allow` (else null). */
	usedCallCount: number | null;
}

/** One USED tool rolled up across sessions — "tool Bash called N times across M sessions". */
export interface UsedToolRollup {
	/** The opaque tool name (tool_call.name). */
	tool: string;
	/** Σ tool_use rows naming this tool across the window. */
	callCount: number;
	/** Distinct sessions that invoked this tool. */
	sessions: SessionRef[];
	/** Count of distinct sessions that invoked it. */
	sessionCount: number;
	/**
	 * Whether SOME session that used this tool had it on its `tool_allow` grant. null when none of
	 * the using sessions recorded a grant (legacy rows — we cannot honestly assert granted-ness).
	 * False means it was used by at least one session but never appeared on any of their grants
	 * (an UNGRANTED use — the inverse anomaly). Honest tri-state, never fabricated.
	 */
	wasGranted: boolean | null;
}

/** The cross-session usage roll-up — granted vs used, kept distinct (F-008). */
export interface UsageRollup {
	/** Every granted capability across the window, sorted by dimension then id. */
	granted: GrantedCapabilityRollup[];
	/** Every used tool across the window, sorted desc by callCount then name. */
	usedTools: UsedToolRollup[];
	/** The session window actually scanned. */
	sessionsScanned: number;
	/** True when the session window hit its cap (more sessions exist than were folded). */
	sessionsCapped: boolean;
	/** True when the tool_use scan hit its cap (more tool rows exist than were folded). */
	toolRowsCapped: boolean;
}

/** Options for {@link usageRollup}. All optional; defaults bound the scan (F-014). */
export interface UsageRollupOptions {
	/** Max sessions to fold (most recent first). Default {@link DEFAULT_ROLLUP_SESSION_CAP}. */
	sessionCap?: number;
	/** Max tool_use rows to fold. Default {@link DEFAULT_ROLLUP_TOOL_ROW_CAP}. */
	toolRowCap?: number;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Coerce a persisted granted-id column to a clean string[] (mirrors analytics/fleet.strList). */
function strList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * Normalize the persisted granted-capability columns on a session row → {@link GrantedCapabilities}
 * or null. A row where EVERY granted field is NONE/absent (a legacy row predating m0065, OR a
 * session that recorded nothing) reads as null — the honest "not recorded", never a fabricated
 * empty grant (F-008/F-013). Mirrors analytics/fleet.normGranted so both surfaces agree.
 */
function normGrantedRow(r: Record<string, unknown>): GrantedCapabilities | null {
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

/** Extract the opaque tool name from a tool_use row's tool_call blob; null when malformed/absent. */
function toolNameOf(toolCall: unknown): string | null {
	if (!toolCall || typeof toolCall !== 'object') return null;
	const name = (toolCall as Record<string, unknown>).name;
	if (typeof name !== 'string') return null;
	const t = name.trim();
	return t === '' ? null : t;
}

/** Coerce a possibly-RecordId column to its string id, or null when absent (never str(undefined)). */
function idOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = String(v);
	return s === '' ? null : s;
}

/**
 * Coerce a SurrealDB datetime column to an ISO string, or null (F-013 — the recurrent defect:
 * a raw SDK datetime escaping a `load` blows up devalue, and `String(undefined)` renders the
 * literal `"undefined"` in the UI).
 *
 * Shadow paths: nil → null · a `Date` → `.toISOString()` · an unparseable string → null (honest
 * unknown, never a fabricated timestamp) · a well-formed string → normalized ISO.
 */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	const s = String(v).trim();
	if (s === '' || s === 'undefined' || s === 'null') return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A non-empty trimmed string, or null. Blank/absent is NOT a name (F-008). */
function textOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = String(v).trim();
	return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

/**
 * Resolve a set of record ids to a `id → row` map with ONE bounded query.
 *
 * Used to hydrate the chip labels (task titles, role names) that make the /agents attribution
 * chips distinguishable. The lookup is a point read over ids that came out of the session window
 * itself, so it is O(distinct links) — never a table scan, and it carries its own LIMIT (F-014).
 * No `ORDER BY`, so there is no F-020 order-idiom obligation.
 *
 * Shadow paths, all named:
 *   • EMPTY id set          → `{}` with NO round-trip (a `WHERE id IN []` is a wasted query).
 *   • a MALFORMED id        → `assertRecordId` throws `IdentifierError`; that ONE id is skipped
 *                             (its chip keeps the honest null label) rather than failing the
 *                             whole roll-up. Ids here originate from the DB, so this is defense
 *                             in depth, not an expected path.
 *   • a DANGLING link       → the row simply does not come back; the map has no entry and the
 *                             caller renders null (honest, F-008 — never an invented title).
 *   • the query itself throws → propagates. A read fault is a real error and belongs to the
 *                             page-level catch; swallowing it would silently blank every label
 *                             (the "best-effort catch hides a developer bug" defect, F-020 sweep).
 */
async function fetchByIds<T extends { id: unknown }>(
	db: Db,
	table: 'task' | 'role',
	fields: string,
	ids: readonly string[]
): Promise<Map<string, T>> {
	const out = new Map<string, T>();
	if (ids.length === 0) return out;
	const links: StringRecordId[] = [];
	for (const id of ids) {
		try {
			links.push(link(id));
		} catch {
			continue; // IdentifierError on a malformed id → skip this one id, keep the roll-up.
		}
	}
	if (links.length === 0) return out;
	const [rows] = await db.query<[T[]]>(
		`SELECT ${fields} FROM ${table} WHERE id IN $ids LIMIT $lim;`,
		{ ids: links, lim: links.length }
	);
	for (const r of rows ?? []) {
		const id = idOrNull(r.id);
		if (id != null) out.set(id, r);
	}
	return out;
}

/**
 * (a) PER-SESSION tool breakdown — fold the session's `tool_use` `message` rows into
 * tool-name → count. The raw rows are written per launch.ts eventToMessage (kind='tool_use',
 * tool_call.name = the invoked tool); `session.tool_iter_count` is the grand total, this is the
 * per-tool breakdown that never existed.
 *
 * BOUNDED (F-014): scans at most `cap` tool_use rows for the session (NEVER the whole message
 * table) and reports `capped` when it hit the ceiling — an honest lower bound, never a silent
 * partial. ORDER BY seq keeps the scan deterministic (and the cap takes the EARLIEST rows).
 *
 * Shadow paths: a session with no tool_use rows → empty `tools` / total 0 / capped false (honest
 * empty, F-008); a row with a malformed/absent tool_call.name is skipped (counted toward neither a
 * fabricated "unknown" bucket nor the total). An invalid sessionId throws at the {@link link}
 * boundary (assertRecordId) — a named validation error, not a silent empty.
 */
export async function sessionToolBreakdown(
	db: Db,
	sessionId: string,
	cap = DEFAULT_SESSION_TOOL_ROW_CAP
): Promise<SessionToolBreakdown> {
	const sid = link(sessionId);
	const lim = Math.max(1, Math.floor(cap));
	// +1 probe row beyond the cap → detect truncation honestly without a second COUNT query.
	// F-020: every ORDER BY idiom (seq, at) MUST appear in the SELECT projection or SurrealDB
	// throws "Missing order idiom" at parse — so seq/at are selected even though only tool_call is read.
	const [rows] = await db.query<[Array<{ tool_call?: unknown; seq?: unknown; at?: unknown }>]>(
		`SELECT tool_call, seq, at FROM message
		   WHERE session = $sid AND kind = "tool_use"
		   ORDER BY seq ASC, at ASC LIMIT $lim;`,
		{ sid, lim: lim + 1 }
	);
	const raw = rows ?? [];
	const capped = raw.length > lim;
	const scanned = capped ? raw.slice(0, lim) : raw;

	const counts = new Map<string, number>();
	let total = 0;
	for (const r of scanned) {
		const name = toolNameOf(r.tool_call);
		if (name == null) continue; // malformed/absent → skip, never a fabricated bucket (F-008)
		counts.set(name, (counts.get(name) ?? 0) + 1);
		total += 1;
	}
	const tools: ToolCount[] = [...counts.entries()]
		.map(([tool, count]) => ({ tool, count }))
		.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
	return { sessionId, tools, total, capped };
}

/** Raw session projection the roll-up folds: id + attribution + the granted columns. */
interface RawRollupSession {
	id: unknown;
	task: unknown;
	role: unknown;
	started_at?: unknown;
	granted_skills?: unknown;
	granted_agents?: unknown;
	granted_mcp?: unknown;
	granted_reserved?: unknown;
	tool_allow?: unknown;
	granted_intent?: unknown;
}

/** Raw tool_use projection the roll-up folds: which session + the tool name. */
interface RawToolUseRow {
	session: unknown;
	tool_call?: unknown;
	at?: unknown;
}

/**
 * (b) CROSS-SESSION roll-up keyed by capability/tool. For every GRANTED capability (from UO-1's
 * persisted set) it lists the sessions/tasks/agents it was granted to; for every USED tool (from
 * tool_use rows) it lists the sessions + a call count. GRANTED-but-never-used is surfaced
 * distinctly: a `tool-allow` id with no matching tool_use → used=false (a DEAD grant); the
 * skill/agent/mcp/reserved dimensions carry used=null (we will not fabricate a mapping from a
 * granted skill id onto a tool_use name — F-008). GRANTED and USED stay rigorously DISTINCT.
 *
 * BOUNDED (F-014): two capped scans — the recent session window (sessionCap) and the tool_use
 * window (toolRowCap) — NEVER an unbounded message-table scan. Truncation is reported via
 * `sessionsCapped` / `toolRowsCapped`. The roll-up restricts the tool_use scan to the SAME session
 * window so granted/used attribution is over a consistent set.
 *
 * ATTRIBUTION LABELS (§2 chip-wall fix): each {@link SessionRef} is hydrated with `taskTitle` /
 * `roleName` / `roleSlug` / `startedAt` so the /agents chips can render a PURPOSE instead of ~30
 * copies of the same intent slug. `started_at` was already in the session projection (no SELECT
 * change ⇒ no new F-020 risk); the title/name come from two BOUNDED point lookups over the
 * window's distinct task/role links — never a scan.
 *
 * Shadow paths: no sessions / no tool rows → empty `granted` + `usedTools`, counts 0 (honest
 * empty, F-008); a session with NO recorded grant (legacy row, normGrantedRow → null) contributes
 * nothing to `granted` but its tool_use rows still count toward `usedTools` with wasGranted=null
 * (we cannot assert granted-ness for it); a tool_use row whose session is outside the window is
 * not folded (kept consistent with the granted set); a session with no task/role link, or a
 * DANGLING one, yields null labels (the chip falls back through the shared naming composer to an
 * honest placeholder — never an invented name).
 */
export async function usageRollup(db: Db, opts: UsageRollupOptions = {}): Promise<UsageRollup> {
	const sessionCap = Math.max(1, Math.floor(opts.sessionCap ?? DEFAULT_ROLLUP_SESSION_CAP));
	const toolRowCap = Math.max(1, Math.floor(opts.toolRowCap ?? DEFAULT_ROLLUP_TOOL_ROW_CAP));

	// Most-recent session window (+1 probe to detect truncation). Bounded — never the whole table.
	// F-020: started_at is in the ORDER BY → must be in the SELECT projection (else "Missing order idiom").
	const [sessionRows] = await db.query<[RawRollupSession[]]>(
		`SELECT id, task, role, started_at,
		        granted_skills, granted_agents, granted_mcp, granted_reserved, tool_allow, granted_intent
		   FROM session ORDER BY started_at DESC LIMIT $lim;`,
		{ lim: sessionCap + 1 }
	);
	const rawSessions = sessionRows ?? [];
	const sessionsCapped = rawSessions.length > sessionCap;
	const sessions = sessionsCapped ? rawSessions.slice(0, sessionCap) : rawSessions;

	// Hydrate the label dimensions the chips need (§2 chip-wall fix). `task` and `role` are LINKS
	// on the session row; without their titles/names every chip degrades to the intent slug and a
	// wall of ~30 identical labels. Two bounded point lookups over the window's DISTINCT ids —
	// small (live: 23 tasks, 8 roles) and independent, so they run concurrently.
	const distinctIds = (pick: (s: RawRollupSession) => unknown): string[] => {
		const set = new Set<string>();
		for (const s of sessions) {
			const id = idOrNull(pick(s));
			if (id != null) set.add(id);
		}
		return [...set];
	};
	const [taskById, roleById] = await Promise.all([
		fetchByIds<{ id: unknown; title?: unknown }>(db, 'task', 'id, title', distinctIds((s) => s.task)),
		fetchByIds<{ id: unknown; name?: unknown; slug?: unknown }>(
			db,
			'role',
			'id, name, slug',
			distinctIds((s) => s.role)
		)
	]);

	// Build a SessionRef + granted view per in-window session, indexed by id for the tool fold.
	const refById = new Map<string, SessionRef>();
	const grantedById = new Map<string, GrantedCapabilities | null>();
	for (const s of sessions) {
		const id = idOrNull(s.id);
		if (id == null) continue;
		const taskId = idOrNull(s.task);
		const roleId = idOrNull(s.role);
		const task = taskId != null ? taskById.get(taskId) : undefined;
		const role = roleId != null ? roleById.get(roleId) : undefined;
		refById.set(id, {
			sessionId: id,
			taskId,
			taskTitle: textOrNull(task?.title),
			roleId,
			roleName: textOrNull(role?.name),
			roleSlug: textOrNull(role?.slug),
			intent: s.granted_intent == null ? null : String(s.granted_intent),
			startedAt: isoOrNull(s.started_at)
		});
		grantedById.set(id, normGrantedRow(s as unknown as Record<string, unknown>));
	}

	// tool_use rows for the in-window sessions (+1 probe). Bounded by toolRowCap (F-014). We filter
	// to the window in JS (SurrealDB `IN` over many record links is awkward across point builds; the
	// cap already bounds the scan and the fold ignores out-of-window sessions).
	// F-020: `at` is in the ORDER BY → must appear in the SELECT projection.
	const [toolRows] = await db.query<[RawToolUseRow[]]>(
		`SELECT session, tool_call, at FROM message WHERE kind = "tool_use"
		   ORDER BY at DESC LIMIT $lim;`,
		{ lim: toolRowCap + 1 }
	);
	const rawTools = toolRows ?? [];
	const toolRowsCapped = rawTools.length > toolRowCap;
	const scannedTools = toolRowsCapped ? rawTools.slice(0, toolRowCap) : rawTools;

	// Fold tool_use → per-tool { callCount, session set } (only sessions in the window), plus a
	// per-(sessionId|toolName) call count so a tool-allow grant can be attributed to ITS sessions'
	// usage in a single pass (no per-grant rescan — bounded fold).
	const usedByTool = new Map<string, { callCount: number; sessionIds: Set<string> }>();
	const sessionToolCounts = new Map<string, number>(); // key: `${sessionId} ${tool}`
	for (const r of scannedTools) {
		const sessId = idOrNull(r.session);
		if (sessId == null || !refById.has(sessId)) continue; // out-of-window → ignore (consistency)
		const name = toolNameOf(r.tool_call);
		if (name == null) continue;
		const e = usedByTool.get(name) ?? { callCount: 0, sessionIds: new Set<string>() };
		e.callCount += 1;
		e.sessionIds.add(sessId);
		usedByTool.set(name, e);
		const stKey = `${sessId} ${name}`;
		sessionToolCounts.set(stKey, (sessionToolCounts.get(stKey) ?? 0) + 1);
	}

	// ── GRANTED roll-up: one entry per (dimension, id), listing the sessions it was granted to. ──
	// keyed "dimension id" so distinct dimensions with the same id never collide.
	const grantedMap = new Map<
		string,
		{ dimension: CapabilityDimension; id: string; sessionIds: Set<string> }
	>();
	const addGrant = (dimension: CapabilityDimension, id: string, sessionId: string) => {
		const key = `${dimension} ${id}`;
		const e = grantedMap.get(key) ?? { dimension, id, sessionIds: new Set<string>() };
		e.sessionIds.add(sessionId);
		grantedMap.set(key, e);
	};
	for (const [sessId, g] of grantedById) {
		if (g == null) continue; // legacy/unrecorded → contributes no grant (honest, F-008)
		for (const id of g.skills) addGrant('skill', id, sessId);
		for (const id of g.agents) addGrant('agent', id, sessId);
		for (const id of g.mcp) addGrant('mcp', id, sessId);
		for (const id of g.reserved) addGrant('reserved', id, sessId);
		for (const id of g.toolAllow) addGrant('tool-allow', id, sessId);
	}

	const granted: GrantedCapabilityRollup[] = [...grantedMap.values()]
		.map((e) => {
			const grantedTo = [...e.sessionIds]
				.map((id) => refById.get(id))
				.filter((r): r is SessionRef => r != null);
			// used/usedCallCount only meaningful for tool-allow (ids map onto tool_use names). For
			// other dimensions we honestly refuse to assert a mapping (used=null, F-008).
			let used: boolean | null = null;
			let usedCallCount: number | null = null;
			if (e.dimension === 'tool-allow') {
				// Count calls ONLY from sessions this id was granted to (attribution stays scoped to the
				// grant — a different session using the same tool is not THIS grant's usage).
				let calls = 0;
				for (const sid of e.sessionIds) calls += sessionToolCounts.get(`${sid} ${e.id}`) ?? 0;
				usedCallCount = calls;
				used = calls > 0;
			}
			return {
				dimension: e.dimension,
				id: e.id,
				grantedTo,
				grantedSessionCount: grantedTo.length,
				used,
				usedCallCount
			};
		})
		.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.id.localeCompare(b.id));

	// ── USED-tool roll-up: one entry per tool name actually invoked, with attribution. ──
	const usedTools: UsedToolRollup[] = [...usedByTool.entries()]
		.map(([tool, e]) => {
			const sessions = [...e.sessionIds]
				.map((id) => refById.get(id))
				.filter((r): r is SessionRef => r != null);
			// wasGranted: did ANY using session have this tool on its tool_allow grant? null when none
			// of the using sessions recorded a grant at all (legacy) — honest tri-state, never fabricated.
			let anyRecorded = false;
			let anyGranted = false;
			for (const sid of e.sessionIds) {
				const g = grantedById.get(sid);
				if (g == null) continue;
				anyRecorded = true;
				if (g.toolAllow.includes(tool)) anyGranted = true;
			}
			const wasGranted = anyRecorded ? anyGranted : null;
			return {
				tool,
				callCount: e.callCount,
				sessions,
				sessionCount: sessions.length,
				wasGranted
			};
		})
		.sort((a, b) => b.callCount - a.callCount || a.tool.localeCompare(b.tool));

	return {
		granted,
		usedTools,
		sessionsScanned: sessions.length,
		sessionsCapped,
		toolRowsCapped
	};
}
