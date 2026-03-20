import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { getServiceById } from '$lib/server/services.js';

/** Map service IDs to their log file paths (if known). */
const LOG_PATHS: Record<string, string> = {
	'claude-flow': '.claude-flow/logs/daemon.log',
	'openclaw': '.claude-flow/logs/security-audit.log',
	'ollama': '.playground/logs/ollama.log',
	'penpot-mcp': '.playground/logs/penpot-mcp.log',
	'memory-db': '.playground/logs/memory-db.log'
};

export const load: PageServerLoad = async ({ params }) => {
	const service = getServiceById(params.id);

	if (!service) {
		error(404, `Service "${params.id}" not found`);
	}

	const logPath = LOG_PATHS[params.id] ?? null;
	let logLines: string[] = [];
	let logError: string | null = null;

	if (logPath) {
		try {
			const { readFile } = await import('node:fs/promises');
			const { resolve } = await import('node:path');
			const content = await readFile(resolve(logPath), 'utf-8');
			const allLines = content.split('\n');
			logLines = allLines.slice(-100);
		} catch {
			logError = `Could not read log file: ${logPath}`;
		}
	} else {
		logError = 'No log file configured for this service.';
	}

	return {
		service,
		logPath,
		logLines,
		logError
	};
};
