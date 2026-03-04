<script lang="ts">
	interface Props {
		usedGb: number;
		totalGb: number;
		modelName?: string;
	}

	let { usedGb, totalGb, modelName }: Props = $props();

	let pct = $derived(totalGb > 0 ? Math.round((usedGb / totalGb) * 100) : 0);
	let barColor = $derived(pct > 90 ? 'bg-accent-red' : pct > 70 ? 'bg-accent-yellow' : 'bg-accent-green');
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	<div class="flex justify-between items-center mb-2">
		<span class="text-xs text-text-secondary uppercase tracking-wider">VRAM Usage</span>
		<span class="text-xs font-mono text-text-primary">{usedGb.toFixed(1)} / {totalGb} GB</span>
	</div>
	<div class="h-3 bg-bg-primary rounded-full overflow-hidden">
		<div class="h-full {barColor} rounded-full transition-all" style="width: {pct}%"></div>
	</div>
	{#if modelName}
		<p class="text-xs text-text-secondary mt-2 font-mono">{modelName}</p>
	{/if}
</div>
