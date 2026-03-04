<script lang="ts">
	import BubbleGraph from '$lib/components/BubbleGraph.svelte';
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

	const graphNodes = $derived.by(() => {
		if (!data.graph?.nodes) return [];
		const entries = data.context?.entries ?? [];
		const nodes = data.graph.nodes;
		const ranks = data.graph.pageRanks;
		return (Object.values(nodes) as GraphNode[]).map((node: GraphNode) => {
			const contextEntry = entries.find((e: { id: string }) => e.id === node.id);
			const label = contextEntry?.summary ?? node.id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
			return { ...node, pageRank: ranks[node.id] ?? 0, label };
		});
	});

	const topContexts = [
		{ key: 'pattern-auth-jwt', score: '0.97', hits: 342 },
		{ key: 'agent-coder-config', score: '0.94', hits: 218 },
		{ key: 'security-scan-results', score: '0.91', hits: 156 },
		{ key: 'routing-model-prefs', score: '0.89', hits: 134 },
		{ key: 'hook-pre-task-config', score: '0.85', hits: 98 },
		{ key: 'session-state-current', score: '0.82', hits: 87 },
		{ key: 'memory-hnsw-params', score: '0.78', hits: 65 },
		{ key: 'swarm-topology-mesh', score: '0.74', hits: 52 }
	];

	const autoMemoryEntries = [
		{ topic: 'Stack Overview', file: 'MEMORY.md', entries: 6, lastUpdated: '3 min ago' },
		{ topic: 'Architecture Decisions', file: 'MEMORY.md', entries: 4, lastUpdated: '1 hr ago' },
		{ topic: 'User Preferences', file: 'MEMORY.md', entries: 5, lastUpdated: '2 hrs ago' },
		{ topic: 'Debugging Patterns', file: 'debugging.md', entries: 12, lastUpdated: 'Yesterday' },
		{ topic: 'Security Findings', file: 'security.md', entries: 8, lastUpdated: '2 days ago' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Memory & Knowledge</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Backend" value="Hybrid" subtitle="HNSW + SQLite" accent="blue" />
		<MetricCard label="Total Nodes" value="1,247" subtitle="across 8 namespaces" accent="cyan" />
		<MetricCard label="Index Size" value="24 MB" subtitle="HNSW vector index" accent="green" />
		<MetricCard label="Hit Rate" value="94.3%" subtitle="cache effectiveness" accent="purple" />
	</div>

	<!-- Memory Graph + Top Contexts -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Memory Graph -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-4">Memory Graph</h2>
			{#if graphNodes.length > 0}
				<BubbleGraph nodes={graphNodes} />
			{:else}
				<div class="h-64 flex items-center justify-center">
					<div class="space-y-8">
						<div class="flex gap-6 justify-center">
							<div class="w-20 h-20 rounded-full border-2 border-accent-purple flex items-center justify-center">
								<span class="text-xs text-accent-purple font-mono">patterns</span>
							</div>
							<div class="w-16 h-16 rounded-full border-2 border-accent-blue flex items-center justify-center">
								<span class="text-xs text-accent-blue font-mono">agents</span>
							</div>
							<div class="w-14 h-14 rounded-full border-2 border-accent-red flex items-center justify-center">
								<span class="text-xs text-accent-red font-mono">security</span>
							</div>
						</div>
						<div class="flex gap-6 justify-center">
							<div class="w-12 h-12 rounded-full border-2 border-accent-cyan flex items-center justify-center">
								<span class="text-[10px] text-accent-cyan font-mono">routing</span>
							</div>
							<div class="w-14 h-14 rounded-full border-2 border-accent-green flex items-center justify-center">
								<span class="text-xs text-accent-green font-mono">sessions</span>
							</div>
							<div class="w-10 h-10 rounded-full border-2 border-accent-yellow flex items-center justify-center">
								<span class="text-[10px] text-accent-yellow font-mono">hooks</span>
							</div>
						</div>
					</div>
				</div>
			{/if}
		</div>

		<!-- Top Contexts by Relevance -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Top Contexts by Relevance</p>
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left py-2 text-text-secondary font-medium">Key</th>
						<th class="text-right py-2 text-text-secondary font-medium">Score</th>
						<th class="text-right py-2 text-text-secondary font-medium">Hits</th>
					</tr>
				</thead>
				<tbody>
					{#each topContexts as ctx}
						<tr class="border-b border-border last:border-0">
							<td class="py-2 text-text-primary">{ctx.key}</td>
							<td class="py-2 text-right font-mono text-accent-green">{ctx.score}</td>
							<td class="py-2 text-right font-mono text-text-primary">{ctx.hits}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Auto-Memory Entries -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Auto-Memory Entries</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Topic</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">File</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Entries</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Last Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each autoMemoryEntries as entry}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 text-text-primary">{entry.topic}</td>
							<td class="px-4 py-3 font-mono text-text-secondary">{entry.file}</td>
							<td class="px-4 py-3 font-mono text-text-primary text-right">{entry.entries}</td>
							<td class="px-4 py-3 text-text-secondary text-right">{entry.lastUpdated}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>
