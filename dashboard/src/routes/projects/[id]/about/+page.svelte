<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const techStatusMap: Record<string, 'online' | 'warning' | 'offline'> = {
		connected: 'online',
		running: 'online',
		loaded: 'online',
		available: 'online',
		stopped: 'offline',
		planned: 'warning'
	};

	const taskStatusColors: Record<string, string> = {
		'completed': 'text-accent-green',
		'in-progress': 'text-accent-blue',
		'planned': 'text-text-secondary'
	};

	const priorityColors: Record<string, string> = {
		high: 'bg-accent-red/20 text-accent-red',
		medium: 'bg-accent-yellow/20 text-accent-yellow',
		low: 'bg-accent-green/20 text-accent-green'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">About / Stack</h1>
		<p class="text-sm text-text-secondary mt-1">
			Project characteristics, dependencies, and configuration for ai-playground
		</p>
	</div>

	<!-- Identity -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center gap-3 mb-2">
			<h2 class="text-sm font-bold text-text-primary">{data.identity.name}</h2>
			<span class="text-xs font-mono text-text-secondary">{data.identity.version}</span>
			<span class="text-xs px-2 py-0.5 bg-accent-green/20 text-accent-green rounded">{data.identity.status}</span>
		</div>
		<p class="text-xs text-text-secondary">{data.identity.description}</p>
	</div>

	<!-- Core Technologies -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Core Technologies</h2>
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			{#each data.coreTech as tech}
				<div class="bg-bg-secondary border border-border rounded-lg p-3">
					<div class="flex items-center justify-between mb-1">
						<span class="text-sm font-medium text-text-primary">{tech.name}</span>
						<StatusBadge status={techStatusMap[tech.status]} size="sm" />
					</div>
					<span class="text-xs font-mono text-text-secondary">{tech.version}</span>
					<div class="mt-2">
						<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded">{tech.badge}</span>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- Languages -->
	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Languages</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
				{#each data.languages as lang}
					<div class="flex items-center justify-between text-xs">
						<span class="text-text-primary">{lang.name}</span>
						<div class="flex items-center gap-2">
							<span class="text-text-secondary font-mono">{lang.files}</span>
							<div class="w-16 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
								<div class="h-full bg-{lang.color} rounded-full" style="width: {lang.pct}%"></div>
							</div>
							<span class="text-text-secondary font-mono w-8 text-right">{lang.pct}%</span>
						</div>
					</div>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Frameworks & Runtime</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
				{#each data.frameworks as fw}
					<p class="text-xs text-text-primary">{fw}</p>
				{/each}
			</div>
		</div>

		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Tools & Infrastructure</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
				{#each data.tools as tool}
					<p class="text-xs text-text-primary">{tool}</p>
				{/each}
			</div>
		</div>
	</div>

	<!-- MCP Servers -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">MCP Servers</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.mcpServers as server}
				<div class="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
					<div class="flex items-center gap-3">
						<span class="w-2 h-2 rounded-full {server.status === 'running' ? 'bg-accent-green' : 'bg-accent-red'}"></span>
						<span class="text-sm font-mono text-text-primary">{server.name}</span>
					</div>
					<span class="text-xs text-text-secondary">{server.description}</span>
					<span class="text-xs font-mono {server.status === 'running' ? 'text-accent-green' : 'text-accent-red'}">{server.status}</span>
				</div>
			{/each}
		</div>
	</div>

	<!-- Channels -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Channels</h2>
		<div class="flex gap-3">
			{#each data.channels as ch}
				<div class="bg-bg-secondary border border-border rounded-lg px-4 py-3 flex items-center gap-3">
					<StatusBadge status={techStatusMap[ch.status]} size="sm" />
					<span class="text-sm text-text-primary">{ch.name}</span>
					<span class="text-[10px] px-1.5 py-0.5 bg-bg-tertiary text-text-secondary rounded">{ch.badge}</span>
				</div>
			{/each}
		</div>
	</div>

	<!-- Project Tasks -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Project Tasks</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.tasks as task}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-xs font-mono text-text-secondary w-20">{task.id}</span>
					<span class="text-xs px-2 py-0.5 rounded {priorityColors[task.priority]}">{task.priority}</span>
					<span class="text-sm text-text-primary flex-1">{task.title}</span>
					<span class="text-xs font-mono {taskStatusColors[task.status]}">{task.status}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
