<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
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

	let loaded = $derived(data != null);
	let selectedCategory = $state('all');

	// Live-poll active agents every 5s
	let liveActiveAgents = $state(data.activeAgents ?? []);

	$effect(() => {
		const interval = setInterval(async () => {
			try {
				const res = await fetch('/api/agents');
				if (res.ok) {
					const json = await res.json();
					if (json.activeAgents) liveActiveAgents = json.activeAgents;
				}
			} catch { /* silent */ }
		}, 5000);
		return () => clearInterval(interval);
	});

	const categories = $derived.by(() => {
		const cats = new Set(data.agents.map((a: AgentDefinition) => a.category));
		return ['all', ...Array.from(cats).sort()];
	});

	const filteredAgents = $derived(
		selectedCategory === 'all'
			? data.agents
			: data.agents.filter((a: AgentDefinition) => a.category === selectedCategory)
	);

	const totalAgents = $derived(data.total ?? data.agents?.length ?? 0);
	const activeAgents = $derived(liveActiveAgents.length);
	const idleAgents = $derived(Math.max(0, totalAgents - activeAgents));
	const errorAgents = $derived(data.analytics?.failureCount ?? 0);
	const maxAgents = $derived(data.v3Progress.maxAgents ?? 6);

	const capacityPercent = $derived(
		maxAgents > 0 ? Math.round((activeAgents / maxAgents) * 100) : 0
	);

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

	{#if loaded}
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

		<!-- Currently Active Agents -->
		{#if liveActiveAgents && liveActiveAgents.length > 0}
			<div>
				<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-2">Running Now</h2>
				<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{#each liveActiveAgents as agent}
						<div class="bg-bg-secondary border border-accent-green/30 rounded-lg p-3 flex items-center gap-3">
							<div class="w-2 h-2 rounded-full bg-accent-green animate-pulse"></div>
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium text-text-primary truncate">{agent.label}</p>
								<p class="text-xs text-text-secondary font-mono truncate">Task: {agent.taskId}</p>
							</div>
							<span class="text-xs text-text-secondary font-mono">PID {agent.pid}</span>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-4 text-center">
				<p class="text-sm text-text-secondary">No agents currently running</p>
				<p class="text-xs text-text-secondary mt-1">Agents spawn on-demand when tasks need execution</p>
			</div>
		{/if}

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
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
	{:else}
		<!-- Loading skeletons -->
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			{#each Array(4) as _}
				<Skeleton variant="metric" />
			{/each}
		</div>
		<Skeleton variant="card" lines={1} />
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
			{#each Array(8) as _}
				<Skeleton variant="card" lines={2} />
			{/each}
		</div>
	{/if}
</div>
