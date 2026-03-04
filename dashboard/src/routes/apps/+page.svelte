<script lang="ts">
	import AppCard from '$lib/components/AppCard.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let serverEntries = $derived(Object.entries(data.servers));
	let totalTools = $derived(data.toolCatalog.reduce((sum: number, g: { tools: string[] }) => sum + g.tools.length, 0));

	let expandedGroups: Record<string, boolean> = $state({});

	function toggleGroup(category: string) {
		expandedGroups[category] = !expandedGroups[category];
	}
</script>

<div class="space-y-6">
	<!-- Summary Metrics -->
	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
		<MetricCard label="MCP Servers" value={serverEntries.length} accent="blue" />
		<MetricCard label="Tool Categories" value={data.toolCatalog.length} accent="purple" />
		<MetricCard label="Total Tools" value={totalTools} accent="cyan" />
	</div>

	<!-- MCP Server Registry -->
	<div>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">MCP Server Registry</h2>
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each serverEntries as [name, config]}
				<AppCard
					{name}
					command={[config.command, ...(config.args ?? [])].join(' ')}
					status={config.autoStart ? 'online' : 'offline'}
					autoStart={config.autoStart ?? false}
				/>
			{/each}
		</div>
	</div>

	<!-- Tool Catalog -->
	<div>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Tool Catalog</h2>
		<div class="space-y-2">
			{#each data.toolCatalog as group}
				<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
					<button
						class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-bg-primary/50 transition-colors"
						onclick={() => toggleGroup(group.category)}
					>
						<span class="text-sm font-medium text-text-primary">{group.category}</span>
						<div class="flex items-center gap-2">
							<span class="text-xs font-mono bg-accent-blue/20 text-accent-blue px-2 py-0.5 rounded-full">
								{group.tools.length}
							</span>
							<span class="text-text-secondary text-xs transition-transform {expandedGroups[group.category] ? 'rotate-180' : ''}">
								&#9660;
							</span>
						</div>
					</button>
					{#if expandedGroups[group.category]}
						<div class="border-t border-border px-4 py-3">
							<div class="flex flex-wrap gap-2">
								{#each group.tools as tool}
									<span class="text-xs font-mono bg-bg-primary text-text-secondary px-2.5 py-1 rounded border border-border">
										{tool}
									</span>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- App Registry -->
	<div>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">App Registry</h2>
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each data.registry as app}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex justify-between items-center mb-2">
						<h3 class="text-sm font-medium text-text-primary">{app.name}</h3>
						<span class="text-xs font-mono {app.status === 'available' ? 'text-accent-green' : 'text-accent-yellow'} uppercase">
							{app.status}
						</span>
					</div>
					<p class="text-xs text-text-secondary">{app.description}</p>
					<p class="text-xs font-mono text-text-secondary mt-2">id: {app.id}</p>
				</div>
			{/each}
		</div>
	</div>
</div>
