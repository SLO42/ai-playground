<script lang="ts">
	import type { Task } from '$lib/types/tasks.js';

	interface TaskWithProject extends Task {
		projectId?: string;
		projectName?: string;
		githubIssue?: number;
		githubUrl?: string;
	}

	interface Props {
		task: TaskWithProject;
		agentNames: string[];
		onupdate: (field: string, value: unknown) => void;
		ondelete: () => void;
		onstatuschange?: (taskId: string, task: TaskWithProject) => void;
		showProjectLink?: boolean;
	}

	let { task, agentNames, onupdate, ondelete, onstatuschange, showProjectLink = false }: Props = $props();

	let starting = $state(false);
	let startError = $state<string | null>(null);
	let polling = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		polling = false;
	}

	async function pollStatus() {
		try {
			const res = await fetch(`/api/tasks/${task.id}`);
			if (!res.ok) return;
			const body = await res.json();
			if (body.task && onstatuschange) {
				onstatuschange(task.id, body.task);
			}
			if (body.task?.status === 'completed' || body.task?.status === 'cancelled') {
				stopPolling();
			}
		} catch {
			// network error — keep polling
		}
	}

	function startPolling() {
		stopPolling();
		polling = true;
		pollTimer = setInterval(pollStatus, 2000);
	}

	// Auto-poll for in_progress tasks
	$effect(() => {
		if (task.status === 'in_progress') {
			startPolling();
		} else {
			stopPolling();
		}
		return () => stopPolling();
	});

	async function handleStart() {
		if (starting) return;
		starting = true;
		startError = null;
		try {
			const res = await fetch(`/api/tasks/${task.id}/start`, { method: 'POST' });
			const body = await res.json();
			if (!res.ok) {
				throw new Error(body.message ?? body.error ?? `Start failed (${res.status})`);
			}
			onupdate('status', 'in_progress');
			if (body.task && onstatuschange) {
				onstatuschange(task.id, body.task);
			}
		} catch (e) {
			startError = e instanceof Error ? e.message : 'Failed to start task';
		} finally {
			starting = false;
		}
	}

	function formatDate(iso: string | null): string {
		if (!iso) return '\u2014';
		return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
</script>

<div class="space-y-4">
	<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-4">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<h2 class="text-sm text-text-secondary uppercase tracking-wider">Task Detail</h2>
				{#if showProjectLink && task.projectId && task.projectName}
					<a
						href="/projects/{task.projectId}/tasks"
						class="px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue text-xs font-medium hover:bg-accent-blue/20 transition-colors"
					>
						{task.projectName}
					</a>
				{/if}
				{#if task.githubIssue && task.githubUrl}
					<a
						href={task.githubUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-tertiary text-xs font-mono text-text-secondary hover:text-text-primary transition-colors"
						title="View on GitHub"
					>
						<svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
							<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
						</svg>
						#{task.githubIssue}
					</a>
				{/if}
			</div>
			<span class="text-xs text-text-secondary font-mono">{task.id}</span>
		</div>

		<!-- Title -->
		<input
			type="text"
			value={task.title}
			onchange={(e) => onupdate('title', (e.target as HTMLInputElement).value)}
			class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm font-medium text-text-primary focus:outline-none focus:border-accent-blue"
		/>

		<!-- Description -->
		<textarea
			value={task.description}
			onchange={(e) => onupdate('description', (e.target as HTMLTextAreaElement).value)}
			placeholder="Add a description..."
			rows="4"
			class="w-full bg-bg-primary border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue resize-y"
		></textarea>

		<!-- Priority + Status -->
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="block text-xs text-text-secondary mb-1">Priority</label>
				<select
					value={task.priority}
					onchange={(e) => onupdate('priority', (e.target as HTMLSelectElement).value)}
					class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
				>
					<option value="critical">Critical</option>
					<option value="high">High</option>
					<option value="medium">Medium</option>
					<option value="low">Low</option>
				</select>
			</div>
			<div>
				<label class="block text-xs text-text-secondary mb-1">Status</label>
				<select
					value={task.status}
					onchange={(e) => onupdate('status', (e.target as HTMLSelectElement).value)}
					class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
				>
					<option value="pending">Pending</option>
					<option value="in_progress">In Progress</option>
					<option value="completed">Completed</option>
					<option value="cancelled">Cancelled</option>
				</select>
			</div>
		</div>

		<!-- Assignee -->
		<div>
			<label class="block text-xs text-text-secondary mb-1">Assignee</label>
			<select
				value={task.assignee ?? ''}
				onchange={(e) => onupdate('assignee', (e.target as HTMLSelectElement).value || null)}
				class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none"
			>
				<option value="">Unassigned</option>
				<option value="user">user</option>
				{#each agentNames as agent}
					<option value={agent}>{agent}</option>
				{/each}
			</select>
		</div>

		<!-- Tags -->
		<div>
			<label class="block text-xs text-text-secondary mb-1">Tags (comma-separated)</label>
			<input
				type="text"
				value={task.tags.join(', ')}
				onchange={(e) => onupdate('tags', (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean))}
				placeholder="bug, frontend, urgent"
				class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
			/>
		</div>

		<!-- Flag for Discussion -->
		<label class="flex items-center gap-2 cursor-pointer">
			<input
				type="checkbox"
				checked={task.flagDiscussion}
				onchange={() => onupdate('flagDiscussion', !task.flagDiscussion)}
				class="w-4 h-4 rounded border-border bg-bg-primary accent-accent-yellow"
			/>
			<span class="text-sm text-text-primary">Flag for Discussion</span>
		</label>

		<!-- Timestamps -->
		<div class="grid grid-cols-3 gap-3 pt-3 border-t border-border text-xs text-text-secondary">
			<div>
				<p class="uppercase tracking-wider mb-0.5">Created</p>
				<p class="font-mono text-text-primary">{formatDate(task.createdAt)}</p>
			</div>
			<div>
				<p class="uppercase tracking-wider mb-0.5">Updated</p>
				<p class="font-mono text-text-primary">{formatDate(task.updatedAt)}</p>
			</div>
			<div>
				<p class="uppercase tracking-wider mb-0.5">Completed</p>
				<p class="font-mono text-text-primary">{formatDate(task.completedAt)}</p>
			</div>
		</div>

		<!-- Actions -->
		{#if startError}
			<div class="flex items-center gap-2 px-3 py-2 rounded bg-accent-red/10 border border-accent-red/20 text-accent-red text-xs">
				<span>{startError}</span>
				<button onclick={() => (startError = null)} class="ml-auto hover:text-accent-red/80" aria-label="Dismiss error">&times;</button>
			</div>
		{/if}
		<div class="flex items-center gap-2 pt-3 border-t border-border">
			{#if task.status === 'pending'}
				<button
					onclick={handleStart}
					disabled={starting}
					class="px-3 py-1.5 rounded text-xs font-medium bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors disabled:opacity-50 disabled:cursor-wait"
				>
					{starting ? 'Starting...' : 'Start'}
				</button>
			{/if}
			{#if polling}
				<span class="inline-flex items-center gap-1.5 text-xs text-accent-cyan">
					<span class="w-2 h-2 rounded-full bg-accent-cyan animate-pulse"></span>
					Polling status...
				</span>
			{/if}
			{#if task.status !== 'completed'}
				<button
					onclick={() => onupdate('status', 'completed')}
					class="px-3 py-1.5 rounded text-xs font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors"
				>
					Mark Complete
				</button>
			{:else}
				<button
					onclick={() => onupdate('status', 'pending')}
					class="px-3 py-1.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
				>
					Reopen
				</button>
			{/if}
			{#if showProjectLink && task.projectId}
				<a
					href="/projects/{task.projectId}/tasks"
					class="px-3 py-1.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors"
				>
					Open in Project
				</a>
			{/if}
			<button
				onclick={ondelete}
				class="px-3 py-1.5 rounded text-xs font-medium bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors ml-auto"
			>
				Delete
			</button>
		</div>
	</div>
</div>
