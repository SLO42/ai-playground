<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let loaded = $derived(data != null);

	const TOTAL_VRAM_GB = 24;

	function getVramUsedGb(): number {
		if (!data.runningModels || data.runningModels.length === 0) return 18.2;
		return data.runningModels.reduce((sum, m) => sum + m.size_vram, 0) / (1024 * 1024 * 1024);
	}

	const models = [
		{
			name: 'GPT-OSS 20B',
			type: 'Local MoE',
			status: 'Running',
			statusColor: 'text-accent-green',
			vram: '14.2 GB',
			tier: 'Tier 1',
			tierColor: 'text-accent-cyan',
			latency: '<1ms',
			cost: '$0'
		},
		{
			name: 'Claude Sonnet 4.6',
			type: 'API',
			status: 'Available',
			statusColor: 'text-accent-green',
			vram: '\u2014',
			tier: 'Tier 3',
			tierColor: 'text-accent-purple',
			latency: '2-5s',
			cost: '$0.003'
		},
		{
			name: 'Claude Haiku 4.5',
			type: 'API',
			status: 'Standby',
			statusColor: 'text-accent-yellow',
			vram: '\u2014',
			tier: 'Tier 2',
			tierColor: 'text-accent-yellow',
			latency: '~500ms',
			cost: '$0.0002'
		}
	];

	const routingChain = [
		{ label: 'Input', sublabel: 'User message', color: '' },
		{ label: 'Router', sublabel: 'Keyword + semantic match', color: 'text-accent-cyan' },
		{ label: 'Ollama / GPT-OSS', sublabel: 'Local MoE (3.6B active)', color: 'text-accent-green' },
		{ label: 'Escalation?', sublabel: 'Complexity > 30%', color: 'text-accent-yellow' },
		{ label: 'Claude API', sublabel: 'Sonnet / Haiku fallback', color: 'text-accent-purple' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Model Routing</h1>

	{#if loaded}
		<!-- Active VRAM -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4 max-w-md">
			<p class="type-label text-text-secondary mb-2">Active VRAM</p>
			<div class="flex items-baseline gap-2 mb-2">
				<span class="type-mono-value text-accent-yellow">{getVramUsedGb().toFixed(1)}</span>
				<span class="text-sm text-text-secondary">/ {TOTAL_VRAM_GB} GB</span>
			</div>
			<div class="h-3 bg-bg-primary rounded-full overflow-hidden">
				<div
					class="h-full rounded-full bg-accent-yellow transition-all"
					style="width: {(getVramUsedGb() / TOTAL_VRAM_GB) * 100}%"
				></div>
			</div>
		</div>

		<!-- Available Models -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Available Models</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each models as model}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-2 mb-1">
							<span class="w-2 h-2 rounded-full {model.status === 'Running' ? 'bg-accent-green' : model.status === 'Available' ? 'bg-accent-blue' : 'bg-accent-yellow'}"></span>
							<span class="type-card-title text-text-primary">{model.name}</span>
						</div>
						<p class="text-xs text-text-secondary mb-3">{model.type}</p>
						<div class="space-y-2 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Status</span>
								<span class="font-mono {model.statusColor}">{model.status}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">VRAM</span>
								<span class="font-mono text-text-primary">{model.vram}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Tier</span>
								<span class="font-mono {model.tierColor}">{model.tier}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Latency</span>
								<span class="font-mono text-text-primary">{model.latency}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Cost/req</span>
								<span class="font-mono text-accent-green">{model.cost}</span>
							</div>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- Routing Chain -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Routing Chain</h2>
			<div class="flex flex-wrap items-center gap-3">
				{#each routingChain as step, i}
					<div class="bg-bg-secondary border border-border rounded-lg px-4 py-3 min-w-[140px] sm:min-w-[160px]">
						<p class="text-sm font-medium {step.color || 'text-text-primary'}">{step.label}</p>
						<p class="text-xs text-text-secondary mt-0.5">{step.sublabel}</p>
					</div>
					{#if i < routingChain.length - 1}
						<svg class="w-5 h-5 text-text-secondary flex-shrink-0 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					{/if}
				{/each}
			</div>
		</section>

		<!-- Routing Intelligence -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Routing Intelligence</p>
			<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-2 text-sm">
				<div>
					<span class="text-text-secondary">Requests today: </span>
					<span class="font-mono text-text-primary">1,247</span>
				</div>
				<div>
					<span class="text-text-secondary">Avg latency: </span>
					<span class="font-mono text-text-primary">12ms</span>
				</div>
				<div>
					<span class="text-accent-green">Local handled: 94.3%</span>
				</div>
				<div>
					<span class="text-accent-green">Cost saved: $4.82</span>
				</div>
				<div>
					<span class="text-accent-yellow">API escalations: 5.7%</span>
				</div>
				<div>
					<span class="text-accent-purple">Pattern matches: 847</span>
				</div>
			</div>
		</div>
		<!-- Token Cost Breakdown -->
		{#if data.efficiencyByModel && data.efficiencyByModel.length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-4">Token Cost Breakdown</h2>
				<div class="bg-bg-secondary border border-border rounded-lg overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="border-b border-border text-text-secondary text-left">
								<th class="px-4 py-3">Model</th>
								<th class="px-4 py-3 text-right">Tasks</th>
								<th class="px-4 py-3 text-right">Input Tokens</th>
								<th class="px-4 py-3 text-right">Output Tokens</th>
								<th class="px-4 py-3 text-right">Total Cost</th>
								<th class="px-4 py-3 text-right">Avg Cost/Task</th>
							</tr>
						</thead>
						<tbody>
							{#each data.efficiencyByModel as model}
								<tr class="border-b border-border last:border-0">
									<td class="px-4 py-3 text-text-primary">{model.name}</td>
									<td class="px-4 py-3 text-right font-mono text-text-primary">{model.count.toLocaleString()}</td>
									<td class="px-4 py-3 text-right font-mono text-text-secondary">{model.inputTokens.toLocaleString()}</td>
									<td class="px-4 py-3 text-right font-mono text-text-secondary">{model.outputTokens.toLocaleString()}</td>
									<td class="px-4 py-3 text-right font-mono text-accent-green">${model.totalCost.toFixed(4)}</td>
									<td class="px-4 py-3 text-right font-mono text-accent-yellow">${model.avgCostPerTask.toFixed(4)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		<!-- Efficiency Ratios -->
		{#if data.efficiencyByModel && data.efficiencyByModel.length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-4">Efficiency Ratios</h2>
				<p class="text-xs text-text-secondary mb-3">Output tokens / Input tokens -- higher ratio means more output per input token</p>
				<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{#each data.efficiencyByModel as model}
						{@const maxRatio = Math.max(...data.efficiencyByModel.map((m) => m.efficiencyRatio), 1)}
						{@const barPct = maxRatio > 0 ? (model.efficiencyRatio / maxRatio) * 100 : 0}
						<div class="bg-bg-secondary border border-border rounded-lg p-4">
							<p class="text-sm font-medium text-text-primary mb-1">{model.name}</p>
							<p class="font-mono text-lg text-accent-cyan mb-2">{model.efficiencyRatio.toFixed(3)}</p>
							<div class="h-2 bg-bg-primary rounded-full overflow-hidden">
								<div
									class="h-full rounded-full bg-accent-cyan transition-all"
									style="width: {barPct}%"
								></div>
							</div>
							<p class="text-xs text-text-secondary mt-2">{model.count} task{model.count !== 1 ? 's' : ''} completed</p>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Most Expensive Tasks -->
		{#if data.topExpensiveTasks && data.topExpensiveTasks.length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-4">Most Expensive Tasks</h2>
				<div class="bg-bg-secondary border border-border rounded-lg divide-y divide-border">
					{#each data.topExpensiveTasks as task, i}
						<div class="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
							<span class="text-xs font-mono text-text-secondary w-6 shrink-0">#{i + 1}</span>
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate">{task.taskTitle || task.taskId}</p>
								<p class="text-xs text-text-secondary">{task.model}</p>
							</div>
							<div class="flex items-center gap-4 text-xs shrink-0">
								<span class="font-mono text-accent-green">${task.costUsd.toFixed(4)}</span>
								<span class="font-mono text-text-secondary">{(task.durationMs / 1000).toFixed(1)}s</span>
								<span class="font-mono text-text-secondary">{(task.inputTokens + task.outputTokens).toLocaleString()} tok</span>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Daily Cost Trend -->
		{#if data.dailyCostTrend && data.dailyCostTrend.length > 0}
			{@const maxDailyCost = Math.max(...data.dailyCostTrend.map((d) => d.cost), 0.0001)}
			<section>
				<h2 class="type-section-title text-text-primary mb-4">Daily Cost Trend (Last 7 Days)</h2>
				<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
					{#each data.dailyCostTrend as day}
						{@const barPct = maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0}
						<div class="flex items-center gap-3">
							<span class="text-xs font-mono text-text-secondary w-20 shrink-0">{day.date.slice(5)}</span>
							<div class="flex-1 h-4 bg-bg-primary rounded-full overflow-hidden">
								<div
									class="h-full rounded-full bg-accent-purple transition-all"
									style="width: {barPct}%"
								></div>
							</div>
							<span class="text-xs font-mono text-accent-green w-16 text-right shrink-0">${day.cost.toFixed(4)}</span>
							<span class="text-xs text-text-secondary w-14 text-right shrink-0">{day.tasks} task{day.tasks !== 1 ? 's' : ''}</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

	{:else}
		<!-- Loading skeletons -->
		<Skeleton variant="card" lines={3} />
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(3) as _}
				<Skeleton variant="card" lines={5} />
			{/each}
		</div>
		<Skeleton variant="card" lines={2} />
	{/if}
</div>
