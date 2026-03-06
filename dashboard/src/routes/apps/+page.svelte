<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let serverEntries = $derived(Object.entries(data.servers));
	let totalTools = $derived(data.toolCatalog.reduce((sum: number, g: { tools: string[] }) => sum + g.tools.length, 0));
	let toolCategories = $derived(data.toolCatalog.length);
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Apps & MCP Servers</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="MCP Servers" value={serverEntries.length} subtitle="{serverEntries.length} configured" accent="blue" />
		<MetricCard label="Total Tools" value={totalTools} subtitle="across {toolCategories} categories" accent="cyan" />
		<MetricCard label="Apps" value={data.registry.length} subtitle="registered" accent="green" />
		<MetricCard label="Tool Categories" value={toolCategories} subtitle="grouped by function" accent="purple" />
	</div>

	<!-- MCP Servers -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">MCP Servers</h2>
		{#if serverEntries.length === 0}
			<p class="text-sm text-text-secondary">No MCP servers configured.</p>
		{:else}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				{#each serverEntries as [name, config]}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-2 mb-1">
							<span class="w-2 h-2 rounded-full bg-accent-green"></span>
							<span class="type-card-title text-text-primary">{name}</span>
						</div>
						<p class="text-xs text-text-secondary font-mono mt-1">{config.command} {config.args?.join(' ') ?? ''}</p>
						{#if config.autoStart !== undefined}
							<p class="text-xs text-text-secondary mt-1">Auto-start: {config.autoStart ? 'yes' : 'no'}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- App Registry -->
	{#if data.registry.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Registered Apps</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each data.registry as app}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-1">
							<span class="type-card-title text-text-primary">{app.name}</span>
							<span class="text-xs font-mono px-2 py-0.5 rounded {app.status === 'available' ? 'text-accent-green bg-accent-green/10' : 'text-text-secondary bg-bg-primary'}">
								{app.status}
							</span>
						</div>
						<p class="text-xs text-text-secondary">{app.description}</p>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Available Tools -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Available Tools</h2>
		{#if data.toolCatalog.length === 0}
			<p class="text-sm text-text-secondary">No tools cataloged.</p>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-4">
				{#each data.toolCatalog as group}
					<div>
						<p class="text-sm font-medium text-accent-cyan mb-2">{group.category}</p>
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
		{/if}
	</section>
</div>
