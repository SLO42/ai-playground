import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { syncTasks, getSyncStatus } from '$lib/server/github-sync.js';

async function getProject(id: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === id);
	if (!project) throw error(404, 'Project not found');
	return project;
}

/** GET — return sync status for this project */
export const GET: RequestHandler = async ({ params }) => {
	const project = await getProject(params.id);
	try {
		const status = await getSyncStatus(project.path);
		return json(status);
	} catch (e) {
		return json({
			repo: 'unknown',
			lastSync: null,
			mappings: 0,
			error: e instanceof Error ? e.message : 'Failed to get sync status'
		});
	}
};

/** POST — trigger a sync for this project */
export const POST: RequestHandler = async ({ params, request }) => {
	const project = await getProject(params.id);

	let direction: 'push' | 'pull' | 'both' = 'both';
	try {
		const body = await request.json();
		if (body.direction === 'push' || body.direction === 'pull') {
			direction = body.direction;
		}
	} catch {
		// No body or invalid JSON — use defaults
	}

	try {
		const result = await syncTasks({
			projectId: params.id,
			projectPath: project.path,
			direction,
			source: 'dashboard'
		});
		return json(result);
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Sync failed', created: 0, updated: 0, pulled: 0, skipped: 0, errors: [String(e)] },
			{ status: 500 }
		);
	}
};
