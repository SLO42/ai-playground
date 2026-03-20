import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getTask, updateTask, migrateFromJson } from '$lib/server/task-store-sql.js';

async function findTaskProject(taskId: string): Promise<{ projectPath: string; projectId: string }> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	for (const project of projects) {
		migrateFromJson(project.path);
		const task = getTask(project.path, taskId);
		if (task) return { projectPath: project.path, projectId: project.id };
	}
	throw error(404, 'Task not found');
}

export async function POST({ params }) {
	const { projectPath } = await findTaskProject(params.id);
	const task = getTask(projectPath, params.id);
	if (!task) throw error(404, 'Task not found');

	if (task.status !== 'pending') {
		throw error(400, `Cannot start a task with status "${task.status}". Only pending tasks can be started.`);
	}

	const updated = updateTask(projectPath, params.id, { status: 'in_progress' });
	if (!updated) throw error(500, 'Failed to update task');

	return json({ task: updated });
}
