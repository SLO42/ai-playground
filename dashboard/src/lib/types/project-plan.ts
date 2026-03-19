/** Project Manager plan — lives at .playground/project-plan.json per project */

export type MilestoneStatus = 'planned' | 'active' | 'completed' | 'blocked';

// ── Macro: strategic phases (weeks-months) ───────────────────────────

export interface Milestone {
	id: string;
	name: string;
	status: MilestoneStatus;
	goals: string[];
	acceptanceCriteria: string[];
	/** Task IDs linked directly to this milestone (unsprinted work) */
	tasks: string[];
	/** Milestone IDs that must complete first */
	dependencies: string[];
	/** Sprint IDs that belong to this milestone */
	sprints: string[];
	targetDate?: string;
	completedAt?: string;
}

// ── Micro: time-boxed sprints (1-2 weeks) ────────────────────────────

export interface Sprint {
	id: string;
	name: string;
	status: MilestoneStatus;
	/** Which macro milestone this sprint serves */
	milestoneId: string;
	/** Sprint goal — what we're trying to achieve this cycle */
	goal: string;
	/** Task IDs in this sprint */
	tasks: string[];
	startDate?: string;
	endDate?: string;
	completedAt?: string;
	/** Retro notes from the PM after sprint completion */
	retrospective?: string;
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
	version: 2;
	vision: string;
	definitionOfDone: string[];
	/** Macro roadmap — strategic phases */
	roadmap: Milestone[];
	/** Micro roadmap — time-boxed sprints linked to macro milestones */
	sprints: Sprint[];
	/** Active sprint ID (at most one) */
	activeSprint: string | null;
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
