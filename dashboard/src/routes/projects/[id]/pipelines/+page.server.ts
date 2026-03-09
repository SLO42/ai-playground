import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { PipelineStatus } from '$lib/server/ci-pipeline.js';

interface PipelineData {
	projectId: string;
	repo: string;
	workflows: PipelineStatus['workflows'];
	recentRuns: PipelineStatus['recentRuns'];
	hasGh: boolean;
}

export const load: PageServerLoad = async ({ params }): Promise<PipelineData> => {
	const empty: PipelineData = {
		projectId: params.id,
		repo: '',
		workflows: [],
		recentRuns: [],
		hasGh: false
	};

	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) return empty;

	try {
		const { getPipelineStatus } = await import('$lib/server/ci-pipeline.js');
		const status = await getPipelineStatus(project.path);

		return {
			projectId: params.id,
			repo: status.repo,
			workflows: status.workflows,
			recentRuns: status.recentRuns,
			hasGh: status.hasGh
		};
	} catch {
		return empty;
	}
};
