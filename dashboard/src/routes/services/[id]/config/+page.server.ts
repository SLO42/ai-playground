import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { SERVICES, PATHS } from '$lib/server/constants.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const load: PageServerLoad = async ({ params }) => {
	const def = SERVICES[params.id as keyof typeof SERVICES];
	if (!def) throw error(404, `Service "${params.id}" not found`);

	let configContent: string | null = null;
	let configError: string | null = null;

	try {
		const configPath = def.configPath
			? resolve(PATHS.root, def.configPath)
			: null;
		if (configPath) {
			configContent = await readFile(configPath, 'utf-8');
		} else {
			configError = 'No config file path defined for this service';
		}
	} catch {
		configError = `Could not read config file: ${def.configPath ?? 'unknown'}`;
	}

	return {
		service: { id: params.id, name: def.name, type: def.type ?? 'Service', configPath: def.configPath },
		configContent,
		configError
	};
};
