import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { McpRegistry } from '$lib/types/mcp.js';
import type { AppEntry } from '$lib/apps/types.js';
import registry from '$lib/apps/registry.json';
import { buildToolCatalog } from '$lib/server/mcp-tool-registry.js';

export const load: PageServerLoad = async () => {
	const mcp = await readJsonFile<McpRegistry>(PATHS.mcpJson);

	const servers = mcp?.mcpServers ?? {};
	const toolCatalog = buildToolCatalog(Object.keys(servers));

	return {
		servers,
		registry: registry as AppEntry[],
		toolCatalog
	};
};
