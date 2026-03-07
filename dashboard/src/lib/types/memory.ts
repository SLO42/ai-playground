export interface RankedEntry {
	id: string;
	content: string;
	summary: string;
	category: string;
	confidence: number;
	pageRank: number;
	accessCount: number;
	words: string[];
}

export interface RankedContext {
	version: number;
	computedAt: number;
	entries: RankedEntry[];
}

export interface AutoMemoryEntry {
	id: string;
	key: string;
	content: string;
	summary: string;
	namespace: string;
	type?: string;
	metadata?: Record<string, unknown>;
	createdAt?: number;
}

/** Response shape from GET /api/memory/context */
export interface MemoryContextResponse {
	context: RankedContext | null;
	autoMemory: AutoMemoryEntry[] | null;
}

/** Subset of the memory YAML config used by the memory page. */
export interface MemoryConfig {
	backend?: string;
	type?: string;
	enableHNSW?: boolean;
	hnsw?: boolean;
	[key: string]: unknown;
}

/** Shape returned by the memory page server load function. */
export interface MemoryPageData {
	graph: import('$lib/types/graph.js').GraphState | null;
	context: RankedContext | null;
	autoMemory: AutoMemoryEntry[] | null;
	memoryConfig: MemoryConfig | null;
	memoryGraphEnabled: boolean;
	loadErrors: string[] | null;
}

/** Namespace/category breakdown entry used in project memory summaries. */
export interface BreakdownEntry {
	name: string;
	count: number;
}

/** Summary stats for a project's memory page. */
export interface ProjectMemorySummary {
	totalNodes: number;
	namespaces: number;
	categories: number;
	avgConfidence: number;
	hitRate: string;
}

/** Shape returned by the project memory page server load function. */
export interface ProjectMemoryPageData {
	projectId: string;
	projectName: string;
	loadError: string | null;
	graph: import('$lib/types/graph.js').GraphState | null;
	summary: ProjectMemorySummary;
	namespaceBreakdown: BreakdownEntry[];
	categoryBreakdown: BreakdownEntry[];
	entries: AutoMemoryEntry[];
	context: RankedContext | null;
	memoryGraphEnabled: boolean;
}
