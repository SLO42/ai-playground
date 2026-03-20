<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		message?: string;
		icon?: string;
		actions?: Snippet;
	}

	let { title, message, icon = '📭', actions }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-16 text-center">
	<span class="text-4xl mb-4">{icon}</span>
	<h3 class="text-sm font-bold text-text-primary mb-1">{title}</h3>
	{#if message}
		<p class="text-xs text-text-secondary max-w-sm">{message}</p>
	{/if}
	{#if actions}
		<div class="mt-4">
			{@render actions()}
		</div>
	{/if}
</div>
