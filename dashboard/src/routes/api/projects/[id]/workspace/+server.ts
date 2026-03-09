import { json } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { getWorkspaceInfo } from '$lib/server/workspace-detector.js';

export async function GET({ params }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const info = await getWorkspaceInfo(project.path);
	return json(info);
}
