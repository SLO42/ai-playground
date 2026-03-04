<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

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
		<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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
				<div class="bg-bg-secondary border border-border rounded-lg px-4 py-3 min-w-[160px]">
					<p class="text-sm font-medium {step.color || 'text-text-primary'}">{step.label}</p>
					<p class="text-xs text-text-secondary mt-0.5">{step.sublabel}</p>
				</div>
				{#if i < routingChain.length - 1}
					<svg class="w-5 h-5 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
					</svg>
				{/if}
			{/each}
		</div>
	</section>

	<!-- Routing Intelligence -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<p class="type-label text-text-secondary mb-3">Routing Intelligence</p>
		<div class="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-2 text-sm">
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
</div>
