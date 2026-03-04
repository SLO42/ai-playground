export interface V3Progress {
	version: string;
	initialized: string;
	domains: {
		completed: number;
		total: number;
		status: string;
	};
	ddd: {
		progress: number;
		modules: number;
		totalFiles: number;
		totalLines: number;
	};
	swarm: {
		activeAgents: number;
		maxAgents: number;
		topology: string;
	};
	learning: {
		status: string;
		patternsLearned: number;
		sessionsCompleted: number;
	};
}

export interface SwarmActivity {
	timestamp: string;
	processes: {
		agentic_flow: number;
		mcp_server: number;
		estimated_agents: number;
	};
	swarm: {
		active: boolean;
		agent_count: number;
		coordination_active: boolean;
	};
	integration: {
		agentic_flow_active: boolean;
		mcp_active: boolean;
	};
}

export interface Learning {
	initialized: string;
	routing: {
		accuracy: number;
		decisions: number;
	};
	patterns: {
		shortTerm: number;
		longTerm: number;
		quality: number;
	};
	sessions: {
		total: number;
		current: string | null;
	};
}
