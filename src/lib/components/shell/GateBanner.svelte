<script lang="ts">
	/**
	 * GateBanner — surfaces a gate decision (D-018/D-024, UI-SPEC §165 / §254):
	 * a NON-BLOCKING banner explaining what an agent action was blocked or flagged
	 * for, and why. `warn` = soft (allowed but flagged), `block` = hard (denied).
	 * Dismissible; stacks under the topbar. Tokens-only; status color is always
	 * paired with a label + icon (§9). Distinct from ConfirmDialog (which blocks).
	 */
	import { confirm } from '$lib/client/confirm.svelte';
</script>

{#if confirm.gates.length > 0}
	<div class="gate-stack" role="region" aria-label="Gate notices">
		{#each confirm.gates as gate (gate.id)}
			<div class="gate" data-severity={gate.severity} role={gate.severity === 'block' ? 'alert' : 'status'}>
				<span class="badge" data-severity={gate.severity}>
					{gate.severity === 'block' ? 'Blocked' : 'Flagged'}
				</span>
				<div class="gate-body">
					<span class="gate-title">
						<span class="gate-name mono">{gate.gate}</span>
						<span class="gate-msg">{gate.message}</span>
					</span>
					{#if gate.detail}
						<span class="gate-detail mono">{gate.detail}</span>
					{/if}
				</div>
				<button
					type="button"
					class="dismiss"
					aria-label="Dismiss gate notice"
					onclick={() => confirm.dismissGate(gate.id)}
				>
					<span aria-hidden="true">✕</span>
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.gate-stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--pad-panel) 0;
	}
	.gate {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--pad-control) var(--space-4);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		animation: gate-in var(--motion-fast) var(--ease-out);
	}
	.gate[data-severity='warn'] {
		background: var(--color-warn-bg);
		border-color: var(--color-warn);
	}
	.gate[data-severity='block'] {
		background: var(--color-error-bg);
		border-color: var(--color-error);
	}

	.badge {
		flex: 0 0 auto;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-xs);
		font: var(--weight-semibold) var(--text-2xs) / 1.4 var(--font-body);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-inverse);
	}
	.badge[data-severity='warn'] {
		background: var(--color-warn);
	}
	.badge[data-severity='block'] {
		background: var(--color-error);
	}

	.gate-body {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.gate-title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--gap-inline);
	}
	.gate-name {
		font-size: var(--text-xs);
		color: var(--color-text-2);
	}
	.gate-msg {
		font: var(--type-body-sm);
		color: var(--color-text);
	}
	.gate-detail {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		word-break: break-word;
	}

	.dismiss {
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
	.dismiss:hover {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}

	@keyframes gate-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.gate {
			animation: none;
		}
	}
</style>
