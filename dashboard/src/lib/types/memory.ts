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
