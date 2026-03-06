import { json } from '@sveltejs/kit';
import { resolve } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { ProjectRegistry } from '$lib/types/projects.js';

export async function GET({ params }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}
	return json({ project });
}

export async function DELETE({ params }) {
	const registryPath = PATHS.playgroundRegistry;
	let registry: ProjectRegistry;
	try {
		const raw = await readFile(registryPath, 'utf-8');
		registry = JSON.parse(raw);
	} catch {
		return json({ error: 'Registry not found' }, { status: 404 });
	}

	// Find project by scanning to match ID
	const projects = await scanAllProjects(registryPath, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	// Remove from registry by path match
	const normalizedPath = resolve(project.path);
	registry.projects = registry.projects.filter((e) => {
		const entryPath = resolve(PATHS.root, e.path === '.' ? '.' : e.path);
		return entryPath !== normalizedPath;
	});

	await writeFile(registryPath, JSON.stringify(registry, null, '\t'), 'utf-8');
	return json({ success: true });
}
