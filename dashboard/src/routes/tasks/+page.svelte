<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetail from '$lib/components/TaskDetail.svelte';
	import { apiPost, apiPut, apiDelete } from '$lib/api-client.js';
	import { goto } from '$app/navigation';
	import { page as pageStore } from '$app/stores';
	import type { PageData } from './$types.js';
	import type { TaskPriority } from '$lib/types/tasks.js';

	let { data }: { data: PageData } = $props();

	interface ProjectTask {
		id: string;
		title: string;
		description: string;
		status: string;
		priority: string;
		flagDiscussion: boolean;
		assignee: string | null;
		tags: string[];
		createdBy: string;
		createdAt: string;
		updatedAt: string;
		completedAt: string | null;
		projectId: string;
		projectName: string;
		githubIssue?: number;
		githubUrl?: string;
	}

	let tasks = $state<ProjectTask[]>(data.tasks);
	let selectedId = $state<string | null>(null);
	let selected = $derived(tasks.find((t) => t.id === selectedId) ?? null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	// Sync tasks from server data when it changes (navigation)
	$effect(() => {
		tasks = data.tasks;
	});

	// Server-driven pagination & filters
	const pagination = $derived(data.pagination);
	const page = $derived(pagination.page);
	const totalPages = $derived(pagination.totalPages);
	const totalFiltered = $derived(pagination.totalFiltered);
	const filter = $derived(data.filters.filter as 'active' | 'completed' | 'all');
	const projectFilter = $derived(data.filters.project);
	let searchQuery = $state(data.filters.q);

	const pageNumbers = $derived.by(() => {
		const pages: number[] = [];
		const delta = 2;
		for (let i = 1; i <= totalPages; i++) {
			if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) {
				pages.push(i);
			}
		}
		return pages;
	});

	// Navigate with updated search params (server-side pagination)
	function navigate(params: Record<string, string | number>) {
		const url = new URL(window.location.href);
		for (const [key, value] of Object.entries(params)) {
			const strVal = String(value);
			if (strVal === '' || strVal === 'all' || (key === 'page' && strVal === '1') || (key === 'filter' && strVal === 'active')) {
				url.searchParams.delete(key);
			} else {
				url.searchParams.set(key, strVal);
			}
		}
		goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
	}

	function setPage(p: number) { navigate({ page: p }); }
	function setFilter(f: string) { navigate({ filter: f, page: 1 }); }
	function setProjectFilter(id: string) { navigate({ project: id, page: 1 }); }

	let searchTimeout: ReturnType<typeof setTimeout>;
	function handleSearch(q: string) {
		searchQuery = q;
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			navigate({ q, page: 1 });
		}, 300);
	}

	// New task modal
	let showNewTaskModal = $state(false);
	let newTitle = $state('');
	let newPriority = $state<TaskPriority>('medium');
	let newProject = $state(data.projects[0]?.id ?? '');
	let newAssignee = $state('');
	let adding = $state(false);
	let saving = $state(false);

	const summary = $derived(data.summary);

	async function addTask() {
		if (!newTitle.trim() || !newProject || adding) return;
		adding = true;
		try {
			const result = await apiPost<{ task: ProjectTask }>(`/api/projects/${newProject}/tasks`, {
				title: newTitle.trim(),
				priority: newPriority,
				assignee: newAssignee || null
			});
			if (result?.task) {
				const project = data.projects.find((p) => p.id === newProject);
				tasks = [...tasks, { ...result.task, projectId: newProject, projectName: project?.name ?? newProject }];
				newTitle = '';
				newPriority = 'medium';
				newAssignee = '';
				selectedId = result.task.id;
				showNewTaskModal = false;
			}
		} finally {
			adding = false;
		}
	}

	async function updateTask(field: string, value: unknown) {
		if (!selected || saving) return;
		saving = true;
		try {
			const result = await apiPut<{ task: ProjectTask }>(`/api/projects/${selected.projectId}/tasks/${selected.id}`, { [field]: value });
			if (result?.task) {
				const existing = tasks.find((t) => t.id === result.task.id);
				tasks = tasks.map((t) =>
					t.id === result.task.id ? { ...result.task, projectId: existing!.projectId, projectName: existing!.projectName } : t
				);
			}
		} finally {
			saving = false;
		}
	}

	async function deleteTask() {
		if (!selected) return;
		const { id, projectId } = selected;
		const ok = await apiDelete(`/api/projects/${projectId}/tasks/${id}`);
		if (ok) {
			tasks = tasks.filter((t) => t.id !== id);
			selectedId = null;
		}
	}

	// Start task from list
	async function startTask(taskId: string) {
		try {
			const result = await apiPost<{ task: ProjectTask }>(`/api/tasks/${taskId}/start`);
			if (result?.task) {
				handleStatusChange(taskId, result.task);
			}
		} catch {
			// error toast handled by apiPost
		}
	}

	// Status polling callback — updates local task state
	function handleStatusChange(taskId: string, updatedTask: Partial<ProjectTask>) {
		tasks = tasks.map((t) =>
			t.id === taskId
				? { ...t, ...updatedTask, projectId: t.projectId, projectName: t.projectName }
				: t
		);
	}

	// GitHub sync
	let syncing = $state(false);
	let syncResult = $state<string | null>(null);

	async function syncGitHub() {
		syncing = true;
		syncResult = null;
		try {
			const result = await apiPost<{ errors?: string[]; created?: number; updated?: number; pulled?: number }>('/api/github/sync', {
				direction: 'both',
				source: 'dashboard'
			});
			if (!result) {
				syncResult = 'Sync failed';
			} else if (result.errors?.length) {
				syncResult = `Sync done with ${result.errors.length} errors`;
			} else {
				const total = (result.created ?? 0) + (result.updated ?? 0) + (result.pulled ?? 0);
				syncResult = total > 0 ? `Synced ${total} items` : 'Already in sync';
			}
			window.location.reload();
		} catch {
			syncResult = 'Sync failed';
		} finally {
			syncing = false;
			setTimeout(() => { syncResult = null; }, 4000);
		}
	}
</script>

<div class="space-y-6">
	<PageHeader title="Tasks">
		{#snippet actions()}
			{#if syncResult}
				<span class="text-xs text-text-secondary">{syncResult}</span>
			{/if}
			<button
				onclick={syncGitHub}
				disabled={syncing}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors
					{syncing ? 'opacity-50 cursor-wait' : 'hover:bg-bg-secondary'}
					border-border text-text-secondary"
				title="Sync tasks with GitHub issues"
			>
				<svg class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
				{syncing ? 'Syncing...' : 'Sync GitHub'}
			</button>
			<button
				onclick={() => (showNewTaskModal = true)}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
				</svg>
				New Task
			</button>
		{/snippet}
	</PageHeader>

	<!-- Summary -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Active" value={summary.active} subtitle="pending + in progress" accent="green" />
		<MetricCard label="Critical" value={summary.critical} subtitle="needs attention" accent="red" />
		<MetricCard label="High" value={summary.high} subtitle="high priority" accent="yellow" />
		<MetricCard label="Flagged" value={summary.flagged} subtitle="for discussion" accent="cyan" />
	</div>

	<!-- Search -->
	<div class="relative">
		<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
			<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
		</svg>
		<input
			type="text"
			bind:value={searchQuery}
			placeholder="Search tasks by title, description, assignee, tag..."
			aria-label="Search tasks"
			class="w-full bg-bg-secondary border border-border rounded-lg pl-9 pr-8 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 focus:outline-none focus:border-accent-blue transition-colors"
		/>
		{#if searchQuery}
			<button
				onclick={() => (searchQuery = '')}
				class="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
				title="Clear search"
				aria-label="Clear search"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		{/if}
	</div>

	<!-- Main Layout -->
	<div class="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-4">
		<div class="space-y-2">
			{#if loading}
				<div class="bg-bg-secondary border border-border rounded-lg p-8 flex flex-col items-center justify-center gap-2 min-h-[200px]">
					<svg class="w-6 h-6 text-text-secondary animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
					</svg>
					<p class="text-sm text-text-secondary">Loading tasks...</p>
				</div>
			{:else if loadError}
				<div class="bg-bg-secondary border border-accent-red/30 rounded-lg p-8 flex flex-col items-center justify-center gap-2 min-h-[200px]">
					<svg class="w-6 h-6 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
					</svg>
					<p class="text-sm text-accent-red">{loadError}</p>
					<button
						onclick={() => window.location.reload()}
						class="text-xs text-text-secondary hover:text-text-primary underline transition-colors"
					>
						Retry
					</button>
				</div>
			{:else if tasks.length === 0}
				<EmptyState title="No tasks" message="Create a task to get started" icon="📋">
					{#snippet actions()}
						<button
							onclick={() => (showNewTaskModal = true)}
							class="text-xs text-accent-blue hover:underline transition-colors"
						>
							Create your first task
						</button>
					{/snippet}
				</EmptyState>
			{:else if totalFiltered === 0}
				<EmptyState title="No matches" message="No tasks match your current filters" icon="🔍">
					{#snippet actions()}
						<button
							onclick={() => { searchQuery = ''; navigate({ q: '', filter: 'active', project: 'all', page: 1 }); }}
							class="text-xs text-accent-blue hover:underline transition-colors"
						>
							Clear all filters
						</button>
					{/snippet}
				</EmptyState>
			{:else}
			<TaskList
				tasks={tasks}
				{selectedId}
				{filter}
				onselect={(id) => (selectedId = id)}
				onfilter={(f) => setFilter(f)}
				showProjectBadge={true}
				{projectFilter}
				projects={data.projects}
				onprojectfilter={(id) => setProjectFilter(id)}
				taskAnalytics={data.taskAnalytics}
				blockerNames={data.blockerNames}
			/>
			{#if totalPages > 1}
				<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary px-1">
					<span class="shrink-0">{totalFiltered} task{totalFiltered !== 1 ? 's' : ''} — page {page} of {totalPages}</span>
					<nav class="flex flex-wrap items-center gap-1" aria-label="Task pagination">
						<button
							disabled={page <= 1}
							class="px-3 py-1.5 rounded-md border transition-colors {page <= 1 ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
							onclick={() => setPage(Math.max(1, page - 1))}
						>
							Prev
						</button>
						{#each pageNumbers as pageNum, i}
							{@const prev = i > 0 ? pageNumbers[i - 1] : 0}
							{#if prev && pageNum - prev > 1}
								<span class="px-1 text-text-secondary">…</span>
							{/if}
							<button
								class="px-3 py-1.5 rounded-md border transition-colors {pageNum === page ? 'bg-accent-blue text-white border-accent-blue' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
								onclick={() => setPage(pageNum)}
							>
								{pageNum}
							</button>
						{/each}
						<button
							disabled={page >= totalPages}
							class="px-3 py-1.5 rounded-md border transition-colors {page >= totalPages ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
							onclick={() => setPage(Math.min(totalPages, page + 1))}
						>
							Next
						</button>
					</nav>
				</div>
			{/if}
			{/if}
		</div>

		{#if selected}
			<TaskDetail
				task={selected}
				agentNames={data.agentNames}
				onupdate={updateTask}
				ondelete={deleteTask}
				showProjectLink={true}
			/>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-6 flex items-center justify-center min-h-[300px]">
				<p class="text-text-secondary text-sm">Select a task to view details</p>
			</div>
		{/if}
	</div>
</div>

<!-- New Task Modal -->
{#if showNewTaskModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onkeydown={(e) => { if (e.key === 'Escape') showNewTaskModal = false; }}
		onclick={(e) => { if (e.target === e.currentTarget) showNewTaskModal = false; }}
		role="dialog"
		aria-modal="true"
		aria-label="New Task"
	>
		<div class="bg-bg-secondary border border-border rounded-lg shadow-lg w-full max-w-md mx-4">
			<div class="flex items-center justify-between p-4 border-b border-border">
				<h2 class="text-sm font-medium text-text-primary">New Task</h2>
				<button
					onclick={() => (showNewTaskModal = false)}
					class="text-text-secondary hover:text-text-primary transition-colors"
					aria-label="Close"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<form class="p-4 space-y-3" onsubmit={(e) => { e.preventDefault(); addTask(); }}>
				<div>
					<label class="block text-xs text-text-secondary mb-1">Title</label>
					<input
						type="text"
						bind:value={newTitle}
						placeholder="Task title..."
						class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
					/>
				</div>
				<div>
					<label class="block text-xs text-text-secondary mb-1">Project</label>
					<select
						bind:value={newProject}
						class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
					>
						<option value="" disabled>Select project...</option>
						{#each data.projects as project}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-xs text-text-secondary mb-1">Priority</label>
						<select
							bind:value={newPriority}
							class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
						>
							<option value="critical">Critical</option>
							<option value="high">High</option>
							<option value="medium">Medium</option>
							<option value="low">Low</option>
						</select>
					</div>
					<div>
						<label class="block text-xs text-text-secondary mb-1">Assignee</label>
						<select
							bind:value={newAssignee}
							class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
						>
							<option value="">Unassigned</option>
							<option value="user">user</option>
							{#each data.agentNames as agent}
								<option value={agent}>{agent}</option>
							{/each}
						</select>
					</div>
				</div>
				<div class="flex items-center justify-end gap-2 pt-2">
					<button
						type="button"
						onclick={() => (showNewTaskModal = false)}
						class="px-3 py-1.5 rounded text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={adding || !newTitle.trim() || !newProject}
						class="px-4 py-1.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-50"
					>
						{adding ? 'Adding...' : 'Add Task'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
