<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import ReportChart from '$lib/components/ReportChart.svelte';
	import ScoreGauge from '$lib/components/ScoreGauge.svelte';
	import { apiPost, apiGet } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let reports = $state(data.reports ?? []);
	let report = $state(data.activeReport);
	let timeSeries = $state(data.timeSeries);
	let generating = $state(false);

	type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

	async function generate(type: ReportType) {
		generating = true;
		try {
			const result = await apiPost<{ report: typeof report; timeSeries: typeof timeSeries }>('/api/reports', { type, source: 'user' });
			if (result) {
				report = result.report;
				timeSeries = result.timeSeries;
				const listData = await apiGet<{ reports: typeof reports }>('/api/reports');
				if (listData) reports = listData.reports;
			}
		} finally {
			generating = false;
		}
	}

	async function loadReport(type: string, date: string) {
		const result = await apiGet<{ report: typeof report; timeSeries: typeof timeSeries }>(`/api/reports?type=${type}&date=${date}`);
		if (result) {
			report = result.report;
			timeSeries = result.timeSeries;
		}
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	}

	const severityColors: Record<string, string> = {
		critical: 'text-accent-red',
		warning: 'text-accent-yellow',
		info: 'text-accent-blue',
		success: 'text-accent-green'
	};

	const agentColors: Record<string, string> = {
		'gpt-oss': 'text-accent-green',
		'claude-code': 'text-accent-blue',
		'claude-api': 'text-accent-purple',
		'claude': 'text-accent-purple',
		'openclaw': 'text-accent-yellow'
	};
</script>

<svelte:head>
	<title>Reports — ai-playground</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Reports</h1>
			<p class="text-sm text-text-secondary mt-1">Activity summaries — daily, weekly, monthly, quarterly, or yearly</p>
		</div>
		<div class="flex items-center gap-2 flex-wrap">
			<button
				onclick={() => generate('daily')}
				disabled={generating}
				class="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
			>
				{generating ? 'Generating...' : 'Daily'}
			</button>
			{#each ['weekly', 'monthly', 'quarterly', 'yearly'] as period}
				<button
					onclick={() => generate(period as ReportType)}
					disabled={generating}
					class="px-4 py-2 text-sm font-medium text-text-primary border border-border rounded-lg hover:bg-bg-secondary transition-colors disabled:opacity-50"
				>
					{period.charAt(0).toUpperCase() + period.slice(1)}
				</button>
			{/each}
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
		<!-- Report List -->
		<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-1 h-fit max-h-[600px] overflow-y-auto">
			<p class="text-xs text-text-secondary uppercase tracking-wider mb-2 px-2">Reports ({reports.length})</p>
			{#each reports as r}
				<button
					class="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
						{report?.id === r.id ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}"
					onclick={() => loadReport(r.type, r.date)}
				>
					<div class="flex items-center gap-2">
						<span class="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase
							{r.type === 'yearly' ? 'bg-accent-red/20 text-accent-red' : r.type === 'quarterly' ? 'bg-accent-yellow/20 text-accent-yellow' : r.type === 'monthly' ? 'bg-accent-green/20 text-accent-green' : r.type === 'weekly' ? 'bg-accent-purple/20 text-accent-purple' : 'bg-accent-cyan/20 text-accent-cyan'}"
						>{r.type}</span>
						<span>{formatDate(r.date)}</span>
					</div>
				</button>
			{:else}
				<p class="text-xs text-text-secondary text-center py-4">No reports yet. Generate one to get started.</p>
			{/each}
		</div>

		<!-- Report Content -->
		{#if report}
			<div class="space-y-6">
				<!-- Summary Header -->
				<div class="bg-bg-secondary border border-border rounded-lg p-5">
					<div class="flex items-center justify-between mb-3">
						<div>
							<h2 class="text-lg font-semibold text-text-primary">{report.sections.summary.periodLabel}</h2>
							<p class="text-xs text-text-secondary mt-0.5">
								Generated {formatDate(report.generatedAt)} at {formatTime(report.generatedAt)} by {report.generatedBy}
							</p>
						</div>
						<div class="flex items-center gap-2">
							<div class="text-right">
								<span class="text-3xl font-bold font-mono
									{report.sections.summary.healthScore >= 80 ? 'text-accent-green' : report.sections.summary.healthScore >= 60 ? 'text-accent-yellow' : 'text-accent-red'}"
								>{report.sections.summary.healthScore}</span>
								<span class="text-xs text-text-secondary">/ 100</span>
								<p class="text-[10px] text-text-secondary uppercase tracking-wider">System Health</p>
							</div>
						</div>
					</div>
					{#if report.sections.summary.highlights.length > 0}
						<div class="space-y-1.5 mt-4">
							{#each report.sections.summary.highlights as h}
								<div class="flex items-center gap-2 text-sm text-text-primary">
									<span class="w-1.5 h-1.5 rounded-full bg-accent-cyan shrink-0"></span>
									{h}
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Scoring Gauges -->
				{#if report.scores}
					<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
						<ScoreGauge
							label="System Health"
							score={report.scores.systemHealth.score}
							grade={report.scores.systemHealth.grade}
							breakdown={report.scores.systemHealth.breakdown}
							accent="cyan"
						/>
						<ScoreGauge
							label="Business Value"
							score={report.scores.businessValue.score}
							grade={report.scores.businessValue.grade}
							breakdown={report.scores.businessValue.breakdown}
							accent="green"
						/>
						<!-- Overall Score -->
						<div class="bg-bg-secondary border border-border rounded-lg p-4 flex flex-col items-center justify-center">
							<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Overall Score</h3>
							<span class="text-6xl font-bold font-mono
								{report.scores.overall >= 80 ? 'text-accent-green' : report.scores.overall >= 60 ? 'text-accent-yellow' : 'text-accent-red'}"
							>{report.scores.overall}</span>
							<span class="text-sm text-text-secondary mt-1">/ 100</span>
							<div class="mt-4 w-full max-w-[200px]">
								<div class="w-full h-2 rounded-full bg-bg-primary overflow-hidden">
									<div class="h-full rounded-full transition-all
										{report.scores.overall >= 80 ? 'bg-accent-green' : report.scores.overall >= 60 ? 'bg-accent-yellow' : 'bg-accent-red'}"
										style="width: {report.scores.overall}%"
									></div>
								</div>
								<div class="flex justify-between text-[10px] text-text-secondary mt-1">
									<span>Health: {report.scores.systemHealth.score}</span>
									<span>Value: {report.scores.businessValue.score}</span>
								</div>
							</div>
						</div>
					</div>
				{/if}

				<!-- Metric Cards -->
				<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
					<MetricCard label="Code Edits" value={report.sections.code.totalEdits} subtitle="~{report.sections.code.totalLinesChanged} lines" accent="blue" />
					<MetricCard label="Tasks" value="{report.sections.tasks.completed}/{report.sections.tasks.created}" subtitle="completed/created" accent="green" />
					<MetricCard label="Conversations" value={report.sections.conversations.totalSessions} subtitle="{report.sections.conversations.totalMessages} messages" accent="purple" />
					<MetricCard label="Routing" value="{(report.sections.routing.successRate * 100).toFixed(0)}%" subtitle="{report.sections.routing.totalDecisions} decisions" accent="cyan" />
				</div>

				<!-- Timeline Charts (weekly+ only) -->
				{#if timeSeries}
					<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
						<ReportChart
							title="Task Completion Over Time"
							labels={timeSeries.labels}
							datasets={[
								{ label: 'Created', data: timeSeries.taskCompletion.created, color: '#3b82f6', type: 'bar' },
								{ label: 'Completed', data: timeSeries.taskCompletion.completed, color: '#22c55e', type: 'bar' }
							]}
							yLabel="Tasks"
						/>
						<ReportChart
							title="Routing Decisions Per Day"
							labels={timeSeries.labels}
							datasets={[
								{ label: 'Total', data: timeSeries.routingDecisions.total, color: '#06b6d4', fill: true },
								{ label: 'Successful', data: timeSeries.routingDecisions.success, color: '#22c55e', fill: true }
							]}
							yLabel="Decisions"
						/>
						<ReportChart
							title="Token Usage Trends"
							labels={timeSeries.labels}
							datasets={[
								{ label: 'API Tokens', data: timeSeries.tokenUsage.api, color: '#a855f7' },
								{ label: 'Local Tokens (free)', data: timeSeries.tokenUsage.local, color: '#22c55e' }
							]}
							yLabel="Estimated Tokens"
						/>
						<ReportChart
							title="GPU Hours (Est.)"
							labels={timeSeries.labels}
							datasets={[
								{ label: 'GPU Hours', data: timeSeries.gpuHours, color: '#eab308', fill: true }
							]}
							yLabel="Hours"
						/>
					</div>
				{/if}

				<!-- Code & Tasks -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<!-- Code Stats -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Code Activity</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Total Edits</span>
								<span class="font-mono text-text-primary">{report.sections.code.totalEdits}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Lines Changed</span>
								<span class="font-mono text-text-primary">~{report.sections.code.totalLinesChanged.toLocaleString()}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Characters Written</span>
								<span class="font-mono text-text-primary">~{report.sections.code.totalCharsWritten.toLocaleString()}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Files Modified</span>
								<span class="font-mono text-text-primary">~{report.sections.code.filesModified}</span>
							</div>
						</div>
					</div>

					<!-- Task Stats -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Tasks</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Created</span>
								<span class="font-mono text-text-primary">{report.sections.tasks.created}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Completed</span>
								<span class="font-mono text-accent-green">{report.sections.tasks.completed}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">In Progress</span>
								<span class="font-mono text-accent-yellow">{report.sections.tasks.inProgress}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Pending</span>
								<span class="font-mono text-text-secondary">{report.sections.tasks.pending}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Automation Success</span>
								<span class="font-mono {report.sections.tasks.automationSuccessRate >= 0.7 ? 'text-accent-green' : 'text-accent-yellow'}">
									{(report.sections.tasks.automationSuccessRate * 100).toFixed(0)}%
								</span>
							</div>
						</div>
					</div>
				</div>

				<!-- GPU & Token Usage -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<!-- GPU -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">GPU Usage (RTX 3090)</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Active Model</span>
								<span class="font-mono text-text-primary">{report.sections.gpu.modelName}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">VRAM</span>
								<span class="font-mono text-text-primary">{report.sections.gpu.vramUsedGb.toFixed(1)} / {report.sections.gpu.vramTotalGb} GB</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Est. Hours Active</span>
								<span class="font-mono text-text-primary">{report.sections.gpu.estimatedHoursActive.toFixed(1)}h</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Est. Power Draw</span>
								<span class="font-mono text-text-primary">~{report.sections.gpu.estimatedWatts}W</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Energy Consumed</span>
								<span class="font-mono text-text-primary">{report.sections.gpu.estimatedKwh.toFixed(3)} kWh</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Est. Cost</span>
								<span class="font-mono text-accent-green">${report.sections.gpu.estimatedCostUsd.toFixed(4)}</span>
							</div>
						</div>
					</div>

					<!-- Tokens -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Token Usage</h3>
						<div class="space-y-2 text-sm">
							{#if report.sections.tokens.claudeCodeTokensUsed > 0}
								<div class="flex justify-between">
									<span class="text-text-secondary">Total API Tokens</span>
									<span class="font-mono text-text-primary">{report.sections.tokens.claudeCodeTokensUsed.toLocaleString()}</span>
								</div>
								<div>
									<div class="flex justify-between mb-1">
										<span class="text-text-secondary">Monthly Usage</span>
										<span class="font-mono text-text-primary">{report.sections.tokens.claudeCodeUsagePercent.toFixed(1)}%</span>
									</div>
									<div class="w-full h-2 rounded-full bg-bg-primary overflow-hidden">
										<div
											class="h-full rounded-full transition-all
												{report.sections.tokens.claudeCodeUsagePercent > 80 ? 'bg-accent-red' : report.sections.tokens.claudeCodeUsagePercent > 50 ? 'bg-accent-yellow' : 'bg-accent-green'}"
											style="width: {Math.min(100, report.sections.tokens.claudeCodeUsagePercent)}%"
										></div>
									</div>
								</div>
							{:else}
								<p class="text-text-secondary text-xs">No API token data for this period</p>
							{/if}
							<div class="flex justify-between">
								<span class="text-text-secondary">API Cost</span>
								<span class="font-mono {report.sections.tokens.estimatedApiCost === 0 ? 'text-accent-green' : 'text-accent-yellow'}">
									${report.sections.tokens.estimatedApiCost.toFixed(4)}
								</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Local (free) Tokens</span>
								<span class="font-mono text-accent-green">{report.sections.tokens.localTokensFree.toLocaleString()}</span>
							</div>
							{#if report.sections.tokens.agentTokens}
								<div class="mt-3 pt-3 border-t border-border">
									<p class="text-xs text-text-secondary uppercase tracking-wider mb-2">Agent Breakdown</p>
									<div class="flex justify-between">
										<span class="text-text-secondary">Agent Tasks</span>
										<span class="font-mono text-text-primary">{report.sections.tokens.agentTokens.taskCount}</span>
									</div>
									<div class="flex justify-between">
										<span class="text-text-secondary">Input Tokens</span>
										<span class="font-mono text-text-primary">{report.sections.tokens.agentTokens.totalInput.toLocaleString()}</span>
									</div>
									<div class="flex justify-between">
										<span class="text-text-secondary">Output Tokens</span>
										<span class="font-mono text-text-primary">{report.sections.tokens.agentTokens.totalOutput.toLocaleString()}</span>
									</div>
									<div class="flex justify-between">
										<span class="text-text-secondary">Agent Cost</span>
										<span class="font-mono text-accent-yellow">${report.sections.tokens.agentTokens.totalCost.toFixed(4)}</span>
									</div>
									{#if Object.keys(report.sections.tokens.agentTokens.byModel).length > 0}
										<div class="mt-2 space-y-1">
											{#each Object.entries(report.sections.tokens.agentTokens.byModel) as [model, stats]}
												<div class="flex items-center justify-between text-xs">
													<span class="font-mono text-text-primary truncate max-w-[120px]" title={model}>{model}</span>
													<span class="text-text-secondary">{stats.count}x — {(stats.input + stats.output).toLocaleString()} tok</span>
												</div>
											{/each}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				</div>

				<!-- Routing & Conversations -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<!-- Routing -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Model Routing</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Decisions</span>
								<span class="font-mono text-text-primary">{report.sections.routing.totalDecisions}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Success Rate</span>
								<span class="font-mono {report.sections.routing.successRate >= 0.9 ? 'text-accent-green' : 'text-accent-yellow'}">
									{(report.sections.routing.successRate * 100).toFixed(0)}%
								</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Most Used Model</span>
								<span class="font-mono text-text-primary">{report.sections.routing.mostUsedModel}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Most Used Agent</span>
								<span class="font-mono {agentColors[report.sections.routing.mostUsedAgent] ?? 'text-text-primary'}">
									{report.sections.routing.mostUsedAgent}
								</span>
							</div>
						</div>
						{#if Object.keys(report.sections.routing.byAgent).length > 0}
							<div class="mt-3 pt-3 border-t border-border space-y-1.5">
								{#each Object.entries(report.sections.routing.byAgent) as [agent, stats]}
									<div class="flex items-center justify-between text-xs">
										<span class="font-mono {agentColors[agent] ?? 'text-text-primary'}">{agent}</span>
										<span class="text-text-secondary">{stats.count}x ({(stats.successRate * 100).toFixed(0)}%)</span>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Conversations -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Conversations</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Total Sessions</span>
								<span class="font-mono text-text-primary">{report.sections.conversations.totalSessions}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Total Messages</span>
								<span class="font-mono text-text-primary">{report.sections.conversations.totalMessages}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">User Sessions</span>
								<span class="font-mono text-accent-blue">{report.sections.conversations.userSessions}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Claw Sessions</span>
								<span class="font-mono text-accent-green">{report.sections.conversations.clawSessions}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Messages/Session</span>
								<span class="font-mono text-text-primary">{report.sections.conversations.avgMessagesPerSession.toFixed(1)}</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Services & Notifications -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<!-- Services -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Service Uptime</h3>
						<div class="space-y-2">
							{#each Object.values(report.sections.services.uptime) as svc}
								<div class="flex items-center justify-between text-sm">
									<div class="flex items-center gap-2">
										<span class="w-2 h-2 rounded-full {svc.status === 'up' ? 'bg-accent-green' : 'bg-accent-red'}"></span>
										<span class="text-text-primary">{svc.service}</span>
									</div>
									<span class="font-mono text-xs {svc.status === 'up' ? 'text-accent-green' : 'text-accent-red'}">
										{svc.status === 'up' ? 'Online' : 'Offline'}
									</span>
								</div>
							{/each}
						</div>
					</div>

					<!-- Notifications -->
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Notifications</h3>
						<div class="space-y-2 text-sm">
							<div class="flex justify-between">
								<span class="text-text-secondary">Total</span>
								<span class="font-mono text-text-primary">{report.sections.notifications.total}</span>
							</div>
							{#each Object.entries(report.sections.notifications.bySeverity) as [severity, count]}
								<div class="flex justify-between">
									<span class="text-text-secondary capitalize">{severity}</span>
									<span class="font-mono {severityColors[severity] ?? 'text-text-primary'}">{count}</span>
								</div>
							{/each}
						</div>
					</div>
				</div>

				<!-- Projects -->
				{#if report.sections.projects.projectSummaries.length > 0}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">
							Project Activity ({report.sections.projects.totalProjects} projects)
						</h3>
						<div class="space-y-2">
							{#each report.sections.projects.projectSummaries.filter(p => p.tasks > 0 || p.completedTasks > 0) as project}
								<div class="flex items-center justify-between text-sm bg-bg-primary rounded-lg px-3 py-2">
									<span class="font-medium text-text-primary">{project.name}</span>
									<div class="flex items-center gap-4 text-xs">
										<span class="text-text-secondary">{project.tasks} tasks</span>
										<span class="text-accent-green">{project.completedTasks} done</span>
									</div>
								</div>
							{:else}
								<p class="text-sm text-text-secondary">No project activity in this period</p>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{:else}
			<div class="flex items-center justify-center h-[400px]">
				<div class="text-center">
					<p class="text-text-secondary text-sm">No report selected</p>
					<p class="text-text-secondary text-xs mt-1">Generate a daily or weekly report to see activity data</p>
				</div>
			</div>
		{/if}
	</div>
</div>
