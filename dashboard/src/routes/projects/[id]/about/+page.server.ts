import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		identity: {
			name: 'ai-playground',
			version: 'v0.1.0-dev',
			description: 'Local AI orchestration + multi-agent system, local-first, privacy-focused',
			status: 'active'
		},
		coreTech: [
			{ name: 'OpenClaw', version: 'v2026.3.x', status: 'connected', badge: 'gateway' },
			{ name: 'Ruflo / Claude Flow', version: 'v3.5.x', status: 'running', badge: 'orchestration' },
			{ name: 'GPT-OSS 20B', version: 'MoE 3.6B', status: 'loaded', badge: 'local model' },
			{ name: 'Claude API', version: 'Sonnet 4.6', status: 'available', badge: 'escalation' }
		],
		languages: [
			{ name: 'TypeScript', files: 526, pct: 64, color: 'accent-blue' },
			{ name: 'Svelte', files: 42, pct: 18, color: 'accent-red' },
			{ name: 'YAML/JSON', files: 2571, pct: 8, color: 'accent-yellow' },
			{ name: 'Python', files: 14, pct: 5, color: 'accent-green' },
			{ name: 'HTML / CSS', files: 8, pct: 3, color: 'accent-purple' },
			{ name: 'Shell', files: 12, pct: 2, color: 'accent-cyan' }
		],
		frameworks: [
			'SvelteKit 2.x', 'Tailwind CSS 4', 'Vite 6', 'Node.js 22'
		],
		tools: [
			'Claude Code', 'Penpot MCP', 'Playwright', 'Vitest'
		],
		mcpServers: [
			{ name: 'claude-flow', status: 'running', description: 'Agent orchestration + memory' },
			{ name: 'penpot', status: 'running', description: 'Design integration' },
			{ name: 'heb', status: 'stopped', description: 'Grocery MCP (texas-grocery)' },
			{ name: 'playwright', status: 'running', description: 'Browser automation' }
		],
		channels: [
			{ name: 'Twitch', status: 'connected', badge: 'live' },
			{ name: 'Discord', status: 'planned', badge: 'future' },
			{ name: 'Telegram', status: 'planned', badge: 'future' }
		],
		tasks: [
			{ id: 'DASH-001', title: 'Dashboard Design System', priority: 'high', status: 'in-progress', description: 'Penpot design system with Tailwind, typography, components, project system views' },
			{ id: 'DASH-002', title: 'OpenClaw Gateway Config', priority: 'high', status: 'completed', description: 'Networking, security, Claude Flow v3 MCP integration, 3-tier proxy API' },
			{ id: 'DASH-003', title: '3-Tier Model Routing', priority: 'medium', status: 'planned', description: 'Agent booster (WASM), Haiku routing, GPT-OSS 20B as primary with Claude escalation' },
			{ id: 'DASH-004', title: 'Ruflo / Claude Flow v3 Integration', priority: 'high', status: 'in-progress', description: 'Full agent lifecycle, HNSW memory, swarm coordination' },
			{ id: 'DASH-005', title: 'Ollama + GPT-OSS 20B Setup', priority: 'medium', status: 'completed', description: 'Local MoE model setup, initial testing, performance benchmarks' }
		]
	};
};
