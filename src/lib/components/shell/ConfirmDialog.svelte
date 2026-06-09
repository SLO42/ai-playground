<script lang="ts">
	/**
	 * ConfirmDialog — the BLOCKING confirm primitive (D-010 diff+confirm,
	 * UI-SPEC §8 / §165 / §254). Used by config writes (shows a unified diff first),
	 * destructive actions (stop agent, delete), and any "are you sure" gate.
	 *
	 * a11y: role=dialog + aria-modal, labelled by the title; focus is trapped while
	 * open (Tab/Shift-Tab cycle within), Esc cancels, the confirm button takes initial
	 * focus, and focus is restored to the previously-focused element on close. Tokens
	 * only; reduced-motion collapses the entrance. Resolves the store promise on accept
	 * (true) / cancel (false) — the awaiting caller proceeds or aborts.
	 */
	import { confirm } from '$lib/client/confirm.svelte';

	const req = $derived(confirm.request);

	let dialogEl = $state<HTMLDivElement | null>(null);
	let confirmBtn = $state<HTMLButtonElement | null>(null);
	let restoreFocus: HTMLElement | null = null;

	// Open transition: remember the trigger, then move focus to the confirm button.
	$effect(() => {
		if (req && dialogEl) {
			restoreFocus = (document.activeElement as HTMLElement) ?? null;
			// focus after paint so the element exists
			queueMicrotask(() => confirmBtn?.focus());
		}
	});

	function close(ok: boolean) {
		// Restore focus to the trigger before settling (the modal unmounts on settle).
		const target = restoreFocus;
		restoreFocus = null;
		if (ok) confirm.accept();
		else confirm.cancel();
		queueMicrotask(() => target?.focus?.());
	}

	function focusables(): HTMLElement[] {
		if (!dialogEl) return [];
		return Array.from(
			dialogEl.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			)
		).filter((el) => !el.hasAttribute('disabled'));
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close(false);
			return;
		}
		if (e.key === 'Tab') {
			// Focus trap — cycle within the dialog (§271 keyboard backbone).
			const items = focusables();
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement as HTMLElement;
			if (e.shiftKey && active === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

{#if req}
	<div class="overlay">
		<!-- Backdrop dismiss as a real button (the project's scrim pattern): click-outside
		     cancels (non-destructive default). Esc + the focus trap live on the dialog. -->
		<button
			type="button"
			class="scrim"
			tabindex="-1"
			aria-label="Cancel"
			onclick={() => close(false)}
		></button>
		<div
			bind:this={dialogEl}
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="confirm-title"
			aria-describedby={req.message ? 'confirm-message' : undefined}
			tabindex="-1"
			onkeydown={onKeydown}
		>
			<h2 id="confirm-title" class="title">{req.title}</h2>
			{#if req.message}
				<p id="confirm-message" class="message">{req.message}</p>
			{/if}

			{#if req.diff && req.diff.length > 0}
				<div class="diff" role="group" aria-label="Pending changes">
					{#each req.diff as line, i (i)}
						<div class="diff-line" data-kind={line.kind}>
							<span class="diff-sign mono" aria-hidden="true"
								>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span
							>
							<span class="diff-text mono">{line.text}</span>
						</div>
					{/each}
				</div>
			{/if}

			<div class="actions">
				<button type="button" class="btn ghost" onclick={() => close(false)}>
					{req.cancelLabel ?? 'Cancel'}
				</button>
				<button
					bind:this={confirmBtn}
					type="button"
					class="btn"
					class:danger={req.danger}
					onclick={() => close(true)}
				>
					{req.confirmLabel ?? 'Confirm'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--pad-panel);
	}
	.scrim {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: var(--color-overlay-scrim);
		cursor: pointer;
		animation: scrim-in var(--motion-fast) var(--ease-out);
	}
	.dialog {
		position: relative;
		width: min(520px, 100%);
		max-height: calc(100vh - var(--space-12));
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--gap-stack);
		padding: var(--pad-card);
		background: var(--color-surface-raised);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-overlay);
		animation: dialog-in var(--motion-normal) var(--ease-out);
	}
	.title {
		font: var(--type-h3);
		color: var(--color-text);
	}
	.message {
		font: var(--type-body-sm);
		color: var(--color-text-2);
	}

	.diff {
		display: flex;
		flex-direction: column;
		background: var(--color-bg-inset);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
		padding: var(--space-3) 0;
		overflow-x: auto;
	}
	.diff-line {
		display: flex;
		gap: var(--space-3);
		padding: 0 var(--space-4);
		font: var(--type-mono-sm);
		white-space: pre;
	}
	.diff-line[data-kind='add'] {
		background: var(--color-success-bg);
		color: var(--color-success);
	}
	.diff-line[data-kind='remove'] {
		background: var(--color-error-bg);
		color: var(--color-error);
	}
	.diff-line[data-kind='context'] {
		color: var(--color-text-muted);
	}
	.diff-sign {
		flex: 0 0 auto;
		width: 1ch;
		text-align: center;
		opacity: 0.8;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--gap-inline);
	}
	.btn {
		padding: var(--pad-control) var(--space-5);
		border: var(--border-width) solid transparent;
		border-radius: var(--radius-sm);
		font: var(--weight-medium) var(--text-sm) / 1 var(--font-sans);
		cursor: pointer;
		background: var(--color-accent);
		color: var(--color-on-accent);
	}
	.btn:hover {
		background: var(--color-accent-hover);
	}
	.btn.danger {
		background: var(--color-error);
		color: var(--color-text-inverse);
	}
	.btn.danger:hover {
		background: var(--error-500);
		filter: brightness(1.1);
	}
	.btn.ghost {
		background: transparent;
		border-color: var(--color-border-strong);
		color: var(--color-text-2);
	}
	.btn.ghost:hover {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}

	@keyframes scrim-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.99);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.dialog {
			animation: none;
		}
	}
</style>
