<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import TaskList from '$lib/components/TaskList.svelte';
	import TaskDetail from '$lib/components/TaskDetail.svelte';
	import { apiPost, apiPut, apiDelete } from '$lib/api-client.js';
	import { navigating } from '$app/stores';
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
	let adding = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	let loading = $derived(!!$navigating);

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
				priority: newPriority
			});
			if (result?.task) {
				tasks = [...tasks, result.task];
				newTitle = '';
				newPriority = 'medium';
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

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="type-page-title text-text-primary">Tasks</h1>
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
			/>

			{#if selected}
				<TaskDetail
					task={selected}
					agentNames={data.agentNames}
					onupdate={updateTask}
					ondelete={deleteTask}
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
