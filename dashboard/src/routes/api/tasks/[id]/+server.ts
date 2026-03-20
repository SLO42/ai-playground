import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getTask, migrateFromJson } from '$lib/server/task-store-sql.js';

export async function GET({ params }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	for (const project of projects) {
		migrateFromJson(project.path);
		const task = getTask(project.path, params.id);
		if (task) {
			return json({ task: { ...task, projectId: project.id, projectName: project.name } });
		}
	}
	throw error(404, 'Task not found');
}
