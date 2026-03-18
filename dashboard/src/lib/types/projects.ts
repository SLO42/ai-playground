/** Environment configuration for a project */
export interface ProjectEnvironment {
	name: string;           // 'dev' | 'staging' | 'production' | custom
	branch?: string;        // git branch for this env
	url?: string;           // deployment URL
	variables: Record<string, string>; // env-specific config (values hidden in UI)
	lastDeployedAt?: string;
	lastDeployedVersion?: string;
	status: 'active' | 'inactive' | 'deploying';
}

/** What lives in `.playground/config.json` — source of truth for project identity */
export interface PlaygroundConfig {
	name: string;
	description?: string;
	tags?: string[];
	techStack?: string[];
	primaryLanguage?: string;
	framework?: string;
	buildTool?: string;
	buildCommand?: string;
	devCommand?: string;
	testCommand?: string;
	lintCommand?: string;
	startCommand?: string;
	releaseCommand?: string;
	gitRemote?: string;
	defaultBranch?: string;
	releaseProcess?: string[];
	services?: PlaygroundService[];
	agents?: PlaygroundAgents;
	stats?: PlaygroundStats;
}

/** Auto-detected project metadata from scanning files */
export interface DetectedProjectMeta {
	language?: string;
	framework?: string;
	buildTool?: string;
	buildCommand?: string;
	devCommand?: string;
	testCommand?: string;
	lintCommand?: string;
	startCommand?: string;
	releaseCommand?: string;
	gitRemote?: string;
	defaultBranch?: string;
	releaseProcess: string[];
	services: PlaygroundService[];
	/** Detected CI/CD workflows with triggers and jobs */
	workflows: DetectedWorkflow[];
	/** Agent directories/types found in .claude/agents/ */
	agents: DetectedAgent[];
	/** Branches found in the git repo */
	branches: string[];
	/** Key dependencies (mod frameworks, major libs) */
	dependencies: DetectedDependency[];
	/** Maintenance hints: README exists, docs dir, changelog, etc. */
	maintenance: MaintenanceInfo;
	/** Workspace/monorepo type if detected (lightweight, type only) */
	workspace?: 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'dotnet' | 'gradle' | null;
	/** Full workspace info with resolved packages and inter-dependencies */
	workspaceInfo?: {
		type: 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'dotnet' | 'gradle';
		rootPath: string;
		packages: {
			name: string;
			path: string;
			version?: string;
			dependencies?: string[];
		}[];
	} | null;
}

export interface DetectedWorkflow {
	name: string;
	file: string;
	triggers: string[];
	jobs: string[];
}

export interface DetectedAgent {
	name: string;
	type: string;          // directory name under .claude/agents/
	fileCount: number;
}

export interface DetectedDependency {
	name: string;
	version?: string;
	type: 'runtime' | 'dev' | 'mod-framework' | 'platform';
}

export interface MaintenanceInfo {
	hasReadme: boolean;
	hasChangelog: boolean;
	hasDocsDir: boolean;
	hasClaude: boolean;
	hasClaudeFlow: boolean;
	hasLicense: boolean;
	branchCount: number;
	activeBranches: string[];
}

export interface PlaygroundService {
	name: string;
	port?: number;
	command?: string;
	healthUrl?: string;
}

export interface PlaygroundAgents {
	topology?: string;
	maxAgents?: number;
	memoryNamespace?: string;
	modelPreferences?: string[];
}

export interface PlaygroundStats {
	lastSynced?: string;
	totalToolUses?: number;
	totalSessions?: number;
	totalAgentSpawns?: number;
}

/** Configuration parameter for a project template */
export interface TemplateParam {
	key: string;
	label: string;
	type: 'boolean' | 'string' | 'select';
	default: string | boolean;
	options?: string[];        // for select type
	description?: string;
}

/** Template metadata for project creation UI */
export interface ProjectTemplate {
	id: string;
	name: string;
	description: string;
	language: string;
	icon: string;
	tags: string[];
	params?: TemplateParam[];
}

/** Full template definition with file generator */
export interface ProjectTemplateDef {
	id: string;
	name: string;
	description: string;
	language: string;
	icon: string;
	tags: string[];
	params: TemplateParam[];
	generate: (name: string, description: string, params: Record<string, string | boolean>) => Record<string, string>;
}

/** What lives in `.playground/registry.json` */
export interface ProjectRegistry {
	version: number;
	projects: ProjectRegistryEntry[];
}

export interface ProjectRegistryEntry {
	path: string; // absolute, or "." for self
	addedAt: string;
}

/** Server-side pagination wrapper */
export interface PaginatedProjects {
	projects: Project[];
	total: number;
	page: number;
	perPage: number;
	totalPages: number;
}

/** Merged display type — config + detected data */
export interface Project {
	id: string;
	name: string;
	description: string;
	path: string;
	tags: string[];
	techStack: string[];
	health: 'healthy' | 'warning' | 'error' | 'unknown';
	status: 'active' | 'archived' | 'unconfigured';
	lastOpened: string;
	agents: number;
	sessions: number;
	memoryNodes: number;
	stats: PlaygroundStats;
	hasClaudeFlow: boolean;
	hasClaude: boolean;
	hasGit: boolean;
	branch?: string;
	commits?: number;
	favorite?: boolean;
}
