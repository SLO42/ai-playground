<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let searchQuery = $state('');

	const nsColors: Record<string, string> = {
		patterns: 'border-l-accent-blue',
		decisions: 'border-l-accent-purple',
		context: 'border-l-accent-cyan',
		errors: 'border-l-accent-red',
		dependencies: 'border-l-accent-yellow',
		'user-prefs': 'border-l-accent-green'
	};

	const nsBadgeColors: Record<string, string> = {
		patterns: 'bg-accent-blue/20 text-accent-blue',
		decisions: 'bg-accent-purple/20 text-accent-purple',
		context: 'bg-accent-cyan/20 text-accent-cyan',
		errors: 'bg-accent-red/20 text-accent-red',
		dependencies: 'bg-accent-yellow/20 text-accent-yellow',
		'user-prefs': 'bg-accent-green/20 text-accent-green'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Project Memory</h1>
		<p class="text-sm text-text-secondary mt-1">HNSW-indexed memory nodes for ai-playground</p>
	</div>

	<!-- Search -->
	<div class="flex gap-2">
		<input
			type="text"
			placeholder="Search memory nodes..."
			bind:value={searchQuery}
			class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
		/>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			Search
		</button>
		<button class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors">
			Add Node
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Total Nodes" value={data.summary.totalNodes} accent="blue" />
		<MetricCard label="Namespaces" value={data.summary.namespaces} accent="purple" />
		<MetricCard label="HNSW Index" value={data.summary.hnswIndex} accent="cyan" />
		<MetricCard label="Hit Rate" value={data.summary.hitRate} accent="green" />
	</div>

	<!-- Namespaces -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Namespaces</h2>
		<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
			{#each data.namespaces as ns}
				<div class="bg-bg-secondary border border-border border-l-2 {nsColors[ns.name]} rounded-lg p-3">
					<div class="flex items-center justify-between mb-1">
						<span class="text-sm font-bold text-text-primary">{ns.name}</span>
						<span class="text-sm font-mono text-{ns.color}">{ns.count}</span>
					</div>
					<p class="text-[10px] text-text-secondary">{ns.description}</p>
				</div>
			{/each}
		</div>
	</div>

	<!-- Recent Nodes -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Nodes</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.recentNodes as node}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm font-mono text-accent-cyan">{node.key}</span>
					<span class="text-[10px] px-2 py-0.5 rounded font-mono {nsBadgeColors[node.namespace]}">{node.namespace}</span>
					<span class="text-xs text-text-secondary flex-1 truncate">{node.value}</span>
					<span class="text-xs font-mono text-text-secondary">{node.ttl ?? '&#8734;'}</span>
					<span class="text-xs font-mono text-accent-green">{node.score}</span>
				</div>
			{/each}
		</div>
	</div>

	<!-- HNSW Configuration -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">HNSW Configuration</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-3 md:grid-cols-6 gap-4">
				{#each Object.entries(data.hnswConfig) as [key, value]}
					<div>
						<p class="text-[10px] text-text-secondary uppercase tracking-wider">{key === 'efConstruction' ? 'EF Construction' : key === 'efSearch' ? 'EF Search' : key.charAt(0).toUpperCase() + key.slice(1)}</p>
						<p class="text-sm font-mono font-bold text-text-primary">{value}</p>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
