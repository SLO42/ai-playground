import { error } from '@sveltejs/kit';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { SERVICES, PATHS, isPathAllowed } from '$lib/server/constants.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.configPath) throw error(404, 'No config file for this service');

	const configPath = resolve(PATHS.root, service.configPath);

	if (!isPathAllowed(configPath)) {
		throw error(403, 'Config path not in allowed directories');
	}

	const ext = service.configPath.split('.').pop() ?? '';
	let language = 'text';
	if (ext === 'yaml' || ext === 'yml') language = 'yaml';
	else if (ext === 'json' || ext === 'json5') language = 'json';
	else if (ext === 'toml') language = 'toml';

	try {
		const content = await readFile(configPath, 'utf-8');
		return {
			content,
			language,
			path: service.configPath
		};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return { content: `# File not found: ${service.configPath}`, language, path: service.configPath };
		}
		throw error(500, 'Failed to read config file');
	}
};
