import type { PageServerLoad } from './$types.js';

export interface Project {
	id: string;
	name: string;
	description: string;
	path: string;
	health: 'healthy' | 'warning' | 'error';
	techStack: string[];
	lastOpened: string;
	status: 'active' | 'archived';
	agents: number;
	sessions: number;
	memoryNodes: number;
}

export const load: PageServerLoad = async () => {
	const projects: Project[] = [
		{
			id: 'ai-playground',
			name: 'ai-playground',
			description: 'Central AI interface with multi-agent orchestration, GPT-OSS 20B local model, and family-only access.',
			path: 'C:\\Users\\11sos\\work\\ai-playground',
			health: 'healthy',
			techStack: ['SvelteKit', 'TypeScript', 'Tailwind', 'Ollama', 'Claude Flow v3'],
			lastOpened: '2 min ago',
			status: 'active',
			agents: 6,
			sessions: 3,
			memoryNodes: 89
		},
		{
			id: 'grocery-mcp',
			name: 'texas-grocery-mcp',
			description: 'H-E-B grocery MCP server for product search, cart management, and coupon clipping.',
			path: 'C:\\Users\\11sos\\work\\texas-grocery-mcp',
			health: 'healthy',
			techStack: ['TypeScript', 'MCP SDK', 'Playwright'],
			lastOpened: '1h ago',
			status: 'active',
			agents: 0,
			sessions: 0,
			memoryNodes: 12
		},
		{
			id: 'openclaw-core',
			name: 'openclaw',
			description: 'OpenClaw gateway core — messaging platform bridge with DM pairing and channel routing.',
			path: 'C:\\Users\\11sos\\work\\openclaw',
			health: 'warning',
			techStack: ['TypeScript', 'WebSocket', 'Discord.js', 'Twitch API'],
			lastOpened: '3h ago',
			status: 'active',
			agents: 2,
			sessions: 1,
			memoryNodes: 34
		},
		{
			id: 'family-bot',
			name: 'family-bot',
			description: 'Family assistant bot with grocery lists, reminders, and homework help.',
			path: 'C:\\Users\\11sos\\work\\family-bot',
			health: 'error',
			techStack: ['Python', 'FastAPI', 'SQLite'],
			lastOpened: '2d ago',
			status: 'archived',
			agents: 0,
			sessions: 0,
			memoryNodes: 5
		}
	];

	return { projects };
};
