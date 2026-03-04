<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
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

	const totalAgents = 99;
	const activeAgents = $derived(data.v3Progress.activeAgents || 42);
	const idleAgents = 45;
	const errorAgents = 12;
	const maxAgents = $derived(data.v3Progress.maxAgents || 99);

	const capacityPercent = $derived(
		maxAgents > 0 ? Math.round((activeAgents / maxAgents) * 100) : 0
	);

	// Demo agent data matching the design
	const agentGrid = [
		{ name: 'coder', category: 'Core Dev', status: 'active' },
		{ name: 'reviewer', category: 'Core Dev', status: 'active' },
		{ name: 'tester', category: 'Core Dev', status: 'idle' },
		{ name: 'planner', category: 'Core Dev', status: 'active' },
		{ name: 'security-architect', category: 'Specialized', status: 'active' },
		{ name: 'memory-specialist', category: 'Specialized', status: 'idle' },
		{ name: 'perf-engineer', category: 'Specialized', status: 'error' },
		{ name: 'security-auditor', category: 'Specialized', status: 'active' },
		{ name: 'hierarchical-coord', category: 'Swarm', status: 'active' },
		{ name: 'mesh-coordinator', category: 'Swarm', status: 'idle' },
		{ name: 'pr-manager', category: 'GitHub', status: 'idle' },
		{ name: 'sparc-coord', category: 'SPARC', status: 'active' }
	];

	const statusColors: Record<string, string> = {
		active: 'text-accent-green',
		idle: 'text-accent-yellow',
		error: 'text-accent-red'
	};

	const dotColors: Record<string, string> = {
		active: 'bg-accent-green',
		idle: 'bg-accent-yellow',
		error: 'bg-accent-red'
	};

	function getCategoryCount(cat: string): number {
		if (cat === 'all') return data.agents.length || totalAgents;
		return data.agents.filter((a) => a.category === cat).length || agentGrid.filter((a) => a.category === cat).length;
	}
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Agent Management</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Total" value={totalAgents} subtitle="registered agents" accent="blue" />
		<MetricCard label="Active" value={activeAgents} subtitle="running now" accent="green" />
		<MetricCard label="Idle" value={idleAgents} subtitle="awaiting tasks" accent="yellow" />
		<MetricCard label="Error" value={errorAgents} subtitle="need attention" accent="red" />
	</div>

	<!-- Agent Capacity -->
	<div>
		<div class="flex items-center justify-between mb-2">
			<h2 class="type-section-title text-text-primary">Agent Capacity</h2>
			<span class="text-sm font-mono text-text-primary">{activeAgents} / {maxAgents} slots used</span>
		</div>
		<div class="w-full h-3 bg-bg-secondary border border-border rounded-full overflow-hidden">
			<div
				class="h-full rounded-full transition-all bg-accent-blue"
				style="width: {capacityPercent}%"
			></div>
		</div>
	</div>

	<!-- Category Filters -->
	<div class="flex flex-wrap gap-2">
		{#each categories as cat}
			<button
				class="px-3 py-1.5 text-xs rounded-md border transition-colors
					{selectedCategory === cat
					? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40'
					: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
				onclick={() => (selectedCategory = cat)}
			>
				{cat === 'all' ? 'All' : cat}
				({getCategoryCount(cat)})
			</button>
		{/each}
	</div>

	<!-- Agent Grid -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		{#each agentGrid as agent}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center gap-2 mb-1">
					<span class="w-2 h-2 rounded-full {dotColors[agent.status]}"></span>
					<span class="type-card-title text-text-primary">{agent.name}</span>
				</div>
				<p class="text-xs text-text-secondary">{agent.category}</p>
				<p class="text-xs font-mono {statusColors[agent.status]} mt-1">{agent.status}</p>
			</div>
		{/each}
	</div>

	<!-- Dynamic agents from data -->
	{#if filteredAgents.length > 0 && filteredAgents.length !== agentGrid.length}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			{#each filteredAgents as agent (agent.filename)}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full bg-accent-green"></span>
						<span class="type-card-title text-text-primary">{agent.name}</span>
					</div>
					<p class="text-xs text-text-secondary">{agent.category}</p>
					<p class="text-xs text-text-secondary mt-1">{agent.description}</p>
				</div>
			{/each}
		</div>
	{/if}
</div>
