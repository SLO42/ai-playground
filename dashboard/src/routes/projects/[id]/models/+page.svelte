<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const tierColors: Record<string, string> = {
		Primary: 'bg-accent-green/20 text-accent-green',
		Escalation: 'bg-accent-blue/20 text-accent-blue',
		Fallback: 'bg-accent-yellow/20 text-accent-yellow'
	};

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		standby: 'bg-accent-yellow',
		unavailable: 'bg-accent-red'
	};

	const strategyLabels: Record<string, string> = {
		cascade: 'Cascade (primary then fallbacks)',
		'round-robin': 'Round Robin',
		'complexity-based': 'Complexity-Based Routing',
		default: 'Default (cascade)'
	};

	function formatTokens(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return String(n);
	}

	function formatCost(n: number): string {
		if (n === 0) return '$0.00';
		if (n < 0.01) return `$${n.toFixed(4)}`;
		return `$${n.toFixed(2)}`;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="type-page-title text-text-primary">Project Models</h1>
		<p class="text-xs text-text-secondary mt-0.5">
			Model routing configuration and usage stats for this project
		</p>
	</div>

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard
			label="Strategy"
			value={data.strategy}
			subtitle={data.hasOverrides ? 'project override' : 'global default'}
			accent="blue"
		/>
		<MetricCard
			label="Requests"
			value={data.totalRequests}
			subtitle="routed for this project"
			accent="green"
		/>
		<MetricCard
			label="Tokens"
			value={formatTokens(data.totalTokens)}
			subtitle="total consumed"
			accent="cyan"
		/>
		<MetricCard
			label="Cost"
			value={formatCost(data.totalCost)}
			subtitle="estimated spend"
			accent="purple"
		/>
	</div>

	<!-- Override Badge -->
	{#if data.hasOverrides}
		<div class="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent-blue/10 border border-accent-blue/20">
			<svg class="w-4 h-4 text-accent-blue shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.384 3.174a1 1 0 01-1.452-1.054l1.029-5.993a1 1 0 00-.287-.958L.878 5.963a1 1 0 01.555-1.705l6.02-.875a1 1 0 00.753-.518L11.02.573a1 1 0 011.96 0l2.814 5.29a1 1 0 00.753.52l6.02.874a1 1 0 01.555 1.705l-4.357 4.247a1 1 0 00-.287.958l1.03 5.993a1 1 0 01-1.453 1.054L12.58 15.17a1 1 0 00-.93 0z" />
			</svg>
			<div>
				<p class="text-sm font-medium text-accent-blue">Project-level model overrides active</p>
				<p class="text-xs text-text-secondary mt-0.5">
					This project uses custom routing instead of global defaults.
					{#if data.overrides.primary}
						Primary: <span class="font-mono text-text-primary">{data.overrides.primary}</span>
					{/if}
				</p>
			</div>
		</div>
	{/if}

	<!-- Routing Chain -->
	{#if data.routingChain.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Routing Chain</h2>
			<div class="flex items-stretch gap-2 overflow-x-auto">
				{#each data.routingChain as model, i}
					<div class="flex-1 min-w-[180px] bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-2">
							<span class="text-sm font-bold text-text-primary truncate">{model.name}</span>
							<span class="text-[10px] px-2 py-0.5 rounded shrink-0 {tierColors[model.tier]}">{model.tier}</span>
						</div>
						<div class="space-y-1 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Provider</span>
								<span class="text-text-primary">{model.provider}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Status</span>
								<div class="flex items-center gap-1.5">
									<span class="w-2 h-2 rounded-full {statusDots[model.status]}"></span>
									<span class="text-text-primary">{model.status}</span>
								</div>
							</div>
						</div>
					</div>
					{#if i < data.routingChain.length - 1}
						<div class="flex items-center">
							<span class="text-text-secondary text-lg">&#8594;</span>
						</div>
					{/if}
				{/each}
			</div>
		</div>
	{:else}
		<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
			<svg class="w-10 h-10 text-text-secondary/40 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
			</svg>
			<h3 class="text-sm font-medium text-text-primary mb-1">No model config found</h3>
			<p class="text-xs text-text-secondary">
				Add a <span class="font-mono">models.json5</span> config or set model preferences in the project settings.
			</p>
		</div>
	{/if}

	<!-- Strategy Info -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Routing Strategy</h2>
		<div class="grid grid-cols-2 md:grid-cols-3 gap-4">
			<div>
				<p class="text-xs text-text-secondary mb-1">Mode</p>
				<p class="text-sm font-medium text-text-primary">{strategyLabels[data.strategy] ?? data.strategy}</p>
			</div>
			<div>
				<p class="text-xs text-text-secondary mb-1">Accuracy</p>
				<p class="text-lg font-mono font-bold text-accent-green">{data.routingAccuracy}%</p>
			</div>
			<div>
				<p class="text-xs text-text-secondary mb-1">Source</p>
				<p class="text-sm font-medium {data.hasOverrides ? 'text-accent-blue' : 'text-text-secondary'}">
					{data.hasOverrides ? 'Project Override' : 'Global Config'}
				</p>
			</div>
		</div>
	</div>

	<!-- Usage by Model -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Usage by Model</h2>
		{#if data.usageByModel.length === 0}
			<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
				<p class="text-sm text-text-secondary">No usage data recorded for this project yet.</p>
				<p class="text-xs text-text-secondary mt-1">Usage stats appear as agents work on this project.</p>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				<table class="w-full text-left">
					<thead>
						<tr class="border-b border-border text-xs text-text-secondary uppercase">
							<th class="px-4 py-2 font-medium">Model</th>
							<th class="px-4 py-2 font-medium text-right">Requests</th>
							<th class="px-4 py-2 font-medium text-right">Tokens</th>
							<th class="px-4 py-2 font-medium text-right">Cost</th>
							<th class="px-4 py-2 font-medium text-right">Avg Duration</th>
						</tr>
					</thead>
					<tbody>
						{#each data.usageByModel as stat}
							<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
								<td class="px-4 py-3 text-sm font-mono text-text-primary">{stat.model}</td>
								<td class="px-4 py-3 text-sm font-mono text-text-primary text-right">{stat.count}</td>
								<td class="px-4 py-3 text-sm font-mono text-text-secondary text-right">{formatTokens(stat.totalTokens)}</td>
								<td class="px-4 py-3 text-sm font-mono text-accent-green text-right">{formatCost(stat.costUsd)}</td>
								<td class="px-4 py-3 text-sm font-mono text-text-secondary text-right">{(stat.avgDurationMs / 1000).toFixed(1)}s</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
