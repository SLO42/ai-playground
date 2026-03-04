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
	sessionsDir: resolve(PROJECT_ROOT, '.claude-flow/sessions')
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
	const resolved = resolve(filePath);
	return ALLOWED_PREFIXES.some(
		(prefix) => resolved === prefix || resolved.startsWith(prefix + '/')  || resolved.startsWith(prefix + '\\')
	);
}
