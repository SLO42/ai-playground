<script lang="ts">
	/**
	 * ToastHost — renders the live toast stack (UI-SPEC §8 "Toasts + tray", §11).
	 * Transient success/error/info notifications, stacked bottom-right, auto-dismiss
	 * (handled by the store) + a manual close. Tokens-only; reduced-motion respected
	 * (the enter/exit slide collapses to instant via the motion tokens). Each toast is
	 * also announced once through the app-root aria-live region (passed via `announce`)
	 * so screen readers hear it without focus theft (§283).
	 */
	import { toasts, type Toast } from '$lib/client/toast.svelte';

	let { announce }: { announce?: (msg: string) => void } = $props();

	// Announce each newly-arrived toast exactly once (§283 — one SR announcement per toast).
	let announced = new Set<number>();
	$effect(() => {
		for (const t of toasts.items) {
			if (!announced.has(t.id)) {
				announced.add(t.id);
				announce?.(`${t.kind}: ${t.title}${t.detail ? `. ${t.detail}` : ''}`);
			}
		}
	});

	const ICON: Record<Toast['kind'], string> = {
		success: '✓',
		error: '✕',
		info: 'i'
	};
</script>

<!-- The SR announcement path is the app-root aria-live region (announce), so the
     toasts themselves carry NO live role (avoids double-announce, §283). The visual
     text is aria-hidden, but the close button stays an accessible, labelled control. -->
<div class="toast-host" data-testid="toast-host">
	{#each toasts.items as toast (toast.id)}
		<div class="toast" data-kind={toast.kind} data-testid="toast">
			<span class="icon" data-kind={toast.kind} aria-hidden="true">{ICON[toast.kind]}</span>
			<div class="body" aria-hidden="true">
				<span class="title">{toast.title}</span>
				{#if toast.detail}
					<span class="detail mono">{toast.detail}</span>
				{/if}
			</div>
			<button
				type="button"
				class="close"
				aria-label="Dismiss notification"
				onclick={() => toasts.dismiss(toast.id)}
			>
				<span aria-hidden="true">✕</span>
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-host {
		position: fixed;
		right: var(--space-6);
		bottom: var(--space-6);
		z-index: var(--z-toast);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		width: min(360px, calc(100vw - var(--space-8)));
		pointer-events: none; /* the container is inert; toasts re-enable below */
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--pad-control) var(--space-4);
		background: var(--color-surface-raised);
		border: var(--border-width) solid var(--color-border-strong);
		border-left-width: 3px;
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-overlay);
		animation: toast-in var(--motion-normal) var(--ease-out);
	}

	/* Status-colored left rail + icon (color is ALWAYS paired with the glyph, §9). */
	.toast[data-kind='success'] {
		border-left-color: var(--color-success);
	}
	.toast[data-kind='error'] {
		border-left-color: var(--color-error);
	}
	.toast[data-kind='info'] {
		border-left-color: var(--color-info);
	}

	.icon {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-top: 1px;
		border-radius: var(--radius-pill);
		font: var(--weight-bold) var(--text-2xs) / 1 var(--font-mono);
		color: var(--color-text-inverse);
	}
	.icon[data-kind='success'] {
		background: var(--color-success);
	}
	.icon[data-kind='error'] {
		background: var(--color-error);
	}
	.icon[data-kind='info'] {
		background: var(--color-info);
	}

	.body {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.title {
		font: var(--type-body-sm);
		color: var(--color-text);
	}
	.detail {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		word-break: break-word;
	}

	.close {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-subtle);
		font-size: var(--text-xs);
		cursor: pointer;
	}
	.close:hover {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
	}
</style>
