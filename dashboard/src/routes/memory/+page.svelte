<script lang="ts">
	import BubbleGraph from '$lib/components/BubbleGraph.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { GraphNode } from '$lib/types/graph.js';
	import type { GraphState } from '$lib/types/graph.js';
	import type { RankedContext, AutoMemoryEntry } from '$lib/types/memory.js';

	interface MemoryPageData {
		graph: GraphState | null;
		context: RankedContext | null;
		autoMemory: AutoMemoryEntry[] | null;
		memoryConfig: Record<string, unknown> | null;
	}

	let { data }: { data: MemoryPageData } = $props();

	// Map graph nodes + pageRanks into BubbleGraph format
	const graphNodes: (GraphNode & { pageRank: number; label: string })[] = $derived.by(() => {
		if (!data.graph?.nodes) return [];
		const entries = data.context?.entries ?? [];
		const nodes = data.graph.nodes;
		const ranks = data.graph.pageRanks;
		return (Object.values(nodes) as GraphNode[]).map((node: GraphNode) => {
			const contextEntry = entries.find((e: { id: string }) => e.id === node.id);
			const label = contextEntry?.summary ?? node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
			return {
				...node,
				pageRank: ranks[node.id] ?? 0,
				label
			};
		});
	});

	// Ranked context table rows sorted by pageRank descending
	const contextColumns = [
		{ key: 'summary', label: 'Summary' },
		{ key: 'category', label: 'Category' },
		{ key: 'confidence', label: 'Confidence', mono: true },
		{ key: 'pageRank', label: 'PageRank', mono: true },
		{ key: 'accessCount', label: 'Accesses', mono: true }
	];

	const contextRows = $derived.by(() => {
		if (!data.context?.entries) return [];
		return [...data.context.entries]
			.sort((a, b) => b.pageRank - a.pageRank)
			.map((entry) => ({
				...entry,
				confidence: entry.confidence.toFixed(3),
				pageRank: entry.pageRank.toFixed(4),
				accessCount: entry.accessCount
			}));
	});

	// Auto memory table
	const autoMemoryColumns = [
		{ key: 'key', label: 'Key', mono: true },
		{ key: 'value', label: 'Summary' },
		{ key: 'namespace', label: 'Namespace', mono: true },
		{ key: 'source', label: 'Source', mono: true }
	];

	const autoMemoryRows = $derived(
		Array.isArray(data.autoMemory)
			? data.autoMemory.map((entry: AutoMemoryEntry) => ({
					key: entry.key,
					value: entry.value?.length > 80 ? entry.value.slice(0, 80) + '...' : entry.value,
					namespace: entry.namespace ?? '—',
					source: entry.source ?? '—'
				}))
			: []
	);

	// Memory config extraction
	const memCfg = $derived(data.memoryConfig as Record<string, unknown> | null);
	const learningBridge = $derived(
		(memCfg?.learningBridge as Record<string, unknown>) ?? null
	);
</script>

<div class="space-y-8">
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Memory & Intelligence</h1>
		<p class="text-sm text-text-secondary mt-1">Knowledge graph, ranked context, and memory configuration</p>
	</div>

	<!-- Memory Config Metrics -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-3">Memory Configuration</h2>
		{#if memCfg}
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
				<MetricCard
					label="HNSW Index"
					value={memCfg.enableHNSW ? 'Enabled' : 'Disabled'}
					subtitle="Vector search acceleration"
					accent={memCfg.enableHNSW ? 'green' : 'red'}
				/>
				<MetricCard
					label="SONA Mode"
					value={String(learningBridge?.sonaMode ?? 'N/A')}
					subtitle="Self-optimizing neural arch"
					accent="purple"
				/>
				<MetricCard
					label="Decay Rate"
					value={learningBridge?.confidenceDecayRate != null ? String(learningBridge.confidenceDecayRate) : 'N/A'}
					subtitle="Confidence decay per cycle"
					accent="yellow"
				/>
				<MetricCard
					label="Consolidation"
					value={learningBridge?.consolidationThreshold != null ? String(learningBridge.consolidationThreshold) : 'N/A'}
					subtitle="Memory merge threshold"
					accent="cyan"
				/>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-6 text-center text-text-secondary text-sm">
				No memory configuration available. Check .claude-flow/config.yaml.
			</div>
		{/if}
	</section>

	<!-- Knowledge Graph -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-3">Knowledge Graph</h2>
		{#if graphNodes.length > 0}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<BubbleGraph nodes={graphNodes} />
				<div class="flex items-center gap-6 mt-3 px-2">
					<div class="flex items-center gap-2">
						<span class="w-3 h-3 rounded-full bg-[#3b82f6]"></span>
						<span class="text-xs text-text-secondary">Core</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="w-3 h-3 rounded-full bg-[#a855f7]"></span>
						<span class="text-xs text-text-secondary">Insights</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="w-3 h-3 rounded-full bg-[#22c55e]"></span>
						<span class="text-xs text-text-secondary">Patterns</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="w-3 h-3 rounded-full bg-[#ef4444]"></span>
						<span class="text-xs text-text-secondary">Security</span>
					</div>
				</div>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-6 text-center text-text-secondary text-sm">
				No graph data available. The knowledge graph will populate as memory entries are created.
			</div>
		{/if}
	</section>

	<!-- Ranked Context Table -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-3">Ranked Context</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<DataTable columns={contextColumns} rows={contextRows} />
		</div>
	</section>

	<!-- Auto Memory -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-3">Auto Memory Store</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<DataTable columns={autoMemoryColumns} rows={autoMemoryRows} />
		</div>
	</section>
</div>
