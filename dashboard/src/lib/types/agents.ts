export interface AgentDefinition {
	name: string;
	category: string;
	description: string;
	filename: string;
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
