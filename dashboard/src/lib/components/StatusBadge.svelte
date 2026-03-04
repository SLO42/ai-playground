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

	const textColors: Record<string, string> = {
		online: 'text-accent-green',
		clean: 'text-accent-green',
		offline: 'text-accent-red',
		error: 'text-accent-red',
		warning: 'text-accent-yellow',
		pending: 'text-accent-yellow'
	};
</script>

<span class="inline-flex items-center gap-1.5 {size === 'sm' ? 'text-xs' : 'text-sm'}">
	<span class="inline-block {size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'} rounded-full {colors[status]}"></span>
	{#if label}
		<span class="{textColors[status]} font-medium uppercase tracking-wider">{label}</span>
	{/if}
</span>
