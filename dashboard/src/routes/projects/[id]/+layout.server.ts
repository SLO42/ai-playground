import type { LayoutServerLoad } from './$types.js';

export const load: LayoutServerLoad = async ({ params }) => {
	const projects: Record<string, { name: string; path: string; health: string; branch: string; commits: number }> = {
		'ai-playground': {
			name: 'ai-playground',
			path: '~/work/ai-playground',
			health: 'healthy',
			branch: 'master',
			commits: 0
		},
		'grocery-mcp': {
			name: 'texas-grocery-mcp',
			path: '~/work/texas-grocery-mcp',
			health: 'healthy',
			branch: 'main',
			commits: 24
		},
		'openclaw-core': {
			name: 'openclaw',
			path: '~/work/openclaw',
			health: 'warning',
			branch: 'develop',
			commits: 142
		},
		'family-bot': {
			name: 'family-bot',
			path: '~/work/family-bot',
			health: 'error',
			branch: 'main',
			commits: 8
		}
	};

	const project = projects[params.id] ?? {
		name: params.id,
		path: `~/work/${params.id}`,
		health: 'healthy',
		branch: 'main',
		commits: 0
	};

	return {
		projectId: params.id,
		project
	};
};
