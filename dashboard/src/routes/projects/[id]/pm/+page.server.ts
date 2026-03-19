import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { loadPlan } from '$lib/server/project-manager.js';
import * as pmDb from '$lib/server/pm-memory-db.js';

export const load: PageServerLoad = async ({ params }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find(p => p.id === params.id);

	if (!project) {
		return {
			projectId: params.id,
			plan: null,
			stats: null,
			recentMemory: [],
			risks: [],
			hasPm: false
		};
	}

	const plan = await loadPlan(project.path);
	let stats = null;
	let recentMemory: ReturnType<typeof pmDb.getRecentEntries> = [];
	let risks: ReturnType<typeof pmDb.getTopEntriesByType> = [];

	try {
		stats = pmDb.getStats(project.path);
		recentMemory = pmDb.getRecentEntries(project.path, 30);
		risks = pmDb.getTopEntriesByType(project.path, 'risk', 10);
	} catch {
		// DB not initialized yet — that's fine
	}

	return {
		projectId: params.id,
		plan,
		stats,
		recentMemory,
		risks,
		hasPm: !!plan
	};
};
