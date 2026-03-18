import type { PageServerLoad } from './$types.js';
import { resolve } from 'path';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import { loadEnvironments } from '$lib/server/environments.js';

interface ProjectSettings {
	general: {
		name: string;
		description: string;
		branch: string;
	};
	build: {
		dev: { command: string; label: string };
		build: { command: string; label: string };
		test: { command: string; label: string };
	};
	agentConfig: {
		topology: string;
		maxAgents: number;
		memoryBackend: string;
		consensus: string;
	};
	autoStart: boolean;
}

export const load: PageServerLoad = async ({ parent }) => {
	const { projectId, project } = await parent();
	const sanitized = projectId.replace(/[^a-zA-Z0-9_-]/g, '');
	const path = resolve(PATHS.projectsDir, `${sanitized}.json`);
	const stored = await readJsonFile<ProjectSettings>(path);

	const environments = await loadEnvironments(project.path);

	return {
		general: stored?.general ?? {
			name: project.name ?? projectId,
			path: project.path ?? '',
			description: project.description ?? '',
			branch: project.branch ?? 'main'
		},
		envVars: [
			{ key: 'ANTHROPIC_API_KEY', value: '\u2022\u2022\u2022\u2022sk-ant-...7x4Q', source: '.env' },
			{ key: 'HEB_DEFAULT_STORE', value: '541', source: '.env' },
			{ key: 'OLLAMA_HOST', value: 'http://127.0.0.1:11434', source: '.env' }
		],
		build: stored?.build ?? {
			dev: { command: 'npm run dev', label: 'Vite + SvelteKit' },
			build: { command: 'npm run build', label: 'Production build' },
			test: { command: 'npm test', label: 'Vitest' }
		},
		agentConfig: stored?.agentConfig ?? {
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		},
		autoStart: stored?.autoStart ?? false,
		environments
	};
};
