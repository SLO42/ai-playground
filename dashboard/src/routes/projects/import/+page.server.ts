import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		defaultPath: 'C:\\Users\\11sos\\work\\ai-playground',
		detectedConfigs: [
			{ file: 'CLAUDE.md', type: 'Claude Config', found: true },
			{ file: 'package.json', type: 'Node.js Project', found: true },
			{ file: '.env.example', type: 'Environment', found: true },
			{ file: '.swarm/memory.db', type: 'Memory DB', found: true },
			{ file: 'docker-compose.yml', type: 'Docker', found: false },
			{ file: '.mcp.json', type: 'MCP Servers', found: true },
			{ file: '.claude-flow/config.yaml', type: 'Ruflo Config', found: true },
			{ file: 'config/openclaw/', type: 'OpenClaw Config', found: true },
			{ file: 'config/security/', type: 'Security Policy', found: true },
			{ file: '.github/workflows/', type: 'CI/CD', found: false }
		],
		detectedServices: [
			{ name: 'Penpot MCP', detected: true },
			{ name: 'Claude Flow Daemon', detected: true },
			{ name: 'OpenClaw Gateway', detected: true },
			{ name: 'Texas Grocery MCP', detected: true }
		],
		importActions: [
			{ label: 'Register project in OpenClaw project index', icon: 'check' },
			{ label: 'Import 4 detected services into Services manager', icon: 'check' },
			{ label: 'Generate .openclaw/project.yaml with routing + agent config', icon: 'check' },
			{ label: 'Create isolated memory namespace "ai-playground"', icon: 'check' },
			{ label: 'Load existing CLAUDE.md as project context', icon: 'check' },
			{ label: 'No changes to existing files — non-destructive import', icon: 'check' }
		]
	};
};
