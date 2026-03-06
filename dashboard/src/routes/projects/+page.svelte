<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { apiDelete } from '$lib/api-client.js';
	import { notifications } from '$lib/stores/notifications.js';
	import type { Project } from '$lib/types/projects.js';

	let projects = $state<Project[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let deleteTarget = $state<Project | null>(null);
	let confirmText = $state('');
	let deleting = $state(false);

	async function handleDelete() {
		if (!deleteTarget || confirmText !== deleteTarget.name) return;
		deleting = true;
		const ok = await apiDelete(`/api/projects/${deleteTarget.id}`);
		deleting = false;
		if (ok) {
			notifications.push('success', 'Project Removed', `${deleteTarget.name} has been removed.`);
			deleteTarget = null;
			confirmText = '';
			fetchProjects();
		}
	}

	async function toggleFavorite(project: Project, e: Event) {
		e.preventDefault();
		e.stopPropagation();
		const newVal = !project.favorite;
		project.favorite = newVal;
		try {
			const res = await fetch('/api/projects', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: project.id, favorite: newVal })
			});
			if (!res.ok) {
				project.favorite = !newVal;
				notifications.push('error', 'Error', 'Failed to update favorite');
			}
		} catch {
			project.favorite = !newVal;
		}
	}

	let filter = $state<'all' | 'active' | 'archived' | 'unconfigured'>('all');
	let search = $state('');
	let tagFilter = $state('');
	let page = $state(1);
	const perPage = 12;

	$effect(() => {
		fetchProjects();
	});

	async function fetchProjects() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/projects');
			if (!res.ok) throw new Error(`Failed to fetch projects: ${res.statusText}`);
			const data = await res.json();
			projects = data.projects ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	const allTags = $derived(
		[...new Set(projects.flatMap((p: Project) => p.tags))].sort()
	);

	const filtered = $derived(
		projects
			.filter((p: Project) => filter === 'all' || p.status === filter)
			.filter((p: Project) => !tagFilter || p.tags.includes(tagFilter))
			.filter(
				(p: Project) =>
					!search ||
					p.name.toLowerCase().includes(search.toLowerCase()) ||
					p.description.toLowerCase().includes(search.toLowerCase()) ||
					p.tags.some((t: string) => t.toLowerCase().includes(search.toLowerCase()))
			)
			.sort((a, b) => {
				// Favorites always first
				if (a.favorite && !b.favorite) return -1;
				if (!a.favorite && b.favorite) return 1;
				return 0;
			})
	);

	const total = $derived(filtered.length);
	const totalPages = $derived(Math.max(1, Math.ceil(total / perPage)));

	// Reset page when filters change
	$effect(() => {
		filter; search; tagFilter;
		page = 1;
	});

	const paged = $derived(filtered.slice((page - 1) * perPage, page * perPage));

	const pageNumbers = $derived(() => {
		const pages: number[] = [];
		const delta = 2;
		for (let i = 1; i <= totalPages; i++) {
			if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) {
				pages.push(i);
			}
		}
		return pages;
	});

	const healthStatus: Record<string, 'online' | 'warning' | 'error' | 'offline'> = {
		healthy: 'online',
		warning: 'warning',
		error: 'error',
		unknown: 'offline'
	};

	const tagColors: Record<string, string> = {
		monorepo: 'bg-accent-purple/20 text-accent-purple',
		'ai-platform': 'bg-accent-blue/20 text-accent-blue',
		dashboard: 'bg-accent-cyan/20 text-accent-cyan',
		webapp: 'bg-accent-green/20 text-accent-green',
		'game-mod': 'bg-accent-yellow/20 text-accent-yellow'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Projects</h1>
			<p class="text-sm text-text-secondary mt-1">
				{#if loading}
					Loading projects...
				{:else}
					{projects.length} project{projects.length !== 1 ? 's' : ''} registered{#if totalPages > 1} — page {page} of {totalPages}{/if}
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<a
				href="/projects/import"
				class="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
			>
				Import
			</a>
			<a
				href="/projects/create"
				class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				+ New Project
			</a>
		</div>
	</div>

	<!-- Loading State -->
	{#if loading}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
			<div class="inline-block w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin mb-3"></div>
			<p class="text-text-secondary text-sm">Scanning projects...</p>
		</div>
	{:else if error}
		<div class="bg-bg-secondary border border-accent-red/30 rounded-lg p-8 text-center">
			<p class="text-accent-red text-sm mb-3">{error}</p>
			<button
				onclick={fetchProjects}
				class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				Retry
			</button>
		</div>
	{:else}
		<!-- Search + Filters -->
		<div class="flex items-center gap-3">
			<input
				type="text"
				placeholder="Search projects..."
				bind:value={search}
				class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
			/>
			<div class="flex gap-1">
				{#each ['all', 'active', 'archived', 'unconfigured'] as f}
					<button
						class="px-3 py-2 text-xs rounded-md border transition-colors
							{filter === f
							? 'bg-accent-blue text-white border-accent-blue'
							: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
						onclick={() => (filter = f as typeof filter)}
					>
						{f.charAt(0).toUpperCase() + f.slice(1)}
					</button>
				{/each}
			</div>
		</div>

		<!-- Tag Filter -->
		{#if allTags.length > 0}
			<div class="flex items-center gap-2 flex-wrap">
				<span class="text-xs text-text-secondary">Tags:</span>
				<button
					class="text-xs px-2 py-0.5 rounded transition-colors {!tagFilter ? 'bg-accent-blue text-white' : 'bg-bg-secondary text-text-secondary hover:text-text-primary'}"
					onclick={() => (tagFilter = '')}
				>
					All
				</button>
				{#each allTags as tag}
					<button
						class="text-xs px-2 py-0.5 rounded transition-colors {tagFilter === tag ? 'bg-accent-blue text-white' : tagColors[tag] ?? 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
						onclick={() => (tagFilter = tagFilter === tag ? '' : tag)}
					>
						{tag}
					</button>
				{/each}
			</div>
		{/if}

		<!-- Project Cards Grid -->
		{#if paged.length > 0}
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{#each paged as project (project.id)}
					<a
						href="/projects/{project.id}"
						class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/50 transition-colors group block"
					>
						<div class="flex items-start justify-between mb-3">
							<div class="flex items-center gap-2">
								<StatusBadge status={healthStatus[project.health]} size="sm" />
								<h2 class="text-sm font-bold text-text-primary group-hover:text-accent-blue transition-colors">
									{project.name}
								</h2>
							</div>
							<div class="flex items-center gap-2">
								{#if project.status === 'archived'}
									<span class="text-xs px-2 py-0.5 bg-bg-tertiary text-text-secondary rounded">Archived</span>
								{:else if project.status === 'unconfigured'}
									<span class="text-xs px-2 py-0.5 bg-accent-yellow/20 text-accent-yellow rounded">Unconfigured</span>
								{/if}
								<button
									onclick={(e) => toggleFavorite(project, e)}
									title={project.favorite ? 'Remove from favorites' : 'Add to favorites'}
									class="p-1 transition-all rounded {project.favorite ? 'text-accent-yellow' : 'opacity-0 group-hover:opacity-100 text-text-secondary hover:text-accent-yellow'} hover:bg-accent-yellow/10"
								>
									<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill={project.favorite ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
									</svg>
								</button>
								<button
									onclick={(e) => { e.preventDefault(); e.stopPropagation(); deleteTarget = project; confirmText = ''; }}
									title="Remove project"
									class="opacity-0 group-hover:opacity-100 p-1 text-text-secondary hover:text-accent-red transition-all rounded hover:bg-accent-red/10"
								>
									<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
									</svg>
								</button>
							</div>
						</div>

						<p class="text-xs text-text-secondary mb-3 line-clamp-2">{project.description}</p>

						<!-- Tags -->
						{#if project.tags.length > 0}
							<div class="flex flex-wrap gap-1 mb-2">
								{#each project.tags as tag}
									<span class="text-[10px] px-1.5 py-0.5 rounded {tagColors[tag] ?? 'bg-bg-tertiary text-text-secondary'}">
										{tag}
									</span>
								{/each}
							</div>
						{/if}

						<!-- Tech Stack Badges -->
						<div class="flex flex-wrap gap-1 mb-3">
							{#each project.techStack as tech}
								<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">
									{tech}
								</span>
							{/each}
						</div>

						<!-- Stats Row -->
						<div class="flex items-center gap-4 text-xs text-text-secondary pt-3 border-t border-border">
							<span>{project.agents} agents</span>
							<span>{project.sessions} sessions</span>
							<span>{project.memoryNodes} memory</span>
							{#if project.stats.totalToolUses}
								<span>{project.stats.totalToolUses} tool uses</span>
							{/if}
							<span class="ml-auto font-mono">{project.lastOpened}</span>
						</div>
					</a>
				{/each}
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
				<p class="text-text-secondary">No projects found matching your criteria.</p>
			</div>
		{/if}

		<!-- Pagination -->
		{#if totalPages > 1}
			<nav class="flex items-center justify-center gap-1 pt-2">
				<button
					disabled={page <= 1}
					class="px-3 py-2 text-xs rounded-md border transition-colors {page <= 1 ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
					onclick={() => (page = Math.max(1, page - 1))}
				>
					Prev
				</button>

				{#each pageNumbers() as pageNum, i}
					{@const prev = i > 0 ? pageNumbers()[i - 1] : 0}
					{#if prev && pageNum - prev > 1}
						<span class="px-1 text-xs text-text-secondary">…</span>
					{/if}
					<button
						class="px-3 py-2 text-xs rounded-md border transition-colors {pageNum === page ? 'bg-accent-blue text-white border-accent-blue' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
						onclick={() => (page = pageNum)}
					>
						{pageNum}
					</button>
				{/each}

				<button
					disabled={page >= totalPages}
					class="px-3 py-2 text-xs rounded-md border transition-colors {page >= totalPages ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
					onclick={() => (page = Math.min(totalPages, page + 1))}
				>
					Next
				</button>
			</nav>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Modal -->
{#if deleteTarget}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onkeydown={(e) => { if (e.key === 'Escape') deleteTarget = null; }}
		role="dialog"
		aria-modal="true"
		aria-label="Remove Project"
	>
		<div class="absolute inset-0" onclick={() => (deleteTarget = null)} role="presentation"></div>
		<div class="relative bg-bg-primary border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
			<h3 class="text-lg font-bold text-text-primary">Remove Project</h3>
			<p class="text-sm text-text-secondary">
				This will remove <strong class="text-text-primary">{deleteTarget.name}</strong> from the dashboard. Project files on disk will not be deleted.
			</p>
			<div>
				<label for="confirm-delete" class="text-xs text-text-secondary block mb-1">
					Type <strong class="text-text-primary">{deleteTarget.name}</strong> to confirm
				</label>
				<input
					id="confirm-delete"
					type="text"
					bind:value={confirmText}
					placeholder={deleteTarget.name}
					class="w-full bg-bg-secondary border border-border rounded px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-red"
				/>
			</div>
			<div class="flex items-center justify-end gap-3 pt-2">
				<button
					onclick={() => (deleteTarget = null)}
					class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={handleDelete}
					disabled={confirmText !== deleteTarget.name || deleting}
					class="px-4 py-2 text-sm rounded-lg transition-colors {confirmText === deleteTarget.name && !deleting ? 'bg-accent-red text-white hover:bg-accent-red/90' : 'bg-bg-tertiary text-text-secondary cursor-not-allowed'}"
				>
					{deleting ? 'Removing...' : 'Remove Project'}
				</button>
			</div>
		</div>
	</div>
{/if}
