import { resolve } from 'path';

const PROJECT_ROOT = resolve(process.cwd(), '..');

export const PATHS = {
	root: PROJECT_ROOT,
	v3Progress: resolve(PROJECT_ROOT, '.claude-flow/metrics/v3-progress.json'),
	swarmActivity: resolve(PROJECT_ROOT, '.claude-flow/metrics/swarm-activity.json'),
	learning: resolve(PROJECT_ROOT, '.claude-flow/metrics/learning.json'),
	graphState: resolve(PROJECT_ROOT, '.claude-flow/data/graph-state.json'),
	rankedContext: resolve(PROJECT_ROOT, '.claude-flow/data/ranked-context.json'),
	autoMemoryStore: resolve(PROJECT_ROOT, '.claude-flow/data/auto-memory-store.json'),
	auditStatus: resolve(PROJECT_ROOT, '.claude-flow/security/audit-status.json'),
	configYaml: resolve(PROJECT_ROOT, '.claude-flow/config.yaml'),
	settingsJson: resolve(PROJECT_ROOT, '.claude/settings.json'),
	networkPolicy: resolve(PROJECT_ROOT, 'config/security/network-policy.yaml'),
	gatewayYaml: resolve(PROJECT_ROOT, 'config/openclaw/gateway.yaml'),
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
	taskSuggestions: resolve(PROJECT_ROOT, '.playground/task-suggestions.json'),
	heartbeatConfig: resolve(PROJECT_ROOT, '.playground/heartbeat-config.json')
} as const;

export const APIS = {
	ollama: 'http://127.0.0.1:11434',
	gateway: 'ws://127.0.0.1:18789',
	hebMcp: 'http://127.0.0.1:3000'
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
	resolve(PROJECT_ROOT, '.mcp.json')
];

export function isPathAllowed(filePath: string): boolean {
	// Reject null bytes and explicit traversal sequences before resolving
	if (filePath.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filePath)) {
		return false;
	}
	const resolved = resolve(filePath);
	// Double-check resolved path doesn't escape PROJECT_ROOT
	if (!resolved.startsWith(PROJECT_ROOT + '/') && !resolved.startsWith(PROJECT_ROOT + '\\') && resolved !== PROJECT_ROOT) {
		return false;
	}
	return ALLOWED_PREFIXES.some(
		(prefix) => resolved === prefix || resolved.startsWith(prefix + '/') || resolved.startsWith(prefix + '\\')
	);
}
