import type { PageServerLoad } from './$types.js';
import registry from '$lib/apps/registry.json';
import type { AppEntry } from '$lib/apps/types.js';
import type { McpRegistry, McpServerConfig, McpToolGroup } from '$lib/types/mcp.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import { buildToolCatalog } from '$lib/server/mcp-tool-registry.js';
import { error } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ params }) => {
	const app = (registry as AppEntry[]).find((a) => a.id === params.appId);
	if (!app) throw error(404, 'App not found');

	const mcp = await readJsonFile<McpRegistry>(PATHS.mcpJson);
	const allServers = mcp?.mcpServers ?? {};

	// Find the MCP server matching this app (by id or close match)
	let serverName: string | null = null;
	let serverConfig: McpServerConfig | null = null;
	for (const [name, config] of Object.entries(allServers)) {
		if (name === app.id || name.includes(app.id) || app.id.includes(name)) {
			serverName = name;
			serverConfig = config;
			break;
		}
	}

	// Build tool catalog for this specific server
	const toolGroups: McpToolGroup[] = serverName ? buildToolCatalog([serverName]) : [];
	const totalTools = toolGroups.reduce((sum, g) => sum + g.tools.length, 0);

	// Check if there's a matching service definition
	const service = Object.values(SERVICES).find(
		(s) => s.id === app.id || s.id.includes(app.id) || app.id.includes(s.id)
	) ?? null;

	return {
		app,
		serverName,
		serverConfig,
		toolGroups,
		totalTools,
		service
	};
};
