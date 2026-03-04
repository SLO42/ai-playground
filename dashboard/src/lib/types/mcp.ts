export interface McpServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
	autoStart?: boolean;
}

export interface McpRegistry {
	mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolGroup {
	category: string;
	tools: string[];
}
