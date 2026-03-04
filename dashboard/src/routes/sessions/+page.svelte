<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let selectedId = $state(data.sessions[0]?.id ?? '');
	let selected = $derived(data.sessions.find((s) => s.id === selectedId) ?? data.sessions[0]);

	const statusMap: Record<string, 'online' | 'offline' | 'warning' | 'error'> = {
		running: 'online',
		completed: 'offline',
		error: 'error'
	};

	const statusLabel: Record<string, string> = {
		running: 'Running',
		completed: 'Done',
		error: 'Error'
	};

	const stageColors: Record<string, string> = {
		completed: 'border-accent-green bg-accent-green/10 text-accent-green',
		running: 'border-accent-blue bg-accent-blue/10 text-accent-blue',
		pending: 'border-border bg-bg-primary text-text-secondary',
		error: 'border-accent-red bg-accent-red/10 text-accent-red'
	};

	const agentTypeColors: Record<string, string> = {
		coder: 'text-accent-blue',
		reviewer: 'text-accent-purple',
		tester: 'text-accent-green',
		planner: 'text-accent-cyan',
		coordinator: 'text-accent-yellow'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Active Sessions</h1>
		<p class="text-sm text-text-secondary mt-1">Monitor running workflows and agent sessions</p>
	</div>

	<!-- Main Layout: List + Detail -->
	<div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
		<!-- Left: Session List -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<div class="p-3 border-b border-border">
				<p class="text-xs text-text-secondary uppercase tracking-wider">Sessions</p>
			</div>
			<div class="divide-y divide-border max-h-[600px] overflow-y-auto">
				{#each data.sessions as session}
					<button
						class="w-full text-left p-3 hover:bg-bg-tertiary transition-colors {session.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-blue' : ''}"
						onclick={() => (selectedId = session.id)}
					>
						<div class="flex items-center justify-between mb-1">
							<span class="text-sm font-medium text-text-primary truncate">{session.name}</span>
							<StatusBadge status={statusMap[session.status]} label={statusLabel[session.status]} size="sm" />
						</div>
						<div class="flex items-center gap-3 text-xs text-text-secondary">
							<span class="font-mono">{session.id}</span>
							<span>{session.agentCount} agents</span>
							<span>{session.duration}</span>
						</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Right: Detail Panel -->
		{#if selected}
			<div class="space-y-4">
				<!-- Session Workflow -->
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-4">
						<h2 class="text-sm text-text-secondary uppercase tracking-wider">Session Workflow</h2>
						<span class="text-xs font-mono text-text-secondary">{selected.name}</span>
					</div>

					<!-- Pipeline visualization -->
					<div class="flex items-center gap-2 overflow-x-auto pb-2">
						{#each selected.workflow as stage, i}
							<div class="flex items-center gap-2 shrink-0">
								<div class="border rounded-lg px-3 py-2 text-xs font-medium {stageColors[stage.status]}">
									<div>{stage.name}</div>
									{#if stage.agent}
										<div class="text-[10px] opacity-75 mt-0.5">{stage.agent}</div>
									{/if}
								</div>
								{#if i < selected.workflow.length - 1}
									<svg class="w-4 h-4 text-text-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
									</svg>
								{/if}
							</div>
						{/each}
					</div>
				</div>

				<!-- Agent Detail -->
				{#if selected.agents.length > 0}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Agent Details</h2>
						<div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
							{#each selected.agents as agent}
								<div class="border border-border rounded-lg p-3 bg-bg-primary">
									<div class="flex items-center justify-between mb-2">
										<span class="text-sm font-medium text-text-primary">{agent.name}</span>
										<span class="text-xs font-mono text-accent-cyan">{agent.model}</span>
									</div>
									<div class="grid grid-cols-2 gap-2 text-xs">
										<div>
											<span class="text-text-secondary">Started:</span>
											<span class="text-text-primary ml-1 font-mono">{agent.started}</span>
										</div>
										<div>
											<span class="text-text-secondary">Duration:</span>
											<span class="text-text-primary ml-1 font-mono">{agent.duration}</span>
										</div>
										<div>
											<span class="text-text-secondary">Files:</span>
											<span class="text-text-primary ml-1 font-mono">{agent.filesModified}</span>
										</div>
										<div>
											<span class="text-text-secondary">Tools:</span>
											<span class="text-text-primary ml-1 font-mono">{agent.toolsUsed.length}</span>
										</div>
									</div>
									<div class="mt-2 pt-2 border-t border-border">
										<p class="text-xs text-text-secondary mb-1">Input:</p>
										<p class="text-xs text-text-primary">{agent.input}</p>
										<p class="text-xs text-text-secondary mt-1 mb-1">Output:</p>
										<p class="text-xs text-text-primary">{agent.output}</p>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Execution Log -->
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Execution Log</h2>
					<div class="bg-bg-primary rounded-lg p-3 max-h-[250px] overflow-y-auto font-mono text-xs space-y-1">
						{#if selected.logs.length > 0}
							{#each selected.logs as log}
								<div class="flex gap-2">
									<span class="text-text-secondary shrink-0">{log.timestamp}</span>
									<span class="{agentTypeColors[log.agentType] ?? 'text-text-secondary'} shrink-0">[{log.agent}]</span>
									<span class="text-text-primary">{log.message}</span>
								</div>
							{/each}
						{:else}
							<p class="text-text-secondary">No log entries for this session.</p>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Summary Row -->
	<div class="text-xs text-text-secondary text-center py-2 border-t border-border">
		{data.summary.total} sessions total / {data.summary.running} running / {data.summary.completed} done / {data.summary.errored} error
	</div>
</div>
