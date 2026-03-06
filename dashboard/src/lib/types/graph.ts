export interface GraphNode {
	id: string;
	category: string;
	confidence: number;
	accessCount: number;
	createdAt: number;
}

export interface GraphEdge {
	sourceId: string;
	targetId: string;
	type: 'temporal' | 'similar' | 'causal';
	weight: number;
}

/** A graph node enriched with computed display properties. */
export interface RankedGraphNode extends GraphNode {
	pageRank: number;
	label: string;
}

export interface GraphState {
	version: number;
	updatedAt: number;
	nodeCount: number;
	nodes: Record<string, GraphNode>;
	edges: GraphEdge[];
	pageRanks?: Record<string, number>;
}

/** Props accepted by the BubbleGraph component. */
export interface BubbleGraphProps {
	nodes: RankedGraphNode[];
	edges?: GraphEdge[];
	onNodeClick?: (nodeId: string) => void;
	ariaLabel?: string;
}

/** POST /api/memory/graph request body. */
export interface GraphPostBody {
	nodes?: GraphNode[];
	edges?: GraphEdge[];
}

/** PUT /api/memory/graph request body. */
export interface GraphPutBody {
	nodes?: Partial<GraphNode>[];
	edges?: (Partial<GraphEdge> & { _delete?: boolean })[];
}

/** Successful mutation response from POST/PUT /api/memory/graph. */
export interface GraphMutationResponse {
	ok: true;
	nodeCount: number;
	edgeCount: number;
	nodesAdded?: number;
	edgesAdded?: number;
	nodesUpdated?: number;
	edgesUpdated?: number;
	edgesDeleted?: number;
}
