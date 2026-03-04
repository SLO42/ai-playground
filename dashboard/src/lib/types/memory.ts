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
	key: string;
	value: string;
	namespace: string;
	source?: string;
	tags?: string[];
	createdAt?: number;
}
