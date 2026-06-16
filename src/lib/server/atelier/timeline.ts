// server/atelier/timeline — G-C: the ATELIER-WIDE reasoning/actions/communications timeline
// (GLOBAL-TRANSCRIPT-SPEC §3/§6.1). A READ-ONLY aggregate that MERGES four already-persisted
// streams by timestamp into one typed, paginated (newest-first), scope-filterable timeline:
//
//   • message       (G-A)  — a session's turns: assistant_text / thinking / tool_use /
//                            tool_result / briefing prose, PLUS pushed-in communications
//                            (origin≠agent — operator interjects; drained peer messages).
//   • peer_message   (G-B)  — agent↔agent comms with status (pending/delivered/expired/…),
//                            so the timeline shows comms that NEVER reached a transcript row.
//   • panel_verdict         — PM/panel validation artifacts (approve/pushback + reasons).
//   • role_event            — workforce lifecycle (created/swap/staffed/retired/flip).
//
// CONTEXT (display-only): each entry is labelled by ACTOR (the session role / PM identity /
// sender→recipient for a comm / role slug) and PROJECT, joined from session / interview_run /
// role context. These labels are NEVER steering signals — origin/role/op carry the authority.
//
// BOUNDED BY CONSTRUCTION (F-014 / D-024): atelier-wide is large, so this is NEVER an unbounded
// scan. Each source is read newest-first with its OWN time-window + a `LIMIT pageSize+1`, then
// merged in memory and sliced to one page; pagination is a timestamp cursor (`before`). A
// failing source yields a PARTIAL timeline (mirrors composeBriefing's best-effort posture,
// F-008) — never a thrown page, never a fabricated entry.
//
// SECURITY (D-026): transcript / peer_message bodies are ALREADY screened+fenced at WRITE
// (G-A / G-B). This is a READ/display feature — it does NOT unscreen, re-fence, or reintroduce
// raw bodies; verdicts / role_events are harness-authored (safe). No new untrusted surface.
//
// BOUNDARY (D-016): every record-id flows through assertRecordId and binds as a StringRecordId;
// the ONLY interpolation is a parameterized clause SHAPE (never a value).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { rowTurnKind, normOrigin, type Turn } from '../../client/transcript-core';

// ── Bounds (frozen — §3 / F-014) ─────────────────────────────────────────────────────

/** Default page size (§5 D3: paginated, newest-first, ~50). */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard cap so a hostile `?size=` cannot turn the page into an unbounded scan. */
export const MAX_PAGE_SIZE = 200;
/** Default trailing window: 7 days of activity (tunable via `sinceMs`). */
export const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── The merged timeline entry ─────────────────────────────────────────────────────────

/** The scope a timeline read runs at. 'global' = atelier-wide; otherwise a single project id. */
export type TimelineScope = { kind: 'global' } | { kind: 'project'; project: string };

/** Which substrate stream an entry came from (audit / UI filter chip). */
export type TimelineSource = 'message' | 'peer_message' | 'panel_verdict' | 'role_event';

/** One merged timeline entry — a Turn (the shared renderer's shape) PLUS the merge metadata
 *  (its source, its ISO timestamp for ordering, and the session it belongs to when it is a
 *  session turn). All fields plain-serializable (F-013 — datetimes already ISO strings). */
export interface TimelineEntry {
	/** Stable key (the source row id). */
	id: string;
	/** The substrate stream (UI filter + audit). */
	source: TimelineSource;
	/** ISO-8601 timestamp the merge orders by (newest-first). */
	at: string;
	/** The session this entry belongs to, when it is a `message` turn (else absent). */
	session?: string;
	/** The normalized render turn the shared <SessionTranscript> displays. */
	turn: Turn;
}

export interface TimelinePage {
	/** True if the DB was reachable AND every source read succeeded; false ⇒ a PARTIAL
	 *  timeline (one or more sources failed — honest, never silently complete). */
	complete: boolean;
	/** The scope this page was read at (echoed back so the UI reflects the server's view). */
	scope: TimelineScope;
	/** The merged entries, NEWEST-FIRST, at most `pageSize`. */
	entries: TimelineEntry[];
	/** The cursor for the NEXT (older) page — pass as `before`. Null ⇒ no more (last page). */
	nextBefore: string | null;
	/** Names of sources that FAILED this read (honest partial — F-008). Empty when complete. */
	failedSources: TimelineSource[];
}

export interface TimelineQuery {
	scope?: TimelineScope;
	/** Page size (clamped 1..MAX_PAGE_SIZE). */
	pageSize?: number;
	/** Cursor: return only entries strictly OLDER than this ISO timestamp (newest-first paging). */
	before?: string | null;
	/** Trailing window floor in ms (entries older than now-sinceMs are excluded). */
	sinceMs?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** F-013/F-008: SurrealDB 2.x datetime (non-POJO) → ISO string; absent/unparseable → null. */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function str(v: unknown): string {
	return v == null ? '' : String(v);
}

function clampPageSize(n: number | undefined): number {
	if (!Number.isFinite(n as number) || (n as number) <= 0) return DEFAULT_PAGE_SIZE;
	return Math.min(Math.floor(n as number), MAX_PAGE_SIZE);
}

/** A short label for a record-link id ('table:abc' → 'abc') for actor/project display. Honest
 *  '—' for an absent value; never fabricated. */
function shortId(v: unknown): string {
	const s = str(v);
	if (!s) return '—';
	const i = s.indexOf(':');
	return i >= 0 ? s.slice(i + 1) : s;
}

// ── Source readers (each bounded: own time-window + LIMIT pageSize+1, newest-first) ──────
//
// Every reader takes the SAME (scope, cutoffIso, before, fetch) and returns TimelineEntry[]
// ordered newest-first. They project ONLY plain fields and coerce datetimes to ISO (F-013).
// `fetch` = pageSize + 1 so the merge can tell whether an older page exists.

type ScopeBind = { sql: string; bind: Record<string, unknown> };

/** Build the optional `project = $project` clause for a scoped read. For a per-project scope the
 *  caller decides whether the table HAS a project column (message/role_event do not directly — see
 *  their readers). Returns the clause fragment + the bind. */
function projectClause(scope: TimelineScope, column: string): ScopeBind {
	if (scope.kind === 'project') {
		return { sql: ` AND ${column} = $project`, bind: { project: link(scope.project) } };
	}
	return { sql: '', bind: {} };
}

/**
 * MESSAGE turns. A message has no direct project column — it is scoped THROUGH its session
 * (session.project). For a per-project read we filter `session.project = $project`; for global
 * we read all. Newest-first by `at` (the wall-clock stamp; seq is per-session so it cannot order
 * cross-session). Honest origin coalesce (m0038 legacy → 'agent'); the shared classifier turns a
 * pushed role/origin into a 'communication' turn for free.
 */
async function readMessages(
	db: Db,
	scope: TimelineScope,
	cutoffIso: string,
	before: string | null,
	fetch: number
): Promise<TimelineEntry[]> {
	const bind: Record<string, unknown> = { cutoff: new Date(cutoffIso), fetch };
	let projSql = '';
	if (scope.kind === 'project') {
		projSql = ' AND session.project = $project';
		bind.project = link(scope.project);
	}
	let beforeSql = '';
	if (before) {
		beforeSql = ' AND at < $before';
		bind.before = new Date(before);
	}
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				session: unknown;
				role: string;
				kind?: string;
				origin?: string;
				content: string;
				tool_call?: Record<string, unknown>;
				at: unknown;
				sproject?: unknown;
				srole?: unknown;
			}>
		]
	>(
		`SELECT id, session, role, kind, origin ?? "agent" AS origin, content, tool_call, at,
		        session.project AS sproject, session.role AS srole
		   FROM message
		  WHERE at >= $cutoff${projSql}${beforeSql}
		  ORDER BY at DESC LIMIT $fetch;`,
		bind
	);
	return (rows ?? []).map((r) => {
		const at = isoOrNull(r.at) ?? cutoffIso;
		const persisted = {
			id: String(r.id),
			role: r.role,
			...(r.kind != null ? { kind: r.kind } : {}),
			origin: r.origin ?? 'agent',
			content: str(r.content),
			...(r.tool_call ? { toolCall: r.tool_call } : {})
		};
		const kind = rowTurnKind(persisted);
		const origin = normOrigin(persisted.origin);
		const turn: Turn = {
			id: persisted.id,
			kind,
			content: persisted.content,
			...(kind === 'assistant'
				? { tag: r.role === 'user' ? 'user' : r.role === 'system' ? 'system' : 'assistant' }
				: {}),
			...(kind === 'communication' ? { origin } : {}),
			...(persisted.toolCall ? { toolCall: persisted.toolCall } : {}),
			actor: shortId(r.srole) !== '—' ? `${shortId(r.srole)}` : `session ${shortId(r.session)}`,
			project: shortId(r.sproject)
		};
		return { id: persisted.id, source: 'message' as const, at, session: str(r.session), turn };
	});
}

/**
 * PEER_MESSAGE comms (G-B). Surfaces comms incl. those that NEVER reached a transcript row
 * (pending / expired / quarantined) — the §5b inbox lens substrate. The body is the ALREADY-
 * FENCED envelope (D-026 — never unscreened). Rendered as a 'communication' Turn carrying the
 * server origin 'agent' (peer comms are DATA, non-steering — D-035a). Status + sender→recipient
 * fold into the actor label. Scoped by the message's own `project` column for a per-project read.
 */
async function readPeerMessages(
	db: Db,
	scope: TimelineScope,
	cutoffIso: string,
	before: string | null,
	fetch: number
): Promise<TimelineEntry[]> {
	const ps = projectClause(scope, 'project');
	const bind: Record<string, unknown> = { cutoff: new Date(cutoffIso), fetch, ...ps.bind };
	let beforeSql = '';
	if (before) {
		beforeSql = ' AND created_at < $before';
		bind.before = new Date(before);
	}
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				from_session: unknown;
				from_role: unknown;
				to_kind: string;
				to_session: unknown;
				to_role: unknown;
				project: unknown;
				body: string;
				status: string;
				created_at: unknown;
			}>
		]
	>(
		`SELECT id, from_session, from_role, to_kind, to_session, to_role, project, body, status, created_at
		   FROM peer_message
		  WHERE created_at >= $cutoff${ps.sql}${beforeSql}
		  ORDER BY created_at DESC LIMIT $fetch;`,
		bind
	);
	return (rows ?? []).map((r) => {
		const at = isoOrNull(r.created_at) ?? cutoffIso;
		const id = String(r.id);
		const from = r.from_role != null ? shortId(r.from_role) : `session ${shortId(r.from_session)}`;
		const to =
			r.to_kind === 'role'
				? shortId(r.to_role)
				: r.to_kind === 'session'
					? `session ${shortId(r.to_session)}`
					: r.to_kind; // pm / atelier — an identity address (§11 placeholder)
		const turn: Turn = {
			id,
			kind: 'communication',
			content: str(r.body),
			origin: 'agent', // peer comms are DATA (D-035a) — the renderer labels them 'communication'
			actor: `${from} → ${to} (${str(r.status)})`,
			project: shortId(r.project)
		};
		return { id, source: 'peer_message' as const, at, turn };
	});
}

/**
 * PANEL_VERDICT artifacts. project is option (NONE for project-less workforce artifacts); a
 * per-project read filters `project = $project`. Rendered as a 'verdict' Turn carrying the
 * decision + confidence + reasons (harness-authored — safe). Actor = the role slug if the
 * verdict is a catalog-role validation, else the validator session.
 */
async function readVerdicts(
	db: Db,
	scope: TimelineScope,
	cutoffIso: string,
	before: string | null,
	fetch: number
): Promise<TimelineEntry[]> {
	const ps = projectClause(scope, 'project');
	const bind: Record<string, unknown> = { cutoff: new Date(cutoffIso), fetch, ...ps.bind };
	let beforeSql = '';
	if (before) {
		beforeSql = ' AND at < $before';
		bind.before = new Date(before);
	}
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				project: unknown;
				verdict: string;
				confidence?: string;
				reasons?: string[];
				validator_session: unknown;
				role: unknown;
				artifact_kind: string;
				at: unknown;
			}>
		]
	>(
		`SELECT id, project, verdict, confidence, reasons, validator_session, role, artifact_kind, at
		   FROM panel_verdict
		  WHERE at >= $cutoff${ps.sql}${beforeSql}
		  ORDER BY at DESC LIMIT $fetch;`,
		bind
	);
	return (rows ?? []).map((r) => {
		const at = isoOrNull(r.at) ?? cutoffIso;
		const id = String(r.id);
		const actor =
			r.role != null ? shortId(r.role) : `validator ${shortId(r.validator_session)}`;
		const turn: Turn = {
			id,
			kind: 'verdict',
			content: str(r.artifact_kind),
			verdict: {
				decision: str(r.verdict),
				confidence: r.confidence != null ? str(r.confidence) : null,
				reasons: Array.isArray(r.reasons) ? r.reasons.map(str) : []
			},
			actor,
			project: shortId(r.project)
		};
		return { id, source: 'panel_verdict' as const, at, turn };
	});
}

/**
 * ROLE_EVENT workforce lifecycle. role_event has NO project column (workforce is project-less) —
 * so for a PER-PROJECT scope, role_events are NOT included (they belong to the global workforce
 * audit, not a project timeline). For GLOBAL they are read in full. Rendered as a 'role_event'
 * Turn carrying the op + role slug actor (harness-authored — safe). The `detail` object is shown
 * as a compact JSON line (it is harness-authored structured data, never raw agent content).
 */
async function readRoleEvents(
	db: Db,
	scope: TimelineScope,
	cutoffIso: string,
	before: string | null,
	fetch: number
): Promise<TimelineEntry[]> {
	// Per-project scope: role_events are project-less workforce audit — excluded (honest: they are
	// not a project's events). The caller still merges the other three sources for a project view.
	if (scope.kind === 'project') return [];
	const bind: Record<string, unknown> = { cutoff: new Date(cutoffIso), fetch };
	let beforeSql = '';
	if (before) {
		beforeSql = ' AND at < $before';
		bind.before = new Date(before);
	}
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				role: unknown;
				op: string;
				detail?: Record<string, unknown>;
				rslug?: unknown;
				at: unknown;
			}>
		]
	>(
		`SELECT id, role, op, detail, role.slug AS rslug, at
		   FROM role_event
		  WHERE at >= $cutoff${beforeSql}
		  ORDER BY at DESC LIMIT $fetch;`,
		bind
	);
	return (rows ?? []).map((r) => {
		const at = isoOrNull(r.at) ?? cutoffIso;
		const id = String(r.id);
		// detail is harness-authored structured data; show a compact one-line view (never raw agent text).
		let detail = '';
		if (r.detail && typeof r.detail === 'object') {
			try {
				detail = JSON.stringify(r.detail);
			} catch {
				detail = '';
			}
		}
		const turn: Turn = {
			id,
			kind: 'role_event',
			content: detail,
			op: str(r.op),
			actor: r.rslug != null ? shortId(r.rslug) : shortId(r.role),
			project: '—'
		};
		return { id, source: 'role_event' as const, at, turn };
	});
}

// ── The merge ────────────────────────────────────────────────────────────────────────

/**
 * Read ONE page of the atelier timeline, merged newest-first across the four sources. Each source
 * is read independently + BOUNDED (own window + LIMIT pageSize+1); a source that THROWS yields a
 * PARTIAL page (F-008 — `complete:false`, the source named in `failedSources`), never a thrown
 * page. The merged stream is sorted by `at` DESC (tiebroken by id for determinism), sliced to
 * `pageSize`, and `nextBefore` is the oldest kept entry's timestamp (null when the merge is short
 * of a full page — last page).
 *
 * SHADOW PATHS: nil/empty project scope id → throws at the D-016 chokepoint (a malformed scope id
 * is a real bug, fail-loud); an empty atelier → { entries:[], nextBefore:null, complete:true }
 * (honest empty); every source failing → an empty PARTIAL page (complete:false, all four named).
 */
export async function readAtelierTimeline(
	db: Db,
	query: TimelineQuery = {}
): Promise<TimelinePage> {
	const scope: TimelineScope = query.scope ?? { kind: 'global' };
	// Validate a per-project scope id EARLY (fail-loud at the boundary — a bad id is a bug, not a
	// honest-empty case). assertRecordId throws an IdentifierError on a malformed id.
	if (scope.kind === 'project') assertRecordId(scope.project);

	const pageSize = clampPageSize(query.pageSize);
	const fetch = pageSize + 1; // +1 across each source so the merge knows if an older page exists
	const before = query.before && query.before.length > 0 ? query.before : null;
	const windowMs = Number.isFinite(query.sinceMs as number) && (query.sinceMs as number) > 0
		? (query.sinceMs as number)
		: DEFAULT_WINDOW_MS;
	const cutoffIso = new Date(Date.now() - windowMs).toISOString();

	// Each source independently — a per-source failure is isolated (best-effort, composeBriefing
	// posture). NAME the failed source; never let one bad source sink the whole page.
	const readers: Array<{ source: TimelineSource; run: () => Promise<TimelineEntry[]> }> = [
		{ source: 'message', run: () => readMessages(db, scope, cutoffIso, before, fetch) },
		{ source: 'peer_message', run: () => readPeerMessages(db, scope, cutoffIso, before, fetch) },
		{ source: 'panel_verdict', run: () => readVerdicts(db, scope, cutoffIso, before, fetch) },
		{ source: 'role_event', run: () => readRoleEvents(db, scope, cutoffIso, before, fetch) }
	];

	const failedSources: TimelineSource[] = [];
	const settled = await Promise.all(
		readers.map(async (r) => {
			try {
				return await r.run();
			} catch (err) {
				failedSources.push(r.source);
				console.warn(
					`[atelier-timeline] source "${r.source}" failed (partial timeline): ${(err as Error).message}`
				);
				return [] as TimelineEntry[];
			}
		})
	);

	// Merge + sort newest-first. Tiebreak by id (descending) so equal timestamps are deterministic
	// across reads (a fast stream produces same-`at` ties; id keeps paging stable, no dup/skip).
	const merged = settled.flat();
	merged.sort((a, b) => {
		if (a.at !== b.at) return a.at < b.at ? 1 : -1;
		return a.id < b.id ? 1 : -1;
	});

	// One page; `nextBefore` only when MORE entries exist beyond the page boundary.
	const entries = merged.slice(0, pageSize);
	const hasMore = merged.length > pageSize;
	const nextBefore = hasMore && entries.length > 0 ? entries[entries.length - 1].at : null;

	return {
		complete: failedSources.length === 0,
		scope,
		entries,
		nextBefore,
		failedSources
	};
}
