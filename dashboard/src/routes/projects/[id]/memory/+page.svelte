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

	// Derive graph nodes from memory entries — must produce RankedGraphNode for BubbleGraph
	const graphNodes = $derived.by(() => {
		if (!liveGraph?.nodes) return [];
		const nodes = liveGraph.nodes;
		const ranks = liveGraph.pageRanks ?? {};
		const contextEntries = liveContext?.entries ?? [];
		return (Object.values(nodes) as GraphNode[]).map((node: GraphNode) => {
			const contextEntry = contextEntries.find((e: { id: string }) => e.id === node.id);
			const label = contextEntry?.summary ?? node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
			const pageRank = ranks[node.id] ?? 0;
			return {
				...node,
				label,
				pageRank,
				size: pageRank > 0 ? Math.max(8, pageRank * 100) : 10
			};
		});
	});

	const graphEdges = $derived<GraphEdge[]>(liveGraph?.edges ?? []);

	let searchQuery = $state('');
	let loading = $state(false);
	let graphRefreshing = $state(false);
	let error = $state<string | null>(data.loadError ?? null);
	let graphFetchError = $state<string | null>(null);

	// Track whether initial data has been received (for client-side navigation)
	let initialReady = $state(!!(data.entries?.length || data.graph || data.context));

	// Tab state
	let activeTab = $state<'overview' | 'entries'>('overview');

	// Entries tab: sort
	let sortField = $state<'summary' | 'namespace' | 'type' | 'createdAt'>('createdAt');
	let sortDir = $state<'asc' | 'desc'>('desc');

	function setSort(field: typeof sortField) {
		if (sortField === field) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDir = field === 'createdAt' ? 'desc' : 'asc';
		}
	}

	// Entries tab: filters
	let filterNamespace = $state<string>('all');
	let filterType = $state<string>('all');

	const availableNamespaces = $derived.by(() => {
		const ns = new Set(liveEntries.map((e: AutoMemoryEntry) => e.namespace ?? 'default'));
		return Array.from(ns).sort();
	});

	const availableTypes = $derived.by(() => {
		const types = new Set(liveEntries.map((e: AutoMemoryEntry) => e.type ?? 'unknown'));
		return Array.from(types).sort();
	});

	// Entries tab: pagination
	let currentPage = $state(1);
	const PAGE_SIZE = 25;

	// Live data that can be refreshed client-side
	let liveEntries = $state<AutoMemoryEntry[]>(data.entries ?? []);
	let liveContext = $state<RankedContext | null>(data.context ?? null);
	let liveGraph = $state<{ nodes: Record<string, GraphNode>; edges?: GraphEdge[]; pageRanks?: Record<string, number> } | null>(data.graph ?? null);

	$effect(() => {
		liveEntries = data.entries ?? [];
		liveContext = data.context ?? null;
		liveGraph = data.graph ?? null;
		initialReady = true;
	});

	async function refresh() {
		loading = true;
		error = null;
		graphFetchError = null;
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

	// Filtered, sorted, paginated entries
	const sortedFilteredEntries = $derived.by(() => {
		let list = liveEntries as AutoMemoryEntry[];

		// Text search
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			list = list.filter(
				(e) =>
					e.key.toLowerCase().includes(q) ||
					(e.summary ?? '').toLowerCase().includes(q) ||
					(e.content ?? '').toLowerCase().includes(q) ||
					(e.namespace ?? '').toLowerCase().includes(q)
			);
		}

		// Namespace filter
		if (filterNamespace !== 'all') {
			list = list.filter(e => (e.namespace ?? 'default') === filterNamespace);
		}

		// Type filter
		if (filterType !== 'all') {
			list = list.filter(e => (e.type ?? 'unknown') === filterType);
		}

		// Sort
		const dir = sortDir === 'asc' ? 1 : -1;
		list = [...list].sort((a, b) => {
			const fieldMap: Record<string, string> = { summary: 'summary', namespace: 'namespace', type: 'type', createdAt: 'createdAt' };
			const key = fieldMap[sortField] as keyof AutoMemoryEntry;
			const av = (a[key] as string | number) ?? '';
			const bv = (b[key] as string | number) ?? '';
			if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
			return String(av).localeCompare(String(bv)) * dir;
		});

		return list;
	});

	const filteredEntries = $derived(sortedFilteredEntries);
	const totalPages = $derived(Math.max(1, Math.ceil(sortedFilteredEntries.length / PAGE_SIZE)));
	const paginatedEntries = $derived(sortedFilteredEntries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

	// Reset page when filters change
	$effect(() => {
		searchQuery; filterNamespace; filterType; sortField; sortDir;
		currentPage = 1;
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

	// Periodic graph refresh (every 30s) when memoryGraphEnabled is true
	const GRAPH_REFRESH_INTERVAL = 30_000;
	let graphRefreshTimer = $state<ReturnType<typeof setInterval> | null>(null);

	async function refreshGraph() {
		graphRefreshing = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/memory`);
			if (!res.ok) {
				graphFetchError = `Graph API returned ${res.status}: ${res.statusText}`;
				return;
			}
			const body = await res.json();
			if (body.graph) liveGraph = body.graph;
			if (body.context) liveContext = body.context;
			if (body.entries) liveEntries = body.entries;
			graphFetchError = null;
		} catch (e) {
			graphFetchError = e instanceof Error ? e.message : 'Failed to fetch graph data';
		} finally {
			graphRefreshing = false;
		}
	}

	async function retryGraphFetch() {
		graphFetchError = null;
		await refreshGraph();
	}

	$effect(() => {
		if (data.memoryGraphEnabled) {
			graphRefreshTimer = setInterval(refreshGraph, GRAPH_REFRESH_INTERVAL);
		}
		return () => {
			if (graphRefreshTimer) {
				clearInterval(graphRefreshTimer);
				graphRefreshTimer = null;
			}
		};
	});
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

	<!-- Loading Overlay — shown during refresh or initial client-side navigation -->
	{#if loading || !initialReady}
		<div class="flex items-center justify-center py-12">
			<div class="flex flex-col items-center gap-4 text-text-secondary text-sm">
				<div class="relative w-10 h-10">
					<div class="absolute inset-0 rounded-full border-2 border-border"></div>
					<div class="absolute inset-0 rounded-full border-2 border-accent-blue border-t-transparent animate-spin"></div>
				</div>
				<span>{loading ? 'Refreshing memory data...' : 'Loading memory data...'}</span>
				<div class="flex gap-1.5 mt-1">
					<div class="w-1.5 h-1.5 rounded-full bg-accent-blue/60 animate-pulse"></div>
					<div class="w-1.5 h-1.5 rounded-full bg-accent-blue/40 animate-pulse" style="animation-delay: 150ms"></div>
					<div class="w-1.5 h-1.5 rounded-full bg-accent-blue/20 animate-pulse" style="animation-delay: 300ms"></div>
				</div>
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
	{:else if !loading && initialReady && totalNodes === 0 && !error}
		<!-- Empty State -->
		<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
			<svg class="w-10 h-10 mx-auto text-text-secondary/40 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
			<p class="text-text-primary font-medium mb-1">No memory data yet</p>
			<p class="text-text-secondary text-sm">Memory entries will appear here as the project stores patterns, decisions, and context.</p>
		</div>
	{:else}

	<!-- Tab Bar -->
	<div class="flex items-center gap-1 border-b border-border">
		<button
			onclick={() => (activeTab = 'overview')}
			class="px-4 py-2 text-sm font-medium border-b-2 transition-colors {activeTab === 'overview' ? 'border-accent-cyan text-accent-cyan' : 'border-transparent text-text-secondary hover:text-text-primary'}"
		>
			Overview
		</button>
		<button
			onclick={() => (activeTab = 'entries')}
			class="px-4 py-2 text-sm font-medium border-b-2 transition-colors {activeTab === 'entries' ? 'border-accent-cyan text-accent-cyan' : 'border-transparent text-text-secondary hover:text-text-primary'}"
		>
			Entries
			<span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary font-mono">{liveEntries.length}</span>
		</button>
	</div>

	<!-- ═══ OVERVIEW TAB ═══ -->
	{#if activeTab === 'overview'}

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-4">
		<MetricCard label="Total Nodes" value={totalNodes} accent="blue" />
		<MetricCard label="Namespaces" value={totalNamespaces} accent="purple" />
		<MetricCard label="Categories" value={totalCategories} accent="cyan" />
		<MetricCard label="Confidence" value={hitRate} accent="green" />
		<MetricCard label="Auto-Memory" value={liveEntries.length} accent="yellow" />
	</div>

	<!-- Memory Graph (lazy-loaded) -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4 relative">
		<div class="flex items-center gap-2 mb-3">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider">Memory Graph</h2>
			{#if graphRefreshing}
				<div class="w-3 h-3 rounded-full border border-accent-blue/40 border-t-accent-blue animate-spin"></div>
			{/if}
		</div>
		{#if data.memoryGraphEnabled === false}
			<div class="flex items-center justify-center py-12 text-text-secondary text-sm">
				<p>Memory graph is disabled. Enable it in settings to visualize relationships.</p>
			</div>
		{:else if graphFetchError}
			<div class="h-48 flex flex-col items-center justify-center gap-2" role="alert">
				<svg class="w-5 h-5 text-accent-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
				<p class="text-text-secondary text-sm">Failed to load graph data</p>
				<p class="text-text-secondary text-xs max-w-md text-center">{graphFetchError}</p>
				<button
					onclick={retryGraphFetch}
					disabled={graphRefreshing}
					class="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary text-text-primary hover:bg-bg-primary transition-colors disabled:opacity-50"
					aria-label="Retry loading memory graph"
				>
					<svg class="w-3 h-3 {graphRefreshing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
					{graphRefreshing ? 'Retrying...' : 'Retry'}
				</button>
			</div>
		{:else if graphNodes.length > 0 && BubbleGraph}
			<BubbleGraph nodes={graphNodes} edges={graphEdges} />
		{:else if graphNodes.length > 0 || graphRefreshing}
			<div class="flex flex-col items-center justify-center py-12 gap-3 text-text-secondary text-sm">
				<div class="w-8 h-8 rounded-full border-2 border-border border-t-accent-cyan animate-spin"></div>
				<p>Loading graph visualization...</p>
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

	<!-- ═══ ENTRIES TAB ═══ -->
	{#if activeTab === 'entries'}

	<section>
		<!-- Toolbar: Search, Filters -->
		<div class="flex flex-wrap items-center gap-3 mb-4">
			<div class="relative flex-1 min-w-[200px]">
				<svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search memories..."
					class="w-full pl-8 pr-3 py-1.5 text-xs bg-bg-primary border border-border rounded text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-cyan/50"
				/>
			</div>
			<select
				bind:value={filterNamespace}
				class="text-xs bg-bg-primary border border-border rounded px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent-cyan/50"
			>
				<option value="all">All namespaces</option>
				{#each availableNamespaces as ns}
					<option value={ns}>{ns}</option>
				{/each}
			</select>
			<select
				bind:value={filterType}
				class="text-xs bg-bg-primary border border-border rounded px-2 py-1.5 text-text-primary focus:outline-none focus:border-accent-cyan/50"
			>
				<option value="all">All types</option>
				{#each availableTypes as t}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</div>

		<!-- Results count -->
		<div class="flex items-center justify-between mb-2">
			<span class="text-xs text-text-secondary">{sortedFilteredEntries.length} of {liveEntries.length} entries</span>
			<span class="text-xs text-text-secondary">Page {currentPage} of {totalPages}</span>
		</div>

		<!-- Table -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<!-- Header -->
			<div class="grid grid-cols-[1fr_8rem_6rem_7rem] items-center px-4 py-2 bg-bg-tertiary/50 border-b border-border text-[10px] uppercase tracking-wider text-text-secondary font-medium">
				<button onclick={() => setSort('summary')} class="text-left hover:text-text-primary transition-colors flex items-center gap-1">
					Summary
					{#if sortField === 'summary'}<span class="text-accent-cyan">{sortDir === 'asc' ? '↑' : '↓'}</span>{/if}
				</button>
				<button onclick={() => setSort('namespace')} class="text-left hover:text-text-primary transition-colors flex items-center gap-1">
					Namespace
					{#if sortField === 'namespace'}<span class="text-accent-cyan">{sortDir === 'asc' ? '↑' : '↓'}</span>{/if}
				</button>
				<button onclick={() => setSort('type')} class="text-left hover:text-text-primary transition-colors flex items-center gap-1">
					Type
					{#if sortField === 'type'}<span class="text-accent-cyan">{sortDir === 'asc' ? '↑' : '↓'}</span>{/if}
				</button>
				<button onclick={() => setSort('createdAt')} class="text-left hover:text-text-primary transition-colors flex items-center gap-1">
					Created
					{#if sortField === 'createdAt'}<span class="text-accent-cyan">{sortDir === 'asc' ? '↑' : '↓'}</span>{/if}
				</button>
			</div>

			<!-- Rows -->
			{#each paginatedEntries as entry (entry.id)}
				<div class="border-b border-border last:border-0">
					<button
						onclick={() => toggleExpand(entry.key)}
						class="w-full grid grid-cols-[1fr_8rem_6rem_7rem] items-center px-4 py-2.5 hover:bg-bg-tertiary/30 transition-colors text-left"
					>
						<div class="flex items-center gap-2 truncate min-w-0">
							<svg class="w-3 h-3 text-text-secondary flex-shrink-0 transition-transform {expandedKeys.has(entry.key) ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
							<span class="text-xs text-text-primary truncate">{entry.summary || entry.key}</span>
						</div>
						<span class="text-[10px] px-1.5 py-0.5 rounded font-mono truncate {nsBadgeColors[entry.namespace] ?? nsBadgeColors['default']}">{entry.namespace ?? 'default'}</span>
						<span class="text-[10px] text-text-secondary">{entry.type ?? 'unknown'}</span>
						<span class="text-[10px] text-text-secondary font-mono">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : 'N/A'}</span>
					</button>
					{#if expandedKeys.has(entry.key)}
						<div class="px-10 pb-3">
							<span class="text-[10px] font-mono text-text-secondary">{entry.key}</span>
							<div class="mt-2 bg-bg-primary border border-border rounded p-3 text-xs text-text-primary font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
								{entry.content || 'No content'}
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="px-4 py-8 text-center">
					<p class="text-text-secondary text-sm">{searchQuery.trim() || filterNamespace !== 'all' || filterType !== 'all' ? 'No entries match your filters' : 'No memory entries yet'}</p>
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<div class="flex items-center justify-center gap-2 mt-4">
				<button
					onclick={() => (currentPage = Math.max(1, currentPage - 1))}
					disabled={currentPage <= 1}
					class="px-2.5 py-1 text-xs rounded border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-30"
				>
					Prev
				</button>
				{#each Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
					if (totalPages <= 7) return i + 1;
					if (currentPage <= 4) return i + 1;
					if (currentPage >= totalPages - 3) return totalPages - 6 + i;
					return currentPage - 3 + i;
				}) as page}
					<button
						onclick={() => (currentPage = page)}
						class="w-7 h-7 text-xs rounded border transition-colors {page === currentPage ? 'border-accent-cyan bg-accent-cyan/10 text-accent-cyan' : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'}"
					>
						{page}
					</button>
				{/each}
				<button
					onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}
					disabled={currentPage >= totalPages}
					class="px-2.5 py-1 text-xs rounded border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-30"
				>
					Next
				</button>
			</div>
		{/if}
	</section>

	{/if}

	{/if}
</div>
