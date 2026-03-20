/**
 * Project Plan — lives at .playground/project-plan.json per project.
 *
 * Two scales:
 *   MACRO — the full strategic picture: identity, releases, phases, feature map
 *   MICRO — time-boxed sprints that execute against macro phases
 */

export type PhaseStatus = 'planned' | 'active' | 'completed' | 'blocked';

// ═══════════════════════════════════════════════════════════════════════
// MACRO — Project-level strategy (the full scope, all releases, all time)
// ═══════════════════════════════════════════════════════════════════════

/** Who the user is in relation to this project */
export interface ProjectRole {
	title: string;
	responsibilities: string[];
}

/** A versioned release point — v0.1, v1.0, v2.0, etc. */
export interface Release {
	id: string;
	version: string;
	name: string;
	status: PhaseStatus;
	/** What "feature complete" means for THIS release */
	featureComplete: string[];
	/** Phases that belong to this release */
	phases: string[];
	targetDate?: string;
	shippedAt?: string;
}

/** A phase within a release — "Foundation", "Core API", "Polish" */
export interface Phase {
	id: string;
	name: string;
	status: PhaseStatus;
	/** Which release this phase belongs to */
	releaseId: string;
	goals: string[];
	acceptanceCriteria: string[];
	/** Task IDs linked directly (unsprinted work) */
	tasks: string[];
	/** Phase IDs that must complete first */
	dependencies: string[];
	/** Sprint IDs that belong to this phase */
	sprints: string[];
	targetDate?: string;
	completedAt?: string;
}

/** A key feature or capability the project delivers */
export interface KeyFeature {
	id?: string;
	name: string;
	description: string;
	/** Which release introduces this feature (legacy) */
	releaseId?: string;
	/** Which phase this feature belongs to */
	phase?: string;
	status: 'planned' | 'in-progress' | 'shipped' | 'done' | 'partial' | 'not-started' | 'collecting' | 'needs-testing' | 'deferred' | 'pushed-back';
	/** Implementation evidence — files, commits, patterns found */
	evidence?: string;
	/** Reason for deferral or push-back (required when status is 'deferred' or 'pushed-back') */
	statusReason?: string;
	priority?: 'high' | 'medium' | 'low' | 'varies';
	effort?: 'tiny' | 'small' | 'medium' | 'large' | 'varies';
	/** Commit hash where this feature shipped */
	shippedIn?: string;
	/** Sub-items for collecting features (e.g. backlog) */
	items?: unknown[];
}

/** The full macro picture — project identity + strategic roadmap */
export interface MacroPlan {
	/** What this project IS — one paragraph, the elevator pitch */
	purpose: string;
	/** Where this project is headed long-term (beyond current releases) */
	longTermVision: string;
	/** The user's role in this project */
	role: ProjectRole;
	/** What makes this project stand out — key differentiators */
	keyHighlights: string[];
	/** The features this project delivers, mapped to releases */
	featureMap: KeyFeature[];
	/** Versioned release points */
	releases: Release[];
	/** Phases within releases */
	phases: Phase[];
	/** Global definition of done — when is the whole project "done"? */
	definitionOfDone: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// MICRO — Sprint-level execution (1-2 week chunks)
// ═══════════════════════════════════════════════════════════════════════

/** An inline task within a sprint */
export interface SprintTask {
	id: string;
	/** Feature this task relates to */
	feature: string | null;
	title: string;
	status: 'todo' | 'in-progress' | 'done' | 'blocked' | 'needs-testing' | 'deferred' | 'pushed-back';
	effort?: 'tiny' | 'small' | 'medium' | 'large';
	description?: string;
	/** Reason for deferral or push-back */
	statusReason?: string;
}

export interface Sprint {
	id: string;
	name: string;
	status: PhaseStatus;
	/** Which phase this sprint serves */
	phaseId?: string;
	/** Which phase this sprint serves (alias) */
	phase?: string;
	/** Sprint goal — what we're trying to achieve this cycle */
	goal: string;
	/** Task IDs (legacy) or inline task objects */
	tasks: (string | SprintTask)[];
	startDate?: string;
	endDate?: string;
	completedAt?: string;
	/** Retro notes from the PM after sprint completion */
	retrospective?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// DECISIONS + TOP-LEVEL PLAN
// ═══════════════════════════════════════════════════════════════════════

export interface ArchDecision {
	id: string;
	title?: string;
	context?: string;
	decision: string;
	rationale?: string;
	consequences?: string[];
	date: string;
	decidedBy?: string;
	status?: 'proposed' | 'accepted' | 'deprecated' | 'superseded';
}

export interface ProjectPlan {
	version: 3;
	macro: MacroPlan;
	sprints: Sprint[];
	activeSprint: string | null;
	decisions: ArchDecision[];
	lastUpdated: string;
	updatedBy: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PM Memory (SQLite-backed)
// ═══════════════════════════════════════════════════════════════════════

export type PMMemoryType = 'observation' | 'learning' | 'risk' | 'pattern' | 'decision-context';

export interface PMMemoryEntry {
	id: string;
	type: PMMemoryType;
	content: string;
	source: string;
	createdAt: string;
	relatedTo: string | null;
	confidence: number;
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

export interface PMMemoryQuery {
	type?: PMMemoryType;
	source?: string;
	minConfidence?: number;
	relatedTo?: string;
	archived?: boolean;
	limit?: number;
	offset?: number;
	orderBy?: 'recent' | 'confidence';
	search?: string;
}

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
