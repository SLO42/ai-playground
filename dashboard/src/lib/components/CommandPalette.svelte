<script lang="ts">
	import { goto } from '$app/navigation';
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
					{/each}
				{/if}
			</div>

			<!-- Footer -->
			<div class="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-text-secondary">
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">↑↓</kbd> navigate</span>
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">↵</kbd> select</span>
				<span><kbd class="px-1 py-0.5 bg-bg-tertiary rounded border border-border font-mono">esc</kbd> close</span>
			</div>
		</div>
	</div>
{/if}
