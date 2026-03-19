import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

async function readFavorites(): Promise<string[]> {
	try {
		const raw = await readFile(resolve(PATHS.root, '.playground/favorites.json'), 'utf-8');
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

export const load: PageServerLoad = async () => {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const favorites = await readFavorites();

	for (const p of projects) {
		p.favorite = favorites.includes(p.id);
	}

	return { projects, favorites };
};
