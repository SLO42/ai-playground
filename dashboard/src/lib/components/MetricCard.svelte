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

<div class="bg-bg-secondary border border-border rounded-lg p-3 sm:p-4 min-w-0">
	<p class="text-[0.65rem] sm:text-xs text-text-secondary uppercase tracking-wider mb-1 truncate">{label}</p>
	<p class="text-xl sm:text-2xl font-bold font-mono truncate {accentColors[accent]}">{value}</p>
	{#if subtitle}
		<p class="text-[0.65rem] sm:text-xs text-text-secondary mt-1 truncate">{subtitle}</p>
	{/if}
</div>
