<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		paused: 'bg-accent-yellow',
		completed: 'bg-bg-tertiary'
	};

	const typeColors: Record<string, string> = {
		sparc: 'bg-accent-purple/20 text-accent-purple',
		debug: 'bg-accent-red/20 text-accent-red',
		swarm: 'bg-accent-blue/20 text-accent-blue',
		tdd: 'bg-accent-green/20 text-accent-green'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Sessions</h1>
			<p class="text-sm text-text-secondary mt-1">Workflows and sessions scoped to ai-playground</p>
		</div>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			+ New Session
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Active" value={data.summary.active} accent="green" />
		<MetricCard label="Paused" value={data.summary.paused} accent="yellow" />
		<MetricCard label="Completed" value={data.summary.completed} accent="blue" />
		<MetricCard label="Total Turns" value={data.summary.totalTurns.toLocaleString()} accent="cyan" />
	</div>

	<!-- Session Table -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Active Sessions</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.sessions as session}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium text-text-primary">{session.name}</span>
							<span class="text-[10px] font-mono text-text-secondary">{session.id}</span>
						</div>
					</div>
					<span class="text-[10px] px-2 py-0.5 rounded font-mono {typeColors[session.type]}">{session.type}</span>
					<div class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full {statusDots[session.status]}"></span>
						<span class="text-xs text-text-secondary">{session.status}</span>
					</div>
					<span class="text-xs font-mono text-text-secondary w-8 text-center">{session.agents}</span>
					<span class="text-xs font-mono text-text-secondary w-12 text-center">{session.turns}</span>
					<span class="text-xs font-mono text-text-secondary w-16 text-right">{session.duration}</span>
					<div class="flex gap-1 w-20 justify-end">
						{#if session.status === 'active'}
							<button class="text-[10px] px-2 py-1 bg-accent-yellow/20 text-accent-yellow rounded hover:bg-accent-yellow/30 transition-colors">Pause</button>
							<button class="text-[10px] px-2 py-1 bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors">Stop</button>
						{:else if session.status === 'paused'}
							<button class="text-[10px] px-2 py-1 bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors">Resume</button>
						{:else}
							<button class="text-[10px] px-2 py-1 bg-bg-tertiary text-text-secondary rounded hover:text-text-primary transition-colors">View</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Session Timeline -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Session Timeline</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between">
				{#each data.timeline as event}
					<div class="flex flex-col items-center gap-2">
						<span class="w-3 h-3 rounded-full bg-accent-{event.color}"></span>
						<span class="text-[10px] font-mono text-text-secondary">{event.time}</span>
						<span class="text-[10px] text-text-secondary text-center max-w-20">{event.label}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Resource Usage -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Resource Usage</h2>
		<div class="grid grid-cols-3 gap-4">
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-xs text-text-secondary">API Tokens Used</p>
				<p class="text-2xl font-bold font-mono text-accent-blue">{data.resources.apiTokens.value.toLocaleString()}</p>
				<p class="text-xs text-text-secondary mt-1">{data.resources.apiTokens.cost}</p>
			</div>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-xs text-text-secondary">Local Tokens</p>
				<p class="text-2xl font-bold font-mono text-accent-green">{data.resources.localTokens.value.toLocaleString()}</p>
				<p class="text-xs text-text-secondary mt-1">{data.resources.localTokens.cost}</p>
			</div>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<p class="text-xs text-text-secondary">Memory Nodes</p>
				<p class="text-2xl font-bold font-mono text-accent-purple">{data.resources.memoryNodes.value}</p>
				<p class="text-xs text-text-secondary mt-1">{data.resources.memoryNodes.label}</p>
			</div>
		</div>
	</div>
</div>
