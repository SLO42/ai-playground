<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Task } from '$lib/types/tasks.js';

	interface TaskItem extends Task {
		projectId?: string;
		projectName?: string;
		githubIssue?: number;
	}

	interface TaskAnalyticsInfo {
		lastEvent: string;
		model?: string;
		durationMs?: number;
		status: 'pending' | 'running' | 'completed' | 'failed';
	}

	interface Props {
		tasks: TaskItem[];
		selectedId: string | null;
		filter: 'active' | 'completed' | 'all';
		onselect: (id: string) => void;
		onfilter: (filter: 'active' | 'completed' | 'all') => void;
		onstart?: (id: string) => void;
		showProjectBadge?: boolean;
		projectFilter?: string;
		projects?: { id: string; name: string }[];
		onprojectfilter?: (projectId: string) => void;
		/** Returns true if the task is blocked by incomplete dependencies. */
		isBlocked?: (task: TaskItem) => boolean;
		/** Returns the list of blocking tasks for tooltip display. */
		getBlockers?: (task: TaskItem) => { id: string; title: string }[];
		/** Agent analytics per task */
		taskAnalytics?: Record<string, TaskAnalyticsInfo>;
		/** Resolved blocker task titles per task */
		blockerNames?: Record<string, string[]>;
	}

	let {
		tasks,
		selectedId,
		filter,
		onselect,
		onfilter,
		onstart,
		showProjectBadge = false,
		projectFilter = 'all',
		projects = [],
		onprojectfilter,
		isBlocked,
		getBlockers,
		taskAnalytics = {},
		blockerNames = {}
	}: Props = $props();

	let startingId = $state<string | null>(null);

	const priorityColors: Record<string, string> = {
		critical: 'bg-accent-red',
		high: 'bg-accent-yellow',
		medium: 'bg-accent-blue',
		low: 'bg-border'
	};

	const statusBadgeMap: Record<string, 'online' | 'pending' | 'offline' | 'warning'> = {
		pending: 'pending',
		in_progress: 'online',
		completed: 'offline',
		cancelled: 'warning'
	};

	const statusLabels: Record<string, string> = {
		pending: 'Pending',
		in_progress: 'Active',
		completed: 'Done',
		cancelled: 'Cancelled'
	};

	// Agent event badge colors — static lookup, no dynamic interpolation
	const agentEventBgColors: Record<string, string> = {
		completed: 'bg-accent-green/15',
		failed: 'bg-accent-red/15',
		spawned: 'bg-accent-cyan/15',
		model_selected: 'bg-accent-purple/15',
		classified: 'bg-accent-blue/15',
		context_gathering: 'bg-accent-yellow/15',
		context_gathered: 'bg-accent-yellow/15',
		committed: 'bg-accent-green/15',
		handoff: 'bg-accent-purple/15'
	};
	const agentEventTextColors: Record<string, string> = {
		completed: 'text-accent-green',
		failed: 'text-accent-red',
		spawned: 'text-accent-cyan',
		model_selected: 'text-accent-purple',
		classified: 'text-accent-blue',
		context_gathering: 'text-accent-yellow',
		context_gathered: 'text-accent-yellow',
		committed: 'text-accent-green',
		handoff: 'text-accent-purple'
	};
	const agentEventLabels: Record<string, string> = {
		completed: 'Completed',
		failed: 'Failed',
		spawned: 'Spawned',
		model_selected: 'Model selected',
		classified: 'Classified',
		context_gathering: 'Gathering context',
		context_gathered: 'Context ready',
		committed: 'Committed',
		handoff: 'Handed off',
		escalation_check: 'Escalation check',
		learning_extracted: 'Learning extracted',
		follow_up_spawned: 'Follow-up',
		follow_up_done: 'Follow-up done',
		test_run: 'Tests ran'
	};

	const defaultEventBg = 'bg-bg-tertiary';
	const defaultEventText = 'text-text-secondary';

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}
</script>

<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
	<!-- Filter Row -->
	<div class="flex items-center border-b border-border">
		<!-- Tab filters -->
		<div class="flex flex-1">
			{#each [['active', 'Active'], ['completed', 'Completed'], ['all', 'All']] as [key, label]}
				<button
					class="flex-1 py-2 text-xs font-medium transition-colors
						{filter === key ? 'text-accent-blue border-b-2 border-accent-blue' : 'text-text-secondary hover:text-text-primary'}"
					onclick={() => onfilter(key as 'active' | 'completed' | 'all')}
				>
					{label}
				</button>
			{/each}
		</div>
		<!-- Project filter (global page only) -->
		{#if showProjectBadge && projects.length > 0 && onprojectfilter}
			<select
				value={projectFilter}
				onchange={(e) => onprojectfilter!((e.target as HTMLSelectElement).value)}
				class="bg-transparent border-l border-border px-2 py-2 text-xs text-text-secondary focus:outline-none"
			>
				<option value="all">All projects</option>
				{#each projects as project}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
		{/if}
	</div>

	<!-- Task List -->
	<div class="divide-y divide-border max-h-[500px] overflow-y-auto">
		{#each tasks as task}
			<div
				class="flex items-center p-3 hover:bg-bg-tertiary transition-colors {task.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-blue' : ''}"
			>
				<button
					class="flex-1 text-left"
					onclick={() => onselect(task.id)}
				>
					<div class="flex items-start gap-2 mb-1">
						<span class="mt-1.5 w-2 h-2 rounded-full flex-shrink-0 {priorityColors[task.priority]}"></span>
						<span class="text-sm font-medium text-text-primary leading-tight line-clamp-2 flex-1">{task.title}</span>
						{#if task.id.startsWith('gh-')}
							<svg class="w-3 h-3 text-text-secondary/50 flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor" aria-label="Synced from GitHub"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
						{/if}
						{#if task.flagDiscussion}
							<svg class="w-3.5 h-3.5 text-accent-yellow flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2z" />
							</svg>
						{/if}
						{#if isBlocked?.(task)}
							{@const blockers = getBlockers?.(task) ?? []}
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-red/15 text-accent-red flex-shrink-0"
								title={blockers.length > 0 ? `Blocked by: ${blockers.map((b) => b.title).join(', ')}` : 'Blocked'}
							>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
									<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
								</svg>
								Blocked
							</span>
						{/if}
					</div>
					<div class="flex items-center gap-2 text-xs text-text-secondary ml-4 flex-wrap">
						{#if showProjectBadge && task.projectName}
							<span class="px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue font-medium">{task.projectName}</span>
						{/if}
						<StatusBadge status={statusBadgeMap[task.status]} label={statusLabels[task.status]} size="sm" />
						{#if task.status === 'in_progress'}
							<span class="w-2 h-2 rounded-full bg-accent-cyan animate-pulse" title="Running"></span>
						{/if}
						{#if taskAnalytics[task.id]}
							{@const info = taskAnalytics[task.id]}
							<span
								class="px-1.5 py-0.5 rounded text-[10px] font-medium {agentEventBgColors[info.lastEvent] ?? defaultEventBg} {agentEventTextColors[info.lastEvent] ?? defaultEventText}"
								title="Agent: {info.lastEvent}{info.model ? ` (${info.model})` : ''}"
							>
								{agentEventLabels[info.lastEvent] ?? info.lastEvent}
							</span>
							{#if info.durationMs != null}
								<span class="text-[10px] text-text-secondary" title="Agent duration">{formatDuration(info.durationMs)}</span>
							{/if}
						{/if}
						{#if task.githubIssue}
							<span class="px-1.5 py-0.5 rounded bg-bg-tertiary font-mono">#{task.githubIssue}</span>
						{/if}
						{#if task.assignee}
							<span class="px-1.5 py-0.5 rounded bg-bg-tertiary">{task.assignee}</span>
						{/if}
						{#each task.tags.slice(0, 2) as tag}
							<span class="px-1.5 py-0.5 rounded bg-bg-tertiary">{tag}</span>
						{/each}
					</div>
					{#if blockerNames[task.id]?.length}
						<p class="text-[10px] text-text-secondary/70 ml-4 mt-0.5 line-clamp-1">
							Blocked by: {blockerNames[task.id].join(', ')}
						</p>
					{/if}
				</button>
				{#if task.status === 'pending' && onstart}
					<button
						onclick={(e: MouseEvent) => {
							e.stopPropagation();
							startingId = task.id;
							onstart!(task.id);
						}}
						disabled={startingId === task.id}
						class="ml-2 flex-shrink-0 px-2.5 py-1 rounded text-xs font-medium bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30 transition-colors disabled:opacity-50 disabled:cursor-wait"
						title="Start task"
					>
						{startingId === task.id ? '...' : 'Start'}
					</button>
				{/if}
			</div>
		{:else}
			<div class="p-6 text-center">
				<p class="text-text-secondary text-sm">No tasks found</p>
				<p class="text-text-secondary text-xs mt-1">Create a task to get started.</p>
			</div>
		{/each}
	</div>
</div>
