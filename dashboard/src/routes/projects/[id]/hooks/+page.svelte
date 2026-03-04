<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const typeBadgeColors: Record<string, string> = {
		pre: 'bg-accent-blue/20 text-accent-blue',
		post: 'bg-accent-green/20 text-accent-green',
		lifecycle: 'bg-accent-purple/20 text-accent-purple',
		routing: 'bg-accent-yellow/20 text-accent-yellow',
		learning: 'bg-accent-cyan/20 text-accent-cyan'
	};

	const workerStatusColors: Record<string, string> = {
		idle: 'bg-accent-yellow',
		running: 'bg-accent-green',
		disabled: 'bg-bg-tertiary'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Hooks</h1>
			<p class="text-sm text-text-secondary mt-1">Self-learning hooks configured for ai-playground</p>
		</div>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			+ Add Hook
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Active Hooks" value={data.summary.activeHooks} accent="blue" />
		<MetricCard label="Executions" value={data.summary.executions.toLocaleString()} accent="green" />
		<MetricCard label="Patterns Learned" value={data.summary.patternsLearned} accent="purple" />
		<MetricCard label="Success Rate" value={data.summary.successRate} accent="cyan" />
	</div>

	<!-- Hook Registry -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Hook Registry</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.hooks as hook}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm font-mono font-bold text-text-primary w-32">{hook.name}</span>
					<span class="text-[10px] px-2 py-0.5 rounded font-mono {typeBadgeColors[hook.type]}">{hook.type}</span>
					<span class="text-xs text-text-secondary flex-1">{hook.description}</span>
					<span class="text-xs font-mono text-text-secondary w-12 text-right">{hook.executions}</span>
					<span class="text-xs text-text-secondary w-16">{hook.lastRun}</span>
					<div class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full {hook.status === 'active' ? 'bg-accent-green' : 'bg-bg-tertiary'}"></span>
						<span class="text-xs {hook.status === 'active' ? 'text-accent-green' : 'text-text-secondary'}">{hook.status}</span>
					</div>
					<button
						class="w-10 h-5 rounded-full transition-colors {hook.enabled ? 'bg-accent-green' : 'bg-bg-tertiary'}"
					>
						<div class="w-4 h-4 bg-white rounded-full transition-transform {hook.enabled ? 'translate-x-5' : 'translate-x-0.5'}"></div>
					</button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Learning Config + Workers -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Learning Configuration -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Learning Configuration</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				{#each Object.entries(data.learningConfig) as [key, value]}
					<div class="flex items-center justify-between">
						<span class="text-sm text-text-secondary capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
						<span class="text-sm font-mono text-accent-green">{value}</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- Active Workers -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Active Workers</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				{#each data.workers as worker}
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-full {workerStatusColors[worker.status]}"></span>
							<span class="text-sm text-text-primary">{worker.name}</span>
						</div>
						<div class="flex items-center gap-3">
							<span class="text-xs {worker.status === 'running' ? 'text-accent-green' : worker.status === 'idle' ? 'text-accent-yellow' : 'text-text-secondary'}">{worker.status}</span>
							<span class="text-xs font-mono text-text-secondary">{worker.load}</span>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Recent Pattern Detections -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Pattern Detections</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.recentPatterns as item}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-xs font-mono text-text-secondary w-12">{item.time}</span>
					<span class="text-sm text-text-primary flex-1">{item.pattern}</span>
					<span class="text-xs font-mono text-accent-green">{item.score}</span>
					<span class="text-xs {item.status === 'applied' ? 'text-accent-green' : 'text-accent-yellow'}">
						{item.status === 'applied' ? '&#10003;' : '&#9675;'} {item.status}
					</span>
				</div>
			{/each}
		</div>
	</div>
</div>
