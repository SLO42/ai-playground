import type { LayoutServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';

export const load: LayoutServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	if (!project) {
		return {
			projectId: params.id,
			project: {
				name: params.id,
				path: `F:/code/${params.id}`,
				health: 'unknown' as const,
				branch: 'main',
				commits: 0
			}
		};
	}

	return {
		projectId: params.id,
		project: {
			name: project.name,
			path: project.path,
			health: project.health,
			branch: project.branch ?? 'main',
			commits: project.commits ?? 0
		}
	};
};
