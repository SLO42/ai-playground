<script lang="ts">
	interface Props {
		status: 'online' | 'offline' | 'warning' | 'pending' | 'clean' | 'error';
		label?: string;
		size?: 'sm' | 'md';
	}

	let { status, label, size = 'sm' }: Props = $props();

	const colors: Record<string, string> = {
		online: 'bg-accent-green',
		clean: 'bg-accent-green',
		offline: 'bg-accent-red',
		error: 'bg-accent-red',
		warning: 'bg-accent-yellow',
		pending: 'bg-accent-yellow'
	};

	// WCAG AA requires 4.5:1 contrast for small text on #0F0F23 / #1A1A2E backgrounds.
	// Raw accent-red (#EF4444) only hits ~4.0:1 — use brighter variants for text.
	const textColors: Record<string, string> = {
		online: 'text-green-400',
		clean: 'text-green-400',
		offline: 'text-red-400',
		error: 'text-red-400',
		warning: 'text-yellow-300',
		pending: 'text-yellow-300'
	};
</script>

<span class="inline-flex items-center gap-1.5 {size === 'sm' ? 'text-xs' : 'text-sm'}" role="status">
	<span aria-hidden="true" class="inline-block {size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'} rounded-full {colors[status]}"></span>
	{#if label}
		<span class="{textColors[status]} font-medium uppercase tracking-wider">{label}</span>
	{/if}
</span>
