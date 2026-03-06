<script lang="ts">
	let {
		hooks,
		total,
		currentPage,
		totalPages,
		pageSize,
		loading = false,
		ondelete,
		ontoggle,
	}: {
		hooks: Array<{ name: string; type: string; description: string; command?: string; enabled: boolean }>;
		total: number;
		currentPage: number;
		totalPages: number;
		pageSize: number;
		loading: boolean;
		ondelete: (name: string) => void;
		ontoggle: (name: string, enabled: boolean) => void;
	} = $props();

	const typeBadgeColors: Record<string, string> = {
		pre: 'bg-accent-blue/20 text-accent-blue',
		post: 'bg-accent-green/20 text-accent-green',
		lifecycle: 'bg-accent-purple/20 text-accent-purple',
		routing: 'bg-accent-yellow/20 text-accent-yellow',
		learning: 'bg-accent-cyan/20 text-accent-cyan'
	};

	function goToPage(page: number) {
		if (page < 1 || page > totalPages) return;
		const url = new URL(window.location.href);
		url.searchParams.set('page', String(page));
		window.location.href = url.toString();
	}
</script>

<section aria-label="Hook registry">
	<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">
		Hook Registry ({total})
	</h2>

	<ul class="bg-bg-secondary border border-border rounded-lg overflow-hidden list-none m-0 p-0" role="list">
		{#each hooks as hook}
			<li class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
				<span class="text-sm font-mono font-bold text-text-primary w-32 truncate">{hook.name}</span>
				<span class="text-[10px] px-2 py-0.5 rounded font-mono {typeBadgeColors[hook.type] ?? 'bg-bg-tertiary text-text-secondary'}">{hook.type}</span>
				<span class="text-xs text-text-secondary flex-1 truncate">{hook.description}</span>
				{#if hook.command}
					<span class="text-xs font-mono text-text-secondary truncate max-w-40">{hook.command}</span>
				{/if}
				<button
					onclick={() => ontoggle(hook.name, !hook.enabled)}
					disabled={loading}
					class="flex items-center gap-1.5 hover:opacity-80 transition-opacity disabled:opacity-50"
					aria-label="{hook.enabled ? 'Disable' : 'Enable'} hook {hook.name}"
				>
					<span class="w-2 h-2 rounded-full {hook.enabled ? 'bg-accent-green' : 'bg-bg-tertiary'}" aria-hidden="true"></span>
					<span class="text-xs {hook.enabled ? 'text-accent-green' : 'text-text-secondary'}">
						{hook.enabled ? 'enabled' : 'disabled'}
					</span>
				</button>
				<button
					onclick={() => ondelete(hook.name)}
					disabled={loading}
					class="text-xs text-accent-red hover:text-accent-red/80 transition-colors disabled:opacity-50"
					aria-label="Delete hook {hook.name}"
				>
					Delete
				</button>
			</li>
		{:else}
			<li class="px-6 py-10 text-center">
				<div class="text-3xl mb-3 opacity-40" aria-hidden="true">&#x2699;</div>
				<p class="text-text-primary text-sm font-medium">No hooks configured</p>
				<p class="text-text-secondary text-xs mt-1">Hooks let you run commands before or after key project events.</p>
			</li>
		{/each}
	</ul>

	<!-- Pagination -->
	{#if totalPages > 1}
		<nav aria-label="Hooks pagination" class="flex items-center justify-between mt-4">
			<span class="text-xs text-text-secondary">
				Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, total)} of {total}
			</span>
			<div class="flex items-center gap-1">
				<button
					onclick={() => goToPage(currentPage - 1)}
					disabled={currentPage <= 1}
					aria-label="Previous page"
					class="px-3 py-1.5 text-xs bg-bg-secondary border border-border rounded-lg text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Prev
				</button>
				{#each Array(totalPages) as _, i}
					<button
						onclick={() => goToPage(i + 1)}
						aria-label="Page {i + 1}"
						aria-current={i + 1 === currentPage ? 'page' : undefined}
						class="px-3 py-1.5 text-xs rounded-lg transition-colors {i + 1 === currentPage ? 'bg-accent-blue text-white' : 'bg-bg-secondary border border-border text-text-primary hover:bg-bg-tertiary'}"
					>
						{i + 1}
					</button>
				{/each}
				<button
					onclick={() => goToPage(currentPage + 1)}
					disabled={currentPage >= totalPages}
					aria-label="Next page"
					class="px-3 py-1.5 text-xs bg-bg-secondary border border-border rounded-lg text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Next
				</button>
			</div>
		</nav>
	{/if}
</section>
