<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const vramPct = $derived(Math.round((data.summary.vramUsed / data.summary.vramTotal) * 100));

	const statusColors: Record<string, string> = {
		loaded: 'bg-accent-green',
		available: 'bg-accent-yellow',
		error: 'bg-accent-red'
	};

	const tierColors: Record<string, string> = {
		Primary: 'bg-accent-green/20 text-accent-green',
		Escalation: 'bg-accent-blue/20 text-accent-blue',
		Fallback: 'bg-accent-yellow/20 text-accent-yellow'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Project Models</h1>
		<p class="text-sm text-text-secondary mt-1">Model routing and VRAM usage for this project</p>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Models" value={data.summary.total} accent="blue" />
		<MetricCard label="Active" value={data.summary.active} accent="green" />
		<MetricCard label="VRAM Used" value="{data.summary.vramUsed} GB" accent="purple" />
		<MetricCard label="VRAM Total" value="{data.summary.vramTotal} GB" accent="cyan" />
	</div>

	<!-- VRAM Gauge -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-2">
			<span class="text-xs text-text-secondary uppercase tracking-wider">VRAM Usage</span>
			<span class="text-sm font-mono text-text-primary">{data.summary.vramUsed} / {data.summary.vramTotal} GB ({vramPct}%)</span>
		</div>
		<div class="h-3 bg-bg-tertiary rounded-full overflow-hidden">
			<div
				class="h-full rounded-full transition-all {vramPct > 90 ? 'bg-accent-red' : vramPct > 70 ? 'bg-accent-yellow' : 'bg-accent-green'}"
				style="width: {vramPct}%"
			></div>
		</div>
	</div>

	<!-- Routing Chain -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Routing Chain</h2>
		<div class="flex items-center gap-2">
			{#each data.routingChain as model, i}
				<div class="flex-1 bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-bold text-text-primary">{model.name}</span>
						<span class="text-[10px] px-2 py-0.5 rounded {tierColors[model.tier]}">{model.tier}</span>
					</div>
					<div class="space-y-1 text-xs">
						<div class="flex justify-between">
							<span class="text-text-secondary">Provider</span>
							<span class="text-text-primary">{model.provider}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Latency</span>
							<span class="font-mono text-text-primary">{model.latency}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Cost</span>
							<span class="font-mono text-accent-green">{model.cost}</span>
						</div>
					</div>
				</div>
				{#if i < data.routingChain.length - 1}
					<span class="text-text-secondary text-lg">→</span>
				{/if}
			{/each}
		</div>
	</div>

	<!-- Model List -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Available Models</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-left">
				<thead>
					<tr class="border-b border-border text-xs text-text-secondary uppercase">
						<th class="px-4 py-2 font-medium">Model</th>
						<th class="px-4 py-2 font-medium">Size</th>
						<th class="px-4 py-2 font-medium">Quant</th>
						<th class="px-4 py-2 font-medium">Params</th>
						<th class="px-4 py-2 font-medium text-right">Context</th>
						<th class="px-4 py-2 font-medium">Status</th>
						<th class="px-4 py-2 font-medium text-right">Tokens/s</th>
					</tr>
				</thead>
				<tbody>
					{#each data.models as model}
						<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
							<td class="px-4 py-3 text-sm font-mono text-text-primary whitespace-nowrap">{model.name}</td>
							<td class="px-4 py-3 text-sm text-text-secondary">{model.size}</td>
							<td class="px-4 py-3 text-xs font-mono text-text-secondary">{model.quantization}</td>
							<td class="px-4 py-3 text-sm text-text-secondary">{model.params}</td>
							<td class="px-4 py-3 text-sm font-mono text-text-secondary text-right">{model.context.toLocaleString()}</td>
							<td class="px-4 py-3">
								<div class="flex items-center gap-1.5">
									<span class="w-2 h-2 rounded-full {statusColors[model.status]}"></span>
									<span class="text-xs text-text-secondary">{model.status}</span>
								</div>
							</td>
							<td class="px-4 py-3 text-sm font-mono text-text-primary text-right">{model.tokensPerSec > 0 ? model.tokensPerSec : '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Routing Intelligence -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Routing Intelligence</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Accuracy</p>
					<p class="text-lg font-mono font-bold text-accent-green">{data.routingIntelligence.accuracy}%</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Local Handled</p>
					<p class="text-lg font-mono font-bold text-text-primary">{data.routingIntelligence.localHandled}%</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Escalated</p>
					<p class="text-lg font-mono font-bold text-accent-blue">{data.routingIntelligence.escalated}%</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Fallback</p>
					<p class="text-lg font-mono font-bold text-accent-yellow">{data.routingIntelligence.fallback}%</p>
				</div>
			</div>
		</div>
	</div>
</div>
