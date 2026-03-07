<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		variant = 'empty',
		title,
		message = '',
		icon: iconSnippet,
		actions
	}: {
		variant?: 'empty' | 'error' | 'loading';
		title: string;
		message?: string;
		icon?: Snippet;
		actions?: Snippet;
	} = $props();

	const variantStyles: Record<string, string> = {
		empty: 'text-text-secondary/40',
		error: 'text-accent-yellow',
		loading: 'text-accent-cyan'
	};
</script>

<div
	class="h-48 flex flex-col items-center justify-center gap-2 text-center px-4"
	role={variant === 'loading' ? 'status' : 'alert'}
	aria-live="polite"
	data-testid="page-fallback"
	data-variant={variant}
>
	{#if iconSnippet}
		<span class={variantStyles[variant]}>
			{@render iconSnippet()}
		</span>
	{/if}
	<p class="text-text-secondary text-sm font-medium" data-testid="fallback-title">{title}</p>
	{#if message}
		<p class="text-text-secondary/70 text-xs max-w-sm" data-testid="fallback-message">{message}</p>
	{/if}
	{#if actions}
		<div class="mt-1" data-testid="fallback-actions">
			{@render actions()}
		</div>
	{/if}
</div>
