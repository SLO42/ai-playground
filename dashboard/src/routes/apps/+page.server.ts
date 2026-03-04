import type { PageServerLoad } from './$types.js';
import { readJsonFile } from '$lib/server/file-reader.js';
import { PATHS } from '$lib/server/constants.js';
import type { McpRegistry } from '$lib/types/mcp.js';
import type { AppEntry } from '$lib/apps/types.js';
import registry from '$lib/apps/registry.json';

export const load: PageServerLoad = async () => {
	const mcp = await readJsonFile<McpRegistry>(PATHS.mcpJson);

	const servers = mcp?.mcpServers ?? {};

	const toolCatalog = [
		{
			category: 'Swarm',
			tools: [
				'swarm_init', 'swarm_status', 'swarm_shutdown', 'swarm_health',
				'agent_spawn', 'agent_list', 'agent_terminate', 'agent_status'
			]
		},
		{
			category: 'Memory',
			tools: [
				'memory_store', 'memory_search', 'memory_retrieve',
				'memory_list', 'memory_delete', 'memory_stats'
			]
		},
		{
			category: 'Intelligence',
			tools: [
				'hooks_intelligence', 'neural_train', 'neural_predict',
				'neural_patterns', 'neural_status', 'neural_optimize'
			]
		},
		{
			category: 'Security',
			tools: [
				'aidefence_scan', 'aidefence_analyze',
				'claims_claim', 'transfer_detect-pii'
			]
		},
		{
			category: 'Browser',
			tools: [
				'browser_open', 'browser_click', 'browser_fill',
				'browser_snapshot', 'browser_screenshot', 'browser_close'
			]
		},
		{
			category: 'Grocery',
			tools: [
				'store_search', 'store_change', 'product_search', 'product_get',
				'cart_add', 'cart_get', 'coupon_list', 'coupon_clip'
			]
		}
	];

	return {
		servers,
		registry: registry as AppEntry[],
		toolCatalog
	};
};
