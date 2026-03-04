<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const capacityPct = $derived(Math.round((data.capacity.current / data.capacity.max) * 100));

	const typeColors: Record<string, string> = {
		coder: 'bg-accent-blue/20 text-accent-blue',
		researcher: 'bg-accent-purple/20 text-accent-purple',
		tester: 'bg-accent-green/20 text-accent-green',
		reviewer: 'bg-accent-cyan/20 text-accent-cyan',
		planner: 'bg-accent-yellow/20 text-accent-yellow',
		security: 'bg-accent-red/20 text-accent-red'
	};

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		idle: 'bg-accent-yellow',
		stopped: 'bg-accent-red'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Agents</h1>
			<p class="text-sm text-text-secondary mt-1">Agents spawned for ai-playground</p>
		</div>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			+ Spawn Agent
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Active" value={data.summary.active} accent="green" />
		<MetricCard label="Idle" value={data.summary.idle} accent="yellow" />
		<MetricCard label="Completed" value={data.summary.completed} accent="blue" />
		<MetricCard label="Failed" value={data.summary.failed} accent="red" />
	</div>

	<!-- Capacity Bar -->
	<div class="flex items-center gap-3">
		<span class="text-xs text-text-secondary uppercase tracking-wider">Capacity</span>
		<span class="text-xs font-mono text-text-primary">{data.capacity.current} / {data.capacity.max} slots</span>
		<div class="flex-1 h-2 bg-bg-tertiary rounded-full overflow-hidden">
			<div
				class="h-full rounded-full transition-all {capacityPct > 80 ? 'bg-accent-red' : capacityPct > 50 ? 'bg-accent-yellow' : 'bg-accent-green'}"
				style="width: {capacityPct}%"
			></div>
		</div>
	</div>

	<!-- Active Agents -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Active Agents</h2>
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			{#each data.agents as agent}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-2">
						<div class="flex items-center gap-2">
							<span class="w-2.5 h-2.5 rounded-full {statusDots[agent.status]}"></span>
							<span class="text-sm font-bold text-text-primary">{agent.name}</span>
						</div>
						<span class="text-[10px] px-2 py-0.5 rounded font-mono {typeColors[agent.type]}">{agent.type}</span>
					</div>
					<p class="text-xs text-text-secondary mb-3">{agent.task}</p>
					<div class="flex items-center gap-6 pt-3 border-t border-border">
						<div>
							<p class="text-[10px] text-text-secondary uppercase">CPU</p>
							<p class="text-sm font-mono text-text-primary">{agent.cpu}</p>
						</div>
						<div>
							<p class="text-[10px] text-text-secondary uppercase">MEM</p>
							<p class="text-sm font-mono text-text-primary">{agent.mem}</p>
						</div>
						<div>
							<p class="text-[10px] text-text-secondary uppercase">Uptime</p>
							<p class="text-sm font-mono text-text-primary">{agent.uptime}</p>
						</div>
						<div class="ml-auto">
							<button class="p-1.5 rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors" title="Stop">
								&#x25A0;
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Recent Completions -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Completions</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.recentCompletions as item}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm font-mono text-text-secondary">{item.name}</span>
					<span class="text-sm text-text-primary flex-1">{item.task}</span>
					<span class="text-xs font-mono text-text-secondary">{item.duration}</span>
					<span class="text-xs text-accent-green">&#10003; {item.result}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
