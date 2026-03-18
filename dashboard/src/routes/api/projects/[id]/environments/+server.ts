/**
 * Environments API — list, create/update, and delete project environments.
 * Data stored at: <projectPath>/.playground/environments.json
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import {
	loadEnvironments,
	saveEnvironments,
	validateEnvironment
} from '$lib/server/environments.js';

async function resolveProject(projectId: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	return projects.find((p) => p.id === projectId);
}

/** GET /api/projects/[id]/environments — list all environments */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const project = await resolveProject(params.id);
		if (!project) {
			return json({ error: 'Project not found' }, { status: 404 });
		}

		const environments = await loadEnvironments(project.path);
		return json({ environments });
	} catch (e) {
		console.error('[api/environments] GET failed:', e);
		return json({ error: 'Failed to load environments' }, { status: 500 });
	}
};

/** POST /api/projects/[id]/environments — create or update an environment */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		const project = await resolveProject(params.id);
		if (!project) {
			return json({ error: 'Project not found' }, { status: 404 });
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		const result = validateEnvironment(body);
		if (!result.valid) {
			return json({ error: result.error }, { status: 400 });
		}

		const envs = await loadEnvironments(project.path);
		const existingIdx = envs.findIndex((e) => e.name === result.data.name);

		if (existingIdx >= 0) {
			envs[existingIdx] = result.data;
		} else {
			envs.push(result.data);
		}

		await saveEnvironments(project.path, envs);
		return json({ ok: true, environment: result.data });
	} catch (e) {
		console.error('[api/environments] POST failed:', e);
		return json({ error: 'Failed to save environment' }, { status: 500 });
	}
};

/** DELETE /api/projects/[id]/environments — remove an environment by name */
export const DELETE: RequestHandler = async ({ params, request }) => {
	try {
		const project = await resolveProject(params.id);
		if (!project) {
			return json({ error: 'Project not found' }, { status: 404 });
		}

		let body: { name?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		if (!body.name || typeof body.name !== 'string') {
			return json({ error: 'Environment name is required' }, { status: 400 });
		}

		const envs = await loadEnvironments(project.path);
		const filtered = envs.filter((e) => e.name !== body.name);

		if (filtered.length === envs.length) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		await saveEnvironments(project.path, filtered);
		return json({ ok: true, deleted: body.name });
	} catch (e) {
		console.error('[api/environments] DELETE failed:', e);
		return json({ error: 'Failed to delete environment' }, { status: 500 });
	}
};
