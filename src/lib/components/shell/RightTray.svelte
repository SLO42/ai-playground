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
	import type { DecisionBriefRow } from '$lib/server/projects/briefs';

	let {
		items = [],
		unread = 0,
		briefs = []
	}: { items?: TrayItem[]; unread?: number; briefs?: DecisionBriefRow[] } = $props();

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

	// ── TASK 16.4 — decision briefs (WORKFORCE-SPEC §8): the tray IS the decisions
	// inbox. A decide POST applies the mechanical effects server-side; failure is
	// surfaced honestly (the brief stays open — the live state stands).
	//
	// HR-5 (HR-RECRUITER-SPEC §7.5) — a `cert_hire` brief is the OPERATOR HIRE-GATE (B4):
	// its APPROVE flips a cert, so the server REQUIRES an explicit operator confirm
	// (operatorConfirmed:true) and refuses anything else with a 409. It has NO defer
	// (approve/reject only — the candidate stays open until decided). The generic decide()
	// alone would always 409 on approve and 400 on defer, so the kind drives the wiring.
	const isCertHire = (b: DecisionBriefRow) => b.artifact_kind === 'cert_hire';
	let briefError = $state<string | null>(null);
	async function decide(b: DecisionBriefRow, action: 'approve' | 'reject' | 'defer') {
		busy = true;
		briefError = null;
		try {
			const body: Record<string, unknown> = { id: b.id, action };
			// B4 — an approve on the hire-gate carries the operator's explicit confirm; without it
			// the server fail-closes (HireGateError → 409) and the cert never flips. Staffing is a
			// SEPARATE D-039 act on the staffing board (optional staffingProposal omitted here).
			if (isCertHire(b) && action === 'approve') body.operatorConfirmed = true;
			const res = await fetch('/api/briefs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { message?: string } | null;
				briefError = detail?.message ?? `decision failed (${res.status})`;
			}
			await invalidate('app:shell');
		} catch (err) {
			briefError = (err as Error).message;
		} finally {
			busy = false;
		}
	}

	/** Completeness rendered from REAL panel rows — or the honest kind-differs note. */
	function completenessLine(b: DecisionBriefRow): string | null {
		const c = b.completeness;
		if (!c) return null;
		if ('kind_differs' in c) return c.note;
		return `${c.validators}/${c.expected} validator verdict(s) · ${c.approve} approve / ${c.pushback} pushback`;
	}

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

		{#if briefs.length > 0}
			<!-- TASK 16.4 — open decision briefs (WORKFORCE-SPEC §8 canonical format).
			     A brief is a QUESTION: the matter does not proceed while it is open. -->
			<section class="briefs" aria-label="Open decision briefs">
				<h3 class="briefs-title">
					Decisions <span class="count mono">{briefs.length}</span>
				</h3>
				{#if briefError}
					<p class="brief-error" role="alert">{briefError}</p>
				{/if}
				{#each briefs as b (b.id)}
					<article class="brief" data-class={b.classification}>
						<p class="brief-class mono">{b.classification.replace('_', ' ')}</p>
						<p class="brief-ask">{b.ask}</p>
						<p class="brief-issue">{b.issue}</p>
						{#if completenessLine(b)}
							<p class="brief-meta"><span class="brief-k">completeness</span> {completenessLine(b)}</p>
						{/if}
						<p class="brief-meta">
							<span class="brief-k">effort</span>
							apply: {b.effort.apply} · if wrong: {b.effort.wrongness}
						</p>
						<p class="brief-meta">
							<span class="brief-k">evidence</span>
							{#each b.evidence as ev (ev)}<span class="mono brief-ev">{ev}</span>{/each}
						</p>
						<p class="brief-meta"><span class="brief-k">falsifier</span> {b.falsifier}</p>
						<ul class="brief-options">
							{#each b.options as o (o.id)}
								<li class="brief-option" class:recommended={!!o.recommended}>
									<span class="brief-option-label">
										{o.label}
										{#if o.recommended}<span class="rec-tag">recommended</span>{/if}
									</span>
									<span class="brief-pro">+ {o.pro}</span>
									<span class="brief-con">− {o.con}</span>
									{#if o.recommended}<span class="brief-why">{o.recommended}</span>{/if}
								</li>
							{/each}
						</ul>
						{#if b.net_tradeoff}<p class="brief-net">{b.net_tradeoff}</p>{/if}
						<div class="brief-actions">
							<button class="brief-btn approve" type="button" disabled={busy} onclick={() => decide(b, 'approve')}>
								Approve
							</button>
							<button class="brief-btn" type="button" disabled={busy} onclick={() => decide(b, 'reject')}>
								Reject
							</button>
							{#if !isCertHire(b)}
								<!-- HR-5 (B4): a hire-gate brief is approve/reject only — there is no defer
								     (the candidate stays open until decided), so the control is omitted. -->
								<button class="brief-btn" type="button" disabled={busy} onclick={() => decide(b, 'defer')}>
									Defer
								</button>
							{/if}
						</div>
					</article>
				{/each}
			</section>
		{/if}

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
								<!-- 14.4c: identifying content — model and/or the persisted how/why label;
								     a row with neither gets an HONEST fallback, never a bare type. -->
								<p class="item-msg">
									<span class="ev-type mono">{item.type}</span>
									{#if item.model}<span class="ev-model mono">{item.model}</span>{/if}
									{#if item.label}<span class="ev-label" title={item.label}>{item.label}</span>{/if}
									{#if !item.model && !item.label}<span class="ev-none">no context recorded</span>{/if}
								</p>
							{/if}
							<div class="item-meta">
								<time class="when" datetime={item.at}>{ago(item.at)}</time>
								{#if item.kind === 'activity' && item.sessionId}
									<span class="ref mono">session {shortId(item.sessionId)}</span>
								{:else if item.kind === 'activity' && item.projectId}
									<span class="ref mono">project {shortId(item.projectId)}</span>
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

	/* ── TASK 16.4 — decision briefs (the decisions inbox) ─────────────────────── */
	.briefs {
		flex: 0 1 auto;
		overflow-y: auto;
		border-bottom: var(--border-width) solid var(--color-border-strong);
		padding: var(--space-3) var(--pad-card);
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.briefs-title {
		font: var(--type-h3);
		color: var(--color-text);
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.count {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}
	.brief-error {
		font: var(--type-body-sm);
		color: var(--color-error);
	}
	.brief {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-bg-inset);
	}
	.brief[data-class='operator_challenge'] {
		border-color: var(--color-warn);
	}
	.brief-class {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.brief-ask {
		font: var(--type-body);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}
	.brief-issue {
		font: var(--type-body-sm);
		color: var(--color-text-2);
	}
	.brief-meta {
		font-size: var(--text-xs);
		color: var(--color-text-2);
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		align-items: baseline;
	}
	.brief-k {
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.brief-ev {
		color: var(--color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.brief-options {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.brief-option {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-2);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
	}
	.brief-option.recommended {
		border-color: var(--color-accent);
	}
	.brief-option-label {
		font: var(--type-body-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
		display: flex;
		gap: var(--space-2);
		align-items: baseline;
	}
	.rec-tag {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		color: var(--color-accent);
	}
	.brief-pro,
	.brief-con,
	.brief-why {
		font-size: var(--text-xs);
		color: var(--color-text-2);
	}
	.brief-why {
		color: var(--color-text-muted);
		font-style: italic;
	}
	.brief-net {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}
	.brief-actions {
		display: flex;
		gap: var(--space-2);
	}
	.brief-btn {
		padding: var(--space-1) var(--space-3);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-2);
		font: var(--type-body-sm);
		cursor: pointer;
	}
	.brief-btn.approve {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.brief-btn:hover:not(:disabled) {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}
	.brief-btn:disabled {
		opacity: 0.5;
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
	.ev-label {
		font-size: var(--text-xs);
		color: var(--color-text-2);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.ev-none {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		font-style: italic;
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
