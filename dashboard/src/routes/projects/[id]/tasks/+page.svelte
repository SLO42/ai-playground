<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetail from '$lib/components/TaskDetail.svelte';
	import { apiPost, apiPut, apiDelete } from '$lib/api-client.js';
	import { navigating } from '$app/stores';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';
	import type { Task, TaskPriority } from '$lib/types/tasks.js';

	let { data }: { data: PageData } = $props();

	let tasks = $state<Task[]>(data.tasks);
	let selectedId = $state<string | null>(null);
	let selected = $derived(tasks.find((t) => t.id === selectedId) ?? null);
	let filter = $state<'active' | 'completed' | 'all'>('active');

	// New task modal
	let showNewTaskModal = $state(false);
	let newTitle = $state('');
	let newPriority = $state<TaskPriority>('medium');
	let newBlockedBy = $state<string[]>([]);
	let adding = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	/** Tasks eligible to be blockers (pending/in-progress from this project). */
	const blockerCandidates = $derived(
		tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress')
	);

	/** Check if a task is blocked (has unresolved blockers). */
	function isTaskBlocked(task: Task): boolean {
		if (!task.blockedBy?.length) return false;
		return task.blockedBy.some((depId) => {
			const dep = tasks.find((t) => t.id === depId);
			return dep && dep.status !== 'completed' && dep.status !== 'cancelled';
		});
	}

	/** Get the blocking tasks for a given task. */
	function getBlockers(task: Task): Task[] {
		if (!task.blockedBy?.length) return [];
		return task.blockedBy
			.map((depId) => tasks.find((t) => t.id === depId))
			.filter((t): t is Task => !!t && t.status !== 'completed' && t.status !== 'cancelled');
	}

	let loading = $derived(!!$navigating);

	// GitHub sync state
	let syncing = $state(false);
	let syncRepo = $state(data.syncStatus?.repo ?? '');
	let lastSync = $state(data.syncStatus?.lastSync ?? null);
	let syncMappings = $state(data.syncStatus?.mappings ?? 0);
	let showSyncMenu = $state(false);

	const hasGitHub = $derived(!!syncRepo && syncRepo !== 'unknown');

	function timeSince(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	async function triggerSync(direction: 'both' | 'pull' | 'push' = 'both') {
		if (syncing) return;
		syncing = true;
		showSyncMenu = false;
		error = null;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/tasks/sync`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ direction })
			});
			const result = await res.json();

			if (result.error && !res.ok) {
				throw new Error(result.error);
			}

			// Refresh tasks from server
			const taskRes = await fetch(`/api/projects/${data.projectId}/tasks?full=true`);
			const taskData = await taskRes.json();
			if (taskData.tasks) tasks = taskData.tasks;

			// Update sync status
			const statusRes = await fetch(`/api/projects/${data.projectId}/tasks/sync`);
			const status = await statusRes.json();
			syncRepo = status.repo ?? syncRepo;
			lastSync = status.lastSync ?? lastSync;
			syncMappings = status.mappings ?? syncMappings;

			const parts: string[] = [];
			if (result.created > 0) parts.push(`${result.created} pushed`);
			if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
			if (result.updated > 0) parts.push(`${result.updated} updated`);
			if (result.errors?.length > 0) parts.push(`${result.errors.length} error(s)`);
			const msg = parts.length > 0 ? parts.join(', ') : 'Already in sync';

			notifications.push(
				result.errors?.length > 0 ? 'warning' : 'success',
				'GitHub sync complete',
				msg
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'Sync failed';
			error = msg;
			notifications.push('error', 'GitHub sync failed', msg);
		} finally {
			syncing = false;
		}
	}

	// Close sync menu on outside click
	function handleWindowClick(e: MouseEvent) {
		if (showSyncMenu && !(e.target as HTMLElement)?.closest?.('.relative')) {
			showSyncMenu = false;
		}
	}

	const filteredTasks = $derived.by(() => {
		if (filter === 'active') return tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
		if (filter === 'completed') return tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled');
		return tasks;
	});

	const summary = $derived.by(() => {
		const active = tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
		const completed = tasks.filter((t) => t.status === 'completed').length;
		const flagged = tasks.filter((t) => t.flagDiscussion && t.status !== 'completed').length;
		return { total: tasks.length, active, completed, flagged };
	});

	function clearError() { error = null; }

	async function addTask() {
		if (!newTitle.trim() || adding) return;
		adding = true;
		error = null;
		try {
			const result = await apiPost<{ task: Task }>(`/api/projects/${data.projectId}/tasks`, {
				title: newTitle.trim(),
				priority: newPriority,
				blockedBy: newBlockedBy.length > 0 ? newBlockedBy : undefined
			});
			if (result?.task) {
				tasks = [...tasks, result.task];
				newTitle = '';
				newPriority = 'medium';
				newBlockedBy = [];
				selectedId = result.task.id;
				showNewTaskModal = false;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to add task';
		} finally {
			adding = false;
		}
	}

	async function updateTask(field: string, value: unknown) {
		if (!selected || saving) return;
		saving = true;
		error = null;
		try {
			const result = await apiPut<{ task: Task }>(`/api/projects/${data.projectId}/tasks/${selected.id}`, { [field]: value });
			if (result?.task) {
				tasks = tasks.map((t) => (t.id === result.task.id ? result.task : t));
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to update task';
		} finally {
			saving = false;
		}
	}

	async function deleteTask() {
		if (!selected) return;
		const id = selected.id;
		error = null;
		try {
			const ok = await apiDelete(`/api/projects/${data.projectId}/tasks/${id}`);
			if (ok) {
				tasks = tasks.filter((t) => t.id !== id);
				selectedId = null;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete task';
		}
	}
</script>

<svelte:window onclick={handleWindowClick} />

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">Tasks</h1>
			{#if hasGitHub}
				<p class="text-xs text-text-secondary mt-0.5 flex items-center gap-1.5">
					<svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
					<span class="font-mono">{syncRepo}</span>
					{#if lastSync}
						<span class="text-text-secondary/60">synced {timeSince(lastSync)}</span>
					{/if}
					{#if syncMappings > 0}
						<span class="text-text-secondary/60">{syncMappings} linked</span>
					{/if}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if hasGitHub}
				<div class="relative">
					<button
						onclick={() => triggerSync('both')}
						disabled={syncing}
						class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
					>
						<svg class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M2.985 19.644l3.181-3.182" />
						</svg>
						{syncing ? 'Syncing...' : 'Sync Issues'}
					</button>
					<button
						onclick={() => (showSyncMenu = !showSyncMenu)}
						disabled={syncing}
						class="absolute -right-6 top-0 bottom-0 px-1.5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
						aria-label="Sync options"
					>
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
					</button>
					{#if showSyncMenu}
						<div class="absolute right-0 top-full mt-1 w-48 bg-bg-secondary border border-border rounded-lg shadow-lg z-20 py-1">
							<button
								onclick={() => triggerSync('pull')}
								class="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary transition-colors flex items-center gap-2"
							>
								<svg class="w-3 h-3 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" /></svg>
								Pull from GitHub
							</button>
							<button
								onclick={() => triggerSync('push')}
								class="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary transition-colors flex items-center gap-2"
							>
								<svg class="w-3 h-3 text-accent-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" /></svg>
								Push to GitHub
							</button>
							<button
								onclick={() => triggerSync('both')}
								class="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-tertiary transition-colors flex items-center gap-2"
							>
								<svg class="w-3 h-3 text-accent-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
								Sync both ways
							</button>
						</div>
					{/if}
				</div>
			{/if}
			<button
				onclick={() => (showNewTaskModal = true)}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
				</svg>
				New Task
			</button>
		</div>
	</div>

	<!-- Error Banner -->
	{#if error}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
			</svg>
			<span class="flex-1">{error}</span>
			<button onclick={clearError} class="text-accent-red/70 hover:text-accent-red transition-colors">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/if}

	<!-- Loading Indicator -->
	{#if loading}
		<div class="flex items-center gap-2 text-text-secondary text-sm">
			<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			Loading tasks...
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Total" value={summary.total} subtitle="tasks" accent="blue" />
		<MetricCard label="Active" value={summary.active} subtitle="pending + in progress" accent="green" />
		<MetricCard label="Completed" value={summary.completed} subtitle="finished" accent="cyan" />
		<MetricCard label="Flagged" value={summary.flagged} subtitle="for discussion" accent="yellow" />
	</div>

	<!-- Main Layout -->
	{#if tasks.length === 0 && !loading}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No tasks yet</h2>
			<p class="text-text-secondary text-xs mb-4">Create your first task to get started</p>
			<button
				onclick={() => (showNewTaskModal = true)}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
				</svg>
				New Task
			</button>
		</div>
	{:else}
		<div class="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
			<TaskList
				tasks={filteredTasks}
				{selectedId}
				{filter}
				onselect={(id) => (selectedId = id)}
				onfilter={(f) => (filter = f)}
				isBlocked={isTaskBlocked}
				getBlockers={(t) => getBlockers(t).map((b) => ({ id: b.id, title: b.title }))}
			/>

			{#if selected}
				<TaskDetail
					task={selected}
					agentNames={data.agentNames}
					onupdate={updateTask}
					ondelete={deleteTask}
					blockers={getBlockers(selected)}
					isBlocked={isTaskBlocked(selected)}
					allTasks={tasks}
					onselecttask={(id) => (selectedId = id)}
				/>
			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg p-6 flex items-center justify-center min-h-[300px]">
					<p class="text-text-secondary text-sm">Select a task to view details</p>
				</div>
			{/if}
		</div>
	{/if}
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
				{#if blockerCandidates.length > 0}
					<div>
						<label class="block text-xs text-text-secondary mb-1">Blocked by</label>
						<div class="max-h-32 overflow-y-auto border border-border rounded bg-bg-primary p-1.5 space-y-1">
							{#each blockerCandidates as candidate}
								<label class="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-bg-tertiary cursor-pointer text-xs text-text-primary">
									<input
										type="checkbox"
										checked={newBlockedBy.includes(candidate.id)}
										onchange={() => {
											if (newBlockedBy.includes(candidate.id)) {
												newBlockedBy = newBlockedBy.filter((id) => id !== candidate.id);
											} else {
												newBlockedBy = [...newBlockedBy, candidate.id];
											}
										}}
										class="accent-accent-blue"
									/>
									<span class="truncate">{candidate.title}</span>
								</label>
							{/each}
						</div>
						{#if newBlockedBy.length > 0}
							<p class="text-xs text-text-secondary mt-1">{newBlockedBy.length} task(s) selected</p>
						{/if}
					</div>
				{/if}
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
						disabled={adding || !newTitle.trim()}
						class="px-4 py-1.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-50"
					>
						{adding ? 'Adding...' : 'Add Task'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
