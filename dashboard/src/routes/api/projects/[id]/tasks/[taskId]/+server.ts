import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getTask, updateTask, deleteTask, migrateIfNeeded } from '$lib/server/task-store.js';
import type { TaskStatus, TaskPriority } from '$lib/types/tasks.js';

async function getProjectPath(id: string): Promise<string> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project.path;
}

export async function GET({ params }) {
	const projectPath = await getProjectPath(params.id);
	await migrateIfNeeded(projectPath);
	const task = await getTask(projectPath, params.taskId);
	if (!task) throw error(404, 'Task not found');
	return json({ task });
}

export async function PUT({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	await migrateIfNeeded(projectPath);

	const body = await request.json();
	const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
	const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

	const updates: Record<string, unknown> = {};
	if (body.title !== undefined) updates.title = body.title;
	if (body.description !== undefined) updates.description = body.description;
	if (body.status !== undefined && validStatuses.includes(body.status)) updates.status = body.status;
	if (body.priority !== undefined && validPriorities.includes(body.priority)) updates.priority = body.priority;
	if (body.flagDiscussion !== undefined) updates.flagDiscussion = body.flagDiscussion;
	if (body.assignee !== undefined) updates.assignee = body.assignee;
	if (body.tags !== undefined && Array.isArray(body.tags)) updates.tags = body.tags.filter((t: unknown) => typeof t === 'string');

	const task = await updateTask(projectPath, params.taskId, updates as any);
	if (!task) throw error(404, 'Task not found');

	return json({ task });
}

export async function DELETE({ params }) {
	const projectPath = await getProjectPath(params.id);
	await migrateIfNeeded(projectPath);
	const deleted = await deleteTask(projectPath, params.taskId);
	if (!deleted) throw error(404, 'Task not found');
	return json({ success: true });
}
