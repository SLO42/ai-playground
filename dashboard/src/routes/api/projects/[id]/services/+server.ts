import { json } from '@sveltejs/kit';
import { normalize, resolve } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params, fetch: serverFetch }) => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const apiRes = await serverFetch('/api/services');
	if (!apiRes.ok) {
		const body = await apiRes.json().catch(() => ({ error: 'Unknown error' }));
		return json({ error: body.error ?? `Services API returned ${apiRes.status}` }, { status: apiRes.status });
	}

	const { services: allServices } = await apiRes.json();

	const projectPath = normalize(resolve(project.path));

	// Tag each service with whether it's project-specific or shared infrastructure
	const services = allServices.map((svc: { configPath?: string | null; [k: string]: any }) => {
		const isProjectScoped = svc.configPath
			? normalize(resolve(svc.configPath)).startsWith(projectPath)
			: false;
		return { ...svc, projectScoped: isProjectScoped };
	});

	return json({
		services,
		projectId: params.id,
		projectPath: project.path,
		timestamp: new Date().toISOString()
	});
};
