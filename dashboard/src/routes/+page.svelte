<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let v3 = $derived(data.v3Progress);
	let learn = $derived(data.learning);
	let swarm = $derived(data.swarmActivity);
	let models = $derived(data.runningModels);

	let totalAgents = 99;
	let memoryNodes = $derived(v3?.learning?.patternsLearned ?? 1247);
	let activeHooks = 17;
	let uptime = '99.7%';

	let runningModel = $derived(models?.[0]);
	let vramUsedGb = $derived(runningModel ? runningModel.size_vram / (1024 ** 3) : 18.2);
	const totalVramGb = 24;

	let patternsLearned = $derived(v3?.learning?.patternsLearned ?? learn?.patterns?.shortTerm ?? 847);

	const migrationProgress = [
		{ label: 'Core Modules', percent: 85, color: 'bg-accent-blue' },
		{ label: 'Security', percent: 72, color: 'bg-accent-green' },
		{ label: 'Memory Unification', percent: 60, color: 'bg-accent-purple' },
		{ label: 'MCP Optimization', percent: 45, color: 'bg-accent-cyan' }
	];

	const topMemoryNodes = [
		{ key: 'pattern-auth-jwt', namespace: 'patterns', hits: 342, lastAccess: '2 min ago' },
		{ key: 'agent-coder-config', namespace: 'agents', hits: 218, lastAccess: '5 min ago' },
		{ key: 'security-scan-latest', namespace: 'security', hits: 156, lastAccess: '12 min ago' },
		{ key: 'routing-model-prefs', namespace: 'routing', hits: 134, lastAccess: '1 min ago' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Dashboard Overview</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Total Agents" value={totalAgents} subtitle="42 active now" accent="blue" />
		<MetricCard label="Memory Nodes" value={memoryNodes.toLocaleString()} subtitle="HNSW indexed" accent="cyan" />
		<MetricCard label="Active Hooks" value={activeHooks} subtitle="3 learning" accent="green" />
		<MetricCard label="Uptime" value={uptime} subtitle="Since last restart" accent="purple" />
	</div>

	<!-- V3 Migration Progress -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">V3 Migration Progress</h2>
		<div class="space-y-4">
			{#each migrationProgress as item}
				<div class="flex items-center gap-4">
					<span class="text-sm text-text-secondary w-40 flex-shrink-0">{item.label}</span>
					<div class="flex-1 h-3 bg-bg-secondary rounded-full overflow-hidden border border-border">
						<div class="h-full {item.color} rounded-full transition-all" style="width: {item.percent}%"></div>
					</div>
					<span class="text-sm font-mono text-text-primary w-12 text-right">{item.percent}%</span>
				</div>
			{/each}
		</div>
	</section>

	<!-- VRAM + Learning -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- VRAM Usage -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-2">VRAM Usage</p>
			<div class="flex items-baseline gap-2 mb-1">
				<span class="type-mono-value text-accent-yellow">{vramUsedGb.toFixed(1)} GB</span>
				<span class="text-sm text-text-secondary">/ {totalVramGb} GB</span>
			</div>
			<div class="h-3 bg-bg-primary rounded-full overflow-hidden mb-3">
				<div
					class="h-full rounded-full transition-all {vramUsedGb / totalVramGb > 0.8 ? 'bg-accent-yellow' : 'bg-accent-green'}"
					style="width: {(vramUsedGb / totalVramGb) * 100}%"
				></div>
			</div>
			<div class="space-y-1 text-xs text-text-secondary font-mono">
				<p>GPT-OSS 20B: 14.2 GB</p>
				<p>KV Cache: 2.8 GB</p>
				<p>System: 1.2 GB</p>
			</div>
		</div>

		<!-- Learning Intelligence -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-2">Learning Intelligence</p>
			<div class="flex items-baseline gap-2 mb-1">
				<span class="type-mono-value text-accent-purple">{patternsLearned}</span>
				<span class="text-sm text-text-secondary">patterns</span>
			</div>
			<div class="h-3 bg-bg-primary rounded-full overflow-hidden mb-3">
				<div class="h-full bg-accent-purple rounded-full" style="width: 72%"></div>
			</div>
			<div class="space-y-1 text-xs text-text-secondary font-mono">
				<p>Trajectories: 234</p>
				<p>Verdicts: 1,892</p>
				<p>Graph edges: 456</p>
			</div>
		</div>
	</div>

	<!-- Top Memory Nodes -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Top Memory Nodes</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Key</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Namespace</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Hits</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Last Access</th>
					</tr>
				</thead>
				<tbody>
					{#each topMemoryNodes as node}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 font-mono text-text-primary">{node.key}</td>
							<td class="px-4 py-3 font-mono text-text-secondary">{node.namespace}</td>
							<td class="px-4 py-3 font-mono text-text-primary text-right">{node.hits}</td>
							<td class="px-4 py-3 text-text-secondary text-right">{node.lastAccess}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>
