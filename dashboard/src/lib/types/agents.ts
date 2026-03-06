export type AgentStatus = 'idle' | 'active' | 'stopped';

export interface AgentInfo {
	name: string;
	type: string;
	description: string;
	filename: string;
	status: AgentStatus;
}

export interface AgentDefinition extends AgentInfo {
	category: string;
	color?: string;
	capabilities?: string[];
	priority?: string;
}

export interface AgentDetail extends AgentDefinition {
	content: string;
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface AgentTemplate {
	id: string;
	name: string;
	description: string;
	category: string;
	content: string;
}

export interface SwarmConfig {
	topology: string;
	maxAgents: number;
	autoScale: boolean;
	coordinationStrategy: string;
}

export interface TeamConfig {
	autoAssign?: boolean;
	patternTraining?: boolean;
	sharedNamespace?: string;
}
