import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		summary: { running: 3, stopped: 1, fromConfig: 3, manual: 1, configSource: ['.mcp.json', '.claude-flow/config.yaml'] },
		services: [
			{
				name: 'Claude Flow Daemon',
				status: 'running',
				description: 'Multi-agent orchestration daemon with HNSW memory',
				port: 3100,
				pid: 14823,
				uptime: '2h 14m',
				configFile: '.claude-flow/config.yaml'
			},
			{
				name: 'Dev Server (Vite)',
				status: 'running',
				description: 'SvelteKit development server with HMR',
				port: 5173,
				pid: 15201,
				uptime: '1h 47m',
				configFile: 'package.json'
			},
			{
				name: 'Penpot MCP',
				status: 'running',
				description: 'Penpot design integration MCP server',
				port: 4400,
				pid: 16042,
				uptime: '0h 38m',
				configFile: '.mcp.json'
			},
			{
				name: 'Ollama',
				status: 'stopped',
				description: 'Local LLM inference (GPT-OSS 20B)',
				port: 11434,
				pid: null,
				uptime: null,
				configFile: null
			}
		],
		autoStart: [
			{ name: 'Claude Flow Daemon', config: '.claude-flow/config.yaml', enabled: true, order: 1, delay: '0s' },
			{ name: 'Dev Server (Vite)', config: 'package.json', enabled: true, order: 2, delay: '2s' },
			{ name: 'Penpot MCP', config: '.mcp.json', enabled: false, order: null, delay: null }
		],
		logs: [
			{ time: '14:23:01', source: 'claude-flow', message: 'Daemon started on port 3100', level: 'info' },
			{ time: '14:23:03', source: 'vite', message: 'Dev server ready at http://localhost:5173', level: 'info' },
			{ time: '14:23:18', source: 'penpot-mcp', message: 'MCP server listening on port 4400', level: 'info' },
			{ time: '14:25:42', source: 'ollama', message: 'Connection refused — service not running', level: 'error' }
		]
	};
};
