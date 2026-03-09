import { resolve, join, sep } from 'path';

const PROJECT_ROOT = resolve(process.cwd(), '..');

/**
 * Workspace root directory where projects are stored.
 * Configurable via PLAYGROUND_WORKSPACE env var; defaults to the parent of PROJECT_ROOT.
 */
export const WORKSPACE_ROOT = resolve(
	process.env.PLAYGROUND_WORKSPACE || resolve(PROJECT_ROOT, '..')
);

/**
 * Multiple workspace roots for scanning projects across directories.
 * Configurable via PLAYGROUND_WORKSPACES (comma-separated) env var.
 * Falls back to a single-element array containing WORKSPACE_ROOT.
 */
export const WORKSPACE_ROOTS: string[] = process.env.PLAYGROUND_WORKSPACES
	? process.env.PLAYGROUND_WORKSPACES.split(',').map((p) => resolve(p.trim()))
	: [WORKSPACE_ROOT];

export const PATHS = {
	root: PROJECT_ROOT,
	v3Progress: resolve(PROJECT_ROOT, '.claude-flow/metrics/v3-progress.json'),
	swarmActivity: resolve(PROJECT_ROOT, '.claude-flow/metrics/swarm-activity.json'),
	learning: resolve(PROJECT_ROOT, '.claude-flow/metrics/learning.json'),
	graphState: resolve(PROJECT_ROOT, '.claude-flow/data/graph-state.json'),
	rankedContext: resolve(PROJECT_ROOT, '.claude-flow/data/ranked-context.json'),
	daemonState: resolve(PROJECT_ROOT, '.claude-flow/daemon-state.json'),
	intelligenceSnapshot: resolve(PROJECT_ROOT, '.claude-flow/data/intelligence-snapshot.json'),
	autoMemoryStore: resolve(PROJECT_ROOT, '.claude-flow/data/auto-memory-store.json'),
	auditStatus: resolve(PROJECT_ROOT, '.claude-flow/security/audit-status.json'),
	configYaml: resolve(PROJECT_ROOT, '.claude-flow/config.yaml'),
	settingsJson: resolve(PROJECT_ROOT, '.claude/settings.json'),
	networkPolicy: resolve(PROJECT_ROOT, 'config/security/network-policy.yaml'),
	gatewayYaml: resolve(PROJECT_ROOT, 'config/openclaw/gateway.yaml'),
	channelsDir: resolve(PROJECT_ROOT, 'config/openclaw/channels'),
	twitchYaml: resolve(PROJECT_ROOT, 'config/openclaw/channels/twitch.yaml'),
	modelsJson5: resolve(PROJECT_ROOT, 'config/openclaw/models.json5'),
	mcpJson: resolve(PROJECT_ROOT, '.mcp.json'),
	agentsDir: resolve(PROJECT_ROOT, '.claude/agents'),
	sessionsDir: resolve(PROJECT_ROOT, '.claude-flow/sessions'),
	logsDir: resolve(PROJECT_ROOT, '.claude-flow/logs'),
	headlessLogsDir: resolve(PROJECT_ROOT, '.claude-flow/logs/headless'),
	openclawLog: resolve(PROJECT_ROOT, '.claude-flow/logs/openclaw-gateway.log'),
	playgroundConfig: resolve(PROJECT_ROOT, '.playground/config.json'),
	playgroundRegistry: resolve(PROJECT_ROOT, '.playground/registry.json'),
	chatsDir: resolve(PROJECT_ROOT, '.playground/chats'),
	routingLog: resolve(PROJECT_ROOT, '.playground/routing-log.json'),
	reportsDir: resolve(PROJECT_ROOT, '.playground/reports'),
	tasksDir: resolve(PROJECT_ROOT, '.playground/tasks'),
	generalSettings: resolve(PROJECT_ROOT, '.playground/settings.json'),
	agentDefaultsSettings: resolve(PROJECT_ROOT, '.playground/agent-defaults.json'),
	modelRoutingSettings: resolve(PROJECT_ROOT, '.playground/model-routing.json'),
	memorySettings: resolve(PROJECT_ROOT, '.playground/memory-settings.json'),
	envFile: resolve(PROJECT_ROOT, '.env'),
	customServices: resolve(PROJECT_ROOT, '.playground/custom-services.json'),
	scanFindings: resolve(PROJECT_ROOT, '.playground/security-findings.json'),
	taskSuggestions: resolve(PROJECT_ROOT, '.playground/task-suggestions.json')
} as const;

export const APIS = {
	ollama: 'http://127.0.0.1:11434',
	gateway: 'ws://127.0.0.1:18789'
} as const;

export interface ServiceDef {
	id: string;
	name: string;
	type: string;
	configPath: string;
	port: number | null;
	healthUrl: string | null;
	logFile: string | null;
}

export const SERVICES: Record<string, ServiceDef> = {
	ollama: {
		id: 'ollama',
		name: 'Ollama Server',
		type: 'Model Runtime',
		configPath: 'config/openclaw/models.json5',
		port: 11434,
		healthUrl: 'http://127.0.0.1:11434/',
		logFile: null
	},
	openclaw: {
		id: 'openclaw',
		name: 'OpenClaw Gateway',
		type: 'API Gateway',
		configPath: 'config/openclaw/gateway.yaml',
		port: 18789,
		healthUrl: 'http://127.0.0.1:18789/',
		logFile: resolve(PROJECT_ROOT, '.claude-flow/logs/openclaw-gateway.log')
	},
	'claude-flow': {
		id: 'claude-flow',
		name: 'Claude Flow Daemon',
		type: 'Background Service',
		configPath: '.claude-flow/config.yaml',
		port: null,
		healthUrl: null,
		logFile: resolve(PROJECT_ROOT, '.claude-flow/logs/headless')
	},
	'penpot-mcp': {
		id: 'penpot-mcp',
		name: 'Penpot MCP Server',
		type: 'MCP Server',
		configPath: join(WORKSPACE_ROOT, 'tools', 'penpot-mcp'),
		port: 4400,
		healthUrl: 'http://127.0.0.1:4400/',
		logFile: null
	},
} as const;

export const POLL_INTERVALS = {
	ollamaPs: 5000,
	v3Metrics: 10000,
	systemHealth: 15000
} as const;

const ALLOWED_PREFIXES = [
	resolve(PROJECT_ROOT, '.claude-flow'),
	resolve(PROJECT_ROOT, '.claude'),
	resolve(PROJECT_ROOT, 'config'),
	resolve(PROJECT_ROOT, '.mcp.json'),
	resolve(PROJECT_ROOT, '.playground')
];

export function isPathAllowed(filePath: string): boolean {
	const resolved = resolve(filePath);
	return ALLOWED_PREFIXES.some(
		(prefix) => resolved === prefix || resolved.startsWith(prefix + sep)
	);
}

export type SettingsScope = 'global' | 'project';

/** Resolve a settings file path based on scope. Global uses root .playground/, project uses <projectPath>/.playground/ */
export function scopedSettingsPath(
	fileName: string,
	scope: SettingsScope,
	projectPath?: string
): string {
	if (scope === 'project' && projectPath) {
		const resolved = resolve(projectPath, '.playground', fileName);
		const normalizedProject = resolve(projectPath);
		if (!resolved.startsWith(normalizedProject + sep)) {
			throw new Error('Invalid project path');
		}
		return resolved;
	}
	return resolve(PROJECT_ROOT, '.playground', fileName);
}
