<script lang="ts">
	interface Props {
		label: string;
		value: string | number;
		subtitle?: string;
		accent?: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'cyan';
	}

	let { label, value, subtitle, accent = 'blue' }: Props = $props();

	const accentColors: Record<string, string> = {
		blue: 'text-accent-blue',
		green: 'text-accent-green',
		yellow: 'text-accent-yellow',
		red: 'text-accent-red',
		purple: 'text-accent-purple',
		cyan: 'text-accent-cyan'
	};
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	<p class="text-xs text-text-secondary uppercase tracking-wider mb-1">{label}</p>
	<p class="text-2xl font-bold font-mono {accentColors[accent]}">{value}</p>
	{#if subtitle}
		<p class="text-xs text-text-secondary mt-1">{subtitle}</p>
	{/if}
</div>
