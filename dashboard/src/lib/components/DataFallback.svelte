<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** 'empty' shows a muted info state, 'error' shows a warning state with optional retry */
		variant?: 'empty' | 'error';
		/** Main heading text */
		title?: string;
		/** Descriptive message below the title */
		message?: string;
		/** Technical detail shown smaller below the message (e.g. error string) */
		detail?: string | null;
		/** Height class for the container (default: 'h-48') */
		height?: string;
		/** Called when the retry/check-again button is clicked */
		onretry?: () => void;
		/** Whether the retry action is in progress */
		retrying?: boolean;
		/** Label for the retry button (default: 'Retry' for error, 'Check Again' for empty) */
		retryLabel?: string;
		/** Optional slot content rendered below the message area */
		children?: Snippet;
	}

	let {
		variant = 'empty',
		title,
		message,
		detail = null,
		height = 'h-48',
		onretry,
		retrying = false,
		retryLabel,
		children,
	}: Props = $props();

	const defaultRetryLabel = $derived(variant === 'error' ? 'Retry' : 'Check Again');
	const activeRetryLabel = $derived(variant === 'error' ? 'Retrying...' : 'Checking...');
	const buttonLabel = $derived(retrying ? activeRetryLabel : (retryLabel ?? defaultRetryLabel));
</script>

<div class="{height} flex flex-col items-center justify-center gap-2">
	{#if variant === 'error'}
		<svg class="w-5 h-5 text-accent-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
		</svg>
	{:else}
		<svg class="w-5 h-5 text-text-secondary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-2.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
		</svg>
	{/if}

	{#if title}
		<p class="text-text-secondary text-sm font-medium">{title}</p>
	{/if}

	{#if message}
		<p class="text-text-secondary text-xs max-w-sm text-center">{message}</p>
	{/if}

	{#if detail}
		<p class="text-text-secondary text-xs">{detail}</p>
	{/if}

	{#if variant === 'error' && onretry}
		<button
			onclick={onretry}
			disabled={retrying}
			class="mt-1 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-border bg-bg-tertiary text-text-primary hover:bg-bg-secondary transition-colors disabled:opacity-50"
		>
			<svg class="w-3.5 h-3.5 {retrying ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
			</svg>
			{retrying ? 'Retrying...' : 'Retry'}
		</button>
	{/if}

	{#if children}
		{@render children()}
	{/if}
</div>
