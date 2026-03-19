/** Project Manager plan — lives at .playground/project-plan.json per project */

export type MilestoneStatus = 'planned' | 'active' | 'completed' | 'blocked';

export interface Milestone {
	id: string;
	name: string;
	status: MilestoneStatus;
	goals: string[];
	acceptanceCriteria: string[];
	/** Task IDs linked to this milestone */
	tasks: string[];
	/** Milestone IDs that must complete first */
	dependencies: string[];
	targetDate?: string;
	completedAt?: string;
}

export interface ArchDecision {
	id: string;
	title: string;
	context: string;
	decision: string;
	consequences: string[];
	date: string;
	decidedBy: string;
}

export interface ProjectPlan {
	version: 1;
	vision: string;
	definitionOfDone: string[];
	roadmap: Milestone[];
	decisions: ArchDecision[];
	lastUpdated: string;
	updatedBy: string;
}

// ── PM Memory (SQLite-backed) ────────────────────────────────────────

export type PMMemoryType = 'observation' | 'learning' | 'risk' | 'pattern' | 'decision-context';

export interface PMMemoryEntry {
	id: string;
	type: PMMemoryType;
	content: string;
	/** What triggered this memory (bootstrap-scan, discussion, heartbeat-review, agent, etc.) */
	source: string;
	createdAt: string;
	/** Optional link to milestone or decision ID */
	relatedTo: string | null;
	/** Confidence 0-1 — PM can revise memories as it learns more */
	confidence: number;
	/** Archived entries are hidden from default views but retained for search */
	archived: boolean;
}

export interface PMMemoryStats {
	totalEntries: number;
	byType: Record<PMMemoryType, number>;
	oldestEntry: string | null;
	newestEntry: string | null;
	totalReviews: number;
	lastReviewedAt: string | null;
}

/** Query options for retrieving PM memory entries */
export interface PMMemoryQuery {
	type?: PMMemoryType;
	source?: string;
	minConfidence?: number;
	relatedTo?: string;
	archived?: boolean;
	limit?: number;
	offset?: number;
	/** 'recent' (default) or 'confidence' (highest first) */
	orderBy?: 'recent' | 'confidence';
	/** Text search across content */
	search?: string;
}

/** What the PM discussion session opens with */
export interface PMBootstrapContext {
	projectName: string;
	language?: string;
	framework?: string;
	techStack: string[];
	hasTests: boolean;
	hasCi: boolean;
	hasDocs: boolean;
	gitRemote?: string;
	branches: string[];
	recentCommitMessages: string[];
	existingTasks: string[];
	readmeExcerpt?: string;
}
