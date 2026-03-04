<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let filter = $state<'all' | 'active' | 'archived'>('all');
	let search = $state('');

	const filtered = $derived(
		data.projects
			.filter((p) => filter === 'all' || p.status === filter)
			.filter(
				(p) =>
					!search ||
					p.name.toLowerCase().includes(search.toLowerCase()) ||
					p.description.toLowerCase().includes(search.toLowerCase())
			)
	);

	const healthStatus: Record<string, 'online' | 'warning' | 'error'> = {
		healthy: 'online',
		warning: 'warning',
		error: 'error'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Projects</h1>
			<p class="text-sm text-text-secondary mt-1">
				{data.projects.length} projects registered
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

	<!-- Search + Filters -->
	<div class="flex items-center gap-3">
		<input
			type="text"
			placeholder="Search projects..."
			bind:value={search}
			class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
		/>
		<div class="flex gap-1">
			{#each ['all', 'active', 'archived'] as f}
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

	<!-- Project Cards Grid -->
	{#if filtered.length > 0}
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			{#each filtered as project (project.id)}
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
						{#if project.status === 'archived'}
							<span class="text-xs px-2 py-0.5 bg-bg-tertiary text-text-secondary rounded">Archived</span>
						{/if}
					</div>

					<p class="text-xs text-text-secondary mb-3 line-clamp-2">{project.description}</p>

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
</div>
