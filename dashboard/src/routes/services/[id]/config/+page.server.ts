import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getServiceById } from '$lib/server/services.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const load: PageServerLoad = async ({ params }) => {
	const service = getServiceById(params.id);

	if (!service) {
		error(404, `Service "${params.id}" not found`);
	}

	let configContent: string | null = null;
	let configError: string | null = null;

	try {
		const configPath = resolve(service.configPath);
		configContent = await readFile(configPath, 'utf-8');
	} catch (err) {
		configError = `Could not read config file: ${service.configPath}`;
	}

	return {
		service,
		configContent,
		configError
	};
};
