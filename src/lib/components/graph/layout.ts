// LG-3 (LIFECYCLE-GRAPH-SPEC §LG-3) — PURE layout for the lifecycle node-graph.
//
// Takes the LG-2 read model (nodes + directed causal edges) and assigns each node a
// deterministic (col,row) grid cell + pixel (x,y), then routes each edge as a cubic
// path between the two node anchors. NO DOM, NO reactivity, NO randomness — same input
// ⇒ same output (stable across re-reads so a live append doesn't reshuffle the whole DAG).
//
// COLUMN = causal depth (left→right): the chain grows forward. Depth is the longest path
// from any root (a node with no incoming edge) following edge direction; a cycle (should
// never occur in a causal DAG, but we never trust input — shadow path) is broken by a
// visited-set so layout always terminates. ROW within a column = stable order by the LG-2
// node order (already time-sorted oldest-first), so nodes settle top-down by arrival.
//
// BOUNDED (F-014): the caller caps node count (LG-2 limits); layout is O(nodes+edges) with
// a single depth pass — no quadratic blowup. Shadow paths: empty graph → empty layout;
// an edge whose endpoint isn't a node is dropped (defensive — LG-2 guarantees no dangling
// edge, but layout never assumes it).

import type {
	LifecycleEdge,
	LifecycleNode,
	LifecycleNodeKind
} from '$lib/server/observability';

/** A node placed on the grid + canvas. Extends the read-model node with geometry. */
export interface PlacedNode extends LifecycleNode {
	/** Causal-depth column (0 = a root). */
	col: number;
	/** Row within the column (0-based, top-down). */
	row: number;
	/** Center x in canvas px. */
	x: number;
	/** Center y in canvas px. */
	y: number;
}

/** An edge resolved to canvas geometry + a cubic path string. */
export interface PlacedEdge extends LifecycleEdge {
	/** Source center. */
	x1: number;
	y1: number;
	/** Target center. */
	x2: number;
	y2: number;
	/** SVG cubic-bezier `d` from the source's right anchor to the target's left anchor. */
	path: string;
}

/** The laid-out graph + the canvas extent the SVG should size to. */
export interface GraphLayout {
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	/** Total canvas width in px (covers the rightmost node + node half-width + margin). */
	width: number;
	/** Total canvas height in px. */
	height: number;
}

/** Geometry constants (px). Exported so the component + tests agree on the box size. */
export const NODE_W = 200;
export const NODE_H = 84;
export const COL_GAP = 96; // horizontal gap between columns (depth steps)
export const ROW_GAP = 28; // vertical gap between rows in a column
export const MARGIN = 32; // canvas padding around the whole graph

const COL_STRIDE = NODE_W + COL_GAP;
const ROW_STRIDE = NODE_H + ROW_GAP;

/**
 * Compute the causal-depth column for every node: the longest directed path from a root.
 * Roots (no incoming edge) are depth 0. A cycle is broken by the on-stack set (layout must
 * terminate even on malformed input — shadow path). Unreachable orphan nodes get depth 0.
 */
function computeDepths(
	nodeIds: string[],
	adj: Map<string, string[]>,
	indeg: Map<string, number>
): Map<string, number> {
	const depth = new Map<string, number>();
	const onStack = new Set<string>();

	const visit = (id: string): number => {
		const cached = depth.get(id);
		if (cached !== undefined) return cached;
		if (onStack.has(id)) return 0; // cycle guard — treat the back-edge target as depth 0
		onStack.add(id);
		let d = 0;
		// depth(node) = 1 + max(depth(parents)); compute via the reverse — but we only have the
		// forward adjacency, so we compute longest path FROM roots by recursing on children and
		// pushing depth downstream. We instead derive depth from indegree-0 roots forward:
		// here `adj` is forward (from→to); we need each node's depth = max over its parents + 1.
		// Build it from the parents map passed via closure (parentsOf below).
		const parents = parentsOf.get(id) ?? [];
		for (const p of parents) {
			d = Math.max(d, visit(p) + 1);
		}
		onStack.delete(id);
		depth.set(id, d);
		return d;
	};

	// parentsOf: reverse adjacency (to→[from]). Built once.
	const parentsOf = new Map<string, string[]>();
	for (const [from, tos] of adj) {
		for (const to of tos) {
			const arr = parentsOf.get(to);
			if (arr) arr.push(from);
			else parentsOf.set(to, [from]);
		}
	}
	void indeg; // indeg kept for callers/clarity; depth derives from parentsOf

	for (const id of nodeIds) visit(id);
	return depth;
}

/**
 * Lay out the lifecycle graph. Deterministic + pure.
 *
 * Shadow paths (all four):
 *   • happy   — nodes + edges → columns by depth, rows by arrival order, edges as cubics.
 *   • nil     — undefined/null nodes → empty layout (the caller renders the empty state).
 *   • empty   — `{nodes:[],edges:[]}` → `{nodes:[],edges:[],width:MARGIN*2,height:MARGIN*2}`.
 *   • malformed — an edge endpoint missing from nodes is dropped (never throws).
 */
export function layoutGraph(
	nodes: LifecycleNode[] | null | undefined,
	edges: LifecycleEdge[] | null | undefined
): GraphLayout {
	const ns = Array.isArray(nodes) ? nodes : [];
	const es = Array.isArray(edges) ? edges : [];

	if (ns.length === 0) {
		return { nodes: [], edges: [], width: MARGIN * 2, height: MARGIN * 2 };
	}

	const idSet = new Set(ns.map((n) => n.id));
	// Forward adjacency + indegree over edges whose BOTH endpoints are real nodes (drop dangling).
	const adj = new Map<string, string[]>();
	const indeg = new Map<string, number>();
	for (const n of ns) indeg.set(n.id, 0);
	const liveEdges: LifecycleEdge[] = [];
	for (const e of es) {
		if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
		liveEdges.push(e);
		const arr = adj.get(e.from);
		if (arr) arr.push(e.to);
		else adj.set(e.from, [e.to]);
		indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	}

	const depth = computeDepths(
		ns.map((n) => n.id),
		adj,
		indeg
	);

	// Assign rows per column in the node array's existing order (LG-2 = oldest-first), so a
	// live append lands at the bottom of its column rather than reshuffling earlier nodes.
	const rowCursor = new Map<number, number>();
	const placed: PlacedNode[] = ns.map((n) => {
		const col = depth.get(n.id) ?? 0;
		const row = rowCursor.get(col) ?? 0;
		rowCursor.set(col, row + 1);
		return {
			...n,
			col,
			row,
			x: MARGIN + col * COL_STRIDE + NODE_W / 2,
			y: MARGIN + row * ROW_STRIDE + NODE_H / 2
		};
	});

	const byId = new Map(placed.map((p) => [p.id, p]));
	const placedEdges: PlacedEdge[] = liveEdges.map((e) => {
		const a = byId.get(e.from)!;
		const b = byId.get(e.to)!;
		// Anchor at the right edge of source, left edge of target (left→right flow).
		const x1 = a.x + NODE_W / 2;
		const y1 = a.y;
		const x2 = b.x - NODE_W / 2;
		const y2 = b.y;
		const midX = (x1 + x2) / 2;
		const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
		return { ...e, x1, y1, x2, y2, path };
	});

	let maxCol = 0;
	let maxRow = 0;
	for (const p of placed) {
		if (p.col > maxCol) maxCol = p.col;
		if (p.row > maxRow) maxRow = p.row;
	}
	const width = MARGIN * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
	const height = MARGIN * 2 + (maxRow + 1) * NODE_H + maxRow * ROW_GAP;

	return { nodes: placed, edges: placedEdges, width, height };
}

/** Short, screen-reader/tooltip-friendly noun for a node kind. */
export function nodeKindLabel(kind: LifecycleNodeKind): string {
	switch (kind) {
		case 'continue':
			return 'Continue';
		case 'session':
			return 'Agent session';
		case 'pm':
			return 'Project manager';
		case 'task':
			return 'Task';
	}
}
