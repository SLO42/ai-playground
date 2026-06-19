<script lang="ts">
	/**
	 * FileSnapshotViewer — the FS-3 "view file" surface (FILE-SNAPSHOT-SPEC §4). A read-only modal
	 * that renders the DB-stored point-in-time snapshot of a referenced file, wherever a file is
	 * referenced (a finding's file:line, a transcript tool turn, a project tree entry).
	 *
	 * It is OPENED with a reference — either `path` (+ optional `project`, the primary surface
	 * lookup: "the most recent snapshot of this file") OR an exact `snapshotId` — and fetches the
	 * normalized row from GET /api/file-snapshot. What it renders is HONEST about what was stored:
	 *
	 *   • a captured body  → read-only mono <pre> (the spec allows "syntax-aware if cheap, else mono
	 *     pre"; we render the literal stored text in a mono pre — no fabrication, no dependency), with
	 *     an explicit "as-of <captured_at> — may be stale; disk is the source of truth" note + the
	 *     content_sha + byte size (F-008 — NEVER labelled current/live).
	 *   • a marker snapshot (quarantined / oversize / binary) → the MARKER + its reason, never an
	 *     attempt to render withheld content (D-026 — a secret-screened file shows why it is withheld).
	 *   • no snapshot       → honest empty: "no snapshot captured yet" (F-008 — never an invented body).
	 *   • a fetch/DB error  → a NAMED honest error line (never a blank or a fake body).
	 *
	 * a11y: role=dialog + aria-modal, labelled by the file path; focus moves to the close button on
	 * open, Esc + the focus trap + click-scrim-to-close mirror ConfirmDialog; focus restores to the
	 * trigger on close. Tokens only; reduced-motion collapses the entrance. Svelte 5 RUNES only.
	 */
	import type { FileSnapshotRow } from '$lib/server/memory/file-snapshot';

	interface Props {
		/** Open/closed — the host toggles this; closing tears the fetch state down. */
		open: boolean;
		/** Project-relative path of the referenced file (the primary lookup). */
		path?: string;
		/** Owning `project:<slug>` id when the reference is project-scoped (scopes the lookup). */
		project?: string;
		/** Exact `file_snapshot:<id>` — used INSTEAD of path when the caller holds the row id. */
		snapshotId?: string;
		/** Called when the viewer requests close (Esc / scrim / button) — host sets open=false. */
		onClose: () => void;
	}
	let { open, path, project, snapshotId, onClose }: Props = $props();

	/** The fetch lifecycle — honest states (F-008), never a fabricated body while loading. */
	type State =
		| { kind: 'idle' }
		| { kind: 'loading' }
		| { kind: 'loaded'; snapshot: FileSnapshotRow | null }
		| { kind: 'error'; message: string };
	let view = $state<State>({ kind: 'idle' });

	let dialogEl = $state<HTMLDivElement | null>(null);
	let closeBtn = $state<HTMLButtonElement | null>(null);
	let restoreFocus: HTMLElement | null = null;

	/** The label the dialog announces — the path, or the id when only an id was given. */
	const refLabel = $derived(path ?? snapshotId ?? 'file');

	/** Fetch the snapshot whenever the viewer opens with a reference (re-runs if the ref changes). */
	$effect(() => {
		if (!open) {
			view = { kind: 'idle' };
			return;
		}
		// Remember the trigger + move focus into the dialog after paint.
		restoreFocus = (document.activeElement as HTMLElement) ?? null;
		queueMicrotask(() => closeBtn?.focus());

		const params = new URLSearchParams();
		if (snapshotId) params.set('id', snapshotId);
		else if (path) {
			params.set('path', path);
			if (project) params.set('project', project);
		} else {
			view = { kind: 'error', message: 'no file reference supplied' };
			return;
		}

		let cancelled = false;
		view = { kind: 'loading' };
		fetch(`/api/file-snapshot?${params.toString()}`)
			.then(async (res) => {
				if (cancelled) return;
				if (!res.ok) {
					// NAMED honest error — surface the server's reason (a 400 carries the D-016 message).
					const detail = await res.text().catch(() => '');
					view = {
						kind: 'error',
						message: `could not load snapshot (${res.status})${detail ? `: ${detail}` : ''}`
					};
					return;
				}
				const body = (await res.json()) as { snapshot: FileSnapshotRow | null };
				if (cancelled) return;
				view = { kind: 'loaded', snapshot: body.snapshot };
			})
			.catch((err) => {
				if (cancelled) return;
				view = { kind: 'error', message: `could not load snapshot: ${String(err?.message ?? err)}` };
			});

		return () => {
			cancelled = true;
		};
	});

	function close() {
		const target = restoreFocus;
		restoreFocus = null;
		onClose();
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
			close();
			return;
		}
		if (e.key === 'Tab') {
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

	/** A short human label for a marker reason (D-026/§2). */
	function markerLabel(reason: string | null): string {
		switch (reason) {
			case 'quarantined':
				return 'secret-screened — content withheld';
			case 'oversize':
				return 'file exceeds the snapshot byte cap — content withheld';
			case 'binary':
				return 'binary file — content withheld';
			default:
				return 'content withheld';
		}
	}
</script>

{#if open}
	<div class="overlay">
		<button type="button" class="scrim" tabindex="-1" aria-label="Close" onclick={close}></button>
		<div
			bind:this={dialogEl}
			class="dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="fsv-title"
			tabindex="-1"
			onkeydown={onKeydown}
		>
			<div class="head">
				<h2 id="fsv-title" class="title mono" title={refLabel}>{refLabel}</h2>
				<button bind:this={closeBtn} type="button" class="close" aria-label="Close" onclick={close}>
					✕
				</button>
			</div>

			{#if view.kind === 'loading'}
				<p class="state-body" role="status">Loading snapshot…</p>
			{:else if view.kind === 'error'}
				<p class="state-body err" role="alert">{view.message}</p>
			{:else if view.kind === 'loaded'}
				{#if !view.snapshot}
					<!-- HONEST EMPTY (F-008): a valid reference with nothing captured. -->
					<p class="state-body">
						No snapshot captured yet — this file has not been recorded in the database. The disk is
						the source of truth.
					</p>
				{:else}
					{@const snap = view.snapshot}
					<!-- The AS-OF banner — load-bearing F-008 label: this is point-in-time, NOT live. -->
					<div class="asof" role="note">
						<span class="asof-icon" aria-hidden="true">◷</span>
						<span class="asof-text">
							as-of {snap.captured_at ?? 'unknown time'} — may be stale; disk is the source of truth
						</span>
					</div>
					<dl class="meta">
						<div class="meta-row">
							<dt>sha</dt>
							<dd class="mono">{snap.content_sha || '—'}</dd>
						</div>
						<div class="meta-row">
							<dt>bytes</dt>
							<dd class="mono">{snap.bytes}</dd>
						</div>
						{#if snap.screen_status && snap.screen_status !== 'clean'}
							<div class="meta-row">
								<dt>screen</dt>
								<dd class="mono" data-screen={snap.screen_status}>{snap.screen_status}</dd>
							</div>
						{/if}
					</dl>

					{#if snap.is_marker}
						<!-- D-026 — a marker snapshot: show WHY content is withheld, never the withheld body. -->
						<div class="marker" role="note" data-reason={snap.marker_reason}>
							<span class="marker-tag mono">{snap.marker_reason ?? 'marker'}</span>
							<span class="marker-text">{markerLabel(snap.marker_reason)}</span>
						</div>
					{:else if snap.content.length}
						<!-- Read-only stored content (mono pre — the spec's "else mono pre"). The dialog body
						     itself scrolls (it is the focusable container, tabindex=-1 + overflow), so the
						     content needs no separate focusable region — keyboard users scroll via the dialog. -->
						<pre class="content mono" aria-label="file snapshot content (read-only)">{snap.content}</pre>
					{:else}
						<!-- An honestly-empty file body (a real 0-byte snapshot, not a missing one). -->
						<p class="state-body">(empty file — the captured content was zero-length)</p>
					{/if}
				{/if}
			{/if}
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
		animation: fsv-scrim-in var(--motion-fast) var(--ease-out);
	}
	.dialog {
		position: relative;
		width: min(840px, 100%);
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
		animation: fsv-dialog-in var(--motion-normal) var(--ease-out);
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.title {
		font: var(--type-mono-sm);
		color: var(--color-text);
		word-break: break-all;
		min-width: 0;
	}
	.close {
		flex: none;
		appearance: none;
		background: transparent;
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		color: var(--color-text-2);
		cursor: pointer;
		padding: var(--space-1) var(--space-3);
		line-height: 1;
	}
	.close:hover {
		background: var(--color-surface-overlay);
		color: var(--color-text);
	}
	.close:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.asof {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-sm);
		background: var(--color-accent-muted, var(--color-surface-card));
		color: var(--color-text-2);
		font: var(--type-body-sm);
	}
	.asof-icon {
		color: var(--color-accent);
		flex: none;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3) var(--space-5);
		margin: 0;
	}
	.meta-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}
	.meta dt {
		font-size: 0.64rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-text-muted);
	}
	.meta dd {
		margin: 0;
		font-size: 0.72rem;
		color: var(--color-text-2);
		word-break: break-all;
	}
	.meta dd[data-screen='redacted'] {
		color: var(--color-error-on-overlay, var(--color-text));
	}

	.marker {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		background: var(--color-bg-inset, var(--color-surface-card));
	}
	.marker-tag {
		flex: none;
		font-size: 0.64rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-sm);
		color: var(--color-error-on-overlay, var(--color-text));
		background: var(--color-error-bg, transparent);
	}
	.marker-text {
		font: var(--type-body-sm);
		color: var(--color-text-2);
	}

	.content {
		margin: 0;
		padding: var(--space-3) var(--space-4);
		background: var(--color-bg-inset, var(--color-surface-card));
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-sm);
		overflow-x: auto;
		font: var(--type-mono-sm);
		color: var(--color-text);
		white-space: pre;
		tab-size: 2;
	}

	.state-body {
		font: var(--type-body-sm);
		color: var(--color-text-2);
	}
	.state-body.err {
		color: var(--color-error-on-overlay, var(--color-text));
	}

	@keyframes fsv-scrim-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes fsv-dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.99);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.dialog {
			animation: none;
		}
	}
</style>
