<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { notifications } from '$lib/stores/notifications.js';
	import type { Component } from 'svelte';
	import type { PageData } from './$types.js';
	import type { AutoMemoryEntry, RankedContext, RankedEntry } from '$lib/types/memory.js';
	import type { GraphNode, GraphEdge } from '$lib/types/graph.js';

	let { data }: { data: PageData } = $props();

	// Lazy-load BubbleGraph to reduce initial bundle size
	let BubbleGraph = $state<Component<{ nodes: GraphNode[]; edges?: GraphEdge[]; onNodeClick?: (node: GraphNode) => void }> | null>(null);
	$effect(() => {
		import('$lib/components/BubbleGraph.svelte').then(m => { BubbleGraph = m.default; });
	});

	// Derive graph nodes from memory entries
	const graphNodes = $derived.by(() => {
		if (!liveGraph?.nodes) return [];
		const nodes = liveGraph.nodes;
		const ranks = liveGraph.pageRanks;
		return (Object.values(nodes) as GraphNode[]).map((node: GraphNode) => ({
			...node,
			size: ranks?.[node.id] ? Math.max(8, ranks[node.id] * 100) : 10
		}));
	});

	const graphEdges = $derived<GraphEdge[]>(liveGraph?.edges ?? []);

	let searchQuery = $state('');
	let loading = $state(false);
	let error = $state<string | null>(data.loadError ?? null);

	// Live data that can be refreshed client-side
	let liveEntries = $state<AutoMemoryEntry[]>(data.entries ?? []);
	let liveContext = $state<RankedContext | null>(data.context ?? null);
	let liveGraph = $state<{ nodes: Record<string, GraphNode>; edges?: GraphEdge[]; pageRanks?: Record<string, number> } | null>(data.graph ?? null);

	$effect(() => {
		liveEntries = data.entries ?? [];
		liveContext = data.context ?? null;
		liveGraph = data.graph ?? null;
	});

	async function refresh() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/memory`);
			if (!res.ok) throw new Error(`Failed to load memory (${res.status})`);
			const body = await res.json();
			liveEntries = body.entries ?? [];
			liveContext = body.context ?? null;
			liveGraph = body.graph ?? null;
			notifications.push('success', 'Memory refreshed', `Loaded ${liveEntries.length} entries`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error';
			notifications.push('error', 'Refresh failed', error ?? 'Failed to refresh memory');
		} finally {
			loading = false;
		}
	}

	const nsColors: Record<string, string> = {
		patterns: 'border-l-accent-blue',
		decisions: 'border-l-accent-purple',
		context: 'border-l-accent-cyan',
		errors: 'border-l-accent-red',
		dependencies: 'border-l-accent-yellow',
		'user-prefs': 'border-l-accent-green',
		default: 'border-l-text-secondary'
	};

	const nsBadgeColors: Record<string, string> = {
		patterns: 'bg-accent-blue/20 text-accent-blue',
		decisions: 'bg-accent-purple/20 text-accent-purple',
		context: 'bg-accent-cyan/20 text-accent-cyan',
		errors: 'bg-accent-red/20 text-accent-red',
		dependencies: 'bg-accent-yellow/20 text-accent-yellow',
		'user-prefs': 'bg-accent-green/20 text-accent-green',
		default: 'bg-bg-tertiary text-text-secondary'
	};

	// Computed metrics
	const namespaceBreakdown = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const e of liveEntries) {
			const ns = e.namespace ?? 'default';
			counts.set(ns, (counts.get(ns) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count);
	});

	const categoryBreakdown = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const e of (liveContext?.entries ?? [])) {
			const cat = e.category ?? 'unknown';
			counts.set(cat, (counts.get(cat) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count);
	});

	const totalNodes = $derived(liveEntries.length + (liveContext?.entries?.length ?? 0));
	const totalNamespaces = $derived(namespaceBreakdown.length);
	const totalCategories = $derived(categoryBreakdown.length);

	const avgConfidence = $derived.by(() => {
		const entries = liveContext?.entries ?? [];
		if (entries.length === 0) return 0;
		return entries.reduce((sum: number, e: RankedEntry) => sum + e.confidence, 0) / entries.length;
	});

	const hitRate = $derived(avgConfidence > 0 ? (avgConfidence * 100).toFixed(1) + '%' : 'N/A');

	// Namespace chart — bar widths relative to max
	const nsMaxCount = $derived(Math.max(1, ...namespaceBreakdown.map((n) => n.count)));

	// Category chart — bar widths relative to max
	const catMaxCount = $derived(Math.max(1, ...categoryBreakdown.map((c) => c.count)));

	// Filtered entries
	const filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return liveEntries;
		const q = searchQuery.toLowerCase();
		return liveEntries.filter(
			(e) =>
				e.key.toLowerCase().includes(q) ||
				(e.summary ?? '').toLowerCase().includes(q) ||
				(e.content ?? '').toLowerCase().includes(q) ||
				(e.namespace ?? '').toLowerCase().includes(q)
		);
	});

	// Expanded entries
	let expandedKeys = $state<Set<string>>(new Set());
	function toggleExpand(key: string) {
		const next = new Set(expandedKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedKeys = next;
	}

	const catBarColors: Record<string, string> = {
		preference: 'bg-accent-blue',
		architecture: 'bg-accent-purple',
		convention: 'bg-accent-cyan',
		decision: 'bg-accent-green',
		pattern: 'bg-accent-yellow',
		bug: 'bg-accent-red'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-xl font-bold text-text-primary">Project Memory</h1>
				{#if loading}
					<StatusBadge status="pending" label="Loading" />
				{:else if error || data.loadError}
					<StatusBadge status="error" label="Error" />
				{:else if totalNodes > 0}
					<StatusBadge status="online" label="{totalNodes} nodes" />
				{:else}
					<StatusBadge status="offline" label="Empty" />
				{/if}
			</div>
			<p class="text-sm text-text-secondary mt-1">HNSW-indexed memory for {data.projectName ?? data.projectId}</p>
		</div>
		<button
			onclick={refresh}
			disabled={loading}
			class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
		>
			<svg class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
			{loading ? 'Refreshing...' : 'Refresh'}
		</button>
	</div>

	<!-- Error Banner -->
	{#if error}
		<div class="flex items-center gap-3 px-4 py-3 bg-accent-red/10 border border-accent-red/30 rounded-lg text-sm text-accent-red">
			<svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
			<span>{error}</span>
			<button onclick={() => (error = null)} class="ml-auto text-accent-red/60 hover:text-accent-red" aria-label="Dismiss error">&times;</button>
		</div>
	{/if}

	<!-- Loading Overlay -->
	{#if loading}
		<div class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3 text-text-secondary text-sm">
				<svg class="w-6 h-6 animate-spin text-accent-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
				<span>Loading memory data...</span>
			</div>
		</div>
	{/if}

	<!-- Server Error State -->
	{#if data.loadError && !loading && liveEntries.length === 0}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
			<svg class="w-10 h-10 mx-auto text-accent-red/60 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
			<p class="text-text-primary font-medium mb-1">Failed to load memory</p>
			<p class="text-text-secondary text-sm mb-4">{data.loadError}</p>
			<button
				onclick={refresh}
				class="px-4 py-2 text-xs font-medium rounded border border-border bg-bg-tertiary text-text-primary hover:bg-bg-primary transition-colors"
			>
				Try Again
			</button>
		</div>
	{:else if !loading && totalNodes === 0 && !error}
		<!-- Empty State -->
		<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
			<svg class="w-10 h-10 mx-auto text-text-secondary/40 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
			<p class="text-text-primary font-medium mb-1">No memory data yet</p>
			<p class="text-text-secondary text-sm">Memory entries will appear here as the project stores patterns, decisions, and context.</p>
		</div>
	{:else}

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-4">
		<MetricCard label="Total Nodes" value={totalNodes} accent="blue" />
		<MetricCard label="Namespaces" value={totalNamespaces} accent="purple" />
		<MetricCard label="Categories" value={totalCategories} accent="cyan" />
		<MetricCard label="Confidence" value={hitRate} accent="green" />
		<MetricCard label="Auto-Memory" value={liveEntries.length} accent="yellow" />
	</div>

	<!-- Memory Graph (lazy-loaded) -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Memory Graph</h2>
		{#if graphNodes.length > 0 && BubbleGraph}
			<BubbleGraph nodes={graphNodes} edges={graphEdges} />
		{:else if graphNodes.length > 0}
			<div class="flex items-center justify-center py-12 text-text-secondary text-sm">
				<p>Loading graph...</p>
			</div>
		{:else}
			<div class="flex items-center justify-center py-12 text-text-secondary text-sm">
				<p>No graph data. Memory graph populates as the system processes entries.</p>
			</div>
		{/if}
	</div>

	<!-- Charts Row -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		<!-- Namespace Distribution Chart -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Namespace Distribution</h2>
			{#if namespaceBreakdown.length > 0}
				<div class="space-y-2">
					{#each namespaceBreakdown as ns}
						<div class="flex items-center gap-3">
							<span class="text-xs text-text-primary w-24 truncate font-mono">{ns.name}</span>
							<div class="flex-1 h-5 bg-bg-tertiary rounded overflow-hidden">
								<div
									class="h-full bg-accent-purple rounded transition-all duration-300"
									style="width: {(ns.count / nsMaxCount) * 100}%"
								></div>
							</div>
							<span class="text-xs font-mono text-text-secondary w-8 text-right">{ns.count}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-text-secondary text-sm text-center py-4">No namespace data</p>
			{/if}
		</div>

		<!-- Category Distribution Chart -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Category Distribution</h2>
			{#if categoryBreakdown.length > 0}
				<div class="space-y-2">
					{#each categoryBreakdown as cat}
						<div class="flex items-center gap-3">
							<span class="text-xs text-text-primary w-24 truncate font-mono">{cat.name}</span>
							<div class="flex-1 h-5 bg-bg-tertiary rounded overflow-hidden">
								<div
									class={"h-full rounded transition-all duration-300 " + (catBarColors[cat.name] ?? 'bg-accent-cyan')}
									style="width: {(cat.count / catMaxCount) * 100}%"
								></div>
							</div>
							<span class="text-xs font-mono text-text-secondary w-8 text-right">{cat.count}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-text-secondary text-sm text-center py-4">No category data</p>
			{/if}
		</div>
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

	<!-- Namespaces Grid -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Namespaces</h2>
		{#if namespaceBreakdown.length > 0}
			<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
				{#each namespaceBreakdown as ns}
					<div class="bg-bg-secondary border border-border border-l-2 {nsColors[ns.name] ?? nsColors['default']} rounded-lg p-3">
						<div class="flex items-center justify-between mb-1">
							<span class="text-sm font-bold text-text-primary">{ns.name}</span>
							<span class="text-sm font-mono text-accent-blue">{ns.count}</span>
						</div>
						<p class="text-[10px] text-text-secondary">{ns.count} entr{ns.count === 1 ? 'y' : 'ies'}</p>
					</div>
				{/each}
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
				<p class="text-text-secondary text-sm">No namespaces configured</p>
				<p class="text-text-secondary text-xs mt-1">Memory nodes will appear here once stored.</p>
			</div>
		{/if}
	</div>

	<!-- Memory Entries -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">
			Memory Entries
			{#if searchQuery.trim()}
				<span class="text-accent-blue">({filteredEntries.length} of {liveEntries.length})</span>
			{/if}
		</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each filteredEntries as entry}
				<button
					onclick={() => toggleExpand(entry.key)}
					class="w-full flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-bg-tertiary/30 transition-colors text-left"
				>
					<svg class="w-3 h-3 mt-1 text-text-secondary flex-shrink-0 transition-transform {expandedKeys.has(entry.key) ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 mb-0.5">
							<span class="text-sm text-text-primary font-medium truncate">{entry.summary || entry.key}</span>
							<span class="text-[10px] px-1.5 py-0.5 rounded font-mono {nsBadgeColors[entry.namespace] ?? nsBadgeColors['default']}">{entry.namespace ?? 'default'}</span>
							{#if entry.type}
								<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded">{entry.type}</span>
							{/if}
						</div>
						<span class="text-[10px] font-mono text-text-secondary">{entry.key}</span>
						{#if expandedKeys.has(entry.key)}
							<div class="mt-2 bg-bg-primary border border-border rounded p-3 text-xs text-text-primary font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
								{entry.content || 'No content'}
							</div>
						{/if}
					</div>
				</button>
			{:else}
				<div class="px-4 py-8 text-center">
					<p class="text-text-secondary text-sm">
						{searchQuery.trim() ? 'No entries match your search' : 'No memory entries yet'}
					</p>
				</div>
			{/each}
		</div>
	</div>

	<!-- Context Entries -->
	{#if (liveContext?.entries ?? []).length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Top Context Entries</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each (liveContext?.entries ?? []).slice(0, 10) as entry}
					<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
						<span class="text-sm text-text-primary truncate flex-1">{entry.summary || entry.id}</span>
						<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">{entry.category}</span>
						<span class="text-xs font-mono text-accent-green">{(entry.confidence * 100).toFixed(0)}%</span>
						<span class="text-xs font-mono text-accent-purple">{(entry.pageRank * 100).toFixed(1)}% PR</span>
						<span class="text-xs font-mono text-text-secondary">{entry.accessCount} hits</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	{/if}
</div>
