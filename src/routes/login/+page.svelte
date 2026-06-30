<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}
	let { data, form }: Props = $props();
</script>

<svelte:head><title>Sign in — Atelier</title></svelte:head>

<div class="auth-wrap">
	<article class="card auth-card" aria-labelledby="login-title">
		<header class="page-head">
			<span class="eyebrow">atelier</span>
			<h1 id="login-title" class="title">Sign in</h1>
			<p class="lede">
				Remote/LAN access needs the operator password. Local (loopback) use is login-free.
			</p>
		</header>

		<div class="card-body">
			{#if !data.dbAvailable}
				<p class="note error" role="alert">The database is not connected — sign in is unavailable.</p>
			{/if}

			<form method="POST" action="?/login" use:enhance class="auth-form">
				<input type="hidden" name="next" value={data.next} />
				<label class="field">
					<span class="field-label">Password</span>
					<input
						class="knob-input mono"
						type="password"
						name="password"
						autocomplete="current-password"
						required
					/>
				</label>

				{#if form?.login?.error}
					<p class="note error" role="alert">{form.login.error}</p>
				{/if}

				<button class="btn primary" type="submit" disabled={!data.dbAvailable}>Sign in</button>
			</form>

			{#if data.canManage}
				<form method="POST" action="?/changePassword" use:enhance class="auth-form manage">
					<h2 class="sub">Change password</h2>
					<label class="field">
						<span class="field-label">New password</span>
						<input class="knob-input mono" type="password" name="password" autocomplete="new-password" minlength="8" required />
					</label>
					<label class="field">
						<span class="field-label">Confirm</span>
						<input class="knob-input mono" type="password" name="confirm" autocomplete="new-password" minlength="8" required />
					</label>
					{#if form?.manage && 'error' in form.manage}
						<p class="note error" role="alert">{form.manage.error}</p>
					{:else if form?.manage && 'ok' in form.manage}
						<p class="note ok" role="status">Password changed.</p>
					{/if}
					<button class="btn" type="submit">Update password</button>
				</form>
			{/if}

			<p class="note tofu">Casual gating over plain HTTP — not a TLS substitute.</p>
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
	.sub {
		font: var(--type-h2);
		font-family: var(--font-display);
		color: var(--color-text);
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
	.auth-form.manage {
		border-top: 1px solid var(--color-border-faint);
		padding-top: 0.75rem;
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
	.note.error {
		color: var(--color-error);
	}
	.note.ok {
		color: var(--color-success);
	}
	.note.tofu {
		color: var(--color-text-subtle);
		border-top: 1px solid var(--color-border-faint);
		padding-top: 0.6rem;
	}
</style>
