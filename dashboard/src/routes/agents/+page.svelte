<script lang="ts">
	import AgentCard from '$lib/components/AgentCard.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { AgentDefinition } from '$lib/types/agents.js';

	interface AgentsPageData {
		agents: AgentDefinition[];
		swarmStatus: {
			active: boolean;
			agentCount: number;
			coordinationActive: boolean;
			processes: { agentic_flow: number; mcp_server: number; estimated_agents: number } | null;
		};
		v3Progress: {
			activeAgents: number;
			maxAgents: number;
			topology: string;
		};
		swarmConfig: Record<string, unknown> | null;
	}

	let { data }: { data: AgentsPageData } = $props();

	let selectedCategory = $state('all');

	const categories = $derived.by(() => {
		const cats = new Set(data.agents.map((a: AgentDefinition) => a.category));
		return ['all', ...Array.from(cats).sort()];
	});

	const filteredAgents = $derived(
		selectedCategory === 'all'
			? data.agents
			: data.agents.filter((a: AgentDefinition) => a.category === selectedCategory)
	);

	const capacityPercent = $derived(
		data.v3Progress.maxAgents > 0
			? Math.round((data.v3Progress.activeAgents / data.v3Progress.maxAgents) * 100)
			: 0
	);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Agents</h1>
			<p class="text-sm text-text-secondary mt-1">
				{data.agents.length} agent definitions across {categories.length - 1} categories
			</p>
		</div>
		<StatusBadge
			status={data.swarmStatus.active ? 'online' : 'offline'}
			label={data.swarmStatus.active ? 'Swarm Active' : 'Swarm Inactive'}
			size="md"
		/>
	</div>

	<!-- Swarm Status Panel -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard
			label="Active Agents"
			value={data.v3Progress.activeAgents}
			subtitle="Running in swarm"
			accent="green"
		/>
		<MetricCard
			label="Max Agents"
			value={data.v3Progress.maxAgents}
			subtitle="Configuration limit"
			accent="blue"
		/>
		<MetricCard
			label="Topology"
			value={data.v3Progress.topology}
			subtitle="Coordination mode"
			accent="purple"
		/>
		<MetricCard
			label="Catalog Size"
			value={data.agents.length}
			subtitle="Available definitions"
			accent="cyan"
		/>
	</div>

	<!-- Swarm Capacity Bar -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-2">
			<span class="text-sm text-text-secondary">Swarm Capacity</span>
			<span class="text-sm font-mono text-text-primary">
				{data.v3Progress.activeAgents} / {data.v3Progress.maxAgents} agents
			</span>
		</div>
		<div class="w-full h-2 bg-bg-tertiary rounded-full overflow-hidden">
			<div
				class="h-full rounded-full transition-all duration-500 {capacityPercent > 80
					? 'bg-accent-red'
					: capacityPercent > 50
						? 'bg-accent-yellow'
						: 'bg-accent-green'}"
				style="width: {capacityPercent}%"
			></div>
		</div>
		<div class="flex items-center justify-between mt-2">
			<span class="text-xs text-text-secondary">{capacityPercent}% utilized</span>
			<span class="text-xs text-text-secondary">{data.v3Progress.topology}</span>
		</div>
	</div>

	<!-- Category Filters -->
	<div class="flex flex-wrap gap-2">
		{#each categories as cat (cat)}
			<button
				class="px-3 py-1.5 text-xs rounded-md border transition-colors
					{selectedCategory === cat
					? 'bg-accent-blue text-white border-accent-blue'
					: 'bg-bg-secondary text-text-secondary border-border hover:border-border/80 hover:text-text-primary'}"
				onclick={() => (selectedCategory = cat)}
			>
				{cat === 'all' ? 'All' : cat}
				{#if cat === 'all'}
					<span class="ml-1 opacity-70">({data.agents.length})</span>
				{:else}
					<span class="ml-1 opacity-70">({data.agents.filter((a: AgentDefinition) => a.category === cat).length})</span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Agent Grid -->
	{#if filteredAgents.length > 0}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
			{#each filteredAgents as agent (agent.filename)}
				<AgentCard name={agent.name} category={agent.category} description={agent.description} />
			{/each}
		</div>
	{:else}
		<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
			<p class="text-text-secondary">No agents found in this category.</p>
		</div>
	{/if}
</div>
