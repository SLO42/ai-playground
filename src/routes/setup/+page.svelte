<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}
	let { data, form }: Props = $props();
</script>

<svelte:head><title>Set password — Atelier</title></svelte:head>

<div class="auth-wrap">
	<article class="card auth-card" aria-labelledby="setup-title">
		<header class="page-head">
			<span class="eyebrow">first run</span>
			<h1 id="setup-title" class="title">Set a password</h1>
			<p class="lede">
				This Atelier is reachable beyond this machine. Set an operator password so
				LAN/remote access requires a login. Local (loopback) use stays login-free.
			</p>
		</header>

		<div class="card-body">
			{#if !data.dbAvailable}
				<p class="note error" role="alert">
					The database is not connected, so a password can't be set right now. Retry once
					it's back.
				</p>
			{/if}

			<form method="POST" use:enhance class="auth-form">
				<label class="field">
					<span class="field-label">New password</span>
					<input
						class="knob-input mono"
						type="password"
						name="password"
						autocomplete="new-password"
						minlength="8"
						required
						aria-describedby="pw-hint"
					/>
				</label>
				<label class="field">
					<span class="field-label">Confirm password</span>
					<input
						class="knob-input mono"
						type="password"
						name="confirm"
						autocomplete="new-password"
						minlength="8"
						required
					/>
				</label>
				<p id="pw-hint" class="note muted">At least 8 characters.</p>

				{#if form?.error}
					<p class="note error" role="alert">{form.error}</p>
				{/if}

				<button class="btn primary" type="submit" disabled={!data.dbAvailable}>Set password</button>
			</form>

			<p class="note tofu">
				Casual gating over plain HTTP — not a TLS substitute. The first visitor who reaches
				this page can claim the password, so set it from this machine before exposing the LAN
				listener.
			</p>
		</div>
	</article>
</div>

<style>
	.auth-wrap {
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: var(--space-4, 2rem) var(--page-gutter, 1rem);
	}
	.auth-card {
		max-width: 26rem;
		width: 100%;
	}
	.page-head {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.eyebrow {
		font: var(--type-body-sm);
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.title {
		font: var(--type-h1);
		color: var(--color-text);
	}
	.lede {
		font: var(--type-body);
		color: var(--color-text-muted);
	}
	.card-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-3, 0.75rem);
	}
	.auth-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.5rem);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.field-label {
		font: var(--type-body-sm);
		color: var(--color-text-2);
	}
	.btn {
		background: var(--color-surface-overlay);
		color: var(--color-text);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm, 6px);
		font-weight: 600;
		padding: 0.45rem 0.85rem;
		min-height: 34px;
		cursor: pointer;
		margin-top: 0.25rem;
	}
	.btn.primary {
		background: var(--color-accent);
		color: var(--color-text-inverse);
		border-color: var(--color-accent);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.note {
		font: var(--type-body-sm);
		margin: 0;
	}
	.note.muted {
		color: var(--color-text-muted);
	}
	.note.error {
		color: var(--color-error);
	}
	.note.tofu {
		color: var(--color-text-subtle);
		border-top: 1px solid var(--color-border-faint);
		padding-top: 0.6rem;
	}
</style>
