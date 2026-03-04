<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let hooks = $derived(data.hooks);
	let workers = $derived(data.workers);
	let learning = $derived(data.learning);

	const hookRegistry = [
		{ hook: 'pre-task', phase: 'Before task', status: 'Active', executions: '1,247', avgTime: '2ms' },
		{ hook: 'post-task', phase: 'After task', status: 'Active', executions: '1,198', avgTime: '5ms' },
		{ hook: 'pre-edit', phase: 'Before edit', status: 'Active', executions: '892', avgTime: '1ms' },
		{ hook: 'post-edit', phase: 'After edit', status: 'Active', executions: '876', avgTime: '3ms' },
		{ hook: 'session-start', phase: 'Session init', status: 'Active', executions: '48', avgTime: '12ms' },
		{ hook: 'session-end', phase: 'Session close', status: 'Active', executions: '47', avgTime: '8ms' },
		{ hook: 'intelligence', phase: 'Learning', status: 'Active', executions: '2,341', avgTime: '15ms' },
		{ hook: 'model-route', phase: 'Model select', status: 'Active', executions: '1,247', avgTime: '1ms' }
	];

	const workerActivity = [
		{ name: 'worker-detect', percent: 78, color: 'bg-accent-blue' },
		{ name: 'worker-dispatch', percent: 65, color: 'bg-accent-green' },
		{ name: 'worker-cancel', percent: 12, color: 'bg-accent-yellow' },
		{ name: 'model-route', percent: 85, color: 'bg-accent-purple' },
		{ name: 'model-outcome', percent: 45, color: 'bg-accent-cyan' },
		{ name: 'model-stats', percent: 32, color: 'bg-accent-red' }
	];

	const learningConfig = [
		{ label: 'Algorithm', value: 'EWC++ (prevent forgetting)' },
		{ label: 'Trajectories', value: '234 recorded' },
		{ label: 'Verdicts', value: '1,892 judgments' },
		{ label: 'Pattern Bank', value: '847 patterns' },
		{ label: 'Graph Edges', value: '456 causal links' },
		{ label: 'Auto-Train', value: 'Enabled (hourly)' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Hooks & Self-Learning</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Total Hooks" value="17" subtitle="across all phases" accent="blue" />
		<MetricCard label="Active Workers" value="12" subtitle="processing events" accent="green" />
		<MetricCard label="Patterns Learned" value="847" subtitle="from trajectories" accent="purple" />
		<MetricCard label="Accuracy" value="95.2%" subtitle="verdict success rate" accent="cyan" />
	</div>

	<!-- Hook Registry -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Hook Registry</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Hook</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Phase</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Status</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Executions</th>
						<th class="text-right px-4 py-3 text-text-secondary font-medium">Avg Time</th>
					</tr>
				</thead>
				<tbody>
					{#each hookRegistry as h}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 font-mono text-text-primary">{h.hook}</td>
							<td class="px-4 py-3 text-text-secondary">{h.phase}</td>
							<td class="px-4 py-3 text-accent-green">{h.status}</td>
							<td class="px-4 py-3 font-mono text-text-primary text-right">{h.executions}</td>
							<td class="px-4 py-3 font-mono text-text-secondary text-right">{h.avgTime}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<!-- Worker Activity + Learning Config -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Worker Activity -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="type-section-title text-text-primary mb-4">Worker Activity</h2>
			<div class="space-y-3">
				{#each workerActivity as worker}
					<div class="flex items-center gap-3">
						<span class="text-xs font-mono text-text-secondary w-36 flex-shrink-0">{worker.name}</span>
						<div class="flex-1 h-3 bg-bg-primary rounded-full overflow-hidden">
							<div class="h-full {worker.color} rounded-full transition-all" style="width: {worker.percent}%"></div>
						</div>
						<span class="text-xs font-mono text-text-primary w-10 text-right">{worker.percent}%</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- Learning Configuration -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Learning Configuration</p>
			<div class="space-y-2">
				{#each learningConfig as item}
					<div class="flex justify-between text-sm">
						<span class="text-text-secondary">{item.label}</span>
						<span class="font-mono text-text-primary">{item.value}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
