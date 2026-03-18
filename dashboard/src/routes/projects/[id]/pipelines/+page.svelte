<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const ciTypeLabels: Record<string, string> = {
		'github-actions': 'GitHub Actions',
		'gitlab-ci': 'GitLab CI',
		circleci: 'CircleCI',
		jenkins: 'Jenkins',
		unknown: 'Unknown'
	};

	const ciTypeColors: Record<string, string> = {
		'github-actions': 'bg-accent-blue/20 text-accent-blue',
		'gitlab-ci': 'bg-accent-purple/20 text-accent-purple',
		circleci: 'bg-accent-green/20 text-accent-green',
		jenkins: 'bg-accent-yellow/20 text-accent-yellow',
		unknown: 'bg-bg-tertiary text-text-secondary'
	};

	const statusDots: Record<string, string> = {
		success: 'bg-accent-green',
		failure: 'bg-accent-red',
		in_progress: 'bg-accent-yellow',
		queued: 'bg-accent-blue',
		completed: 'bg-accent-green'
	};

	const statusLabels: Record<string, string> = {
		success: 'Passed',
		failure: 'Failed',
		in_progress: 'Running',
		queued: 'Queued',
		completed: 'Completed'
	};

	const conclusionDots: Record<string, string> = {
		success: 'bg-accent-green',
		failure: 'bg-accent-red',
		cancelled: 'bg-text-secondary',
		skipped: 'bg-text-secondary/40',
		timed_out: 'bg-accent-red'
	};

	const conclusionLabels: Record<string, string> = {
		success: 'Passed',
		failure: 'Failed',
		cancelled: 'Cancelled',
		skipped: 'Skipped',
		timed_out: 'Timed Out'
	};

	let refreshing = $state(false);
	let triggeringWorkflow = $state<string | null>(null);
	let triggerMessage = $state('');

	// Compute display status from WorkflowRun (completed status uses conclusion)
	function displayStatus(run: { status: string; conclusion: string | null }): string {
		if (run.status === 'completed') {
			return run.conclusion ?? 'success';
		}
		return run.status;
	}

	function displayDot(run: { status: string; conclusion: string | null }): string {
		if (run.status === 'completed') {
			return conclusionDots[run.conclusion ?? 'success'] ?? 'bg-text-secondary';
		}
		return statusDots[run.status] ?? 'bg-text-secondary';
	}

	function displayLabel(run: { status: string; conclusion: string | null }): string {
		if (run.status === 'completed') {
			return conclusionLabels[run.conclusion ?? 'success'] ?? run.conclusion ?? 'Done';
		}
		return statusLabels[run.status] ?? run.status;
	}

	function displayColor(run: { status: string; conclusion: string | null }): string {
		const s = displayStatus(run);
		if (s === 'success') return 'text-accent-green';
		if (s === 'failure' || s === 'timed_out') return 'text-accent-red';
		if (s === 'in_progress' || s === 'queued') return 'text-accent-yellow';
		return 'text-text-secondary';
	}

	let successCount = $derived(
		data.recentRuns.filter((r) => r.status === 'completed' && r.conclusion === 'success').length
	);
	let failureCount = $derived(
		data.recentRuns.filter((r) => r.status === 'completed' && r.conclusion === 'failure').length
	);
	let successRate = $derived(
		data.recentRuns.length > 0
			? Math.round((successCount / data.recentRuns.length) * 100)
			: 0
	);

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}

	function formatDuration(seconds: number | null): string {
		if (seconds === null) return '';
		if (seconds < 60) return `${seconds}s`;
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}m ${secs}s`;
	}

	function ghRepoUrl(remote: string | null): string | null {
		if (!remote) return null;
		const match = remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
		if (match) return `https://github.com/${match[1]}`;
		if (remote.startsWith('https://github.com')) return remote.replace(/\.git$/, '');
		return null;
	}

	async function refreshPipelines() {
		refreshing = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pipelines`);
			if (res.ok) {
				const fresh = await res.json();
				// Trigger page reload via navigation
				window.location.reload();
			}
		} catch {
			// silent
		} finally {
			refreshing = false;
		}
	}

	async function triggerWorkflow(workflowName: string) {
		triggeringWorkflow = workflowName;
		triggerMessage = '';
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pipelines`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'trigger', workflowId: workflowName })
			});
			const result = await res.json();
			if (res.ok && result.triggered) {
				triggerMessage = `Triggered "${workflowName}"`;
				setTimeout(() => (triggerMessage = ''), 4000);
			} else {
				triggerMessage = result.message ?? 'Failed to trigger';
				setTimeout(() => (triggerMessage = ''), 4000);
			}
		} catch {
			triggerMessage = 'Network error';
			setTimeout(() => (triggerMessage = ''), 4000);
		} finally {
			triggeringWorkflow = null;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">Pipelines</h1>
			<p class="text-xs text-text-secondary mt-0.5">CI/CD configuration and workflow runs</p>
		</div>
		<div class="flex items-center gap-2">
			{#if triggerMessage}
				<span class="text-xs {triggerMessage.startsWith('Triggered') ? 'text-accent-green' : 'text-accent-red'}">{triggerMessage}</span>
			{/if}
			<button
				onclick={refreshPipelines}
				disabled={refreshing}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50"
			>
				<svg class="w-3.5 h-3.5 {refreshing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
				</svg>
				{refreshing ? 'Refreshing...' : 'Refresh'}
			</button>
			{#if ghRepoUrl(data.gitRemote)}
				<a
					href="{ghRepoUrl(data.gitRemote)}/actions"
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
						<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
					</svg>
					View on GitHub
				</a>
			{/if}
		</div>
	</div>

	<!-- Summary Metrics -->
	{#if data.recentRuns.length > 0}
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
			<MetricCard label="CI Configs" value={data.ciConfigs.length} subtitle="detected" accent="blue" />
			<MetricCard label="Recent Runs" value={data.recentRuns.length} subtitle="workflow runs" accent="cyan" />
			<MetricCard label="Pass Rate" value="{successRate}%" subtitle="{successCount} passed, {failureCount} failed" accent="green" />
			<MetricCard
				label="Git Remote"
				value={data.hasRepo ? 'Connected' : 'None'}
				subtitle={data.hasRepo ? 'repository linked' : 'no remote found'}
				accent={data.hasRepo ? 'green' : 'yellow'}
			/>
		</div>
	{/if}

	<!-- No Pipelines State -->
	{#if data.ciConfigs.length === 0 && data.recentRuns.length === 0}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No pipelines configured</h2>
			<p class="text-text-secondary text-xs mb-4 max-w-md">
				{#if !data.hasRepo}
					This project has no git remote. Add a remote and push to GitHub to enable CI/CD workflows.
				{:else}
					No CI/CD configuration files were detected. Add a workflow file to get started.
				{/if}
			</p>
			{#if data.hasRepo}
				<p class="text-text-secondary text-xs">
					Create <span class="font-mono text-accent-blue">.github/workflows/ci.yml</span> to set up GitHub Actions.
				</p>
			{/if}
		</div>
	{/if}

	<!-- CI Config Files -->
	{#if data.ciConfigs.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Detected CI Configurations</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each data.ciConfigs as config}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-2 mb-2">
							<span class="text-[10px] px-2 py-0.5 rounded font-medium {ciTypeColors[config.type]}">
								{ciTypeLabels[config.type]}
							</span>
						</div>
						<p class="text-sm font-medium text-text-primary mb-1">{config.name}</p>
						<p class="text-xs font-mono text-text-secondary truncate" title={config.file}>{config.file}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Workflow Definitions -->
	{#if data.workflows && data.workflows.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Workflow Definitions</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each data.workflows as workflow}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-2">
							<p class="text-sm font-medium text-text-primary">{workflow.name}</p>
							<span class="text-[10px] px-1.5 py-0.5 rounded font-medium {workflow.state === 'active' ? 'bg-accent-green/20 text-accent-green' : 'bg-text-secondary/20 text-text-secondary'}">
								{workflow.state === 'active' ? 'Active' : workflow.state === 'disabled_manually' ? 'Disabled' : 'Inactive'}
							</span>
						</div>
						<p class="text-xs font-mono text-text-secondary truncate mb-3" title={workflow.path}>{workflow.path}</p>
						{#if workflow.lastRun}
							<div class="flex items-center gap-2 text-xs text-text-secondary mb-3">
								<span class="w-1.5 h-1.5 rounded-full {displayDot(workflow.lastRun)}"></span>
								<span>{displayLabel(workflow.lastRun)}</span>
								<span class="font-mono">{workflow.lastRun.branch}</span>
								{#if workflow.lastRun.duration !== null}
									<span>{formatDuration(workflow.lastRun.duration)}</span>
								{/if}
							</div>
						{/if}
						{#if workflow.state === 'active'}
							<button
								onclick={() => triggerWorkflow(workflow.name)}
								disabled={triggeringWorkflow === workflow.name}
								class="w-full px-3 py-1.5 text-xs font-medium text-accent-blue border border-accent-blue/30 rounded-lg hover:bg-accent-blue/10 transition-colors disabled:opacity-50"
							>
								{triggeringWorkflow === workflow.name ? 'Triggering...' : 'Trigger Workflow'}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- GitHub Error -->
	{#if data.ghError}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow text-sm">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
			</svg>
			<span class="flex-1 text-xs">Could not fetch workflow runs: {data.ghError}</span>
		</div>
	{/if}

	<!-- gh CLI Notice -->
	{#if data.hasRepo && !data.hasGh && data.ciConfigs.length > 0}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-blue/10 border border-accent-blue/20 text-sm">
			<svg class="w-4 h-4 text-accent-blue shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
			</svg>
			<p class="text-xs text-text-secondary">
				Install the <span class="font-mono text-accent-blue">gh</span> CLI to see live workflow run status here.
			</p>
		</div>
	{/if}

	<!-- Recent Workflow Runs -->
	{#if data.recentRuns.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Workflow Runs</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				<div class="divide-y divide-border">
					{#each data.recentRuns as run}
						<div class="flex items-center gap-4 px-4 py-3 hover:bg-bg-tertiary/50 transition-colors">
							<div class="flex items-center gap-1.5 shrink-0">
								<span class="w-2.5 h-2.5 rounded-full {displayDot(run)}"></span>
							</div>
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium text-text-primary truncate">{run.name}</p>
								<div class="flex items-center gap-2 text-xs text-text-secondary mt-0.5">
									<span class="font-mono">{run.branch}</span>
									<span class="font-mono">{run.commit}</span>
									{#if run.actor}
										<span>{run.actor}</span>
									{/if}
								</div>
							</div>
							<span class="text-xs font-medium {displayColor(run)}">
								{displayLabel(run)}
							</span>
							{#if run.duration !== null}
								<span class="text-xs text-text-secondary shrink-0">{formatDuration(run.duration)}</span>
							{/if}
							<span class="text-xs text-text-secondary shrink-0">{formatDate(run.startedAt)}</span>
							{#if run.url}
								<a
									href={run.url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xs text-accent-blue hover:underline shrink-0"
								>
									View
								</a>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</div>
