<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiPost } from '$lib/api-client.js';
	import { navigating } from '$app/stores';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let workflows = $state(data.workflows ?? []);
	let recentRuns = $state(data.recentRuns ?? []);
	let error = $state<string | null>(null);
	let loading = $derived(!!$navigating);
	let triggeringId = $state<string | null>(null);

	// ── Derived metrics ────────────────────────────────────────────────

	const totalWorkflows = $derived(workflows.length);

	const successRate = $derived.by(() => {
		const completed = recentRuns.filter((r) => r.status === 'completed');
		if (completed.length === 0) return '--';
		const successes = completed.filter((r) => r.conclusion === 'success').length;
		return `${Math.round((successes / completed.length) * 100)}%`;
	});

	const lastRunStatus = $derived.by(() => {
		if (recentRuns.length === 0) return 'none';
		const last = recentRuns[0];
		if (last.status !== 'completed') return last.status;
		return last.conclusion ?? 'unknown';
	});

	const activeRuns = $derived(
		recentRuns.filter((r) => r.status === 'in_progress' || r.status === 'queued').length
	);

	// ── Status badge helpers ───────────────────────────────────────────

	const conclusionStyles: Record<string, string> = {
		success: 'bg-accent-green/20 text-accent-green',
		failure: 'bg-accent-red/20 text-accent-red',
		cancelled: 'bg-accent-yellow/20 text-accent-yellow',
		skipped: 'bg-bg-tertiary text-text-secondary',
		timed_out: 'bg-accent-red/20 text-accent-red',
		in_progress: 'bg-accent-yellow/20 text-accent-yellow',
		queued: 'bg-bg-tertiary text-text-secondary',
		none: 'bg-bg-tertiary text-text-secondary',
		unknown: 'bg-bg-tertiary text-text-secondary'
	};

	function statusBadgeClass(run: { status: string; conclusion: string | null }): string {
		if (run.status !== 'completed') return conclusionStyles[run.status] ?? conclusionStyles.unknown;
		return conclusionStyles[run.conclusion ?? 'unknown'] ?? conclusionStyles.unknown;
	}

	function statusLabel(run: { status: string; conclusion: string | null }): string {
		if (run.status !== 'completed') return run.status.replace('_', ' ');
		return (run.conclusion ?? 'unknown').replace('_', ' ');
	}

	function formatDuration(seconds: number | null): string {
		if (seconds === null) return '--';
		if (seconds < 60) return `${seconds}s`;
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		if (mins < 60) return `${mins}m ${secs}s`;
		const hours = Math.floor(mins / 60);
		return `${hours}h ${mins % 60}m`;
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}

	function timeAgo(iso: string): string {
		try {
			const diff = Date.now() - new Date(iso).getTime();
			const mins = Math.floor(diff / 60000);
			if (mins < 1) return 'just now';
			if (mins < 60) return `${mins}m ago`;
			const hours = Math.floor(mins / 60);
			if (hours < 24) return `${hours}h ago`;
			const days = Math.floor(hours / 24);
			return `${days}d ago`;
		} catch {
			return '';
		}
	}

	function clearError() {
		error = null;
	}

	// ── Actions ────────────────────────────────────────────────────────

	async function triggerWorkflow(workflowId: string, workflowName: string) {
		if (triggeringId) return;
		triggeringId = workflowId;
		error = null;

		try {
			const result = await apiPost<{ triggered: boolean; message: string }>(
				`/api/projects/${data.projectId}/pipelines`,
				{ action: 'trigger', workflowId }
			);

			if (result?.triggered) {
				notifications.push('success', 'Workflow triggered', `"${workflowName}" has been queued`);
				await refreshRuns();
			} else {
				error = result?.message ?? 'Failed to trigger workflow';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to trigger workflow';
		} finally {
			triggeringId = null;
		}
	}

	async function refreshRuns() {
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pipelines`);
			if (res.ok) {
				const refreshed = await res.json();
				workflows = refreshed.workflows ?? [];
				recentRuns = refreshed.recentRuns ?? [];
			}
		} catch {
			// silent — data stays stale
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">CI/CD Pipelines</h1>
			{#if data.repo}
				<p class="text-xs text-text-secondary mt-0.5">
					<span class="font-mono text-accent-cyan">{data.repo}</span>
				</p>
			{:else}
				<p class="text-xs text-text-secondary mt-0.5">No GitHub repository detected</p>
			{/if}
		</div>
		<button
			onclick={refreshRuns}
			aria-label="Refresh pipeline data"
			class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/50 transition-colors"
		>
			<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
			</svg>
			Refresh
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

	<!-- Loading -->
	{#if loading}
		<div class="flex items-center gap-2 text-text-secondary text-sm">
			<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			Loading pipelines...
		</div>
	{/if}

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Workflows" value={totalWorkflows} subtitle="defined" accent="blue" />
		<MetricCard label="Success Rate" value={successRate} subtitle="recent runs" accent="green" />
		<MetricCard
			label="Last Run"
			value={lastRunStatus}
			subtitle={recentRuns.length > 0 ? timeAgo(recentRuns[0].startedAt) : 'no runs'}
			accent={lastRunStatus === 'success' ? 'green' : lastRunStatus === 'failure' ? 'red' : 'yellow'}
		/>
		<MetricCard
			label="Active"
			value={activeRuns}
			subtitle="in progress"
			accent={activeRuns > 0 ? 'yellow' : 'cyan'}
		/>
	</div>

	<!-- No GitHub / No gh CLI -->
	{#if !data.hasGh}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.1-5.1m0 0L11.42 5m-5.1 5.07h12.56" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">GitHub CLI not available</h2>
			<p class="text-text-secondary text-xs">
				Install the <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer" class="text-accent-blue hover:underline">GitHub CLI</a> and authenticate with <code class="text-accent-cyan">gh auth login</code> to view pipelines.
			</p>
		</div>
	{:else if !data.repo}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.364-3.828a4.5 4.5 0 00-1.242-7.244l4.5-4.5a4.5 4.5 0 016.364 6.364l-1.757 1.757" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No GitHub repository</h2>
			<p class="text-text-secondary text-xs">This project does not have a GitHub remote configured.</p>
		</div>
	{:else}
		<!-- Workflows -->
		{#if workflows.length > 0}
			<div>
				<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Workflows</h2>
				<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
					{#each workflows as wf (wf.id)}
						<div class="bg-bg-secondary border border-border rounded-lg p-4">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<h3 class="text-sm font-medium text-text-primary truncate">{wf.name}</h3>
									<p class="text-[0.65rem] font-mono text-text-secondary mt-0.5 truncate">{wf.path}</p>
								</div>
								<div class="flex items-center gap-2 shrink-0">
									{#if wf.state !== 'active'}
										<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded bg-accent-yellow/20 text-accent-yellow">
											{wf.state.replace('disabled_', '')}
										</span>
									{/if}
									<button
										onclick={() => triggerWorkflow(String(wf.id), wf.name)}
										disabled={triggeringId !== null || wf.state !== 'active'}
										class="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.65rem] font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										title="Trigger workflow"
									>
										{#if triggeringId === String(wf.id)}
											<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
												<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
												<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
											</svg>
										{:else}
											<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
												<path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
											</svg>
										{/if}
										Run
									</button>
								</div>
							</div>

							<!-- Last run info -->
							{#if wf.lastRun}
								<div class="mt-3 pt-3 border-t border-border flex items-center gap-2 text-xs">
									<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded {statusBadgeClass(wf.lastRun)}">
										{statusLabel(wf.lastRun)}
									</span>
									<span class="text-text-secondary truncate">{wf.lastRun.branch}</span>
									<span class="text-text-secondary ml-auto shrink-0">{timeAgo(wf.lastRun.startedAt)}</span>
								</div>
							{:else}
								<div class="mt-3 pt-3 border-t border-border">
									<p class="text-xs text-text-secondary italic">No runs yet</p>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Recent Runs -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Runs</h2>
			{#if recentRuns.length === 0}
				<div class="bg-bg-secondary border border-border rounded-lg p-8 flex flex-col items-center justify-center text-center">
					<svg class="w-10 h-10 text-text-secondary/40 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
					</svg>
					<h3 class="text-text-primary text-sm font-medium mb-1">No recent runs</h3>
					<p class="text-text-secondary text-xs">Workflow runs will appear here once triggered.</p>
				</div>
			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
					<!-- Table header -->
					<div class="hidden sm:grid grid-cols-[1fr_100px_120px_80px_80px_100px] gap-2 px-4 py-2 border-b border-border text-[0.65rem] text-text-secondary uppercase tracking-wider">
						<span>Run</span>
						<span>Status</span>
						<span>Branch</span>
						<span>Commit</span>
						<span>Duration</span>
						<span>Started</span>
					</div>

					{#each recentRuns as run (run.id)}
						<div class="sm:grid sm:grid-cols-[1fr_100px_120px_80px_80px_100px] gap-2 px-4 py-3 border-b border-border last:border-b-0 hover:bg-bg-tertiary transition-colors">
							<!-- Run name + actor -->
							<div class="min-w-0">
								<a
									href={run.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-sm text-text-primary hover:text-accent-blue transition-colors truncate block"
									title={run.name}
								>
									{run.name}
								</a>
								<span class="text-[0.65rem] text-text-secondary sm:hidden">
									by {run.actor}
								</span>
							</div>

							<!-- Status badge -->
							<div class="flex items-center mt-1 sm:mt-0">
								<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded {statusBadgeClass(run)}">
									{statusLabel(run)}
								</span>
							</div>

							<!-- Branch -->
							<div class="flex items-center min-w-0 mt-1 sm:mt-0">
								<span class="text-xs font-mono text-text-secondary truncate">{run.branch}</span>
							</div>

							<!-- Commit -->
							<div class="flex items-center mt-1 sm:mt-0">
								<span class="text-xs font-mono text-accent-cyan">{run.commit}</span>
							</div>

							<!-- Duration -->
							<div class="flex items-center mt-1 sm:mt-0">
								<span class="text-xs text-text-secondary">{formatDuration(run.duration)}</span>
							</div>

							<!-- Started -->
							<div class="flex items-center mt-1 sm:mt-0">
								<span class="text-xs text-text-secondary" title={formatDate(run.startedAt)}>
									{timeAgo(run.startedAt)}
								</span>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>
