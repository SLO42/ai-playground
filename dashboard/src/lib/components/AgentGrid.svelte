<script lang="ts">
	let {
		agents,
		pagination,
		typeColors,
		statusDots,
		loading,
		onremove,
		ongoToPage
	}: {
		agents: Array<{ name: string; type: string; status: string; description?: string; filename: string }>;
		pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
		typeColors: Record<string, string>;
		statusDots: Record<string, string>;
		loading: boolean;
		onremove: (filename: string) => void;
		ongoToPage: (p: number) => void;
	} = $props();

	const pageNumbers = $derived(() => {
		const { page: current, totalPages } = pagination;
		const pages: (number | '...')[] = [];
		if (totalPages <= 7) {
			for (let i = 1; i <= totalPages; i++) pages.push(i);
		} else {
			pages.push(1);
			if (current > 3) pages.push('...');
			for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) {
				pages.push(i);
			}
			if (current < totalPages - 2) pages.push('...');
			pages.push(totalPages);
		}
		return pages;
	});
</script>

{#if agents.length > 0}
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4" role="list" aria-label="Agents">
		{#each agents as agent}
			<div class="bg-bg-secondary border border-border rounded-lg p-4" role="listitem">
				<div class="flex items-center justify-between mb-2">
					<div class="flex items-center gap-2">
						<span class="w-2.5 h-2.5 rounded-full {statusDots[agent.status] ?? statusDots.idle}" role="img" aria-label="Status: {agent.status}"></span>
						<span class="text-sm font-bold text-text-primary">{agent.name}</span>
					</div>
					<span class="text-[10px] px-2 py-0.5 rounded font-mono {typeColors[agent.type] ?? typeColors.general}">{agent.type}</span>
				</div>
				{#if agent.description}
					<p class="text-xs text-text-secondary mb-3">{agent.description}</p>
				{/if}
				<div class="flex items-center justify-between pt-3 border-t border-border">
					<span class="text-[10px] text-text-secondary font-mono">{agent.filename}</span>
					<button
						onclick={() => onremove(agent.filename)}
						disabled={loading}
						class="px-2 py-1 text-xs rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors disabled:opacity-50"
						aria-label="Remove agent {agent.name}"
					>
						Remove
					</button>
				</div>
			</div>
		{/each}
	</div>

	{#if pagination.totalPages > 1}
		<span class="sr-only" aria-live="polite" aria-atomic="true">
			Page {pagination.page} of {pagination.totalPages}
		</span>
		<nav class="flex items-center justify-between mt-6" aria-label="Agent list pagination">
			<span class="text-xs text-text-secondary">
				Showing {(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.totalItems)} of {pagination.totalItems} agents
			</span>
			<div
				class="flex items-center gap-1"
				role="group"
				aria-label="Pagination controls"
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'ArrowLeft' && pagination.page > 1) {
						e.preventDefault();
						ongoToPage(pagination.page - 1);
						// Focus the new current page button after navigation
						const nav = (e.currentTarget as HTMLElement);
						requestAnimationFrame(() => {
							const current = nav.querySelector('[aria-current="page"]') as HTMLElement | null;
							current?.focus();
						});
					} else if (e.key === 'ArrowRight' && pagination.page < pagination.totalPages) {
						e.preventDefault();
						ongoToPage(pagination.page + 1);
						const nav = (e.currentTarget as HTMLElement);
						requestAnimationFrame(() => {
							const current = nav.querySelector('[aria-current="page"]') as HTMLElement | null;
							current?.focus();
						});
					} else if (e.key === 'Home') {
						e.preventDefault();
						ongoToPage(1);
						const nav = (e.currentTarget as HTMLElement);
						requestAnimationFrame(() => {
							const current = nav.querySelector('[aria-current="page"]') as HTMLElement | null;
							current?.focus();
						});
					} else if (e.key === 'End') {
						e.preventDefault();
						ongoToPage(pagination.totalPages);
						const nav = (e.currentTarget as HTMLElement);
						requestAnimationFrame(() => {
							const current = nav.querySelector('[aria-current="page"]') as HTMLElement | null;
							current?.focus();
						});
					}
				}}
			>
				<button
					onclick={() => ongoToPage(pagination.page - 1)}
					disabled={pagination.page <= 1}
					aria-label="Go to previous page, page {pagination.page - 1}"
					class="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
				>
					Prev
				</button>
				{#each pageNumbers() as p}
					{#if p === '...'}
						<span class="px-2 py-1 text-xs text-text-secondary" aria-hidden="true">...</span>
					{:else}
						<button
							onclick={() => ongoToPage(p)}
							aria-label="Go to page {p}"
							aria-current={p === pagination.page ? 'page' : undefined}
							class="px-2.5 py-1 text-xs rounded border transition-colors {p === pagination.page ? 'border-accent-blue bg-accent-blue/20 text-accent-blue font-bold' : 'border-border text-text-secondary hover:bg-bg-tertiary'}"
						>
							{p}
						</button>
					{/if}
				{/each}
				<button
					onclick={() => ongoToPage(pagination.page + 1)}
					disabled={pagination.page >= pagination.totalPages}
					aria-label="Go to next page, page {pagination.page + 1}"
					class="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
				>
					Next
				</button>
			</div>
		</nav>
	{/if}
{:else}
	<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-10 text-center">
		<div class="text-3xl mb-3 opacity-40" aria-hidden="true">&#129302;</div>
		<p class="text-text-primary text-sm font-medium">No agents associated</p>
		<p class="text-text-secondary text-xs mt-1">Add agents to this project to enable AI-powered task execution.</p>
	</div>
{/if}
