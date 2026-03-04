<script lang="ts">
	import { onMount } from 'svelte';

	type ToastVariant = 'success' | 'error' | 'warning' | 'info';

	interface ToastItem {
		id: string;
		variant: ToastVariant;
		title: string;
		message?: string;
		timestamp?: string;
		autoDismiss?: boolean;
	}

	interface Props {
		toasts?: ToastItem[];
		onDismiss?: (id: string) => void;
	}

	let { toasts = [], onDismiss }: Props = $props();

	const borderColors: Record<ToastVariant, string> = {
		success: 'border-l-accent-green',
		error: 'border-l-accent-red',
		warning: 'border-l-accent-yellow',
		info: 'border-l-accent-blue'
	};

	function dismiss(id: string) {
		onDismiss?.(id);
	}
</script>

{#if toasts.length > 0}
	<div class="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 max-w-sm">
		{#each toasts as toast (toast.id)}
			<div
				class="bg-bg-secondary border border-border border-l-4 {borderColors[toast.variant]} rounded-lg p-4 shadow-lg animate-slide-in"
			>
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0 flex-1">
						<p class="text-sm font-semibold text-text-primary">{toast.title}</p>
						{#if toast.message}
							<p class="text-xs text-text-secondary mt-1">{toast.message}</p>
						{/if}
					</div>
					<div class="flex items-center gap-2 flex-shrink-0">
						{#if toast.timestamp}
							<span class="text-xs text-text-secondary">{toast.timestamp}</span>
						{/if}
						<button
							onclick={() => dismiss(toast.id)}
							class="text-text-secondary hover:text-text-primary transition-colors text-sm leading-none"
						>
							&times;
						</button>
					</div>
				</div>
			</div>
		{/each}
	</div>
{/if}

<style>
	@keyframes slide-in {
		from {
			transform: translateX(100%);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}

	.animate-slide-in {
		animation: slide-in 0.3s ease-out;
	}
</style>
