<script lang="ts">
	import BubbleGraph from '$lib/components/BubbleGraph.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { GraphNode } from '$lib/types/graph.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let searchQuery = $state('');

	const graphNodes = $derived.by(() => {
		if (!data.graph?.nodes) return [];
		const nodes = data.graph.nodes;
		const ranks = data.graph.pageRanks ?? {};
		return (Object.values(nodes) as GraphNode[]).map((node: GraphNode) => {
			const label = node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
			return { ...node, pageRank: ranks[node.id] ?? 0, label };
		});
	});

	const filteredMemory = $derived.by(() => {
		if (!searchQuery.trim()) return data.autoMemory;
		const q = searchQuery.toLowerCase();
		return data.autoMemory.filter(
			(entry) =>
				entry.key.toLowerCase().includes(q) ||
				entry.value.toLowerCase().includes(q) ||
				(entry.namespace ?? '').toLowerCase().includes(q)
		);
	});

	const nsColors: Record<string, string> = {
		patterns: 'border-l-accent-blue',
		decisions: 'border-l-accent-purple',
		context: 'border-l-accent-cyan',
		errors: 'border-l-accent-red',
		dependencies: 'border-l-accent-yellow',
		'user-prefs': 'border-l-accent-green',
		security: 'border-l-accent-red',
		sessions: 'border-l-accent-green',
		agents: 'border-l-accent-blue',
		routing: 'border-l-accent-cyan',
		hooks: 'border-l-accent-yellow',
		default: 'border-l-accent-blue'
	};

	const nsBadgeColors: Record<string, string> = {
		patterns: 'bg-accent-blue/20 text-accent-blue',
		decisions: 'bg-accent-purple/20 text-accent-purple',
		context: 'bg-accent-cyan/20 text-accent-cyan',
		errors: 'bg-accent-red/20 text-accent-red',
		dependencies: 'bg-accent-yellow/20 text-accent-yellow',
		'user-prefs': 'bg-accent-green/20 text-accent-green',
		security: 'bg-accent-red/20 text-accent-red',
		sessions: 'bg-accent-green/20 text-accent-green',
		agents: 'bg-accent-blue/20 text-accent-blue',
		routing: 'bg-accent-cyan/20 text-accent-cyan',
		hooks: 'bg-accent-yellow/20 text-accent-yellow',
		default: 'bg-bg-tertiary text-text-secondary'
	};

	function getNsBorderClass(ns: string): string {
		return nsColors[ns] ?? nsColors['default'];
	}

	function getNsBadgeClass(ns: string): string {
		return nsBadgeColors[ns] ?? nsBadgeColors['default'];
	}

	const maxNsCount = $derived(Math.max(...data.namespaces.map((n) => n.count), 1));

	function formatDate(ts: number | undefined): string {
		if (!ts) return 'Unknown';
		try {
			return new Date(ts).toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return 'Unknown';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Project Memory</h1>
		<p class="text-sm text-text-secondary mt-1">
			Knowledge graph and auto-memory entries for {data.projectName}
		</p>
	</div>

	<!-- Search -->
	<div class="flex gap-2">
		<input
			type="text"
			placeholder="Search memory entries..."
			bind:value={searchQuery}
			class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
		/>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Graph Nodes" value={data.stats.totalNodes} accent="blue" />
		<MetricCard label="Memory Entries" value={data.stats.totalAutoMemory} accent="cyan" />
		<MetricCard label="Namespaces" value={data.stats.totalNamespaces} accent="purple" />
		<MetricCard label="Graph Edges" value={data.stats.totalEdges} accent="green" />
	</div>

	<!-- Graph + Namespaces -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Memory Graph -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Memory Graph</h2>
			{#if graphNodes.length > 0}
				<BubbleGraph nodes={graphNodes} />
			{:else}
				<div class="h-48 flex items-center justify-center">
					<p class="text-xs text-text-secondary italic">No graph data available for this project</p>
				</div>
			{/if}
		</div>

		<!-- Namespace Distribution -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Namespace Distribution</h2>
			{#if data.namespaces.length > 0}
				<div class="space-y-2">
					{#each data.namespaces as ns}
						<div class="flex items-center justify-between text-xs border-l-2 {getNsBorderClass(ns.name)} pl-3 py-1">
							<span class="text-text-primary font-medium">{ns.name}</span>
							<div class="flex items-center gap-2">
								<span class="font-mono text-text-secondary">{ns.count}</span>
								<div class="w-20 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
									<div
										class="h-full bg-accent-blue rounded-full"
										style="width: {Math.round((ns.count / maxNsCount) * 100)}%"
									></div>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="h-48 flex items-center justify-center">
					<p class="text-xs text-text-secondary italic">No memory entries found</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- Memory Entries -->
	{#if filteredMemory.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">
				Memory Entries ({filteredMemory.length})
			</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each filteredMemory as entry}
					<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
						<span class="text-sm font-mono text-accent-cyan shrink-0 max-w-48 truncate" title={entry.key}>{entry.key}</span>
						<span class="text-[10px] px-2 py-0.5 rounded font-mono shrink-0 {getNsBadgeClass(entry.namespace ?? 'default')}">
							{entry.namespace ?? 'default'}
						</span>
						<span class="text-xs text-text-secondary flex-1 truncate" title={entry.value}>{entry.value}</span>
						{#if entry.createdAt}
							<span class="text-[10px] text-text-secondary shrink-0">{formatDate(entry.createdAt)}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{:else if searchQuery.trim()}
		<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
			<p class="text-sm text-text-secondary">No memory entries match "{searchQuery}"</p>
		</div>
	{:else}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125v-3.75m16.5 3.75v3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125v-3.75" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No memory data</h2>
			<p class="text-text-secondary text-xs">
				Memory entries will appear here as agents interact with this project
			</p>
		</div>
	{/if}
</div>
