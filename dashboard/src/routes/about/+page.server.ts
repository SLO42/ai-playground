import type { PageServerLoad } from './$types.js';

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

export const load: PageServerLoad = async () => {
	const platform = {
		name: 'ai-playground',
		version: 'v0.1.0',
		description: 'AI agent orchestration dashboard with cloud flow model routing, multi-agent coordination, and cross-platform messaging.'
	};

	const coreTech: TechCard[] = [
		{ name: 'SvelteKit', version: '2.x', description: 'Full-stack framework', color: 'accent-red' },
		{ name: 'Tailwind CSS', version: 'v4', description: 'Utility-first CSS', color: 'accent-cyan' },
		{ name: 'TypeScript', version: '5.x', description: 'Type-safe JS', color: 'accent-blue' },
		{ name: 'Chart.js', version: '4.x', description: 'Data visualization', color: 'accent-yellow' }
	];

	const stack: StackPanel[] = [
		{
			name: 'OpenClaw',
			description: 'Central AI interface across messaging platforms.',
			details: ['Gateway on port 18789', 'DM pairing policy', 'Twitch, Discord, WhatsApp channels', 'TLS 1.3 minimum'],
			color: 'accent-blue'
		},
		{
			name: 'Ollama / GPT-OSS 20B',
			description: 'Local MoE model for orchestration and routing.',
			details: ['3.6B active params', 'RTX 3090 (24GB VRAM)', '$0 per token', 'Native API on :11434'],
			color: 'accent-green'
		},
		{
			name: 'Claude Flow v3',
			description: 'Multi-agent orchestration with 60+ agent types.',
			details: ['HNSW memory indexing', 'Hierarchical-mesh topology', 'Byzantine fault tolerance', 'EWC++ consolidation'],
			color: 'accent-purple'
		},
		{
			name: 'HEB MCP',
			description: 'Texas Grocery integration for H-E-B.',
			details: ['Product search + pricing', 'Cart management', 'Coupon clipping', 'Session auto-refresh'],
			color: 'accent-yellow'
		}
	];

	const mcpServers: McpServer[] = [
		{ name: 'claude-flow', status: 'connected' },
		{ name: 'penpot-mcp', status: 'connected' },
		{ name: 'heb (texas-grocery)', status: 'disconnected' },
		{ name: 'playwright', status: 'connected' }
	];

	const channels: Channel[] = [
		{ name: 'Twitch', type: 'Streaming', status: 'active' },
		{ name: 'Discord', type: 'Messaging', status: 'inactive' },
		{ name: 'WhatsApp', type: 'Messaging', status: 'inactive' }
	];

	return { platform, coreTech, stack, mcpServers, channels };
};
