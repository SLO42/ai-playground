<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let expandedCategories: Record<string, boolean> = $state({});

	function toggleCategory(category: string) {
		expandedCategories[category] = !expandedCategories[category];
	}
</script>

<div class="space-y-6">
	<div class="flex items-center gap-4">
		<a href="/apps" class="text-sm text-accent-cyan hover:underline">&larr; Back to Apps</a>
	</div>

	<!-- App Header -->
	<div class="bg-bg-secondary border border-border rounded-lg p-6">
		<div class="flex items-center gap-3 mb-2">
			<h1 class="type-page-title text-text-primary">{data.app.name}</h1>
			<span class="text-xs font-mono px-2 py-0.5 rounded {data.app.status === 'available' ? 'text-accent-green bg-accent-green/10' : 'text-text-secondary bg-bg-primary'}">
				{data.app.status}
			</span>
		</div>
		<p class="text-sm text-text-secondary">{data.app.description}</p>
	</div>

	<!-- Metrics -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard
			label="Tool Categories"
			value={data.toolGroups.length}
			subtitle={data.toolGroups.length === 1 ? '1 group' : `${data.toolGroups.length} groups`}
			accent="blue"
		/>
		<MetricCard
			label="Total Tools"
			value={data.totalTools}
			subtitle="available"
			accent="cyan"
		/>
		<MetricCard
			label="Server"
			value={data.serverName ? 1 : 0}
			subtitle={data.serverName ?? 'not configured'}
			accent="green"
		/>
		<MetricCard
			label="Service"
			value={data.service ? 1 : 0}
			subtitle={data.service?.type ?? 'no service'}
			accent="purple"
		/>
	</div>

	<!-- MCP Server Configuration -->
	{#if data.serverConfig}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">MCP Server Configuration</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
					<div>
						<p class="text-xs text-text-secondary mb-1">Server Name</p>
						<p class="text-sm font-mono text-text-primary">{data.serverName}</p>
					</div>
					<div>
						<p class="text-xs text-text-secondary mb-1">Command</p>
						<p class="text-sm font-mono text-text-primary">{data.serverConfig.command}</p>
					</div>
				</div>
				{#if data.serverConfig.args?.length}
					<div>
						<p class="text-xs text-text-secondary mb-1">Arguments</p>
						<div class="flex flex-wrap gap-1.5">
							{#each data.serverConfig.args as arg}
								<span class="text-xs font-mono bg-bg-primary text-text-secondary px-2 py-1 rounded border border-border">{arg}</span>
							{/each}
						</div>
					</div>
				{/if}
				{#if data.serverConfig.env && Object.keys(data.serverConfig.env).length > 0}
					<div>
						<p class="text-xs text-text-secondary mb-1">Environment Variables</p>
						<div class="flex flex-wrap gap-1.5">
							{#each Object.keys(data.serverConfig.env) as key}
								<span class="text-xs font-mono bg-bg-primary text-text-secondary px-2 py-1 rounded border border-border">{key}</span>
							{/each}
						</div>
					</div>
				{/if}
				{#if data.serverConfig.autoStart !== undefined}
					<div>
						<p class="text-xs text-text-secondary mb-1">Auto-Start</p>
						<p class="text-sm text-text-primary">{data.serverConfig.autoStart ? 'Enabled' : 'Disabled'}</p>
					</div>
				{/if}
			</div>
		</section>
	{:else}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">MCP Server Configuration</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-sm text-text-secondary">No MCP server configured for this app. Add it to <code class="text-xs font-mono text-accent-cyan">.mcp.json</code> to enable tools.</p>
			</div>
		</section>
	{/if}

	<!-- Service Info -->
	{#if data.service}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Service Details</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
					<div>
						<p class="text-xs text-text-secondary mb-1">Name</p>
						<p class="text-sm text-text-primary">{data.service.name}</p>
					</div>
					<div>
						<p class="text-xs text-text-secondary mb-1">Type</p>
						<p class="text-sm text-text-primary">{data.service.type}</p>
					</div>
					{#if data.service.port}
						<div>
							<p class="text-xs text-text-secondary mb-1">Port</p>
							<p class="text-sm font-mono text-text-primary">{data.service.port}</p>
						</div>
					{/if}
					<div>
						<p class="text-xs text-text-secondary mb-1">Config</p>
						<p class="text-sm font-mono text-text-primary">{data.service.configPath}</p>
					</div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Tool Catalog -->
	{#if data.toolGroups.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Available Tools ({data.totalTools})</h2>
			<div class="space-y-2">
				{#each data.toolGroups as group}
					<div class="bg-bg-secondary border border-border rounded-lg">
						<button
							type="button"
							class="w-full flex items-center justify-between p-4 text-left hover:bg-bg-primary/50 transition-colors rounded-lg"
							onclick={() => toggleCategory(group.category)}
						>
							<div class="flex items-center gap-3">
								<span class="text-sm font-medium text-accent-cyan">{group.category}</span>
								<span class="text-xs text-text-secondary">{group.tools.length} tools</span>
							</div>
							<span class="text-text-secondary text-xs">{expandedCategories[group.category] ? '▾' : '▸'}</span>
						</button>
						{#if expandedCategories[group.category]}
							<div class="px-4 pb-4">
								<div class="flex flex-wrap gap-2">
									{#each group.tools as tool}
										<span class="text-xs font-mono bg-bg-primary text-text-secondary px-3 py-1.5 rounded border border-border">
											{tool}
										</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{:else}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Available Tools</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-sm text-text-secondary">No tools registered for this app.</p>
			</div>
		</section>
	{/if}
</div>
