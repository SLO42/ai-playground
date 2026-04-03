<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiPost } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let generating = $state(false);
	let generated = $state(false);
	let generateError = $state('');

	const priorityColors: Record<string, string> = {
		critical: 'text-accent-red',
		high: 'text-accent-yellow',
		medium: 'text-accent-blue',
		low: 'text-text-secondary'
	};

	const priorityBg: Record<string, string> = {
		critical: 'bg-accent-red/20',
		high: 'bg-accent-yellow/20',
		medium: 'bg-accent-blue/20',
		low: 'bg-bg-tertiary'
	};

	const healthColors: Record<string, string> = {
		healthy: 'text-accent-green',
		warning: 'text-accent-yellow',
		error: 'text-accent-red',
		unknown: 'text-text-secondary'
	};

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function timeSince(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	const completionRate = $derived(
		data.stats.total > 0 ? Math.round((data.stats.completed / data.stats.total) * 100) : 0
	);

	async function generateGlobalReport() {
		generating = true;
		generateError = '';
		try {
			const result = await apiPost('/api/reports', { type: 'daily', source: 'project-page' });
			if (result === null) {
				generateError = 'Failed to generate report. Please try again.';
			} else {
				generated = true;
			}
		} catch (err) {
			generateError = err instanceof Error ? err.message : 'An unexpected error occurred.';
		} finally {
			generating = false;
		}
	}
</script>

<svelte:head>
	<title>Reports — {data.projectId} | AI Playground</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">Project Reports</h1>
			<p class="text-sm text-text-secondary mt-1">Task analytics and project health for this project</p>
		</div>
		<div class="flex items-center gap-2">
			<a
				href="/reports"
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
				</svg>
				Global Reports
			</a>
			<div class="flex items-center gap-2">
				<button
					onclick={generateGlobalReport}
					disabled={generating || generated}
					class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium {generateError ? 'bg-accent-red/20 text-accent-red' : 'bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30'} transition-colors disabled:opacity-50"
				>
					{generating ? 'Generating...' : generated ? 'Generated' : generateError ? 'Retry Report' : 'Generate Daily Report'}
				</button>
				{#if generateError}
					<span class="text-xs text-accent-red">{generateError}</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- Task Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Total Tasks" value={data.stats.total} subtitle="all time" accent="blue" />
		<MetricCard label="Completed" value={data.stats.completed} subtitle="{completionRate}% done" accent="green" />
		<MetricCard label="In Progress" value={data.stats.inProgress} subtitle="active" accent="yellow" />
		<MetricCard label="Pending" value={data.stats.pending} subtitle="queued" accent="cyan" />
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- Project Health -->
		<div class="bg-bg-secondary border border-border rounded-lg p-5">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-4">Project Health</h2>
			<div class="space-y-3 text-sm">
				<div class="flex items-center justify-between">
					<span class="text-text-secondary">Status</span>
					<span class="font-medium capitalize {healthColors[data.projectMeta.health ?? 'unknown']}">
						{data.projectMeta.health ?? 'Unknown'}
					</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-text-secondary">Branch</span>
					<span class="font-mono text-text-primary">{data.projectMeta.branch ?? '—'}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-text-secondary">Commits</span>
					<span class="font-mono text-text-primary">{data.projectMeta.commits ?? 0}</span>
				</div>
				{#if data.projectMeta.lastActivity}
					<div class="flex items-center justify-between">
						<span class="text-text-secondary">Last Activity</span>
						<span class="text-text-primary">{timeSince(data.projectMeta.lastActivity)}</span>
					</div>
				{/if}
				<div class="pt-3 border-t border-border">
					<div class="flex items-center justify-between mb-1.5">
						<span class="text-text-secondary">Completion Rate</span>
						<span class="font-mono {completionRate >= 80 ? 'text-accent-green' : completionRate >= 50 ? 'text-accent-yellow' : 'text-accent-red'}">{completionRate}%</span>
					</div>
					<div class="w-full h-2 rounded-full bg-bg-primary overflow-hidden">
						<div
							class="h-full rounded-full transition-all {completionRate >= 80 ? 'bg-accent-green' : completionRate >= 50 ? 'bg-accent-yellow' : 'bg-accent-red'}"
							style="width: {completionRate}%"
						></div>
					</div>
				</div>
			</div>
		</div>

		<!-- Priority Breakdown -->
		<div class="bg-bg-secondary border border-border rounded-lg p-5">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-4">Tasks by Priority</h2>
			{#if data.stats.total === 0}
				<p class="text-sm text-text-secondary text-center py-6">No tasks yet</p>
			{:else}
				<div class="space-y-3">
					{#each Object.entries(data.byPriority) as [priority, count]}
						{#if count > 0}
							<div class="flex items-center gap-3">
								<span class="w-20 text-xs capitalize {priorityColors[priority] ?? 'text-text-secondary'}">{priority}</span>
								<div class="flex-1 h-5 bg-bg-primary rounded overflow-hidden">
									<div
										class="h-full rounded transition-all {priorityBg[priority] ?? 'bg-bg-tertiary'}"
										style="width: {Math.round((count / data.stats.total) * 100)}%"
									></div>
								</div>
								<span class="w-6 text-right text-xs font-mono text-text-primary">{count}</span>
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- Top Tags -->
		<div class="bg-bg-secondary border border-border rounded-lg p-5">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-4">Top Tags</h2>
			{#if data.topTags.length === 0}
				<p class="text-sm text-text-secondary text-center py-6">No tags used yet</p>
			{:else}
				<div class="flex flex-wrap gap-2">
					{#each data.topTags as { tag, count }}
						<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-bg-tertiary text-text-primary border border-border">
							<span>{tag}</span>
							<span class="font-mono text-text-secondary">{count}</span>
						</span>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Recent Completions -->
		<div class="bg-bg-secondary border border-border rounded-lg p-5">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-4">Recently Completed</h2>
			{#if data.recentCompleted.length === 0}
				<p class="text-sm text-text-secondary text-center py-6">No completed tasks yet</p>
			{:else}
				<div class="space-y-2">
					{#each data.recentCompleted as task}
						<div class="flex items-start gap-2 text-sm">
							<svg class="w-4 h-4 text-accent-green shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
							</svg>
							<div class="flex-1 min-w-0">
								<p class="text-text-primary truncate">{task.title}</p>
								{#if task.updatedAt}
									<p class="text-xs text-text-secondary">{timeSince(task.updatedAt)}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
