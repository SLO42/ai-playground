import { json, error } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { listTasks, getAllTasks, createTask, migrateIfNeeded } from '$lib/server/task-store.js';
import type { TaskStatus, TaskPriority } from '$lib/types/tasks.js';

async function getProjectPath(id: string): Promise<string> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project.path;
}

export async function GET({ params, url }) {
	const projectPath = await getProjectPath(params.id);
	await migrateIfNeeded(projectPath);

	const statusFilter = url.searchParams.get('status');
	if (statusFilter) {
		const statuses = statusFilter.split(',') as TaskStatus[];
		const all = await getAllTasks(projectPath);
		return json({ tasks: all.filter((t) => statuses.includes(t.status)) });
	}

	// Return index entries for fast listing, or full tasks if ?full=true
	if (url.searchParams.get('full') === 'true') {
		return json({ tasks: await getAllTasks(projectPath) });
	}
	return json({ tasks: await listTasks(projectPath) });
}

export async function POST({ params, request }) {
	const projectPath = await getProjectPath(params.id);
	await migrateIfNeeded(projectPath);

	const body = await request.json();
	if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
		throw error(400, 'Title is required');
	}

	const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

	const task = await createTask(projectPath, {
		title: body.title,
		description: body.description,
		priority: validPriorities.includes(body.priority) ? body.priority : 'medium',
		assignee: body.assignee,
		tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === 'string') : [],
		createdBy: body.createdBy ?? 'user',
		blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.filter((id: unknown) => typeof id === 'string') : undefined
	});

	return json({ task }, { status: 201 });
}
