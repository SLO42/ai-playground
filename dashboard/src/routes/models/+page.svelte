<script lang="ts">
	import ModelCard from '$lib/components/ModelCard.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import GaugeChart from '$lib/components/GaugeChart.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const TOTAL_VRAM_GB = 24;

	function formatBytes(bytes: number): string {
		const gb = bytes / (1024 * 1024 * 1024);
		return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	}

	function getVramUsedGb(): number {
		if (!data.runningModels || data.runningModels.length === 0) return 0;
		return data.runningModels.reduce((sum, m) => sum + m.size_vram, 0) / (1024 * 1024 * 1024);
	}

	function getActiveModelName(): string | undefined {
		if (!data.runningModels || data.runningModels.length === 0) return undefined;
		return data.runningModels.map((m) => m.name).join(', ');
	}

	function getActiveModelNames(): Set<string> {
		if (!data.runningModels) return new Set();
		return new Set(data.runningModels.map((m) => m.name));
	}

	const routingChain = [
		{ name: 'GPT-OSS 20B', cost: '$0', latency: '<50ms', tier: 'Primary', color: 'accent-green' },
		{ name: 'Claude Sonnet 4.6', cost: '~$0.003', latency: '2-5s', tier: 'Escalation', color: 'accent-blue' },
		{ name: 'Claude Haiku 4.5', cost: '~$0.0002', latency: '~500ms', tier: 'Fallback', color: 'accent-purple' }
	];

	function getLearningValue(key: string): number | string {
		if (!data.learning || typeof data.learning !== 'object') return 0;
		const val = (data.learning as Record<string, unknown>)[key];
		return typeof val === 'number' || typeof val === 'string' ? val : 0;
	}
</script>

<div class="space-y-8">
	<!-- Page Header -->
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Models</h1>
		<p class="text-sm text-text-secondary mt-1">Model registry, routing chain, and inference intelligence</p>
	</div>

	<!-- Model Registry -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-4">Model Registry</h2>
		{#if data.ollamaModels && data.ollamaModels.length > 0}
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each data.ollamaModels as model}
					<ModelCard
						name={model.name}
						size={formatBytes(model.size)}
						quantization={model.details?.quantization_level}
						contextWindow={data.modelsConfig?.models?.providers?.ollama?.models?.find(
							(m) => model.name.startsWith(m.id.split(':')[0])
						)?.contextWindow}
						cost="$0 (local)"
						active={getActiveModelNames().has(model.name)}
					/>
				{/each}
			</div>
		{:else}
			<p class="text-sm text-text-secondary">No Ollama models found. Is Ollama running?</p>
		{/if}

		<!-- Config-defined models (Anthropic etc.) -->
		{#if data.modelsConfig?.models?.providers}
			{@const providers = data.modelsConfig.models.providers}
			{#each Object.entries(providers) as [providerKey, provider]}
				{#if providerKey !== 'ollama' && provider.models}
					<div class="mt-4">
						<h3 class="text-sm font-medium text-text-secondary mb-3 uppercase tracking-wider">{providerKey}</h3>
						<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
							{#each provider.models as model}
								<ModelCard
									name={model.name}
									size={model.contextWindow ? `${(model.contextWindow / 1024).toFixed(0)}K ctx` : 'API'}
									quantization={model.reasoning ? 'Reasoning' : 'Standard'}
									cost={model.cost ? `$${model.cost.input}/M in` : 'API pricing'}
								/>
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		{/if}
	</section>

	<!-- Active Model -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-4">Active Model</h2>
		{#if data.runningModels && data.runningModels.length > 0}
			<div class="max-w-md">
				<VramGauge
					usedGb={getVramUsedGb()}
					totalGb={TOTAL_VRAM_GB}
					modelName={getActiveModelName()}
				/>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-sm text-text-secondary">No models currently loaded in VRAM</p>
			</div>
		{/if}
	</section>

	<!-- Routing Chain -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-4">Routing Chain</h2>
		<div class="flex flex-wrap items-center gap-3">
			{#each routingChain as step, i}
				<div class="bg-bg-secondary border border-border rounded-lg p-4 min-w-[180px]">
					<div class="flex items-center gap-2 mb-2">
						<span class="w-2 h-2 rounded-full bg-{step.color}"></span>
						<span class="text-sm font-medium text-text-primary">{step.name}</span>
					</div>
					<div class="space-y-1 text-xs text-text-secondary">
						<p>Cost: <span class="font-mono text-text-primary">{step.cost}</span></p>
						<p>Latency: <span class="font-mono text-text-primary">{step.latency}</span></p>
						<p class="text-{step.color} font-medium">{step.tier}</p>
					</div>
				</div>
				{#if i < routingChain.length - 1}
					<svg class="w-6 h-6 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
					</svg>
				{/if}
			{/each}
		</div>
	</section>

	<!-- Routing Intelligence -->
	<section>
		<h2 class="text-lg font-semibold text-text-primary mb-4">Routing Intelligence</h2>
		{#if data.learning}
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
				<div class="flex justify-center">
					<GaugeChart
						value={Number(getLearningValue('routingAccuracy')) || 0}
						max={100}
						label="Routing Accuracy"
						color="#3b82f6"
					/>
				</div>
				<MetricCard
					label="Decisions"
					value={getLearningValue('totalDecisions') || 0}
					subtitle="Total routing decisions"
					accent="cyan"
				/>
				<MetricCard
					label="Pattern Quality"
					value={getLearningValue('patternQuality') || '—'}
					subtitle="Learned routing patterns"
					accent="purple"
				/>
				<MetricCard
					label="Avg Latency"
					value={getLearningValue('avgLatencyMs') ? `${getLearningValue('avgLatencyMs')}ms` : '—'}
					subtitle="Mean routing time"
					accent="green"
				/>
			</div>
		{:else}
			<p class="text-sm text-text-secondary">No routing intelligence data available yet</p>
		{/if}
	</section>
</div>
