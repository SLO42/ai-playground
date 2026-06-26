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

/** One column (causal-rank) band — drives the n8n-style column header + rhythm guides. */
export interface GraphColumn {
	/** The causal-depth rank this column represents (0 = roots). */
	col: number;
	/** Left x of the column band (px). */
	x: number;
	/** Center x of the column (where the cards + header center). */
	centerX: number;
	/** Column band width (px). */
	width: number;
	/** How many nodes landed in this column. */
	count: number;
	/** A short phase label for the header (derived from the dominant node kind in the column). */
	label: string;
}

/** The laid-out graph + the canvas extent the SVG should size to. */
export interface GraphLayout {
	nodes: PlacedNode[];
	edges: PlacedEdge[];
	/** Per-column header/rhythm metadata, left→right by rank. */
	columns: GraphColumn[];
	/** Total canvas width in px (covers the rightmost node + node half-width + margin). */
	width: number;
	/** Total canvas height in px. */
	height: number;
}

/** Geometry constants (px). Exported so the component + tests agree on the box size.
 *  Fixed-size n8n-style card: a kind eyebrow + truncated title + a tidy meta grid + a footer
 *  metric strip all FIT inside NODE_W×NODE_H with no overflow (the card text is laid out as HTML
 *  inside a <foreignObject> of exactly this size, clipped by overflow:hidden + ellipsis). */
export const NODE_W = 224;
export const NODE_H = 124;
export const COL_GAP = 104; // horizontal gap between columns (depth steps)
export const ROW_GAP = 32; // vertical gap between rows in a column
export const MARGIN = 36; // canvas padding around the whole graph
/** Reserved band above each column for its header (phase label + node count). */
export const COL_HEADER_H = 34;

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
		return { nodes: [], edges: [], columns: [], width: MARGIN * 2, height: MARGIN * 2 };
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
		// The LATERAL 'messaged' data-share is NOT a causal edge: it must NOT contribute to causal
		// depth (else two same-rank sessions that exchanged data would shove one into a deeper
		// column, breaking the "parallel spawns share a rank" layout). It still renders as an edge
		// (it's in liveEdges) — just routed between whatever columns its endpoints landed in.
		if (e.kind === 'messaged') continue;
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
			// Cards start BELOW the column-header band so the header never overlaps row 0.
			y: MARGIN + COL_HEADER_H + row * ROW_STRIDE + NODE_H / 2
		};
	});

	const byId = new Map(placed.map((p) => [p.id, p]));
	const placedEdges: PlacedEdge[] = liveEdges.map((e) => {
		const a = byId.get(e.from)!;
		const b = byId.get(e.to)!;
		// LATERAL data-share ('messaged'): the endpoints often share a column (two parallel
		// sessions), so a right→left causal cubic would degenerate to a flat overlap. Route it as a
		// RIGHT-SIDE arc — both anchors leave the cards' right edge and bow outward — so a sideways
		// data hop reads visually distinct from the left→right causal flow (and never overlaps the
		// node it connects). Honest geometry; the edge STYLE (color/dash/label) carries the meaning.
		if (e.kind === 'messaged') {
			const x1 = a.x + NODE_W / 2;
			const y1 = a.y;
			const x2 = b.x + NODE_W / 2;
			const y2 = b.y;
			// Bow the control points out to the right of the rightmost endpoint by a fixed offset.
			const bow = Math.max(x1, x2) + COL_GAP * 0.55;
			const path = `M ${x1} ${y1} C ${bow} ${y1}, ${bow} ${y2}, ${x2} ${y2}`;
			return { ...e, x1, y1, x2, y2, path };
		}
		// Causal edge — anchor at the right edge of source, left edge of target (left→right flow).
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
	const height = MARGIN * 2 + COL_HEADER_H + (maxRow + 1) * NODE_H + maxRow * ROW_GAP;

	// Column bands (left→right by rank) — header label from the column's dominant node kind.
	const columns: GraphColumn[] = [];
	for (let col = 0; col <= maxCol; col++) {
		const inCol = placed.filter((p) => p.col === col);
		const x = MARGIN + col * COL_STRIDE;
		columns.push({
			col,
			x,
			centerX: x + NODE_W / 2,
			width: NODE_W,
			count: inCol.length,
			label: columnLabel(col, inCol)
		});
	}

	return { nodes: placed, edges: placedEdges, columns, width, height };
}

/** A short phase label for a column header: the dominant node kind, else a rank fallback. */
function columnLabel(col: number, inCol: PlacedNode[]): string {
	if (inCol.length === 0) return `Rank ${col}`;
	const counts = new Map<LifecycleNodeKind, number>();
	for (const n of inCol) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
	let best: LifecycleNodeKind = inCol[0].kind;
	let bestN = 0;
	for (const [k, n] of counts) {
		if (n > bestN) {
			best = k;
			bestN = n;
		}
	}
	switch (best) {
		case 'continue':
			return 'Continue';
		case 'session':
			return inCol.length > 1 ? 'Agent sessions' : 'Agent session';
		case 'pm':
			return 'Project manager';
		case 'task':
			return inCol.length > 1 ? 'Tasks' : 'Task';
	}
}

/**
 * Truncate a label to `max` chars with a trailing ellipsis — the VISIBLE card title (the full,
 * untruncated label is always available on hover/popover, never lost). CSS `text-overflow:ellipsis`
 * does the visual clip too, but this keeps the SVG/text-equivalent honest at a known bound (F-014).
 */
export function truncate(s: string, max = 40): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** One step on a node's causal path — the neighbour node id, its label, and the edge that joins
 *  it (so the UI can render "spawned →" / "(inferred)" honestly without re-deriving). */
export interface PathStep {
	/** The neighbour node id. */
	id: string;
	/** The neighbour's human label (screened at source — D-026). */
	label: string;
	/** The causal edge kind joining this node to the focus node. */
	kind: LifecycleEdge['kind'];
	/** True ⇒ the joining edge is inferred (heuristic), not a real link (F-008 honest). */
	inferred: boolean;
}

/** A node's place in the causal chain: its incoming parents and outgoing children, both labelled. */
export interface NodePath {
	/** Nodes with an edge INTO the focus node (its causes). Empty for a root. */
	parents: PathStep[];
	/** Nodes the focus node has an edge TO (what it caused). Empty for a leaf. */
	children: PathStep[];
}

/**
 * Derive a node's causal PATH — parent(s) → this → child(ren) — from the read-model edges. PURE +
 * total: a node id absent from `nodes` (or a nil/empty input) yields an empty path (never throws).
 * Labels resolve from the node set; an edge to/from an unknown node is dropped (defensive — LG-2
 * guarantees no dangling edge, but this never assumes it). Steps are de-duplicated + label-sorted
 * for a stable, deterministic render. F-008: only REAL edges surface; `inferred` is carried through
 * verbatim so the UI marks a heuristic link honestly.
 *
 * Shadow paths (all four): happy → parents+children; nil → empty path; empty graph → empty path;
 * unknown focus id / dangling endpoint → that step dropped (never a fabricated neighbour).
 */
export function nodePath(
	focusId: string | null | undefined,
	nodes: LifecycleNode[] | null | undefined,
	edges: LifecycleEdge[] | null | undefined
): NodePath {
	const ns = Array.isArray(nodes) ? nodes : [];
	const es = Array.isArray(edges) ? edges : [];
	if (!focusId) return { parents: [], children: [] };
	const labelOf = new Map(ns.map((n) => [n.id, n.label]));
	if (!labelOf.has(focusId)) return { parents: [], children: [] };

	const seen = new Set<string>(); // dedup a neighbour reached by >1 edge (key = dir+id+kind)
	const parents: PathStep[] = [];
	const children: PathStep[] = [];
	for (const e of es) {
		if (e.to === focusId && labelOf.has(e.from)) {
			const key = `p:${e.from}:${e.kind}`;
			if (seen.has(key)) continue;
			seen.add(key);
			parents.push({ id: e.from, label: labelOf.get(e.from)!, kind: e.kind, inferred: e.inferred });
		} else if (e.from === focusId && labelOf.has(e.to)) {
			const key = `c:${e.to}:${e.kind}`;
			if (seen.has(key)) continue;
			seen.add(key);
			children.push({ id: e.to, label: labelOf.get(e.to)!, kind: e.kind, inferred: e.inferred });
		}
	}
	const byLabel = (a: PathStep, b: PathStep) =>
		a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
	parents.sort(byLabel);
	children.sort(byLabel);
	return { parents, children };
}

/**
 * The set of node ids on a node's FULL causal path: the focus node itself + every transitive
 * ANCESTOR (follow causal edges backward) + every transitive DESCENDANT (forward). PURE + total.
 *
 * CAUSAL edges only (`spawned` / `reported-to` / `proposed` / `follow-up`) define lineage — the
 * LATERAL `messaged` data-share is EXCLUDED (a sideways data hop is not an ancestor/descendant, so
 * a peer link can never pull an unrelated branch into the highlighted path — honest, F-008). The
 * returned set ALWAYS contains `focusId` (when it is a real node) so the focus node itself stays
 * lit. A cycle (should not occur in a causal DAG, but input is never trusted) terminates via the
 * visited set. Used by the LG-3 focus interaction: ids IN the set are highlighted, the rest dimmed.
 *
 * Shadow paths (all four): happy → the focus node's full lineage closure; nil focusId/nodes/edges
 * → empty set; empty graph → empty set; unknown focus id → empty set (nothing to highlight).
 */
export function nodeLineage(
	focusId: string | null | undefined,
	nodes: LifecycleNode[] | null | undefined,
	edges: LifecycleEdge[] | null | undefined
): Set<string> {
	const out = new Set<string>();
	const ns = Array.isArray(nodes) ? nodes : [];
	const es = Array.isArray(edges) ? edges : [];
	if (!focusId) return out;
	const idSet = new Set(ns.map((n) => n.id));
	if (!idSet.has(focusId)) return out;

	// Causal adjacency (exclude the lateral 'messaged' data-share). Forward (from→to) for
	// descendants, reverse (to→from) for ancestors. Drop edges whose endpoints aren't real nodes.
	const fwd = new Map<string, string[]>();
	const rev = new Map<string, string[]>();
	for (const e of es) {
		if (e.kind === 'messaged') continue; // lateral data-share is not causal lineage
		if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
		(fwd.get(e.from) ?? fwd.set(e.from, []).get(e.from)!).push(e.to);
		(rev.get(e.to) ?? rev.set(e.to, []).get(e.to)!).push(e.from);
	}

	// Walk a direction from the focus node, collecting every reachable id (visited-set terminates).
	const walk = (adj: Map<string, string[]>) => {
		const stack = [focusId];
		const seen = new Set<string>([focusId]);
		while (stack.length) {
			const cur = stack.pop()!;
			out.add(cur);
			for (const next of adj.get(cur) ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					stack.push(next);
				}
			}
		}
	};
	walk(fwd); // descendants (+ focus)
	walk(rev); // ancestors (+ focus)
	return out;
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
