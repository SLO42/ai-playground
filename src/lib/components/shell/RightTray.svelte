<script lang="ts">
	/**
	 * RightTray — the slide-over notifications + recent-activity tray (UI-SPEC §3/§85/§147).
	 *
	 * A slide-in panel anchored to the right edge surfacing REAL `notification` + `agent_event`
	 * rows (merged newest-first from the layout load; F-008). The Topbar bell toggles it; this
	 * panel reads `tray.open` reactively. Per-item mark-read + "mark all read" POST to
	 * /api/notifications; the change lands LIVE over the one SSE `notification` watcher, which
	 * re-invalidates the layout load (the parent passes fresh `items`/`unread` back in). A
	 * "see all" link opens the durable /reports#notifications history.
	 *
	 * a11y: role=dialog + aria-modal labelled by the heading; focus moves into the panel on open
	 * (the close button), Tab/Shift-Tab cycle within (focus trap), Esc closes, and focus is
	 * restored to the trigger (the bell) on close. Tokens only; reduced-motion collapses the
	 * slide. Honest empty state when there is nothing to show (F-008).
	 */
	import { tray } from '$lib/client/tray.svelte';
	import { invalidate } from '$app/navigation';
	import type { TrayItem } from '$lib/server/notifications/repo';

	let { items = [], unread = 0 }: { items?: TrayItem[]; unread?: number } = $props();

	let panelEl = $state<HTMLElement | null>(null);
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let restoreFocus: HTMLElement | null = null;
	let busy = $state(false);

	const open = $derived(tray.open);
	const hasUnread = $derived(items.some((i) => i.kind === 'notification' && !i.read));

	// Open transition: remember the trigger, then move focus into the panel after paint.
	$effect(() => {
		if (open && panelEl) {
			restoreFocus = (document.activeElement as HTMLElement) ?? null;
			queueMicrotask(() => closeBtn?.focus());
		}
	});

	function close() {
		const target = restoreFocus;
		restoreFocus = null;
		tray.hide();
		queueMicrotask(() => target?.focus?.());
	}

	function focusables(): HTMLElement[] {
		if (!panelEl) return [];
		return Array.from(
			panelEl.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			)
		).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
			return;
		}
		if (e.key === 'Tab') {
			const list = focusables();
			if (list.length === 0) return;
			const first = list[0];
			const last = list[list.length - 1];
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

	async function post(body: Record<string, unknown>) {
		busy = true;
		try {
			await fetch('/api/notifications', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			// The SSE `notification` watcher will re-invalidate too; do it eagerly so the
			// badge/rows update even if the live frame is in flight.
			await invalidate('app:shell');
		} catch {
			/* a failed mark-read leaves the row unread — honest, the live state stands */
		} finally {
			busy = false;
		}
	}

	const markOne = (id: string) => post({ action: 'read', id });
	const markAll = () => post({ action: 'read-all' });

	/** Relative "time ago" — deterministic, tokens-free copy (mirrors the Home feed). */
	function ago(iso: string): string {
		if (!iso) return '—';
		const t = new Date(iso).getTime();
		if (Number.isNaN(t)) return '—';
		const s = Math.max(0, Math.round((Date.now() - t) / 1000));
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.round(h / 24)}d ago`;
	}

	const shortId = (id: string): string => id.split(':').pop()?.slice(0, 8) ?? id;
</script>

{#if open}
	<!-- Backdrop dismiss as a real button (the project's scrim pattern): click-outside closes. -->
	<button type="button" class="scrim" tabindex="-1" aria-label="Close notifications" onclick={close}
	></button>
	<div
		bind:this={panelEl}
		class="tray"
		role="dialog"
		aria-modal="true"
		aria-labelledby="tray-title"
		tabindex="-1"
		onkeydown={onKeydown}
	>
		<header class="tray-head">
			<div class="title-wrap">
				<h2 id="tray-title" class="title">Notifications</h2>
				{#if unread > 0}
					<span class="badge" aria-label={`${unread} unread`}>{unread}</span>
				{/if}
			</div>
			<button
				bind:this={closeBtn}
				type="button"
				class="icon-btn"
				aria-label="Close"
				onclick={close}
			>
				<span class="x" aria-hidden="true"></span>
			</button>
		</header>

		<div class="tray-actions">
			<button
				type="button"
				class="link-btn"
				disabled={busy || !hasUnread}
				onclick={markAll}
			>
				Mark all read
			</button>
			<a class="link-btn see-all" href="/reports#notifications" onclick={close}>See all →</a>
		</div>

		<div class="feed" role="list" aria-label="Notifications and recent activity">
			{#if items.length === 0}
				<!-- Honest empty state (F-008): no fabricated notices. -->
				<div class="empty">
					<p class="empty-title">Nothing yet</p>
					<p class="empty-sub">Notifications and recent agent activity will appear here.</p>
				</div>
			{:else}
				{#each items as item (item.id)}
					<div
						class="item"
						class:unread={item.kind === 'notification' && !item.read}
						data-kind={item.kind}
						role="listitem"
					>
						<span class="dot" data-kind={item.kind} aria-hidden="true"></span>
						<div class="item-body">
							{#if item.kind === 'notification'}
								<p class="item-msg">{item.message || '—'}</p>
							{:else}
								<p class="item-msg">
									<span class="ev-type mono">{item.type}</span>
									{#if item.model}<span class="ev-model mono">{item.model}</span>{/if}
								</p>
							{/if}
							<div class="item-meta">
								<time class="when" datetime={item.at}>{ago(item.at)}</time>
								{#if item.kind === 'activity' && item.sessionId}
									<span class="ref mono">session {shortId(item.sessionId)}</span>
								{/if}
							</div>
						</div>
						{#if item.kind === 'notification' && !item.read}
							<button
								type="button"
								class="mark-btn"
								disabled={busy}
								aria-label="Mark read"
								onclick={() => markOne(item.id)}
							>
								Mark read
							</button>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}

<style>
	.scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-tray);
		border: 0;
		padding: 0;
		background: var(--color-overlay-scrim);
		cursor: pointer;
		animation: scrim-in var(--motion-fast) var(--ease-out);
	}
	.tray {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-tray);
		width: min(380px, 100vw);
		display: flex;
		flex-direction: column;
		background: var(--color-surface-raised);
		border-left: var(--border-width) solid var(--color-border-strong);
		box-shadow: var(--shadow-overlay);
		animation: tray-in var(--motion-normal) var(--ease-out);
	}
	.tray-head {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--pad-card);
		border-bottom: var(--border-width) solid var(--color-border);
	}
	.title-wrap {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.title {
		font: var(--type-h3);
		color: var(--color-text);
	}
	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font: var(--weight-semibold) var(--text-xs) / 1 var(--font-body);
	}
	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: var(--border-width) solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-2);
		cursor: pointer;
	}
	.icon-btn:hover {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}
	/* Close glyph drawn from currentColor (no icon font / asset). */
	.x {
		position: relative;
		width: 14px;
		height: 14px;
	}
	.x::before,
	.x::after {
		content: '';
		position: absolute;
		top: 50%;
		left: 0;
		width: 14px;
		height: 2px;
		background: currentColor;
		border-radius: 1px;
	}
	.x::before {
		transform: rotate(45deg);
	}
	.x::after {
		transform: rotate(-45deg);
	}

	.tray-actions {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-2) var(--pad-card);
		border-bottom: var(--border-width) solid var(--color-border);
	}
	.link-btn {
		padding: var(--space-1) var(--space-2);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-accent);
		font: var(--type-body-sm);
		cursor: pointer;
		text-decoration: none;
	}
	.link-btn:hover:not(:disabled) {
		text-decoration: underline;
	}
	.link-btn:disabled {
		color: var(--color-text-muted);
		cursor: default;
	}

	.feed {
		flex: 1 1 auto;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}
	.empty {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: var(--space-12) var(--pad-card);
		margin: auto 0;
	}
	.empty-title {
		font: var(--type-body);
		color: var(--color-text-2);
	}
	.empty-sub {
		font: var(--type-body-sm);
		color: var(--color-text-muted);
		max-width: 26ch;
	}

	.item {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--pad-card);
		border-bottom: var(--border-width) solid var(--color-border);
	}
	.item.unread {
		background: var(--color-bg-inset);
	}
	.dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		margin-top: 6px;
		border-radius: var(--radius-pill);
		background: var(--color-neutral);
	}
	.dot[data-kind='notification'] {
		background: var(--color-accent);
	}
	.item-body {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.item-msg {
		font: var(--type-body-sm);
		color: var(--color-text);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}
	.ev-type {
		color: var(--color-text);
	}
	.ev-model {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}
	.item-meta {
		display: flex;
		gap: var(--space-3);
		align-items: baseline;
	}
	.when,
	.ref {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}
	.mark-btn {
		flex: 0 0 auto;
		align-self: center;
		padding: var(--space-1) var(--space-2);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-2);
		font-size: var(--text-xs);
		cursor: pointer;
		white-space: nowrap;
	}
	.mark-btn:hover:not(:disabled) {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}
	.mark-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	@keyframes scrim-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes tray-in {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.tray {
			animation: none;
		}
	}
</style>
