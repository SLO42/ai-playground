import { json, error } from '@sveltejs/kit';
import { readFile, readdir, stat } from 'fs/promises';
import { resolve } from 'path';
import { SERVICES } from '$lib/server/constants.js';
import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const service = SERVICES[params.id as keyof typeof SERVICES];
	if (!service) throw error(404, 'Service not found');
	if (!service.logFile) throw error(404, 'No logs configured for this service');

	const lines = Math.min(parseInt(url.searchParams.get('lines') ?? '100', 10), 500);

	try {
		const logPath = service.logFile;
		const info = await stat(logPath);

		let content: string;

		if (info.isDirectory()) {
			// claude-flow: aggregate latest headless worker logs
			const files = await readdir(logPath);
			const fileStats = await Promise.all(
				files
					.filter((f) => f.endsWith('.log'))
					.map(async (f) => {
						const fp = resolve(logPath, f);
						const s = await stat(fp);
						return { path: fp, name: f, mtime: s.mtimeMs };
					})
			);
			fileStats.sort((a, b) => b.mtime - a.mtime);

			// Read from newest files until we have enough lines
			const allLines: string[] = [];
			for (const f of fileStats.slice(0, 10)) {
				if (allLines.length >= lines) break;
				const text = await readFile(f.path, 'utf-8');
				const fLines = text.split('\n').filter(Boolean);
				// Prefix with filename for context
				const prefix = f.name.replace(/_/g, ' ').replace('.log', '');
				allLines.push(...fLines.map((l) => `[${prefix}] ${l}`));
			}

			content = allLines.slice(-lines).join('\n');
		} else {
			// Single file — read last N lines
			const text = await readFile(logPath, 'utf-8');
			const allLines = text.split('\n');
			content = allLines.slice(-lines).join('\n');
		}

		return json({
			lines: content.split('\n'),
			serviceName: service.name
		});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return json({ lines: [], serviceName: service.name });
		}
		throw error(500, 'Failed to read logs');
	}
};
