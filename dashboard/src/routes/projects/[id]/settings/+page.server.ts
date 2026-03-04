import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
	return {
		general: {
			name: 'ai-playground',
			path: 'C:\\Users\\11sos\\work\\ai-playground',
			branch: 'master',
			description: 'Local AI orchestration dashboard'
		},
		envVars: [
			{ key: 'ANTHROPIC_API_KEY', value: '••••••••sk-ant-...7x4Q', source: '.env' },
			{ key: 'HEB_DEFAULT_STORE', value: '541', source: '.env' },
			{ key: 'OLLAMA_HOST', value: 'http://127.0.0.1:11434', source: '.env' }
		],
		build: {
			dev: { command: 'npm run dev', label: 'Vite + SvelteKit' },
			build: { command: 'npm run build', label: 'Production build' },
			test: { command: 'npm test', label: 'Vitest' }
		},
		agentConfig: {
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		}
	};
};
