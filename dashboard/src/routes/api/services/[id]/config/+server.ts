import { json, error } from '@sveltejs/kit';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { SERVICES, PATHS, isPathAllowed } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.configPath) throw error(404, 'No config file for this service');

	const configPath = resolve(PATHS.root, service.configPath);

	if (!isPathAllowed(configPath)) {
		throw error(403, 'Config path not in allowed directories');
	}

	try {
		const content = await readFile(configPath, 'utf-8');
		const ext = service.configPath.split('.').pop() ?? '';
		let language = 'text';
		if (ext === 'yaml' || ext === 'yml') language = 'yaml';
		else if (ext === 'json' || ext === 'json5') language = 'json';
		else if (ext === 'toml') language = 'toml';

		return json({
			content,
			language,
			path: service.configPath,
			serviceName: service.name
		});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return json({ content: '', language: 'text', path: service.configPath, serviceName: service.name });
		}
		throw error(500, 'Failed to read config file');
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.configPath) throw error(404, 'No config file for this service');

	const configPath = resolve(PATHS.root, service.configPath);

	if (!isPathAllowed(configPath)) {
		throw error(403, 'Config path not in allowed directories');
	}

	const body = await request.json();
	if (typeof body.content !== 'string') {
		throw error(400, 'Missing or invalid "content" field');
	}

	try {
		await writeFile(configPath, body.content, 'utf-8');
		return json({ success: true, message: `Config saved: ${service.configPath}` });
	} catch {
		throw error(500, 'Failed to write config file');
	}
};
