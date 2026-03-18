<script lang="ts">
	import { goto } from '$app/navigation';
<<<<<<< HEAD

	interface CommandItem {
		href: string;
		label: string;
		section: string;
		keywords?: string[];
		icon: string;
	}

	let open = $state(false);
	let query = $state('');
	let selectedIndex = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();

	const commands: CommandItem[] = [
		{ href: '/', label: 'Home', section: 'Navigation', keywords: ['dashboard', 'overview'], icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4' },
		{ href: '/chat', label: 'Chat', section: 'Navigation', keywords: ['message', 'conversation', 'talk'], icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
		{ href: '/projects', label: 'Projects', section: 'Navigation', keywords: ['workspace', 'folder'], icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
		{ href: '/projects/create', label: 'Create Project', section: 'Actions', keywords: ['new project'], icon: 'M12 4v16m8-8H4' },
		{ href: '/projects/import', label: 'Import Project', section: 'Actions', keywords: ['import', 'github'], icon: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12' },
		{ href: '/tasks', label: 'Tasks', section: 'Navigation', keywords: ['todo', 'backlog', 'work'], icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
		{ href: '/models', label: 'Models', section: 'Navigation', keywords: ['llm', 'ollama', 'claude', 'routing', 'ai'], icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z' },
		{ href: '/agents', label: 'Agents', section: 'Navigation', keywords: ['bot', 'worker', 'swarm'], icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
		{ href: '/agents/create', label: 'Create Agent', section: 'Actions', keywords: ['new agent', 'spawn'], icon: 'M12 4v16m8-8H4' },
		{ href: '/channels', label: 'Channels', section: 'Navigation', keywords: ['twitch', 'discord', 'messaging'], icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
		{ href: '/apps', label: 'Apps', section: 'Navigation', keywords: ['marketplace', 'plugins', 'extensions'], icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
		{ href: '/memory', label: 'Memory', section: 'Navigation', keywords: ['database', 'vector', 'knowledge', 'store'], icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16M9 11h.01M15 11h.01M9 15h.01M15 15h.01' },
		{ href: '/security', label: 'Security', section: 'Navigation', keywords: ['scan', 'audit', 'vulnerability'], icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
		{ href: '/hooks', label: 'Hooks', section: 'Navigation', keywords: ['automation', 'events', 'triggers'], icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
		{ href: '/reports', label: 'Reports', section: 'Navigation', keywords: ['analytics', 'charts', 'metrics'], icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
		{ href: '/sessions', label: 'Sessions', section: 'Navigation', keywords: ['active', 'running', 'live'], icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ href: '/inbox', label: 'Inbox', section: 'Navigation', keywords: ['notifications', 'messages', 'unread'], icon: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4' },
		{ href: '/settings', label: 'Settings', section: 'Navigation', keywords: ['config', 'preferences', 'options'], icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
		{ href: '/services', label: 'Services', section: 'Navigation', keywords: ['server', 'api', 'endpoints', 'mcp'], icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01' },
		{ href: '/about', label: 'About', section: 'Navigation', keywords: ['info', 'version', 'help'], icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
	];

	function matchesQuery(item: CommandItem, q: string): boolean {
		if (!q) return true;
		const lower = q.toLowerCase();
		const terms = lower.split(/\s+/).filter(Boolean);
		const searchable = [item.label, item.section, item.href, ...(item.keywords ?? [])].join(' ').toLowerCase();
		return terms.every((term) => searchable.includes(term));
	}

	let filtered = $derived.by(() => {
		const results = commands.filter((c) => matchesQuery(c, query));
		// Group by section, actions first when searching
		if (query) return results;
		const actions = results.filter((c) => c.section === 'Actions');
		const nav = results.filter((c) => c.section === 'Navigation');
		return [...actions, ...nav];
	});

	$effect(() => {
		// Reset selection when filtered list changes
		filtered;
		selectedIndex = 0;
	});

	function openPalette() {
		open = true;
		query = '';
		selectedIndex = 0;
		// Focus input on next tick
		requestAnimationFrame(() => inputEl?.focus());
	}

	function closePalette() {
		open = false;
		query = '';
	}

	function selectItem(item: CommandItem) {
		closePalette();
		goto(item.href);
	}

	function handleKeydown(e: KeyboardEvent) {
		// Global: Ctrl+K or Cmd+K to open
		if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
			e.preventDefault();
			if (open) {
				closePalette();
			} else {
				openPalette();
			}
			return;
		}

		if (!open) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			closePalette();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % Math.max(filtered.length, 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(filtered.length, 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filtered[selectedIndex];
			if (item) selectItem(item);
		}
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) closePalette();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- Backdrop -->
	<div
		role="presentation"
		class="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh]"
		onclick={handleBackdropClick}
		onkeydown={(e) => { if (e.key === 'Escape') closePalette(); }}
	>
		<div role="dialog" aria-modal="true" aria-label="Command palette" class="w-full max-w-lg bg-bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden">
			<!-- Search input -->
			<div class="flex items-center gap-3 px-4 py-3 border-b border-border">
				<svg aria-hidden="true" class="w-5 h-5 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
				</svg>
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					role="combobox"
					aria-label="Search pages and actions"
					aria-expanded="true"
					aria-controls="command-palette-list"
					aria-activedescendant={filtered[selectedIndex] ? `cmd-item-${selectedIndex}` : undefined}
					autocomplete="off"
					placeholder="Search pages, actions..."
					class="flex-1 bg-transparent text-text-primary placeholder:text-text-secondary text-sm outline-none"
				/>
				<kbd class="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary text-[10px] font-mono border border-border">
					ESC
				</kbd>
			</div>

			<!-- Results -->
			<div id="command-palette-list" role="listbox" aria-label="Search results" class="max-h-80 overflow-y-auto py-2">
				{#if filtered.length === 0}
					<div class="px-4 py-8 text-center text-text-secondary text-sm" role="status">
						No results for "{query}"
					</div>
				{:else}
					{@const sections = [...new Set(filtered.map((c) => c.section))]}
					{#each sections as section}
						<div class="px-3 pt-2 pb-1" role="presentation">
							<span class="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">{section}</span>
						</div>
						{#each filtered.filter((c) => c.section === section) as item, i}
							{@const globalIndex = filtered.indexOf(item)}
							<div
								id="cmd-item-{globalIndex}"
								role="option"
								aria-selected={globalIndex === selectedIndex}
								class="flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors
									{globalIndex === selectedIndex
										? 'bg-accent-blue/15 text-accent-blue'
										: 'text-text-primary hover:bg-bg-tertiary/50'}"
								onclick={() => selectItem(item)}
								onmouseenter={() => (selectedIndex = globalIndex)}
							>
								<svg aria-hidden="true" class="w-4 h-4 flex-shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
								</svg>
								<span class="flex-1">{item.label}</span>
								{#if globalIndex === selectedIndex}
									<kbd class="text-[10px] font-mono text-text-secondary">Enter</kbd>
								{/if}
							</div>
						{/each}
=======
	import { page } from '$app/state';

	interface Props {
		open?: boolean;
		onclose?: () => void;
	}

	let { open = $bindable(false), onclose }: Props = $props();

	let query = $state('');
	let selectedIndex = $state(0);

	const commands = [
		{ label: 'Go to Home', shortcut: 'G H', action: () => goto('/'), category: 'Navigation' },
		{ label: 'Go to Projects', shortcut: 'G P', action: () => goto('/projects'), category: 'Navigation' },
		{ label: 'Go to Agents', shortcut: 'G A', action: () => goto('/agents'), category: 'Navigation' },
		{ label: 'Go to Models', shortcut: 'G M', action: () => goto('/models'), category: 'Navigation' },
		{ label: 'Go to Inbox', shortcut: 'G I', action: () => goto('/inbox'), category: 'Navigation' },
		{ label: 'Go to Settings', shortcut: 'G S', action: () => goto('/settings'), category: 'Navigation' },
		{ label: 'Go to Sessions', shortcut: '', action: () => goto('/sessions'), category: 'Navigation' },
		{ label: 'Go to Memory', shortcut: '', action: () => goto('/memory'), category: 'Navigation' },
		{ label: 'Go to Security', shortcut: '', action: () => goto('/security'), category: 'Navigation' },
		{ label: 'Go to Hooks', shortcut: '', action: () => goto('/hooks'), category: 'Navigation' },
		{ label: 'Go to Services', shortcut: '', action: () => goto('/services'), category: 'Navigation' },
		{ label: 'Go to Channels', shortcut: '', action: () => goto('/channels'), category: 'Navigation' },
		{ label: 'Go to Apps', shortcut: '', action: () => goto('/apps'), category: 'Navigation' },
		{ label: 'Go to Notifications', shortcut: '', action: () => goto('/notifications'), category: 'Navigation' }
	];

	const filtered = $derived(
		query.trim()
			? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
			: commands
	);

	$effect(() => {
		if (open) {
			query = '';
			selectedIndex = 0;
		}
	});

	function close() {
		open = false;
		onclose?.();
	}

	function execute(index: number) {
		const cmd = filtered[index];
		if (cmd) {
			cmd.action();
			close();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % filtered.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			execute(selectedIndex);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	}
</script>

{#if open}
	<!-- Backdrop -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/50 z-[100] flex items-start justify-center pt-[15vh] md:pt-[20vh]"
		onkeydown={handleKeydown}
		onclick={(e) => { if (e.target === e.currentTarget) close(); }}
	>
		<!-- Panel -->
		<div class="w-full max-w-lg mx-4 bg-bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden">
			<!-- Search Input -->
			<div class="flex items-center gap-3 px-4 py-3 border-b border-border">
				<svg class="w-4 h-4 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
				</svg>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					bind:value={query}
					onkeydown={handleKeydown}
					placeholder="Type a command..."
					autofocus
					class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
				/>
				<kbd class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded border border-border font-mono">ESC</kbd>
			</div>

			<!-- Results -->
			<div class="max-h-72 overflow-y-auto py-2">
				{#if filtered.length === 0}
					<div class="px-4 py-6 text-center text-sm text-text-secondary">No results found</div>
				{:else}
					{#each filtered as cmd, i}
						<button
							class="w-full flex items-center justify-between px-4 py-2 text-sm transition-colors
								{i === selectedIndex ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary hover:bg-bg-tertiary'}"
							onclick={() => execute(i)}
							onmouseenter={() => (selectedIndex = i)}
						>
							<span>{cmd.label}</span>
							{#if cmd.shortcut}
								<kbd class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded border border-border font-mono">{cmd.shortcut}</kbd>
							{/if}
						</button>
>>>>>>> worktree-agent-a855fd15
					{/each}
				{/if}
			</div>

			<!-- Footer -->
<<<<<<< HEAD
			<div class="flex items-center gap-4 px-4 py-2 border-t border-border text-[10px] text-text-secondary">
				<span class="flex items-center gap-1">
					<kbd class="px-1 py-0.5 rounded bg-bg-tertiary border border-border font-mono">↑↓</kbd>
					navigate
				</span>
				<span class="flex items-center gap-1">
					<kbd class="px-1 py-0.5 rounded bg-bg-tertiary border border-border font-mono">↵</kbd>
					select
				</span>
				<span class="flex items-center gap-1">
					<kbd class="px-1 py-0.5 rounded bg-bg-tertiary border border-border font-mono">esc</kbd>
					close
				</span>
=======
			<div class="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-text-secondary">
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">↑↓</kbd> navigate</span>
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">↵</kbd> select</span>
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">esc</kbd> close</span>
>>>>>>> worktree-agent-a855fd15
			</div>
		</div>
	</div>
{/if}
