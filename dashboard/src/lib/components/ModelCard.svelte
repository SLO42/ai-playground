<script lang="ts">
	interface Props {
		name: string;
		size: string;
		quantization?: string;
		contextWindow?: number;
		cost?: string;
		active?: boolean;
	}

	let { name, size, quantization, contextWindow, cost, active = false }: Props = $props();
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4 {active ? 'ring-1 ring-accent-green' : ''}">
	<div class="flex justify-between items-start">
		<div>
			<h3 class="text-sm font-medium text-text-primary">{name}</h3>
			<p class="text-xs text-text-secondary mt-1 font-mono">{size}</p>
		</div>
		{#if active}
			<span class="inline-flex items-center gap-1 text-xs text-accent-green bg-accent-green/10 px-2 py-0.5 rounded-full">
				<span class="w-1.5 h-1.5 rounded-full bg-accent-green"></span>
				Active
			</span>
		{/if}
	</div>
	<div class="mt-3 flex gap-3 text-xs text-text-secondary">
		{#if quantization}
			<span class="font-mono">{quantization}</span>
		{/if}
		{#if contextWindow}
			<span class="font-mono">{(contextWindow / 1024).toFixed(0)}K ctx</span>
		{/if}
		{#if cost}
			<span class="font-mono">{cost}</span>
		{/if}
	</div>
</div>
