import { json } from '@sveltejs/kit';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects, scanProject } from '$lib/server/project-scanner.js';

export async function POST({ params }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const rescanned = await scanProject(project.path);
	return json({ project: rescanned });
}
