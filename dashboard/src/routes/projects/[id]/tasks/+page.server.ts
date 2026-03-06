import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readdir } from 'fs/promises';
import { basename } from 'path';
import { getAllTasks, migrateIfNeeded } from '$lib/server/task-store.js';

async function getAgentNames(): Promise<string[]> {
	try {
		const entries = await readdir(PATHS.agentsDir);
		return entries
			.filter((f) => f.endsWith('.md') || f.endsWith('.yaml') || f.endsWith('.yml'))
			.map((f) => basename(f, f.substring(f.lastIndexOf('.'))));
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const [projects, agentNames] = await Promise.all([
		scanAllProjects(PATHS.playgroundRegistry, PATHS.root),
		getAgentNames()
	]);
	const project = projects.find((p) => p.id === params.id);

	let tasks: import('$lib/types/tasks.js').Task[] = [];
	if (project) {
		await migrateIfNeeded(project.path);
		tasks = await getAllTasks(project.path);
	}

	return { tasks, projectId: params.id, agentNames };
};
