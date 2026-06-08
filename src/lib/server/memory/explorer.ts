// TASK 6.6 — /memory explorer read-projections (UI-SPEC §43 /memory; F-008; D-015).
//
// Read-only projections for the global memory explorer UI: a recall LIST (recent active
// memory rows, ranked by importance) and a knowledge-GRAPH view (entity nodes + their
// typed `references` edges). Pure reads, no LLM, no embedding call — the UI renders LIVE
// rows or an honest empty state (F-008); nothing is fabricated.
//
// Soft-archive read-guard (D-015): archived/superseded rows are RETURNED (the UI dims
// them per UI-SPEC §155/§156) but flagged via `status`; quarantined secrets are EXCLUDED
// outright (D-026 — a quarantined secret is never embedded, recalled, OR surfaced).
// Boundary discipline (D-016): values bind via $param; no interpolated ids.

import type { Db } from '../db/client';

/** One memory row projected for the recall list. Content is already screen-clean. */
export interface MemoryRow {
	id: string;
	content: string;
	kind: string;
	scope: string;
	tier: number;
	importance: number;
	project?: string;
	tags?: string[];
	status: 'active' | 'archived' | 'superseded';
	createdAt?: string;
}

/** A knowledge-graph node (entity). */
export interface GraphNodeRow {
	id: string;
	label: string;
	type: string;
	status: 'active' | 'archived' | 'superseded';
}

/** A typed edge between two graph nodes. */
export interface GraphEdgeRow {
	from: string;
	to: string;
	kind: string;
}

/** The full graph projection for the explorer. */
export interface MemoryGraph {
	nodes: GraphNodeRow[];
	edges: GraphEdgeRow[];
}

/**
 * List recent memory rows for the recall list, ranked by importance then recency. Excludes
 * quarantined rows (never surfaced — D-026); includes archived/superseded so the UI can dim
 * them (UI-SPEC §156). Returns [] when the store is empty (honest empty state, F-008).
 */
export async function listMemories(db: Db, limit = 100): Promise<MemoryRow[]> {
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				content: string;
				kind: string;
				scope: string;
				tier: number;
				importance: number;
				project?: unknown;
				tags?: string[];
				status: 'active' | 'archived' | 'superseded';
				created_at?: unknown;
			}>
		]
	>(
		`SELECT id, content, kind, scope, tier, importance, project, tags, status, created_at
		   FROM memory
		  WHERE screen_status != "quarantined"
		  ORDER BY importance DESC, created_at DESC
		  LIMIT $limit;`,
		{ limit }
	);
	return rows.map((r) => ({
		id: String(r.id),
		content: r.content,
		kind: r.kind,
		scope: r.scope,
		tier: r.tier,
		importance: r.importance,
		...(r.project != null ? { project: String(r.project) } : {}),
		...(Array.isArray(r.tags) && r.tags.length ? { tags: r.tags } : {}),
		status: r.status ?? 'active',
		...(r.created_at != null ? { createdAt: String(r.created_at) } : {})
	}));
}

/**
 * Build the knowledge-graph projection: every entity node plus the typed `references`
 * edges between entities (the navigable topic graph from the auto-memory import, D-032).
 * Archived/superseded nodes are returned flagged (dimmed in the UI), not hidden. Returns
 * empty arrays when no graph exists (honest empty state, F-008).
 */
export async function listGraph(db: Db, nodeLimit = 300): Promise<MemoryGraph> {
	const [nodeRows] = await db.query<
		[Array<{ id: unknown; label: string; type: string; status: 'active' | 'archived' | 'superseded' }>]
	>(
		`SELECT id, label, type, status FROM entity ORDER BY status ASC, label ASC LIMIT $nodeLimit;`,
		{ nodeLimit }
	);
	const nodes: GraphNodeRow[] = nodeRows.map((n) => ({
		id: String(n.id),
		label: n.label,
		type: n.type,
		status: n.status ?? 'active'
	}));

	// Edges between entity nodes only (the topic graph). in/out are record links.
	const [edgeRows] = await db.query<[Array<{ in: unknown; out: unknown; kind: string }>]>(
		`SELECT in, out, kind FROM references
		  WHERE meta::tb(in) = "entity" AND meta::tb(out) = "entity";`
	);
	const nodeIds = new Set(nodes.map((n) => n.id));
	const edges: GraphEdgeRow[] = edgeRows
		.map((e) => ({ from: String(e.in), to: String(e.out), kind: e.kind }))
		.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

	return { nodes, edges };
}
