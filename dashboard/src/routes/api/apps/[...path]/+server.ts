import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import registry from '$lib/apps/registry.json';
import type { AppEntry } from '$lib/apps/types.js';
import type { McpRegistry } from '$lib/types/mcp.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import { buildToolCatalog } from '$lib/server/mcp-tool-registry.js';

export const GET: RequestHandler = async ({ params }) => {
	const path = params.path;

	// GET /api/apps — list all apps
	if (!path) {
		return json({ apps: registry });
	}

	// GET /api/apps/:appId — single app detail
	const appId = path.split('/')[0];
	const app = (registry as AppEntry[]).find((a) => a.id === appId);
	if (!app) {
		return json({ error: 'App not found' }, { status: 404 });
	}

	const mcp = await readJsonFile<McpRegistry>(PATHS.mcpJson);
	const allServers = mcp?.mcpServers ?? {};

	let serverName: string | null = null;
	let serverConfig = null;
	for (const [name, config] of Object.entries(allServers)) {
		if (name === app.id || name.includes(app.id) || app.id.includes(name)) {
			serverName = name;
			serverConfig = config;
			break;
		}
	}

	const toolGroups = serverName ? buildToolCatalog([serverName]) : [];
	const totalTools = toolGroups.reduce((sum, g) => sum + g.tools.length, 0);

	const service = Object.values(SERVICES).find(
		(s) => s.id === app.id || s.id.includes(app.id) || app.id.includes(s.id)
	) ?? null;

	return json({
		app,
		serverName,
		serverConfig,
		toolGroups,
		totalTools,
		service
	});
};

export const POST: RequestHandler = async () => {
	return json({ error: 'Not implemented' }, { status: 501 });
};
