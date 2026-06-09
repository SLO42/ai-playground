<script lang="ts">
	/**
	 * CommandPalette — Cmd/Ctrl-K fuzzy command + nav launcher (UI-SPEC §3, §148,
	 * §271 "command palette as the keyboard backbone"). Keyboard-driven, focus-trapped,
	 * Esc-closes, role=dialog + aria. Jumps to any page/project, or fires an action
	 * (start a manual run). Tokens-only; reduced-motion respected.
	 *
	 * Single nav truth: navigation commands come from the shared `navGroups` (Sidebar's
	 * source). Projects come live from the layout load (honest empty if none / DB down).
	 */
	import { goto } from '$app/navigation';
	import { rankItems } from './fuzzy';
	import { buildCommands, type Command, type PaletteProject } from './commands';
	import { toasts } from '$lib/client/toast.svelte';

	let {
		projects = [],
		onstartrun
	}: {
		/** Live project list for the "Open project" commands. */
		projects?: PaletteProject[];
		/** Fired when the user picks "Start manual run" — host wires the real action. */
		onstartrun?: () => void;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let activeIndex = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let listEl = $state<HTMLDivElement | null>(null);
	let restoreFocus: HTMLElement | null = null;

	// The full command set (rebuilt when projects change). Action callbacks fire a
	// toast so the operator gets feedback even before a real run is wired end-to-end
	// (honest: it announces the intent, the host's onstartrun does the real work).
	const commands = $derived<Command[]>(
		buildCommands(projects, {
			startManualRun: () => {
				onstartrun?.();
				toasts.info('Start manual run', 'Choose a project to run.');
			}
		})
	);

	// Ranked + filtered results for the current query.
	const results = $derived(rankItems(query, commands).map((r) => r.item));

	// Group results by section, preserving the ranked order within each section.
	const grouped = $derived.by(() => {
		const order: string[] = [];
		const map = new Map<string, Command[]>();
		for (const cmd of results) {
			if (!map.has(cmd.section)) {
				map.set(cmd.section, []);
				order.push(cmd.section);
			}
			map.get(cmd.section)!.push(cmd);
		}
		return order.map((section) => ({ section, items: map.get(section)! }));
	});

	// A flat, ranked list aligned with the visual order, for arrow-key navigation.
	const flat = $derived(grouped.flatMap((g) => g.items));

	function openPalette() {
		restoreFocus = (document.activeElement as HTMLElement) ?? null;
		open = true;
		query = '';
		activeIndex = 0;
		queueMicrotask(() => inputEl?.focus());
	}

	function closePalette() {
		open = false;
		const target = restoreFocus;
		restoreFocus = null;
		queueMicrotask(() => target?.focus?.());
	}

	function runCommand(cmd: Command | undefined) {
		if (!cmd) return;
		closePalette();
		if (cmd.kind === 'action') {
			cmd.run?.();
		} else if (cmd.href) {
			void goto(cmd.href);
		}
	}

	// Keep the active row in range as the result set shrinks while typing.
	$effect(() => {
		void query;
		if (activeIndex >= flat.length) activeIndex = Math.max(0, flat.length - 1);
	});

	// Global Cmd/Ctrl-K toggle (the §271 backbone). Bound on window so it works from
	// any focused element; ignores when typing in another input UNLESS it's the combo.
	function onWindowKeydown(e: KeyboardEvent) {
		const isToggle = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
		if (isToggle) {
			e.preventDefault();
			if (open) closePalette();
			else openPalette();
		}
	}

	// Within the palette: arrow navigation, Enter to run, Esc to close, Tab trapped.
	function onPaletteKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			closePalette();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (flat.length) activeIndex = (activeIndex + 1) % flat.length;
			scrollActiveIntoView();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (flat.length) activeIndex = (activeIndex - 1 + flat.length) % flat.length;
			scrollActiveIntoView();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			runCommand(flat[activeIndex]);
		} else if (e.key === 'Tab') {
			// Trap focus inside the dialog — only the input + rows matter, so just keep
			// focus on the input (rows are mouse/arrow-driven, not Tab-stops).
			e.preventDefault();
			inputEl?.focus();
		}
	}

	function scrollActiveIntoView() {
		queueMicrotask(() => {
			const el = listEl?.querySelector<HTMLElement>('[data-active="true"]');
			el?.scrollIntoView({ block: 'nearest' });
		});
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<div class="overlay">
		<!-- Backdrop dismiss as a real button (the project's established scrim pattern in
		     +layout.svelte) — accessible click-outside without a static-interaction warning.
		     tabindex -1 keeps it out of the Tab order (Esc is the keyboard close path). -->
		<button
			type="button"
			class="scrim"
			tabindex="-1"
			aria-label="Close command palette"
			onclick={() => closePalette()}
		></button>
		<div
			class="palette"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			tabindex="-1"
			onkeydown={onPaletteKeydown}
		>
			<div class="search">
				<span class="search-icon mono" aria-hidden="true">⌕</span>
				<input
					bind:this={inputEl}
					bind:value={query}
					class="search-input mono"
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-autocomplete="list"
					aria-activedescendant={flat[activeIndex] ? `palette-opt-${flat[activeIndex].id}` : undefined}
					placeholder="Jump to a page, project, or action…"
					autocomplete="off"
					spellcheck="false"
				/>
				<kbd class="hint mono">esc</kbd>
			</div>

			<div bind:this={listEl} class="list" id="palette-list" role="listbox">
				{#if flat.length === 0}
					<div class="empty">No commands match "{query}".</div>
				{:else}
					{#each grouped as group (group.section)}
						<div class="group" role="group" aria-label={group.section}>
							<div class="eyebrow group-title">{group.section}</div>
							{#each group.items as cmd (cmd.id)}
								{@const idx = flat.indexOf(cmd)}
								<button
									type="button"
									id="palette-opt-{cmd.id}"
									class="option"
									role="option"
									aria-selected={idx === activeIndex}
									data-active={idx === activeIndex}
									onmousemove={() => (activeIndex = idx)}
									onclick={() => runCommand(cmd)}
								>
									<span class="option-label">{cmd.label}</span>
									{#if cmd.hint}
										<span class="option-hint mono">{cmd.hint}</span>
									{/if}
								</button>
							{/each}
						</div>
					{/each}
				{/if}
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
		align-items: flex-start;
		justify-content: center;
		padding-top: 12vh;
		padding-inline: var(--pad-panel);
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
	.palette {
		position: relative;
		width: min(560px, 100%);
		max-height: 64vh;
		display: flex;
		flex-direction: column;
		background: var(--color-surface-raised);
		border: var(--border-width) solid var(--color-border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-overlay);
		overflow: hidden;
		animation: palette-in var(--motion-normal) var(--ease-out);
	}

	.search {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4) var(--space-5);
		border-bottom: var(--border-width) solid var(--color-border);
	}
	.search-icon {
		color: var(--color-text-subtle);
		font-size: var(--text-md);
	}
	.search-input {
		flex: 1 1 auto;
		min-width: 0;
		background: transparent;
		border: 0;
		color: var(--color-text);
		font-size: var(--text-base);
	}
	.search-input::placeholder {
		color: var(--color-text-subtle);
	}
	/* The input owns its own focus via the textbox itself; the visible ring would be
	   redundant inside the modal, so we suppress it with a transparent outline (NOT
	   outline:none — keeps a real ring in forced-colors mode per §9). */
	.search-input:focus-visible {
		outline: 2px solid transparent;
		box-shadow: none;
	}
	.hint {
		flex: 0 0 auto;
		padding: var(--space-1) var(--space-2);
		border: var(--border-width) solid var(--color-border);
		border-radius: var(--radius-xs);
		font-size: var(--text-2xs);
		color: var(--color-text-subtle);
	}

	.list {
		overflow-y: auto;
		padding: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.group-title {
		padding: 0 var(--space-3);
		margin-bottom: var(--space-1);
	}
	.option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		width: 100%;
		padding: var(--space-3) var(--space-3);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-2);
		font: var(--type-body-sm);
		text-align: left;
		cursor: pointer;
	}
	.option[data-active='true'] {
		background: var(--color-surface-selected);
		color: var(--color-text-accent);
	}
	.option-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.option-hint {
		flex: 0 0 auto;
		font-size: var(--text-xs);
		color: var(--color-text-subtle);
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		padding: var(--space-6) var(--space-4);
		text-align: center;
		font: var(--type-body-sm);
		color: var(--color-text-muted);
	}

	@keyframes scrim-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes palette-in {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.scrim,
		.palette {
			animation: none;
		}
	}
</style>
