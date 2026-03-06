<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { Component } from 'svelte';
	import type { GraphNode, GraphEdge, RankedGraphNode, GraphState } from '$lib/types/graph.js';
	import type { RankedContext, RankedEntry, AutoMemoryEntry, MemoryContextResponse } from '$lib/types/memory.js';

	interface MemoryPageData {
		graph: GraphState | null;
		context: RankedContext | null;
		autoMemory: AutoMemoryEntry[] | null;
		memoryConfig: Record<string, unknown> | null;
	}

	let { data }: { data: MemoryPageData } = $props();

	// Lazy-load BubbleGraph
	let BubbleGraph = $state<Component<{ nodes: RankedGraphNode[]; edges?: GraphEdge[]; onNodeClick?: (nodeId: string) => void }> | null>(null);
	$effect(() => {
		import('$lib/components/BubbleGraph.svelte').then(m => { BubbleGraph = m.default; });
	});

	// Client-side refresh state
	let loading = $state(false);
	let error = $state<string | null>(null);
	let lastRefreshed = $state<number | null>(null);

	// Live context/autoMemory that can be refreshed client-side
	let liveContext = $state<RankedContext | null>(null);
	let liveAutoMemory = $state<AutoMemoryEntry[] | null>(null);

	// Sync from server data (initial load + navigation)
	$effect(() => {
		liveContext = data.context;
		liveAutoMemory = data.autoMemory;
	});

	async function refreshContext() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/memory/context');
			if (!res.ok) throw new Error(`Failed to fetch memory context (${res.status})`);
			const body: MemoryContextResponse = await res.json();
			liveContext = body.context;
			liveAutoMemory = body.autoMemory;
			lastRefreshed = Date.now();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error refreshing memory context';
		} finally {
			loading = false;
		}
	}

	let graphError = $state<string | null>(null);

	const graphNodes = $derived.by((): RankedGraphNode[] => {
		if (!data.graph?.nodes) return [];
		try {
			const entries = liveContext?.entries ?? [];
			const nodes = data.graph.nodes;
			const ranks = data.graph.pageRanks ?? {};
			return Object.values(nodes).map((node): RankedGraphNode => {
				const contextEntry = entries.find((e: { id: string }) => e.id === node.id);
				const label = contextEntry?.summary ?? node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
				return { ...node, pageRank: ranks[node.id] ?? 0, label };
			});
		} catch (e) {
			graphError = e instanceof Error ? e.message : 'Failed to process graph data';
			return [];
		}
	});

	const graphEdges = $derived.by(() => {
		try {
			return (data.graph?.edges ?? []) as GraphEdge[];
		} catch {
			return [];
		}
	});

	// Selected node detail
	let selectedNodeId = $state<string | null>(null);

	const selectedNode = $derived.by(() => {
		if (!selectedNodeId) return null;
		const entry = (liveContext?.entries ?? []).find((e: RankedEntry) => e.id === selectedNodeId);
		const graphNode = data.graph?.nodes?.[selectedNodeId];
		if (!entry && !graphNode) return null;
		return {
			id: selectedNodeId,
			summary: entry?.summary ?? selectedNodeId,
			content: entry?.content ?? '',
			category: entry?.category ?? graphNode?.category ?? 'unknown',
			confidence: entry?.confidence ?? graphNode?.confidence ?? 0,
			pageRank: entry?.pageRank ?? data.graph?.pageRanks?.[selectedNodeId] ?? 0,
			accessCount: entry?.accessCount ?? graphNode?.accessCount ?? 0,
			connectedTo: (data.graph?.edges ?? [])
				.filter((e: GraphEdge) => e.sourceId === selectedNodeId || e.targetId === selectedNodeId)
				.map((e: GraphEdge) => {
					const otherId = e.sourceId === selectedNodeId ? e.targetId : e.sourceId;
					const otherEntry = (liveContext?.entries ?? []).find((x: RankedEntry) => x.id === otherId);
					return { name: otherEntry?.summary ?? otherId.replace(/^mem-MEMORY-/, ''), type: e.type, weight: e.weight };
				})
		};
	});

	function handleNodeClick(nodeId: string) {
		selectedNodeId = selectedNodeId === nodeId ? null : nodeId;
	}

	const topContexts = $derived.by(() => {
		const entries = liveContext?.entries ?? [];
		return [...entries]
			.sort((a: RankedEntry, b: RankedEntry) => b.pageRank - a.pageRank)
			.slice(0, 10)
			.map((e: RankedEntry) => ({
				id: e.id,
				key: e.summary || e.id,
				score: e.confidence.toFixed(2),
				pageRank: (e.pageRank * 100).toFixed(1),
				hits: e.accessCount,
				category: e.category
			}));
	});

	const autoMemoryEntries = $derived.by(() => {
		return (liveAutoMemory ?? []).map((entry: AutoMemoryEntry) => {
			const source = (entry.metadata?.sourceFile as string) ?? '';
			const projectMatch = source.match(/projects[/\\]([^/\\]+)[/\\]/);
			const project = projectMatch ? projectMatch[1].replace(/^[Cc]--/, '').replace(/-/g, '/').split('/').pop() : '';
			return {
				key: entry.key,
				summary: entry.summary || entry.key,
				namespace: entry.namespace ?? 'default',
				content: entry.content || '',
				type: entry.type ?? 'unknown',
				project,
				bootstrapped: !!(entry.metadata?.bootstrapped),
				createdAt: formatRelativeTime(entry.createdAt)
			};
		});
	});

	// Expanded auto-memory entries
	let expandedKeys = $state<Set<string>>(new Set());

	function toggleExpand(key: string) {
		const next = new Set(expandedKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedKeys = next;
	}

	const contextCategories = $derived.by(() => {
		const entries = liveContext?.entries ?? [];
		const counts = new Map<string, number>();
		for (const e of entries) {
			const cat = e.category ?? 'unknown';
			counts.set(cat, (counts.get(cat) ?? 0) + 1);
		}
		return Array.from(counts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count);
	});

	const metricBackend = $derived(
		(data.memoryConfig?.backend as string) ?? (data.memoryConfig?.type as string) ?? 'N/A'
	);

	const metricTotalNodes = $derived(
		(liveContext?.entries?.length ?? 0).toLocaleString()
	);

	const metricNamespaces = $derived.by(() => {
		const entries = liveAutoMemory ?? [];
		const namespaces = new Set(entries.map((e: AutoMemoryEntry) => e.namespace));
		return namespaces.size;
	});

	const metricHnsw = $derived.by(() => {
		if (!data.memoryConfig) return 'N/A';
		const hnsw = data.memoryConfig.enableHNSW ?? data.memoryConfig.hnsw;
		if (hnsw === true) return 'Enabled';
		if (hnsw && typeof hnsw === 'object') return 'Enabled';
		return 'Disabled';
	});

	const metricHitRate = $derived.by(() => {
		const entries = liveContext?.entries ?? [];
		if (entries.length === 0) return 'N/A';
		const avgConfidence = entries.reduce((sum: number, e: RankedEntry) => sum + e.confidence, 0) / entries.length;
		return (avgConfidence * 100).toFixed(1) + '%';
	});

	const metricEdges = $derived(data.graph?.edges?.length ?? 0);

	function formatRelativeTime(timestamp?: number): string {
		if (!timestamp) return 'N/A';
		const now = Date.now();
		const diffMs = now - timestamp;
		const diffSec = Math.floor(diffMs / 1000);
		const diffMin = Math.floor(diffSec / 60);
		const diffHr = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHr / 24);

		if (diffSec < 60) return 'just now';
		if (diffMin < 60) return `${diffMin} min ago`;
		if (diffHr < 24) return `${diffHr} hr${diffHr > 1 ? 's' : ''} ago`;
		if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
		return new Date(timestamp).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="type-page-title text-text-primary">Memory & Knowledge</h1>
		<button
			onclick={refreshContext}
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

	<!-- Last refreshed -->
	{#if lastRefreshed}
		<p class="text-[10px] text-text-secondary">Last refreshed: {formatRelativeTime(lastRefreshed)}</p>
	{/if}

	<!-- Memory Context Summary -->
	{#if liveContext}
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-3">Context Summary</h2>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
				<div>
					<p class="text-text-secondary text-xs mb-1">Total Entries</p>
					<p class="text-text-primary font-mono text-lg">{liveContext.entries?.length ?? 0}</p>
				</div>
				<div>
					<p class="text-text-secondary text-xs mb-1">Categories</p>
					<div class="flex flex-wrap gap-1 mt-1">
						{#each contextCategories as cat}
							<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">{cat.name} ({cat.count})</span>
						{/each}
						{#if contextCategories.length === 0}
							<span class="text-[10px] text-text-secondary">none</span>
						{/if}
					</div>
				</div>
				<div>
					<p class="text-text-secondary text-xs mb-1">Confidence Range</p>
					<p class="text-text-primary font-mono">
						{#if (liveContext.entries?.length ?? 0) > 0}
							{(Math.min(...liveContext.entries.map((e: RankedEntry) => e.confidence)) * 100).toFixed(0)}% – {(Math.max(...liveContext.entries.map((e: RankedEntry) => e.confidence)) * 100).toFixed(0)}%
						{:else}
							N/A
						{/if}
					</p>
				</div>
			</div>
		</div>
	{:else if loading}
		<div class="bg-bg-secondary border border-border rounded-lg p-4 animate-pulse">
			<div class="h-4 w-36 bg-bg-tertiary rounded mb-3"></div>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div class="space-y-2">
					<div class="h-3 w-20 bg-bg-tertiary rounded"></div>
					<div class="h-6 w-12 bg-bg-tertiary rounded"></div>
				</div>
				<div class="space-y-2">
					<div class="h-3 w-20 bg-bg-tertiary rounded"></div>
					<div class="h-5 w-32 bg-bg-tertiary rounded"></div>
				</div>
				<div class="space-y-2">
					<div class="h-3 w-24 bg-bg-tertiary rounded"></div>
					<div class="h-5 w-16 bg-bg-tertiary rounded"></div>
				</div>
			</div>
		</div>
	{:else}
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="text-text-secondary text-sm text-center py-2">No memory context available. Context populates as the system processes entries.</p>
		</div>
	{/if}

	<!-- Loading overlay for metric section -->
	{#if loading}
		<div class="flex items-center justify-center py-4">
			<div class="flex items-center gap-2 text-text-secondary text-sm">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
				Loading memory context...
			</div>
		</div>
	{/if}

	<!-- Metric Cards -->
	<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
		<MetricCard label="Backend" value={metricBackend} subtitle="memory store" accent="blue" />
		<MetricCard label="Nodes" value={metricTotalNodes} subtitle="{metricNamespaces} namespace{metricNamespaces === 1 ? '' : 's'}" accent="cyan" />
		<MetricCard label="Edges" value={metricEdges} subtitle="connections" accent="purple" />
		<MetricCard label="HNSW" value={metricHnsw} subtitle="vector index" accent="green" />
		<MetricCard label="Confidence" value={metricHitRate} subtitle="avg across entries" accent="yellow" />
		<MetricCard label="Entries" value={(liveAutoMemory ?? []).length} subtitle="auto-memory" accent="blue" />
	</div>

	<!-- Memory Graph + Detail Panel -->
	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<!-- Memory Graph -->
		<div class="lg:col-span-2 bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-4">Memory Graph</h2>
			{#if graphError}
				<div class="h-48 flex flex-col items-center justify-center gap-2">
					<svg class="w-5 h-5 text-accent-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
					<p class="text-text-secondary text-sm">Failed to load graph data</p>
					<p class="text-text-secondary text-xs">{graphError}</p>
				</div>
			{:else if graphNodes.length > 0 && BubbleGraph}
				<BubbleGraph nodes={graphNodes} edges={graphEdges} onNodeClick={handleNodeClick} />
			{:else if graphNodes.length > 0 || loading}
				<div class="h-48 flex flex-col items-center justify-center gap-3">
					<svg class="w-6 h-6 animate-spin text-accent-cyan" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
					<p class="text-text-secondary text-sm">Loading memory graph...</p>
				</div>
			{:else}
				<div class="h-48 flex items-center justify-center">
					<p class="text-text-secondary">No graph data. Memory graph populates as the system processes entries.</p>
				</div>
			{/if}
		</div>

		<!-- Node Detail / Top Contexts -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			{#if selectedNode}
				<div class="flex items-center justify-between mb-3">
					<p class="type-label text-text-secondary">Node Detail</p>
					<button onclick={() => (selectedNodeId = null)} class="text-xs text-text-secondary hover:text-text-primary">&times; close</button>
				</div>
				<h3 class="text-sm font-bold text-text-primary mb-2">{selectedNode.summary}</h3>
				<div class="space-y-2 text-xs mb-4">
					<div class="flex justify-between">
						<span class="text-text-secondary">Category</span>
						<span class="font-mono text-accent-blue">{selectedNode.category}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">PageRank</span>
						<span class="font-mono text-accent-green">{(selectedNode.pageRank * 100).toFixed(1)}%</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Confidence</span>
						<span class="font-mono text-accent-yellow">{(selectedNode.confidence * 100).toFixed(0)}%</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Access Count</span>
						<span class="font-mono text-text-primary">{selectedNode.accessCount}</span>
					</div>
				</div>
				{#if selectedNode.content}
					<div class="mb-4">
						<p class="text-[10px] text-text-secondary uppercase tracking-wider mb-1">Content</p>
						<div class="bg-bg-primary border border-border rounded p-2 text-xs text-text-primary font-mono max-h-40 overflow-y-auto whitespace-pre-wrap">
							{selectedNode.content}
						</div>
					</div>
				{/if}
				{#if selectedNode.connectedTo.length > 0}
					<p class="text-[10px] text-text-secondary uppercase tracking-wider mb-1">Connections ({selectedNode.connectedTo.length})</p>
					<div class="space-y-1">
						{#each selectedNode.connectedTo as conn}
							<div class="flex items-center gap-2 text-xs">
								<span class="w-1.5 h-1.5 rounded-full {conn.type === 'similar' ? 'bg-accent-purple' : 'bg-text-secondary'}"></span>
								<span class="text-text-primary truncate">{conn.name}</span>
								<span class="text-text-secondary ml-auto text-[10px]">{conn.type}</span>
							</div>
						{/each}
					</div>
				{/if}
			{:else}
				<p class="type-label text-text-secondary mb-3">Top Contexts by Relevance</p>
				<div class="space-y-0">
					{#each topContexts as ctx}
						<button
							onclick={() => handleNodeClick(ctx.id)}
							class="w-full flex items-center justify-between py-2 border-b border-border last:border-0 hover:bg-bg-tertiary/30 transition-colors text-left px-1 rounded"
						>
							<span class="text-xs text-text-primary truncate mr-2">{ctx.key}</span>
							<div class="flex items-center gap-3 shrink-0">
								<span class="text-[10px] font-mono text-accent-green">{ctx.pageRank}%</span>
								<span class="text-[10px] font-mono text-text-secondary">{ctx.hits} hits</span>
							</div>
						</button>
					{:else}
						<p class="text-xs text-text-secondary py-4 text-center">No context entries loaded</p>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Auto-Memory Entries -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Auto-Memory Entries</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each autoMemoryEntries as entry}
				<button
					onclick={() => toggleExpand(entry.key)}
					class="w-full flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-bg-tertiary/30 transition-colors text-left"
				>
					<svg class="w-3 h-3 mt-1 text-text-secondary flex-shrink-0 transition-transform {expandedKeys.has(entry.key) ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2 mb-0.5">
							<span class="text-sm text-text-primary font-medium">{entry.summary}</span>
							<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">{entry.namespace}</span>
							<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded">{entry.type}</span>
							{#if entry.bootstrapped}
								<span class="text-[10px] px-1.5 py-0.5 bg-accent-blue/20 text-accent-blue rounded">bootstrapped</span>
							{/if}
						</div>
						<div class="flex items-center gap-3 text-[10px] text-text-secondary">
							<span class="font-mono">{entry.key}</span>
							{#if entry.project}
								<span>from: {entry.project}</span>
							{/if}
							<span class="ml-auto">{entry.createdAt}</span>
						</div>
						{#if expandedKeys.has(entry.key)}
							<div class="mt-2 bg-bg-primary border border-border rounded p-3 text-xs text-text-primary font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
								{entry.content}
							</div>
						{/if}
					</div>
				</button>
			{:else}
				<div class="px-4 py-8 text-center">
					<p class="text-text-secondary">No auto-memory entries loaded</p>
				</div>
			{/each}
		</div>
	</section>
</div>
