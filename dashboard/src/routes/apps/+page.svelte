<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let serverEntries = $derived(Object.entries(data.servers));
	let totalTools = $derived(data.toolCatalog.reduce((sum: number, g: { tools: string[] }) => sum + g.tools.length, 0));

	const mcpServers = [
		{ name: 'claude-flow', desc: 'Multi-agent orchestration', version: 'v3.5.x', tools: 12, status: 'Connected', statusColor: 'text-accent-green', dotColor: 'bg-accent-green' },
		{ name: 'texas-grocery', desc: 'H-E-B grocery integration', version: 'v0.1.3', tools: 11, status: 'Connected', statusColor: 'text-accent-green', dotColor: 'bg-accent-green' },
		{ name: 'playwright', desc: 'Browser automation', version: 'latest', tools: 8, status: 'Connected', statusColor: 'text-accent-green', dotColor: 'bg-accent-green' },
		{ name: 'penpot', desc: 'Design tool MCP', version: 'develop', tools: 5, status: 'Connected', statusColor: 'text-accent-green', dotColor: 'bg-accent-green' }
	];

	const toolGroups = [
		{ server: 'claude-flow', color: 'text-accent-cyan', tools: ['agent_spawn', 'swarm_init', 'memory_store', 'memory_search', 'task_create', 'hooks_pre-task'] },
		{ server: 'texas-grocery', color: 'text-accent-green', tools: ['product_search', 'cart_add', 'coupon_list', 'store_search', 'session_refresh'] },
		{ server: 'playwright', color: 'text-accent-blue', tools: ['browser_navigate', 'browser_click', 'browser_screenshot', 'browser_snapshot'] },
		{ server: 'penpot', color: 'text-accent-purple', tools: ['execute_code', 'export_shape', 'penpot_api_info', 'import_image'] }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Apps & MCP Servers</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="MCP Servers" value={serverEntries.length || 4} subtitle="3 connected" accent="blue" />
		<MetricCard label="Total Tools" value={totalTools || 23} subtitle="across all servers" accent="cyan" />
		<MetricCard label="Requests Today" value="847" subtitle="94% local" accent="green" />
		<MetricCard label="Avg Latency" value="12ms" subtitle="local model" accent="purple" />
	</div>

	<!-- MCP Servers -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">MCP Servers</h2>
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			{#each mcpServers as server}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full {server.dotColor}"></span>
						<span class="type-card-title text-text-primary">{server.name}</span>
					</div>
					<p class="text-xs text-text-secondary">{server.desc}</p>
					<p class="text-xs text-text-secondary mt-1">Version: {server.version}</p>
					<p class="text-xs text-accent-cyan font-mono mt-1">Tools: {server.tools}</p>
					<p class="text-xs {server.statusColor} font-mono">{server.status}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Available Tools -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Available Tools</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-4">
			{#each toolGroups as group}
				<div>
					<p class="text-sm font-medium {group.color} mb-2">{group.server}</p>
					<div class="flex flex-wrap gap-2">
						{#each group.tools as tool}
							<span class="text-xs font-mono bg-bg-primary text-text-secondary px-3 py-1.5 rounded border border-border">
								{tool}
							</span>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>
</div>
