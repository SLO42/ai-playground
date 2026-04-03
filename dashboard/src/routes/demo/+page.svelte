<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { LifecycleTask } from './+page.server.js';

	let { data } = $props();

	const STEP_META: Record<string, { label: string; icon: string; color: string }> = {
		classified:        { label: 'Classified',       icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2', color: 'text-accent-blue' },
		escalation_check:  { label: 'Escalation Check', icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',                                                                                                     color: 'text-accent-yellow' },
		model_selected:    { label: 'Model Selected',   icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z',           color: 'text-accent-purple' },
		context_gathering: { label: 'Gathering Context', icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7',                                                                                               color: 'text-accent-cyan' },
		context_gathered:  { label: 'Context Ready',    icon: 'M9 12l2 2 4-4',                                                                                                                        color: 'text-accent-cyan' },
		spawned:           { label: 'Agent Spawned',    icon: 'M13 10V3L4 14h7v7l9-11h-7z',                                                                                                           color: 'text-accent-green' },
		handoff:           { label: 'Escalated',        icon: 'M7 11l5-5m0 0l5 5m-5-5v12',                                                                                                            color: 'text-accent-yellow' },
		completed:         { label: 'Completed',        icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',                                                                                       color: 'text-accent-green' },
		committed:         { label: 'Committed',        icon: 'M5 13l4 4L19 7',                                                                                                                       color: 'text-green-400' },
		test_run:          { label: 'Tests Run',        icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', color: 'text-accent-blue' },
		review_spawned:    { label: 'Review Started',   icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z', color: 'text-accent-purple' },
		review_findings:   { label: 'Findings',         icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z', color: 'text-accent-yellow' },
		review_completed:  { label: 'Review Done',      icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',                                                                                       color: 'text-accent-purple' },
		follow_up_spawned: { label: 'Follow-up',        icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6',                                                                                                          color: 'text-accent-cyan' },
		follow_up_done:    { label: 'Follow-up Done',   icon: 'M9 12l2 2 4-4',                                                                                                                        color: 'text-accent-cyan' },
		failed:            { label: 'Failed',           icon: 'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z',                                                                color: 'text-accent-red' },
	};

	const statusColors: Record<string, string> = {
		completed: 'bg-accent-green',
		failed: 'bg-accent-red',
		running: 'bg-accent-yellow',
		pending: 'bg-accent-blue'
	};

	const routeLabels: Record<string, string> = {
		openclaw: 'OpenClaw (local, $0)',
		'openclaw-context': 'OpenClaw + Claude Code',
		'claude-code': 'Claude Code (API)'
	};

	let selectedTask: LifecycleTask | null = $state(null);

	function formatDuration(ms: number | undefined): string {
		if (!ms) return '--';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}

	function formatCost(cost: number | undefined): string {
		if (cost === undefined || cost === null) return '--';
		if (cost === 0) return '$0';
		return `$${cost.toFixed(4)}`;
	}

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function eventDetail(event: Record<string, unknown>): string {
		const parts: string[] = [];
		if (event.route) parts.push(`Route: ${routeLabels[event.route as string] ?? event.route}`);
		if (event.model) parts.push(`Model: ${event.model}`);
		if (event.modelTier) parts.push(`Tier: ${event.modelTier}`);
		if (event.provider) parts.push(`Provider: ${event.provider}`);
		if (event.escalated !== undefined) parts.push(event.escalated ? 'Escalated' : 'No escalation needed');
		if (event.escalationReason) parts.push(`Reason: ${event.escalationReason}`);
		if (event.handoffReason) parts.push(`Handoff: ${event.handoffReason}`);
		if (event.durationMs) parts.push(`Duration: ${formatDuration(event.durationMs as number)}`);
		if (event.costUsd !== undefined) parts.push(`Cost: ${formatCost(event.costUsd as number)}`);
		if (event.filesChanged) parts.push(`Files: ${event.filesChanged}`);
		if (event.commitHash) parts.push(`Commit: ${(event.commitHash as string).slice(0, 7)}`);
		if (event.contextLength) parts.push(`Context: ${event.contextLength} chars`);
		if (event.exitCode !== undefined) parts.push(`Exit: ${event.exitCode}`);
		if (event.inputTokens) parts.push(`In: ${event.inputTokens} tok`);
		if (event.outputTokens) parts.push(`Out: ${event.outputTokens} tok`);
		return parts.join(' | ');
	}
</script>

<svelte:head>
	<title>Demo | AI Playground</title>
</svelte:head>

<PageHeader
	title="How Claw Works"
	subtitle="Real task lifecycle data — from creation to completion"
/>

<!-- Summary stats -->
<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
	<MetricCard label="Total Tasks" value={data.summary.totalTasks} accent="blue" />
	<MetricCard label="Completed" value={data.summary.completedTasks} accent="green" />
	<MetricCard label="Failed" value={data.summary.failedTasks} accent="red" />
	<MetricCard label="Avg Duration" value={formatDuration(data.summary.avgDurationMs)} accent="cyan" />
	<MetricCard label="Total Cost" value={formatCost(data.summary.totalCostUsd)} accent="purple" />
	<MetricCard label="Escalation Rate" value={`${(data.escalationRate * 100).toFixed(0)}%`} accent="yellow" />
</div>

<!-- How it works steps -->
<div class="bg-bg-secondary border border-border rounded-lg p-5 mb-8">
	<h2 class="text-sm font-bold text-text-primary mb-4 uppercase tracking-wider">The Claw Pipeline</h2>
	<div class="flex flex-wrap items-center gap-2 text-xs">
		{#each ['Task Created', 'Heartbeat Picks Up', 'Classify & Route', 'Select Model', 'Spawn Agent', 'Execute (code + commit + test)', 'Review (if 3+ files)', 'Follow-ups (docs + memory)'] as step, i}
			{#if i > 0}
				<svg class="w-4 h-4 text-text-secondary shrink-0 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
			{/if}
			<span class="bg-bg-tertiary/50 border border-border px-2.5 py-1.5 rounded font-medium text-text-primary">{step}</span>
		{/each}
	</div>
</div>

<!-- Model distribution -->
{#if data.modelDistribution?.length > 0}
<div class="bg-bg-secondary border border-border rounded-lg p-5 mb-8">
	<h2 class="text-sm font-bold text-text-primary mb-4 uppercase tracking-wider">Model Distribution</h2>
	<div class="flex gap-1 h-6 rounded overflow-hidden mb-3">
		{#each data.modelDistribution as dist}
			{@const barColors: Record<string, string> = { 'gpt-oss-20b': 'bg-accent-cyan', 'claude-sonnet-4-6': 'bg-accent-blue', 'claude-opus-4-6': 'bg-accent-purple' }}
			<div
				class="{barColors[dist.model] ?? 'bg-accent-green'} transition-all"
				style="width: {Math.max(dist.percentage, 2)}%"
				title="{dist.model}: {dist.percentage.toFixed(1)}% ({dist.count} tasks)"
			></div>
		{/each}
	</div>
	<div class="flex flex-wrap gap-4 text-xs text-text-secondary">
		{#each data.modelDistribution as dist}
			{@const dotColors: Record<string, string> = { 'gpt-oss-20b': 'bg-accent-cyan', 'claude-sonnet-4-6': 'bg-accent-blue', 'claude-opus-4-6': 'bg-accent-purple' }}
			<span class="flex items-center gap-1.5">
				<span class="w-2 h-2 rounded-full {dotColors[dist.model] ?? 'bg-accent-green'}"></span>
				{dist.model} ({dist.percentage.toFixed(0)}%)
			</span>
		{/each}
	</div>
</div>
{/if}

<!-- Task lifecycle list + detail panel -->
<div class="grid grid-cols-1 lg:grid-cols-5 gap-4">
	<!-- Task list -->
	<div class="lg:col-span-2 space-y-2 max-h-[70vh] overflow-y-auto pr-1">
		<h2 class="text-sm font-bold text-text-primary mb-3 uppercase tracking-wider sticky top-0 bg-bg-primary pb-2 z-10">
			Recent Tasks ({data.lifecycleTasks.length})
		</h2>
		{#each data.lifecycleTasks as task (task.taskId)}
			<button
				class="w-full text-left bg-bg-secondary border rounded-lg p-3 transition-colors
					{selectedTask?.taskId === task.taskId ? 'border-accent-blue bg-accent-blue/5' : 'border-border hover:border-border hover:bg-bg-tertiary/30'}"
				onclick={() => selectedTask = task}
			>
				<div class="flex items-start gap-2">
					<span class="mt-1 w-2 h-2 rounded-full shrink-0 {statusColors[task.status]}"></span>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium text-text-primary truncate">{task.taskTitle}</p>
						<div class="flex flex-wrap gap-2 mt-1 text-xs text-text-secondary">
							{#if task.route}
								<span>{routeLabels[task.route] ?? task.route}</span>
							{/if}
							{#if task.durationMs}
								<span>{formatDuration(task.durationMs)}</span>
							{/if}
							{#if task.costUsd !== undefined}
								<span>{formatCost(task.costUsd)}</span>
							{/if}
							<span>{task.events.length} steps</span>
						</div>
					</div>
				</div>
			</button>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
				<p class="text-sm text-text-secondary">No lifecycle data yet. Create and run tasks to see the pipeline in action.</p>
			</div>
		{/each}
	</div>

	<!-- Detail panel -->
	<div class="lg:col-span-3">
		{#if selectedTask}
			<div class="bg-bg-secondary border border-border rounded-lg p-5 sticky top-4">
				<div class="flex items-center justify-between mb-4">
					<div class="min-w-0 flex-1">
						<h3 class="text-sm font-bold text-text-primary truncate">{selectedTask.taskTitle}</h3>
						<p class="text-xs text-text-secondary mt-0.5 font-mono">{selectedTask.taskId}</p>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<span class="w-2 h-2 rounded-full {statusColors[selectedTask.status]}"></span>
						<span class="text-xs font-medium text-text-secondary uppercase">{selectedTask.status}</span>
					</div>
				</div>

				<!-- Summary badges -->
				<div class="flex flex-wrap gap-2 mb-5">
					{#if selectedTask.route}
						<span class="text-xs bg-accent-blue/10 text-accent-blue px-2 py-0.5 rounded">{routeLabels[selectedTask.route] ?? selectedTask.route}</span>
					{/if}
					{#if selectedTask.model}
						<span class="text-xs bg-accent-purple/10 text-accent-purple px-2 py-0.5 rounded">{selectedTask.model}</span>
					{/if}
					{#if selectedTask.hadReview}
						<span class="text-xs bg-accent-yellow/10 text-accent-yellow px-2 py-0.5 rounded">Review</span>
					{/if}
					{#if selectedTask.hadFollowUp}
						<span class="text-xs bg-accent-cyan/10 text-accent-cyan px-2 py-0.5 rounded">Follow-up</span>
					{/if}
					{#if selectedTask.commitHash}
						<span class="text-xs bg-green-500/10 text-green-400 px-2 py-0.5 rounded font-mono">{selectedTask.commitHash.slice(0, 7)}</span>
					{/if}
				</div>

				<!-- Event timeline -->
				<div class="relative pl-6 space-y-0">
					{#each selectedTask.events as event, i}
						{@const meta = STEP_META[event.type] ?? { label: event.type, icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', color: 'text-text-secondary' }}
						<div class="relative pb-5 {i === selectedTask.events.length - 1 ? '' : ''}">
							<!-- Connector line -->
							{#if i < selectedTask.events.length - 1}
								<div class="absolute left-[-16px] top-5 bottom-0 w-px bg-border"></div>
							{/if}
							<!-- Icon node -->
							<div class="absolute left-[-22px] top-0.5 w-3.5 h-3.5 rounded-full bg-bg-primary border-2 border-border flex items-center justify-center">
								<svg class="w-2 h-2 {meta.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
									<path stroke-linecap="round" stroke-linejoin="round" d={meta.icon} />
								</svg>
							</div>
							<!-- Content -->
							<div>
								<div class="flex items-center gap-2">
									<span class="text-xs font-semibold {meta.color}">{meta.label}</span>
									<span class="text-[0.65rem] text-text-secondary font-mono">{formatTime(event.timestamp)}</span>
								</div>
								{#if eventDetail(event as unknown as Record<string, unknown>)}
									<p class="text-xs text-text-secondary mt-0.5 leading-relaxed">{eventDetail(event as unknown as Record<string, unknown>)}</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center sticky top-4">
				<svg class="w-10 h-10 text-text-secondary mx-auto mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
				</svg>
				<p class="text-sm text-text-secondary">Select a task to see its full lifecycle</p>
				<p class="text-xs text-text-secondary mt-1">Each step shows how Claw classified, routed, and executed the work</p>
			</div>
		{/if}
	</div>
</div>
