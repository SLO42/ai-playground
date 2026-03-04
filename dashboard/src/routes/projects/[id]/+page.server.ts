import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
	const overviews: Record<string, any> = {
		'ai-playground': {
			description:
				'Central AI interface with multi-agent orchestration, GPT-OSS 20B local model, and family-only access.',
			techStack: ['SvelteKit', 'TypeScript', 'Tailwind', 'Ollama', 'Claude Flow v3'],
			stats: { agents: 6, sessions: 3, memoryNodes: 89, hooks: 14, channels: 2, models: 4 },
			health: 'healthy',
			services: [
				{ name: 'OpenClaw Gateway', status: 'online', port: 18789 },
				{ name: 'Ollama (GPT-OSS 20B)', status: 'online', port: 11434 },
				{ name: 'Claude Flow Daemon', status: 'online', port: null },
				{ name: 'HEB MCP Server', status: 'offline', port: null }
			],
			recentActivity: [
				{ action: 'Agent spawned', detail: 'coder — auth fix', time: '2m ago' },
				{ action: 'Session started', detail: 'workflow-pipeline-42', time: '8m ago' },
				{ action: 'Memory stored', detail: 'pattern-auth (patterns)', time: '15m ago' },
				{ action: 'Hook executed', detail: 'post-edit → lint check', time: '22m ago' },
				{ action: 'Channel message', detail: 'slo42 via Twitch', time: '31m ago' }
			],
			quickLinks: [
				{ label: 'Models', href: 'models', stat: '4 models', accent: 'blue' },
				{ label: 'Agents', href: 'agents', stat: '6 active', accent: 'green' },
				{ label: 'Channels', href: 'channels', stat: '2 connected', accent: 'cyan' },
				{ label: 'Sessions', href: 'sessions', stat: '3 running', accent: 'purple' },
				{ label: 'Memory', href: 'memory', stat: '89 nodes', accent: 'blue' },
				{ label: 'Hooks', href: 'hooks', stat: '14 registered', accent: 'yellow' },
				{ label: 'Security', href: 'security', stat: '0 findings', accent: 'green' },
				{ label: 'Apps & MCP', href: 'services', stat: '4 services', accent: 'cyan' }
			]
		}
	};

	const fallback = {
		description: `Project workspace for ${params.id}`,
		techStack: [],
		stats: { agents: 0, sessions: 0, memoryNodes: 0, hooks: 0, channels: 0, models: 0 },
		health: 'healthy',
		services: [],
		recentActivity: [],
		quickLinks: [
			{ label: 'Models', href: 'models', stat: '-', accent: 'blue' },
			{ label: 'Agents', href: 'agents', stat: '-', accent: 'green' },
			{ label: 'Channels', href: 'channels', stat: '-', accent: 'cyan' },
			{ label: 'Sessions', href: 'sessions', stat: '-', accent: 'purple' },
			{ label: 'Memory', href: 'memory', stat: '-', accent: 'blue' },
			{ label: 'Hooks', href: 'hooks', stat: '-', accent: 'yellow' },
			{ label: 'Security', href: 'security', stat: '-', accent: 'green' },
			{ label: 'Apps & MCP', href: 'services', stat: '-', accent: 'cyan' }
		]
	};

	return { overview: overviews[params.id] ?? fallback };
};
