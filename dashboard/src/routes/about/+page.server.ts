import type { PageServerLoad } from './$types.js';
import { readYamlFile } from '$lib/server/yaml-parser.js';
import { readJsonFile, readTextFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { readdir } from 'fs/promises';
import { resolve, basename } from 'path';

export interface TechCard {
	name: string;
	version: string;
	description: string;
	color: string;
}

export interface StackPanel {
	name: string;
	description: string;
	details: string[];
	color: string;
}

export interface McpServer {
	name: string;
	status: 'connected' | 'disconnected';
}

export interface Channel {
	name: string;
	type: string;
	status: 'active' | 'inactive';
}

// ─── Config file type shapes ──────────────────────────────────────

interface GatewayConfig {
	gateway?: {
		host?: string;
		port?: number;
		protocol?: string;
		tls?: { minVersion?: string };
	};
	dm?: { policy?: string };
	channels?: { enabled?: string[] };
	models?: {
		primary?: string;
		fallback?: string[];
		maxTokens?: number;
	};
}

interface ClaudeFlowConfig {
	version?: string;
	swarm?: {
		topology?: string;
		maxAgents?: number;
		coordinationStrategy?: string;
	};
	memory?: {
		backend?: string;
		enableHNSW?: boolean;
		learningBridge?: { enabled?: boolean };
		memoryGraph?: { enabled?: boolean };
	};
	neural?: { enabled?: boolean };
}

interface McpJsonConfig {
	mcpServers?: Record<string, unknown>;
}

interface ChannelConfig {
	channel?: string;
	enabled?: boolean;
}

// ─── JSON5 comment stripper (no extra dependency) ─────────────────

function stripJson5Comments(text: string): string {
	let result = '';
	let inString = false;
	let stringChar = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inString) {
			result += ch;
			if (ch === '\\') {
				result += next ?? '';
				i++;
			} else if (ch === stringChar) {
				inString = false;
			}
		} else if (ch === '"' || ch === "'") {
			inString = true;
			stringChar = ch;
			result += ch;
		} else if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			result += '\n';
		} else if (ch === '/' && next === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i++;
		} else {
			result += ch;
		}
	}
	return result.replace(/,\s*([}\]])/g, '$1');
}

// ─── Loader ───────────────────────────────────────────────────────

export const load: PageServerLoad = async () => {
	const [gateway, cfConfig, mcpJson, playgroundConfig, modelsRaw] = await Promise.all([
		readYamlFile<GatewayConfig>(PATHS.gatewayYaml),
		readYamlFile<ClaudeFlowConfig>(PATHS.configYaml),
		readJsonFile<McpJsonConfig>(PATHS.mcpJson),
		readJsonFile<{ name?: string; description?: string; version?: string }>(PATHS.playgroundConfig),
		readTextFile(PATHS.modelsJson5)
	]);

	// ─── Platform ─────────────────────────────────────────────────

	const platform = {
		name: playgroundConfig?.name ?? 'ai-playground',
		version: `v${__APP_VERSION__}`,
		description:
			playgroundConfig?.description ??
			'AI agent orchestration dashboard with cloud flow model routing, multi-agent coordination, and cross-platform messaging.'
	};

	// ─── Core Tech (static — these don't come from config) ────────

	const coreTech: TechCard[] = [
		{ name: 'SvelteKit', version: '2.x', description: 'Full-stack framework', color: 'accent-red' },
		{ name: 'Tailwind CSS', version: 'v4', description: 'Utility-first CSS', color: 'accent-cyan' },
		{ name: 'TypeScript', version: '5.x', description: 'Type-safe JS', color: 'accent-blue' },
		{ name: 'Chart.js', version: '4.x', description: 'Data visualization', color: 'accent-yellow' }
	];

	// ─── Stack panels (from config files) ─────────────────────────

	const gwPort = gateway?.gateway?.port ?? 18789;
	const gwTls = gateway?.gateway?.tls?.minVersion ?? 'TLSv1.3';
	const gwDmPolicy = gateway?.dm?.policy ?? 'pairing';
	const gwChannels = gateway?.channels?.enabled ?? [];

	let modelNames: string[] = [];
	if (modelsRaw) {
		try {
			const parsed = JSON.parse(stripJson5Comments(modelsRaw));
			const providers = parsed?.models?.providers ?? {};
			for (const provider of Object.values(providers) as Array<{ models?: Array<{ name?: string }> }>) {
				if (provider.models) {
					for (const m of provider.models) {
						if (m.name) modelNames.push(m.name);
					}
				}
			}
		} catch {
			// fall through
		}
	}

	const primaryModel = gateway?.models?.primary ?? 'ollama/gpt-oss:20b';
	const fallbackModels = gateway?.models?.fallback ?? [];

	const cfVersion = cfConfig?.version ?? '3.0.0';
	const cfTopology = cfConfig?.swarm?.topology ?? 'hierarchical-mesh';
	const cfMaxAgents = cfConfig?.swarm?.maxAgents ?? 6;
	const cfMemoryBackend = cfConfig?.memory?.backend ?? 'hybrid';
	const cfHnsw = cfConfig?.memory?.enableHNSW ?? true;
	const cfNeural = cfConfig?.neural?.enabled ?? true;
	const cfLearning = cfConfig?.memory?.learningBridge?.enabled ?? false;

	const channelList = gwChannels.length
		? gwChannels.map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')
		: 'Twitch';

	const stack: StackPanel[] = [
		{
			name: 'OpenClaw',
			description: 'Central AI interface across messaging platforms.',
			details: [
				`Gateway on port ${gwPort}`,
				`DM ${gwDmPolicy} policy`,
				`${channelList} channel${gwChannels.length !== 1 ? 's' : ''}`,
				`${gwTls} minimum`
			],
			color: 'accent-blue'
		},
		{
			name: 'Ollama / GPT-OSS 20B',
			description: 'Local MoE model for orchestration and routing.',
			details: [
				...(modelNames.length ? modelNames : ['GPT-OSS 20B (MoE, 3.6B active)']),
				`Primary: ${primaryModel}`,
				`Fallback: ${fallbackModels.length ? fallbackModels.join(', ') : 'none'}`,
				'$0 per token'
			],
			color: 'accent-green'
		},
		{
			name: `Claude Flow v3 (${cfVersion})`,
			description: `Multi-agent orchestration with ${cfMaxAgents} max agents.`,
			details: [
				`${cfHnsw ? 'HNSW' : 'Standard'} memory indexing (${cfMemoryBackend})`,
				`${cfTopology} topology`,
				cfNeural ? 'Neural engine enabled' : 'Neural engine disabled',
				cfLearning ? 'Self-learning memory active' : 'Self-learning memory off'
			],
			color: 'accent-purple'
		}
	];

	// ─── MCP Servers (from .mcp.json) ─────────────────────────────

	const mcpServerNames = mcpJson?.mcpServers ? Object.keys(mcpJson.mcpServers) : [];
	const mcpServers: McpServer[] = mcpServerNames.map((name) => ({
		name,
		status: 'connected' as const
	}));

	// ─── Channels (from config/openclaw/channels/*.yaml) ──────────

	let channels: Channel[] = [];
	try {
		const channelsDir = resolve(PATHS.root, 'config/openclaw/channels');
		const files = await readdir(channelsDir);
		const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

		const channelConfigs = await Promise.all(
			yamlFiles.map(async (f) => {
				const cfg = await readYamlFile<ChannelConfig>(resolve(channelsDir, f));
				const name = cfg?.channel ?? basename(f, '.yaml').replace('.yml', '');
				return {
					name: name.charAt(0).toUpperCase() + name.slice(1),
					type: name.toLowerCase() === 'twitch' ? 'Streaming' : 'Messaging',
					status: (cfg?.enabled !== false ? 'active' : 'inactive') as 'active' | 'inactive'
				};
			})
		);
		channels = channelConfigs;
	} catch {
		channels = (gateway?.channels?.enabled ?? ['twitch']).map((name) => ({
			name: name.charAt(0).toUpperCase() + name.slice(1),
			type: name.toLowerCase() === 'twitch' ? 'Streaming' : 'Messaging',
			status: 'active' as const
		}));
	}

	return { platform, coreTech, stack, mcpServers, channels };
};
