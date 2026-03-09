import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readdir } from 'fs/promises';
import { basename } from 'path';
import { getAllTasks, migrateIfNeeded } from '$lib/server/task-store.js';
import { getSyncStatus } from '$lib/server/github-sync.js';

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
	let syncStatus: { repo: string; lastSync: string | null; mappings: number } | null = null;

	if (project) {
		const [, allTasks, status] = await Promise.all([
			migrateIfNeeded(project.path),
			getAllTasks(project.path),
			getSyncStatus(project.path).catch(() => null)
		]);
		tasks = allTasks;
		syncStatus = status ? { repo: status.repo, lastSync: status.lastSync, mappings: status.mappings } : null;
	}

	return { tasks, projectId: params.id, agentNames, syncStatus };
};
