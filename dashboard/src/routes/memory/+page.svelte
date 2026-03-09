<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import PageFallback from '$lib/components/PageFallback.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import type { Component } from 'svelte';
	import type { GraphNode, GraphEdge, RankedGraphNode, GraphState } from '$lib/types/graph.js';
	import type { RankedContext, RankedEntry, AutoMemoryEntry, MemoryContextResponse, MemoryPageData } from '$lib/types/memory.js';

	let { data }: { data: MemoryPageData } = $props();

	// Lazy-load BubbleGraph
	let BubbleGraph = $state<Component<{ nodes: RankedGraphNode[]; edges?: GraphEdge[]; onNodeClick?: (nodeId: string) => void }> | null>(null);
	$effect(() => {
		import('$lib/components/BubbleGraph.svelte').then(m => { BubbleGraph = m.default; });
	});

	// Client-side refresh state
	let loading = $state(false);
	let error = $state<string | null>(null);
	let graphFetchError = $state<string | null>(null);
	let lastRefreshed = $state<number | null>(null);

	// Live context/autoMemory/graph that can be refreshed client-side
	let liveContext = $state<RankedContext | null>(null);
	let liveAutoMemory = $state<AutoMemoryEntry[] | null>(null);
	let liveGraph = $state<GraphState | null>(null);

	// Sync from server data (initial load + navigation)
	$effect(() => {
		liveContext = data.context;
		liveAutoMemory = data.autoMemory;
		liveGraph = data.graph;
	});

	async function refreshContext() {
		loading = true;
		error = null;
		graphFetchError = null;
		try {
			const graphEnabled = data.memoryGraphEnabled !== false;
			const fetches: Promise<Response>[] = [fetch('/api/memory/context')];
			if (graphEnabled) {
				fetches.push(fetch('/api/memory/graph'));
			}
			const [contextRes, graphRes] = await Promise.all(fetches);
			if (!contextRes.ok) throw new Error(`Failed to fetch memory context (${contextRes.status})`);
			const body: MemoryContextResponse = await contextRes.json();
			liveContext = body.context;
			liveAutoMemory = body.autoMemory;
			if (graphRes?.ok) {
				const graphBody: GraphState = await graphRes.json();
				liveGraph = graphBody;
			} else if (graphRes && !graphRes.ok) {
				graphFetchError = `Graph API returned ${graphRes.status}: ${graphRes.statusText}`;
			}
			lastRefreshed = Date.now();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error refreshing memory context';
		} finally {
			loading = false;
		}
	}

	async function retryGraphFetch() {
		graphFetchError = null;
		loading = true;
		try {
			const graphRes = await fetch('/api/memory/graph');
			if (!graphRes.ok) {
				graphFetchError = `Graph API returned ${graphRes.status}: ${graphRes.statusText}`;
				return;
			}
			const graphBody: GraphState = await graphRes.json();
			liveGraph = graphBody;
		} catch (e) {
			graphFetchError = e instanceof Error ? e.message : 'Failed to fetch graph data';
		} finally {
			loading = false;
		}
	}

	const graphResult = $derived.by((): { nodes: RankedGraphNode[]; error: string | null } => {
		if (!liveGraph?.nodes) return { nodes: [], error: null };
		try {
			const entries = liveContext?.entries ?? [];
			const nodes = liveGraph.nodes;
			const ranks = liveGraph.pageRanks ?? {};
			const result = Object.values(nodes).map((node): RankedGraphNode => {
				const contextEntry = entries.find((e: { id: string }) => e.id === node.id);
				const label = contextEntry?.summary ?? node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
				return { ...node, pageRank: ranks[node.id] ?? 0, label };
			});
			return { nodes: result, error: null };
		} catch (e) {
			return { nodes: [], error: e instanceof Error ? e.message : 'Failed to process graph data' };
		}
	});
	const graphNodes = $derived(graphResult.nodes);
	const graphError = $derived(graphResult.error);

	const graphEdges = $derived.by(() => {
		try {
			return (liveGraph?.edges ?? []) as GraphEdge[];
		} catch {
			return [];
		}
	});

	// Selected node detail
	let selectedNodeId = $state<string | null>(null);

	const selectedNode = $derived.by(() => {
		if (!selectedNodeId) return null;
		const entry = (liveContext?.entries ?? []).find((e: RankedEntry) => e.id === selectedNodeId);
		const graphNode = liveGraph?.nodes?.[selectedNodeId];
		if (!entry && !graphNode) return null;
		return {
			id: selectedNodeId,
			summary: entry?.summary ?? selectedNodeId,
			content: entry?.content ?? '',
			category: entry?.category ?? graphNode?.category ?? 'unknown',
			confidence: entry?.confidence ?? graphNode?.confidence ?? 0,
			pageRank: entry?.pageRank ?? liveGraph?.pageRanks?.[selectedNodeId] ?? 0,
			accessCount: entry?.accessCount ?? graphNode?.accessCount ?? 0,
			connectedTo: (liveGraph?.edges ?? [])
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
				id: entry.id,
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

	// Search & filter
	let searchQuery = $state('');
	let groupBy = $state<'namespace' | 'type' | 'none'>('namespace');

	// Selection state
	let selectedIds = $state<Set<string>>(new Set());
	let collapsedGroups = $state<Set<string>>(new Set());

	// Start all groups collapsed on first render
	let groupsInitialized = $state(false);

	function toggleSelect(id: string, ev: MouseEvent) {
		ev.stopPropagation();
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function toggleGroup(label: string) {
		const next = new Set(collapsedGroups);
		if (next.has(label)) next.delete(label);
		else next.add(label);
		collapsedGroups = next;
	}

	function selectGroup(groupEntries: typeof filteredEntries) {
		const ids = groupEntries.map(e => e.id);
		const allInGroup = ids.every(id => selectedIds.has(id));
		const next = new Set(selectedIds);
		if (allInGroup) {
			for (const id of ids) next.delete(id);
		} else {
			for (const id of ids) next.add(id);
		}
		selectedIds = next;
	}

	const filteredEntries = $derived.by(() => {
		if (!searchQuery.trim()) return autoMemoryEntries;
		const q = searchQuery.toLowerCase();
		return autoMemoryEntries.filter(e =>
			e.summary.toLowerCase().includes(q) ||
			e.key.toLowerCase().includes(q) ||
			e.namespace.toLowerCase().includes(q) ||
			e.content.toLowerCase().includes(q)
		);
	});

	const groupedEntries = $derived.by(() => {
		if (groupBy === 'none') return [{ label: '', entries: filteredEntries }];
		const groups = new Map<string, typeof filteredEntries>();
		for (const entry of filteredEntries) {
			const key = groupBy === 'namespace' ? entry.namespace : (entry.type ?? 'unknown');
			const list = groups.get(key) ?? [];
			list.push(entry);
			groups.set(key, list);
		}
		return Array.from(groups.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([label, entries]) => ({ label, entries }));
	});

	// Collapse all groups when groupBy changes or on first load
	let lastGroupBy = $state(groupBy);
	$effect(() => {
		if (groupBy !== lastGroupBy || (!groupsInitialized && groupedEntries.length > 0)) {
			collapsedGroups = new Set(groupedEntries.filter(g => g.label).map(g => g.label));
			lastGroupBy = groupBy;
			groupsInitialized = true;
		}
	});

	// Delete memory entries
	let deleting = $state(false);

	async function deleteEntry(id: string, ev: MouseEvent) {
		ev.stopPropagation();
		try {
			const res = await fetch('/api/memory/entries', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids: [id] })
			});
			if (!res.ok) throw new Error(`Delete failed (${res.status})`);
			liveAutoMemory = (liveAutoMemory ?? []).filter(e => e.id !== id);
			const next = new Set(selectedIds);
			next.delete(id);
			selectedIds = next;
			refreshContext();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete entry';
		}
	}

	async function deleteSelected() {
		if (selectedIds.size === 0) return;
		deleting = true;
		try {
			const ids = Array.from(selectedIds);
			const res = await fetch('/api/memory/entries', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ids })
			});
			if (!res.ok) throw new Error(`Delete failed (${res.status})`);
			const body = await res.json();
			liveAutoMemory = (liveAutoMemory ?? []).filter(e => !selectedIds.has(e.id));
			selectedIds = new Set();
			syncResult = `Deleted ${body.removed} entries`;
			refreshContext();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete entries';
		} finally {
			deleting = false;
		}
	}

	// Sync memory bridge
	let syncing = $state(false);
	let syncResult = $state<string | null>(null);

	async function syncMemory() {
		syncing = true;
		syncResult = null;
		error = null;
		try {
			const res = await fetch('/api/memory/sync', { method: 'POST' });
			if (!res.ok) throw new Error(`Sync failed (${res.status})`);
			const body = await res.json();
			const parts: string[] = [];
			if (body.added > 0) parts.push(`${body.added} added`);
			if (body.updated > 0) parts.push(`${body.updated} updated`);
			if (body.sources?.length) parts.push(`sources: ${body.sources.join(', ')}`);
			syncResult = parts.length > 0 ? parts.join(', ') : 'No changes';
			// Refresh data after sync
			await refreshContext();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sync failed';
		} finally {
			syncing = false;
		}
	}

	// Active tab
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

	// Entries tab: namespace filter
	let filterNamespace = $state<string>('all');
	let filterType = $state<string>('all');

	const availableNamespaces = $derived.by(() => {
		const ns = new Set((liveAutoMemory ?? []).map((e: AutoMemoryEntry) => e.namespace ?? 'default'));
		return Array.from(ns).sort();
	});

	const availableTypes = $derived.by(() => {
		const types = new Set((liveAutoMemory ?? []).map((e: AutoMemoryEntry) => e.type ?? 'unknown'));
		return Array.from(types).sort();
	});

	// Entries tab: pagination
	let currentPage = $state(1);
	const PAGE_SIZE = 25;

	const sortedFilteredEntries = $derived.by(() => {
		let list = autoMemoryEntries;

		// Text search
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			list = list.filter(e =>
				e.summary.toLowerCase().includes(q) ||
				e.key.toLowerCase().includes(q) ||
				e.namespace.toLowerCase().includes(q) ||
				e.content.toLowerCase().includes(q)
			);
		}

		// Namespace filter
		if (filterNamespace !== 'all') {
			list = list.filter(e => e.namespace === filterNamespace);
		}

		// Type filter
		if (filterType !== 'all') {
			list = list.filter(e => e.type === filterType);
		}

		// Sort
		const dir = sortDir === 'asc' ? 1 : -1;
		list = [...list].sort((a, b) => {
			const av = a[sortField] ?? '';
			const bv = b[sortField] ?? '';
			if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
			return String(av).localeCompare(String(bv)) * dir;
		});

		return list;
	});

	const totalPages = $derived(Math.max(1, Math.ceil(sortedFilteredEntries.length / PAGE_SIZE)));
	const paginatedEntries = $derived(sortedFilteredEntries.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

	// Reset page when filters change
	$effect(() => {
		// Access dependencies to trigger
		searchQuery; filterNamespace; filterType; sortField; sortDir;
		currentPage = 1;
	});

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

	const isEmpty = $derived(!loading && (liveAutoMemory ?? []).length === 0 && (liveContext?.entries ?? []).length === 0);

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

	const metricEdges = $derived(liveGraph?.edges?.length ?? 0);

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
	<div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
		<h1 class="type-page-title text-text-primary">Memory & Knowledge</h1>
		<div class="flex items-center gap-2 flex-shrink-0">
			<button
				onclick={syncMemory}
				disabled={syncing || loading}
				class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 transition-colors disabled:opacity-50"
			>
				<svg class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" /></svg>
				{syncing ? 'Syncing...' : 'Sync Sources'}
			</button>
			<button
				onclick={refreshContext}
				disabled={loading}
				class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
			>
				<svg class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
				{loading ? 'Refreshing...' : 'Refresh'}
			</button>
		</div>
	</div>

	<!-- Error Banner -->
	{#if error}
		<div class="flex items-center gap-3 px-4 py-3 bg-accent-red/10 border border-accent-red/30 rounded-lg text-sm text-accent-red">
			<svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
			<span>{error}</span>
			<button onclick={() => (error = null)} class="ml-auto text-accent-red/60 hover:text-accent-red" aria-label="Dismiss error">&times;</button>
		</div>
	{/if}

	<!-- Sync Result Banner -->
	{#if syncResult}
		<div class="flex items-center gap-3 px-4 py-3 bg-accent-green/10 border border-accent-green/30 rounded-lg text-sm text-accent-green">
			<svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
			<span>Sync complete: {syncResult}</span>
			<button onclick={() => (syncResult = null)} class="ml-auto text-accent-green/60 hover:text-accent-green" aria-label="Dismiss">&times;</button>
		</div>
	{/if}

	<!-- Server Load Errors -->
	{#if data.loadErrors}
		<div class="flex items-start gap-3 px-4 py-3 bg-accent-yellow/10 border border-accent-yellow/30 rounded-lg text-sm text-accent-yellow">
			<svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
			<div>
				<p class="font-medium">Some data failed to load:</p>
				<ul class="mt-1 list-disc list-inside text-xs">
					{#each data.loadErrors as loadError}
						<li>{loadError}</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	{#if isEmpty && !error}
		<PageFallback
			variant="empty"
			title="No memory data yet"
			message="Memory entries will appear here as the system stores patterns, decisions, and context. Use Sync Sources to import existing memory files."
		>
			{#snippet icon()}
				<svg class="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
			{/snippet}
			{#snippet actions()}
				<button
					onclick={syncMemory}
					disabled={syncing}
					class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 transition-colors disabled:opacity-50"
				>
					<svg class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" /></svg>
					{syncing ? 'Syncing...' : 'Sync Sources'}
				</button>
			{/snippet}
		</PageFallback>
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
			<span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-secondary font-mono">{(liveAutoMemory ?? []).length}</span>
		</button>
	</div>

	<!-- ═══ OVERVIEW TAB ═══ -->
	{#if activeTab === 'overview'}

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
		<div class="bg-bg-secondary border border-border rounded-lg p-6">
			<div class="flex flex-col items-center justify-center py-4 gap-3">
				<div class="w-10 h-10 rounded-full bg-accent-cyan/10 flex items-center justify-center">
					<svg class="w-5 h-5 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" /></svg>
				</div>
				<p class="text-text-primary text-sm font-medium">No memory context yet</p>
				<p class="text-text-secondary text-xs text-center max-w-xs">Memory context populates automatically as agents process tasks and store knowledge. Use the refresh button to check for new entries.</p>
			</div>
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
		<div class="lg:col-span-2 bg-bg-secondary border border-border rounded-lg p-2 sm:p-4">
			<h2 class="type-section-title text-text-primary mb-4">Memory Graph</h2>
			{#if data.memoryGraphEnabled === false}
				<div class="flex flex-col items-center justify-center py-10 gap-4">
					<svg class="w-16 h-16 text-text-secondary/20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
						<circle cx="32" cy="12" r="5" stroke="currentColor" stroke-width="2" />
						<circle cx="12" cy="44" r="5" stroke="currentColor" stroke-width="2" />
						<circle cx="52" cy="44" r="5" stroke="currentColor" stroke-width="2" />
						<circle cx="32" cy="36" r="5" stroke="currentColor" stroke-width="2" />
						<line x1="32" y1="17" x2="32" y2="31" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" />
						<line x1="28" y1="39" x2="16" y2="41" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" />
						<line x1="36" y1="39" x2="48" y2="41" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" />
						<line x1="10" y1="10" x2="54" y2="54" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
					<div class="text-center space-y-1">
						<p class="text-text-secondary text-sm font-medium">Memory graph is disabled. Enable it in settings to visualize relationships.</p>
						<p class="text-text-secondary/60 text-xs">Turn on the graph to explore how memory entries connect.</p>
					</div>
					<a
						href="/settings"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary text-text-primary hover:bg-bg-primary transition-colors"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><circle cx="12" cy="12" r="3" /></svg>
						Enable in Settings
					</a>
				</div>
			{:else if graphFetchError || graphError}
				<div class="h-48 flex flex-col items-center justify-center gap-2">
					<svg class="w-5 h-5 text-accent-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
					<p class="text-text-secondary text-sm">Failed to load graph data</p>
					<p class="text-text-secondary text-xs">{graphFetchError ?? graphError}</p>
					<button
						onclick={retryGraphFetch}
						disabled={loading}
						class="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary text-text-primary hover:bg-bg-primary transition-colors disabled:opacity-50"
					>
						<svg class="w-3 h-3 {loading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
						{loading ? 'Retrying...' : 'Retry'}
					</button>
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
				<div class="flex flex-col items-center justify-center py-10 gap-4">
					<svg class="w-16 h-16 text-text-secondary/20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
						<circle cx="32" cy="16" r="6" stroke="currentColor" stroke-width="2" />
						<circle cx="14" cy="46" r="6" stroke="currentColor" stroke-width="2" />
						<circle cx="50" cy="46" r="6" stroke="currentColor" stroke-width="2" />
						<line x1="32" y1="22" x2="20" y2="40" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 4" />
						<line x1="32" y1="22" x2="44" y2="40" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 4" />
						<circle cx="32" cy="16" r="2" fill="currentColor" class="opacity-30" />
						<circle cx="14" cy="46" r="2" fill="currentColor" class="opacity-30" />
						<circle cx="50" cy="46" r="2" fill="currentColor" class="opacity-30" />
					</svg>
					<div class="text-center space-y-2">
						<p class="text-text-primary text-sm font-medium">No graph data yet</p>
						<p class="text-text-secondary text-xs max-w-sm">The memory graph visualizes connections between knowledge entries. As agents work on tasks and store findings, nodes and edges will appear here.</p>
						<button
							onclick={refreshContext}
							disabled={loading}
							class="mt-1 inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10 transition-colors disabled:opacity-50"
						>
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
							Check for data
						</button>
					</div>
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
						<div class="flex flex-col items-center gap-2 py-6">
							<svg class="w-6 h-6 text-text-secondary/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" /></svg>
							<p class="text-xs text-text-secondary">No context entries yet</p>
							<p class="text-[10px] text-text-secondary/60 text-center max-w-[180px]">Top contexts will appear here as memory accumulates.</p>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	{/if}

	<!-- ═══ ENTRIES TAB ═══ -->
	{#if activeTab === 'entries'}

	<section>
		<!-- Toolbar: Search, Filters, Bulk Actions -->
		<div class="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
			<div class="relative w-full sm:flex-1 sm:w-auto min-w-0">
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
			{#if selectedIds.size > 0}
				<button
					onclick={deleteSelected}
					disabled={deleting}
					class="text-xs px-2.5 py-1.5 rounded border border-accent-red/30 bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors disabled:opacity-50"
				>
					{deleting ? 'Deleting...' : `Delete ${selectedIds.size} selected`}
				</button>
			{/if}
		</div>

		<!-- Results count -->
		<div class="flex items-center justify-between mb-2">
			<span class="text-xs text-text-secondary">{sortedFilteredEntries.length} of {autoMemoryEntries.length} entries</span>
			<span class="text-xs text-text-secondary">Page {currentPage} of {totalPages}</span>
		</div>

		<!-- Table -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<!-- Header (hidden on mobile, shown as table header on md+) -->
			<div class="hidden md:grid grid-cols-[2rem_1fr_8rem_6rem_7rem_2rem] items-center px-3 py-2 bg-bg-tertiary/50 border-b border-border text-[10px] uppercase tracking-wider text-text-secondary font-medium">
				<div></div>
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
				<div></div>
			</div>

			<!-- Mobile sort controls (shown only on small screens) -->
			<div class="flex md:hidden items-center gap-2 px-3 py-2 bg-bg-tertiary/50 border-b border-border">
				<span class="text-[10px] text-text-secondary uppercase tracking-wider">Sort:</span>
				<select
					onchange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as typeof sortField)}
					class="text-[10px] bg-bg-primary border border-border rounded px-1.5 py-1 text-text-primary"
				>
					<option value="summary" selected={sortField === 'summary'}>Summary</option>
					<option value="namespace" selected={sortField === 'namespace'}>Namespace</option>
					<option value="type" selected={sortField === 'type'}>Type</option>
					<option value="createdAt" selected={sortField === 'createdAt'}>Created</option>
				</select>
				<button onclick={() => (sortDir = sortDir === 'asc' ? 'desc' : 'asc')} class="text-[10px] text-accent-cyan">{sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}</button>
			</div>

			<!-- Rows -->
			{#each paginatedEntries as entry (entry.id)}
				<div class="border-b border-border last:border-0">
					<!-- Desktop row -->
					<div class="hidden md:grid grid-cols-[2rem_1fr_8rem_6rem_7rem_2rem] items-center px-3 py-2 hover:bg-bg-tertiary/30 transition-colors">
						<button
							onclick={(ev) => toggleSelect(entry.id, ev)}
							class="flex-shrink-0"
							aria-label="Select {entry.summary}"
						>
							<div class="w-3.5 h-3.5 rounded border {selectedIds.has(entry.id) ? 'bg-accent-cyan border-accent-cyan' : 'border-text-secondary/40 hover:border-text-secondary'} flex items-center justify-center transition-colors">
								{#if selectedIds.has(entry.id)}
									<svg class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
								{/if}
							</div>
						</button>
						<button onclick={() => toggleExpand(entry.key)} class="text-left truncate flex items-center gap-2 min-w-0">
							<svg class="w-3 h-3 text-text-secondary flex-shrink-0 transition-transform {expandedKeys.has(entry.key) ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
							<span class="text-xs text-text-primary truncate">{entry.summary}</span>
						</button>
						<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono truncate">{entry.namespace}</span>
						<span class="text-[10px] text-text-secondary">{entry.type}</span>
						<span class="text-[10px] text-text-secondary font-mono">{entry.createdAt}</span>
						<button
							onclick={(ev) => deleteEntry(entry.id, ev)}
							class="text-text-secondary hover:text-accent-red transition-colors"
							title="Delete entry"
							aria-label="Delete {entry.summary}"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
						</button>
					</div>
					<!-- Mobile card row -->
					<div class="flex md:hidden items-start gap-2 px-3 py-2.5 hover:bg-bg-tertiary/30 transition-colors">
						<button
							onclick={(ev) => toggleSelect(entry.id, ev)}
							class="flex-shrink-0 mt-0.5"
							aria-label="Select {entry.summary}"
						>
							<div class="w-4 h-4 rounded border {selectedIds.has(entry.id) ? 'bg-accent-cyan border-accent-cyan' : 'border-text-secondary/40'} flex items-center justify-center">
								{#if selectedIds.has(entry.id)}
									<svg class="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
								{/if}
							</div>
						</button>
						<button onclick={() => toggleExpand(entry.key)} class="flex-1 min-w-0 text-left">
							<div class="flex items-center gap-1.5 mb-1">
								<svg class="w-3 h-3 text-text-secondary flex-shrink-0 transition-transform {expandedKeys.has(entry.key) ? 'rotate-90' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
								<span class="text-xs text-text-primary truncate">{entry.summary}</span>
							</div>
							<div class="flex flex-wrap items-center gap-1.5 pl-4.5">
								<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">{entry.namespace}</span>
								<span class="text-[10px] text-text-secondary">{entry.type}</span>
								<span class="text-[10px] text-text-secondary font-mono">{entry.createdAt}</span>
							</div>
						</button>
						<button
							onclick={(ev) => deleteEntry(entry.id, ev)}
							class="flex-shrink-0 mt-0.5 text-text-secondary hover:text-accent-red transition-colors"
							title="Delete entry"
							aria-label="Delete {entry.summary}"
						>
							<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
						</button>
					</div>
					<!-- Expanded content -->
					{#if expandedKeys.has(entry.key)}
						<div class="px-4 md:px-10 pb-3">
							<div class="flex items-center gap-3 text-[10px] text-text-secondary mb-2">
								<span class="font-mono">{entry.key}</span>
								{#if entry.project}
									<span>from: {entry.project}</span>
								{/if}
								{#if entry.bootstrapped}
									<span class="px-1.5 py-0.5 bg-accent-blue/20 text-accent-blue rounded">bootstrapped</span>
								{/if}
							</div>
							<div class="bg-bg-primary border border-border rounded p-3 text-xs text-text-primary font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
								{entry.content}
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="px-4 py-10 flex flex-col items-center gap-3">
					{#if searchQuery || filterNamespace !== 'all' || filterType !== 'all'}
						<svg class="w-8 h-8 text-text-secondary/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
						<p class="text-text-secondary text-sm font-medium">No matching entries</p>
						<p class="text-text-secondary/60 text-xs text-center max-w-xs">Try adjusting your search query or filters to find what you're looking for.</p>
					{:else}
						<div class="w-10 h-10 rounded-full bg-accent-purple/10 flex items-center justify-center">
							<svg class="w-5 h-5 text-accent-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
						</div>
						<p class="text-text-primary text-sm font-medium">No auto-memory entries yet</p>
						<p class="text-text-secondary text-xs text-center max-w-xs">Auto-memory entries are created when agents store knowledge from tasks, conversations, and code analysis. They'll appear here automatically.</p>
					{/if}
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
