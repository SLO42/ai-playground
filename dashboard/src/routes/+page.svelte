<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let autoRefresh = $state(true);
	let refreshing = $state(false);
	let lastRefresh = $state(new Date().toISOString());

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
			lastRefresh = new Date().toISOString();
		} finally {
			refreshing = false;
		}
	}

	function startAutoRefresh() {
		stopAutoRefresh();
		if (autoRefresh) refreshTimer = setInterval(refresh, 15000);
	}

	function stopAutoRefresh() {
		if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
	}

	function toggleAutoRefresh() {
		autoRefresh = !autoRefresh;
		if (autoRefresh) startAutoRefresh();
		else stopAutoRefresh();
	}

	onMount(() => startAutoRefresh());
	onDestroy(() => stopAutoRefresh());

	// Heartbeat (automation) toggle
	let heartbeatEnabled = $state(data.heartbeatEnabled);
	let heartbeatToggling = $state(false);

	async function toggleHeartbeat() {
		heartbeatToggling = true;
		try {
			const res = await apiFetch('/api/settings/heartbeat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !heartbeatEnabled })
			});
			if (res.ok) {
				const body = await res.json();
				heartbeatEnabled = body.enabled;
			}
		} catch { /* keep current state */ }
		heartbeatToggling = false;
	}

	// Derived data
	let daemon = $derived(data.daemonState);
	let models = $derived(data.runningModels);
	let analytics = $derived(data.analytics);
	let pool = $derived(data.poolStats);
	let tasks = $derived(data.taskSummary);
	let sessions = $derived(data.recentSessions);
	let notifs = $derived(data.notifications);
	let agents = $derived(data.activeAgents);
	let services = $derived(data.serviceHealth);

	let runningModel = $derived(models?.[0]);
	let vramUsedGb = $derived(runningModel ? runningModel.size_vram / (1024 ** 3) : 0);
	const totalVramGb = 24;
	let modelName = $derived(runningModel?.name ?? 'None');

	let servicesOnline = $derived(services.filter((s: any) => s.online).length);

	let warmRate = $derived(
		pool.warmResumes + pool.coldStarts > 0
			? (pool.warmResumes / (pool.warmResumes + pool.coldStarts)) * 100
			: 0
	);

	let scaleEvents = $derived(pool.scaleEvents ?? []);
	let scaleUps = $derived(scaleEvents.filter((e: any) => e.action === 'scale-up').length);
	let scaleDowns = $derived(scaleEvents.filter((e: any) => e.action === 'scale-down').length);
	let lastScaleEvent = $derived(scaleEvents.length > 0 ? scaleEvents[scaleEvents.length - 1] : null);

	function timeAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}

	function runningFor(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const secs = Math.floor(diff / 1000);
		if (secs < 60) return `${secs}s`;
		const mins = Math.floor(secs / 60);
		if (mins < 60) return `${mins}m ${secs % 60}s`;
		return `${Math.floor(mins / 60)}h ${mins % 60}m`;
	}

	const severityColors: Record<string, string> = {
		success: 'text-accent-green',
		info: 'text-accent-cyan',
		warning: 'text-accent-yellow',
		error: 'text-accent-red'
	};

	const sessionSourceColors: Record<string, string> = {
		claw: 'text-accent-cyan',
		user: 'text-accent-green',
		system: 'text-text-secondary'
	};

	const sessionStatusColors: Record<string, string> = {
		streaming: 'bg-accent-green animate-pulse',
		waiting: 'bg-accent-yellow',
		idle: 'bg-text-secondary',
		error: 'bg-accent-red'
	};
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-4">
			<h1 class="type-page-title text-text-primary">Dashboard</h1>
			<!-- Automation toggle -->
			<button
				onclick={toggleHeartbeat}
				disabled={heartbeatToggling}
				class="flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors text-xs font-medium
					{heartbeatEnabled
						? 'border-accent-green/40 bg-accent-green/10 text-accent-green hover:bg-accent-green/20'
						: 'border-accent-red/40 bg-accent-red/10 text-accent-red hover:bg-accent-red/20'}
					{heartbeatToggling ? 'opacity-50' : ''}"
				title={heartbeatEnabled ? 'Claw automation is running — click to pause' : 'Claw automation is paused — click to resume'}
			>
				<span class="w-2 h-2 rounded-full {heartbeatEnabled ? 'bg-accent-green animate-pulse' : 'bg-accent-red'}"></span>
				{heartbeatEnabled ? 'Automation On' : 'Automation Off'}
			</button>
		</div>
		<div class="flex items-center gap-3 text-xs text-text-secondary">
			<span class="font-mono">
				{#if refreshing}
					Refreshing...
				{:else}
					{new Date(lastRefresh).toLocaleTimeString()}
				{/if}
			</span>
			<button
				onclick={refresh}
				disabled={refreshing}
				class="px-2 py-1 rounded border border-border hover:bg-bg-secondary transition-colors disabled:opacity-50"
			>
				Refresh
			</button>
			<button
				onclick={toggleAutoRefresh}
				class="flex items-center gap-1.5 px-2 py-1 rounded border border-border hover:bg-bg-secondary transition-colors"
			>
				<span class="w-2 h-2 rounded-full {autoRefresh ? 'bg-accent-green' : 'bg-text-secondary'}"></span>
				Auto
			</button>
		</div>
	</div>

	<!-- Top-level Status -->
	<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
		<MetricCard
			label="Services"
			value="{servicesOnline}/{services.length}"
			subtitle="online"
			accent={servicesOnline === services.length ? 'green' : 'yellow'}
		/>
		<MetricCard
			label="Agents Running"
			value={agents.length}
			subtitle={agents.length > 0 ? agents.map((a: any) => a.label).join(', ').slice(0, 30) : 'idle'}
			accent={agents.length > 0 ? 'cyan' : 'blue'}
		/>
		<MetricCard
			label="Tasks"
			value="{tasks.pending + tasks.inProgress}"
			subtitle="{tasks.pending} pending, {tasks.inProgress} active"
			accent={tasks.inProgress > 0 ? 'green' : tasks.pending > 0 ? 'yellow' : 'blue'}
		/>
		<MetricCard
			label="Completed"
			value={tasks.completed}
			subtitle="{tasks.failed} failed of {tasks.total}"
			accent={tasks.failed > 0 ? 'yellow' : 'green'}
		/>
		<MetricCard
			label="Cost Today"
			value="${analytics.summary.totalCostUsd.toFixed(2)}"
			subtitle="${analytics.summary.avgCostPerTask.toFixed(2)} avg/task"
			accent={analytics.summary.totalCostUsd > 5 ? 'red' : analytics.summary.totalCostUsd > 1 ? 'yellow' : 'green'}
		/>
		<MetricCard
			label="VRAM"
			value="{vramUsedGb.toFixed(1)} GB"
			subtitle={modelName}
			accent={vramUsedGb > 0 ? 'yellow' : 'blue'}
		/>
	</div>

	<!-- Two-column: Active Agents + Recent Sessions -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Active Agents -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<p class="type-label text-text-secondary">Running Agents</p>
				<a href="/agents" class="text-xs text-accent-blue hover:underline">all agents &rarr;</a>
			</div>
			{#if agents.length > 0}
				<div class="space-y-2">
					{#each agents as agent}
						<a
							href="/chat?session={agent.sessionId}"
							class="flex items-center gap-3 bg-bg-primary rounded-lg px-3 py-2.5 hover:bg-bg-tertiary transition-colors"
						>
							<span class="w-2.5 h-2.5 rounded-full bg-accent-green animate-pulse shrink-0"></span>
							<div class="min-w-0 flex-1">
								<span class="text-sm font-medium truncate block" style="color: {agent.color}">{agent.label}</span>
								<span class="text-[10px] font-mono text-text-secondary">{agent.taskId}</span>
							</div>
							<span class="text-xs font-mono text-text-secondary shrink-0">{runningFor(agent.startedAt)}</span>
						</a>
					{/each}
				</div>
			{:else}
				<div class="text-center py-6">
					<p class="text-sm text-text-secondary">No agents running</p>
					<p class="text-xs text-text-secondary/60 mt-1">Agents spawn when Claw finds pending tasks</p>
				</div>
			{/if}
		</div>

		<!-- Recent Sessions -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<p class="type-label text-text-secondary">Recent Sessions</p>
				<a href="/sessions" class="text-xs text-accent-blue hover:underline">all sessions &rarr;</a>
			</div>
			{#if sessions.length > 0}
				<div class="space-y-1.5">
					{#each sessions as session}
						<a
							href="/chat?session={session.id}"
							class="flex items-center gap-2.5 bg-bg-primary rounded-lg px-3 py-2 hover:bg-bg-tertiary transition-colors"
						>
							<span class="w-2 h-2 rounded-full shrink-0 {sessionStatusColors[session.status ?? 'idle'] ?? 'bg-text-secondary'}"></span>
							<div class="min-w-0 flex-1">
								<span class="text-xs text-text-primary truncate block">{session.title}</span>
							</div>
							{#if session.source}
								<span class="text-[10px] font-mono {sessionSourceColors[session.source] ?? 'text-text-secondary'}">{session.source}</span>
							{/if}
							<span class="text-[10px] font-mono text-text-secondary shrink-0">{timeAgo(session.updatedAt)}</span>
						</a>
					{/each}
				</div>
			{:else}
				<div class="text-center py-6">
					<p class="text-sm text-text-secondary">No sessions yet</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- Three-column: Task Pipeline + Session Pool + Routing -->
	<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
		<!-- Task Pipeline -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<p class="type-label text-text-secondary">Task Pipeline</p>
				<a href="/tasks" class="text-xs text-accent-blue hover:underline">view &rarr;</a>
			</div>
			<div class="space-y-2">
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Pending</span>
					<span class="font-mono text-accent-yellow">{tasks.pending}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">In Progress</span>
					<span class="font-mono text-accent-cyan">{tasks.inProgress}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Completed</span>
					<span class="font-mono text-accent-green">{tasks.completed}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Failed</span>
					<span class="font-mono {tasks.failed > 0 ? 'text-accent-red' : 'text-text-secondary'}">{tasks.failed}</span>
				</div>
				<!-- Progress bar -->
				{#if tasks.total > 0}
					<div class="h-2 rounded-full bg-bg-tertiary overflow-hidden flex mt-1">
						{#if tasks.completed > 0}
							<div class="bg-accent-green/70 transition-all" style="width: {(tasks.completed / tasks.total) * 100}%"></div>
						{/if}
						{#if tasks.inProgress > 0}
							<div class="bg-accent-cyan/70 transition-all" style="width: {(tasks.inProgress / tasks.total) * 100}%"></div>
						{/if}
						{#if tasks.failed > 0}
							<div class="bg-accent-red/70 transition-all" style="width: {(tasks.failed / tasks.total) * 100}%"></div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<!-- Session Pool -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<p class="type-label text-text-secondary">Session Pool</p>
				<a href="/agents" class="text-xs text-accent-blue hover:underline">details &rarr;</a>
			</div>
			<div class="space-y-2">
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Slots Used</span>
					<span class="font-mono text-text-primary">{pool.slots.length} / {pool.maxSlots}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Active</span>
					<span class="font-mono text-accent-cyan">{pool.slots.filter((s: any) => s.status === 'active').length}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Warm Resumes</span>
					<span class="font-mono text-accent-green">{pool.warmResumes}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Cold Starts</span>
					<span class="font-mono text-accent-yellow">{pool.coldStarts}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Warm Rate</span>
					<span class="font-mono {warmRate > 60 ? 'text-accent-green' : warmRate > 30 ? 'text-accent-yellow' : 'text-text-secondary'}">{warmRate.toFixed(0)}%</span>
				</div>
				<!-- Slot dots -->
				<div class="flex gap-1 mt-1">
					{#each pool.slots as slot}
						<div
							class="w-3 h-3 rounded-sm {slot.status === 'active' ? 'bg-accent-cyan' : 'bg-accent-green/40'}"
							title="{slot.area} ({slot.status}) — {slot.taskCount} tasks, ${slot.totalCost.toFixed(2)}"
						></div>
					{/each}
					{#each Array(Math.max(0, pool.maxSlots - pool.slots.length)) as _}
						<div class="w-3 h-3 rounded-sm bg-bg-tertiary border border-border/50"></div>
					{/each}
				</div>
				<!-- Auto-scale activity -->
				{#if scaleEvents.length > 0}
					<div class="border-t border-border/50 pt-2 mt-2 space-y-1.5">
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary">Scale Ups</span>
							<span class="font-mono text-accent-cyan">{scaleUps}</span>
						</div>
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary">Scale Downs</span>
							<span class="font-mono text-accent-yellow">{scaleDowns}</span>
						</div>
						{#if lastScaleEvent}
							<div class="flex items-center justify-between text-xs">
								<span class="text-text-secondary">Last Scale</span>
								<span class="font-mono {lastScaleEvent.action === 'scale-up' ? 'text-accent-cyan' : 'text-accent-yellow'}">
									{lastScaleEvent.action === 'scale-up' ? '+' : '-'}{lastScaleEvent.slotsChanged} slot{lastScaleEvent.slotsChanged !== 1 ? 's' : ''} {timeAgo(lastScaleEvent.timestamp)}
								</span>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<!-- Agent Routing Summary -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<p class="type-label text-text-secondary">Agent Routing</p>
				<a href="/models" class="text-xs text-accent-blue hover:underline">models &rarr;</a>
			</div>
			<div class="space-y-2">
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">OpenClaw (local)</span>
					<span class="font-mono text-accent-green">{analytics.byRoute.openclaw.count}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Claude Code (API)</span>
					<span class="font-mono text-accent-purple">{analytics.byRoute.claudeCode.count}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Escalation Rate</span>
					<span class="font-mono {analytics.escalationRate > 0.3 ? 'text-accent-yellow' : 'text-accent-green'}">{(analytics.escalationRate * 100).toFixed(0)}%</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Sonnet Tasks</span>
					<span class="font-mono text-accent-cyan">{analytics.byRoute.claudeCode.sonnet}</span>
				</div>
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-secondary">Opus Tasks</span>
					<span class="font-mono text-accent-purple">{analytics.byRoute.claudeCode.opus}</span>
				</div>
				<!-- Model distribution bar -->
				{#if analytics.byRoute.openclaw.count + analytics.byRoute.claudeCode.count > 0}
					{@const total = analytics.byRoute.openclaw.count + analytics.byRoute.claudeCode.count}
					<div class="h-2 rounded-full bg-bg-tertiary overflow-hidden flex mt-1">
						<div class="bg-accent-green/70" style="width: {(analytics.byRoute.openclaw.count / total) * 100}%" title="Local"></div>
						<div class="bg-accent-cyan/70" style="width: {(analytics.byRoute.claudeCode.sonnet / total) * 100}%" title="Sonnet"></div>
						<div class="bg-accent-purple/70" style="width: {(analytics.byRoute.claudeCode.opus / total) * 100}%" title="Opus"></div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Recent Notifications -->
	{#if notifs.items.length > 0}
		<section>
			<div class="flex items-center justify-between mb-3">
				<h2 class="type-section-title text-text-primary">
					Recent Activity
					{#if notifs.unread > 0}
						<span class="ml-2 text-xs font-normal px-1.5 py-0.5 rounded-full bg-accent-cyan/15 text-accent-cyan">{notifs.unread} unread</span>
					{/if}
				</h2>
				<a href="/inbox" class="text-xs text-accent-blue hover:underline">inbox &rarr;</a>
			</div>
			<div class="bg-bg-secondary border border-border rounded-lg divide-y divide-border/50">
				{#each notifs.items.slice(0, 6) as notif}
					<div class="flex items-start gap-3 px-4 py-3">
						<span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {notif.severity === 'success' ? 'bg-accent-green' : notif.severity === 'warning' ? 'bg-accent-yellow' : notif.severity === 'error' ? 'bg-accent-red' : 'bg-accent-cyan'}"></span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="text-sm text-text-primary">{notif.title}</span>
								<span class="text-[10px] font-mono text-text-secondary">{notif.category}</span>
							</div>
							<p class="text-xs text-text-secondary mt-0.5 truncate">{notif.message}</p>
						</div>
						<span class="text-[10px] font-mono text-text-secondary shrink-0">{timeAgo(notif.timestamp)}</span>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Agent Lifecycle Timeline (last 24h) -->
	{#if analytics.timeline.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-3">24h Agent Activity</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-end gap-1 h-20">
					{#each analytics.timeline as bucket}
						{@const maxEvents = Math.max(...analytics.timeline.map((t: any) => t.events), 1)}
						{@const height = (bucket.events / maxEvents) * 100}
						<div
							class="flex-1 flex flex-col items-center gap-0.5"
							title="{bucket.hour.slice(11, 16)}: {bucket.tasks} tasks, {bucket.events} events, ${bucket.cost.toFixed(2)}"
						>
							<div class="w-full rounded-t bg-accent-cyan/60 transition-all" style="height: {height}%"></div>
						</div>
					{/each}
				</div>
				<div class="flex justify-between mt-1.5 text-[10px] text-text-secondary font-mono">
					<span>{analytics.timeline[0]?.hour.slice(11, 16) ?? ''}</span>
					<span class="text-text-secondary/50">{analytics.timeline.length} hours</span>
					<span>{analytics.timeline[analytics.timeline.length - 1]?.hour.slice(11, 16) ?? ''}</span>
				</div>
			</div>
		</section>
	{/if}

	<!-- VRAM + Daemon -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- VRAM -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-2">VRAM Usage</p>
			<div class="flex items-baseline gap-2 mb-1">
				<span class="type-mono-value text-accent-yellow">{vramUsedGb.toFixed(1)} GB</span>
				<span class="text-sm text-text-secondary">/ {totalVramGb} GB</span>
			</div>
			<div class="h-3 bg-bg-primary rounded-full overflow-hidden mb-2">
				<div
					class="h-full rounded-full transition-all {vramUsedGb / totalVramGb > 0.8 ? 'bg-accent-yellow' : 'bg-accent-green'}"
					style="width: {(vramUsedGb / totalVramGb) * 100}%"
				></div>
			</div>
			<div class="text-xs text-text-secondary font-mono">
				{#if runningModel}
					{modelName} &middot; {runningModel.details?.parameter_size ?? ''} &middot; {runningModel.details?.quantization_level ?? ''}
				{:else}
					No models loaded
				{/if}
			</div>
		</div>

		<!-- Daemon Status -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-2">
				<p class="type-label text-text-secondary">Heartbeat / Daemon</p>
				<span class="text-xs px-2 py-0.5 rounded-full {daemon?.running ? 'bg-accent-green/15 text-accent-green' : 'bg-bg-tertiary text-text-secondary'}">
					{daemon?.running ? 'active' : 'stopped'}
				</span>
			</div>
			{#if daemon}
				{@const workers = Object.entries(daemon.workers ?? {})}
				{@const activeW = workers.filter(([, w]) => w.runCount > 0).length}
				<div class="space-y-1.5 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Workers</span>
						<span class="font-mono text-text-primary">{activeW} / {workers.length} active</span>
					</div>
					{#each workers.slice(0, 4) as [name, w]}
						<div class="flex items-center justify-between">
							<span class="text-text-secondary truncate max-w-[120px]">{name}</span>
							<div class="flex items-center gap-3">
								<span class="font-mono text-text-primary">{w.runCount} runs</span>
								<span class="font-mono {w.failureCount > 0 ? 'text-accent-red' : 'text-accent-green'}">{w.runCount > 0 ? Math.round((w.successCount / w.runCount) * 100) + '%' : '-'}</span>
							</div>
						</div>
					{/each}
					{#if workers.length > 4}
						<p class="text-text-secondary/50 text-center">+{workers.length - 4} more</p>
					{/if}
				</div>
			{:else}
				<p class="text-xs text-text-secondary mt-2">No daemon state available.</p>
			{/if}
		</div>
	</div>
</div>
