<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		subtitle?: string;
		actions?: Snippet;
	}

	let { title, subtitle, actions }: Props = $props();
</script>

<div class="flex items-start justify-between gap-4 mb-6">
	<div>
		<h1 class="text-lg font-bold text-text-primary">{title}</h1>
		{#if subtitle}
			<p class="text-sm text-text-secondary mt-0.5">{subtitle}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex items-center gap-2 shrink-0">
			{@render actions()}
		</div>
	{/if}
</div>
