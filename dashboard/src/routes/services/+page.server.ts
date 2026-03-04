import type { PageServerLoad } from './$types.js';

export interface Service {
	id: string;
	name: string;
	type: string;
	configPath: string;
	pid: number | null;
	port: number | null;
	secondaryPort: number | null;
	status: 'running' | 'stopped' | 'errored';
	uptime: string | null;
	ram: string | null;
	cpu: string | null;
	errorMessage: string | null;
}

export const load: PageServerLoad = async () => {
	const services: Service[] = [
		{
			id: 'penpot-mcp',
			name: 'Penpot MCP Server',
			type: 'MCP Server',
			configPath: 'C:\\Users\\11sos\\tools\\penpot-mcp',
			pid: 12847,
			port: 4400,
			secondaryPort: null,
			status: 'running',
			uptime: '2h 14m',
			ram: '48 MB',
			cpu: '1.2%',
			errorMessage: null
		},
		{
			id: 'claude-flow',
			name: 'Claude Flow Daemon',
			type: 'Background Service',
			configPath: '.claude-flow/config.yaml',
			pid: 9134,
			port: 3847,
			secondaryPort: null,
			status: 'running',
			uptime: '5h 02m',
			ram: '124 MB',
			cpu: '0.8%',
			errorMessage: null
		},
		{
			id: 'ollama',
			name: 'Ollama Server',
			type: 'Model Runtime',
			configPath: 'config/openclaw/models.json5',
			pid: 4713,
			port: 11434,
			secondaryPort: null,
			status: 'running',
			uptime: '12h 38m',
			ram: '8.4 GB',
			cpu: '14.2%',
			errorMessage: null
		},
		{
			id: 'openclaw',
			name: 'OpenClaw Gateway',
			type: 'API Gateway',
			configPath: 'config/openclaw/gateway.yaml',
			pid: 15023,
			port: 18789,
			secondaryPort: null,
			status: 'running',
			uptime: '5h 01m',
			ram: '64 MB',
			cpu: '0.3%',
			errorMessage: null
		},
		{
			id: 'heb-mcp',
			name: 'Texas Grocery MCP',
			type: 'MCP Server',
			configPath: '.mcp.json -> "heb"',
			pid: null,
			port: null,
			secondaryPort: null,
			status: 'stopped',
			uptime: null,
			ram: null,
			cpu: null,
			errorMessage: null
		},
		{
			id: 'memory-db',
			name: 'Memory DB (SQLite)',
			type: 'Database',
			configPath: '.swarm/memory.db',
			pid: 3891,
			port: null,
			secondaryPort: null,
			status: 'errored',
			uptime: null,
			ram: null,
			cpu: null,
			errorMessage: 'Lock file exists — investigate or force restart'
		},
		{
			id: 'dev-dashboard',
			name: 'Dev Dashboard',
			type: 'Web App',
			configPath: 'dashboard/',
			pid: null,
			port: null,
			secondaryPort: null,
			status: 'stopped',
			uptime: null,
			ram: null,
			cpu: null,
			errorMessage: null
		}
	];

	const running = services.filter((s) => s.status === 'running').length;
	const stopped = services.filter((s) => s.status === 'stopped').length;
	const errored = services.filter((s) => s.status === 'errored').length;

	return {
		services,
		stats: { running, stopped, errored, total: services.length }
	};
};
