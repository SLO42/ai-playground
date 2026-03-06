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
