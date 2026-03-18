<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const healthMap: Record<string, 'online' | 'warning' | 'offline'> = {
		healthy: 'online',
		warning: 'warning',
		error: 'offline',
		unknown: 'offline'
	};

	const depTypeColors: Record<string, string> = {
		runtime: 'bg-accent-blue/20 text-accent-blue',
		dev: 'bg-accent-purple/20 text-accent-purple',
		'mod-framework': 'bg-accent-red/20 text-accent-red',
		platform: 'bg-accent-yellow/20 text-accent-yellow'
	};

	const maintenanceChecks = $derived([
		{ label: 'README', has: data.maintenance.hasReadme },
		{ label: 'Changelog', has: data.maintenance.hasChangelog },
		{ label: 'Docs directory', has: data.maintenance.hasDocsDir },
		{ label: 'CLAUDE.md', has: data.maintenance.hasClaude },
		{ label: 'Claude Flow', has: data.maintenance.hasClaudeFlow },
		{ label: 'License', has: data.maintenance.hasLicense }
	]);

	function formatDate(iso: string | null): string {
		if (!iso) return 'Unknown';
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return iso;
		}
	}

	let showAllDeps = $state(false);
	const visibleDeps = $derived(showAllDeps ? data.dependencies : data.dependencies.slice(0, 12));
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">About / Stack</h1>
		<p class="text-sm text-text-secondary mt-1">
			Project characteristics, dependencies, and configuration
		</p>
	</div>

	<!-- Identity Card -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center gap-3 mb-2">
			<h2 class="text-sm font-bold text-text-primary">{data.identity.name}</h2>
			<StatusBadge status={healthMap[data.identity.health] ?? 'offline'} label={data.identity.health} size="sm" />
			<span class="text-xs px-2 py-0.5 rounded bg-accent-cyan/20 text-accent-cyan">{data.identity.status}</span>
		</div>
		<p class="text-xs text-text-secondary mb-3">{data.identity.description}</p>
		<div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
			<div>
				<p class="text-text-secondary uppercase tracking-wider mb-0.5">Path</p>
				<p class="text-text-primary font-mono truncate" title={data.identity.path}>{data.identity.path}</p>
			</div>
			<div>
				<p class="text-text-secondary uppercase tracking-wider mb-0.5">Branch</p>
				<p class="text-accent-cyan font-mono">{data.identity.branch}</p>
			</div>
			<div>
				<p class="text-text-secondary uppercase tracking-wider mb-0.5">Last Activity</p>
				<p class="text-text-primary">{data.identity.lastOpened}</p>
			</div>
			{#if data.gitRemote}
				<div>
					<p class="text-text-secondary uppercase tracking-wider mb-0.5">Remote</p>
					<p class="text-text-primary font-mono truncate" title={data.gitRemote}>{data.gitRemote}</p>
				</div>
			{/if}
		</div>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Dependencies" value={data.stats.totalDeps} accent="blue" />
		<MetricCard label="Branches" value={data.stats.totalBranches} accent="cyan" />
		<MetricCard label="Agents" value={data.stats.totalAgents} accent="purple" />
		<MetricCard label="Workflows" value={data.stats.totalWorkflows} accent="green" />
	</div>

	<!-- Tech Stack & Language -->
	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<!-- Detected Stack -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Detected Technologies</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3">
				{#if data.techStack.length > 0}
					<div class="flex flex-wrap gap-2">
						{#each data.techStack as tech}
							<span class="text-xs px-2 py-1 rounded bg-bg-tertiary text-text-primary">{tech}</span>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-text-secondary italic">No technologies detected</p>
				{/if}
				{#if data.language || data.framework || data.buildTool}
					<div class="mt-3 pt-3 border-t border-border space-y-1.5">
						{#if data.language}
							<div class="flex items-center justify-between text-xs">
								<span class="text-text-secondary">Language</span>
								<span class="text-text-primary font-medium">{data.language}</span>
							</div>
						{/if}
						{#if data.framework}
							<div class="flex items-center justify-between text-xs">
								<span class="text-text-secondary">Framework</span>
								<span class="text-text-primary font-medium">{data.framework}</span>
							</div>
						{/if}
						{#if data.buildTool}
							<div class="flex items-center justify-between text-xs">
								<span class="text-text-secondary">Build Tool</span>
								<span class="text-text-primary font-medium">{data.buildTool}</span>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<!-- Commands -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Commands</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
				{#each Object.entries(data.commands) as [key, cmd]}
					<div class="flex items-center justify-between text-xs">
						<span class="text-text-secondary capitalize">{key}</span>
						{#if cmd}
							<span class="text-accent-cyan font-mono truncate ml-2" title={cmd}>{cmd}</span>
						{:else}
							<span class="text-text-secondary italic">not configured</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Maintenance Checklist -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Project Health</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3 space-y-2">
				{#each maintenanceChecks as check}
					<div class="flex items-center gap-2 text-xs">
						{#if check.has}
							<span class="text-accent-green">&#x2713;</span>
						{:else}
							<span class="text-accent-red">&#x2717;</span>
						{/if}
						<span class="text-text-primary">{check.label}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Timeline -->
	<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="text-xs text-text-secondary uppercase tracking-wider mb-1">Created</p>
			<p class="text-sm font-mono text-text-primary">{formatDate(data.timeline.created)}</p>
		</div>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="text-xs text-text-secondary uppercase tracking-wider mb-1">Last Modified</p>
			<p class="text-sm font-mono text-text-primary">{formatDate(data.timeline.lastModified)}</p>
		</div>
	</div>

	<!-- Scripts from package.json -->
	{#if Object.keys(data.scripts).length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Package Scripts</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each Object.entries(data.scripts) as [name, cmd]}
					<div class="flex items-center gap-4 px-4 py-2.5 border-b border-border last:border-0">
						<span class="text-sm font-mono text-accent-blue shrink-0 w-32">{name}</span>
						<span class="text-xs font-mono text-text-secondary truncate" title={cmd}>{cmd}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Dependencies -->
	{#if data.dependencies.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">
				Dependencies ({data.dependencies.length})
			</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each visibleDeps as dep}
					<div class="flex items-center gap-4 px-4 py-2.5 border-b border-border last:border-0">
						<span class="text-sm font-mono text-text-primary flex-1">{dep.name}</span>
						{#if dep.version}
							<span class="text-xs font-mono text-text-secondary">{dep.version}</span>
						{/if}
						<span class="text-[10px] px-1.5 py-0.5 rounded {depTypeColors[dep.type] ?? 'bg-bg-tertiary text-text-secondary'}">{dep.type}</span>
					</div>
				{/each}
			</div>
			{#if data.dependencies.length > 12}
				<button
					onclick={() => showAllDeps = !showAllDeps}
					class="mt-2 text-xs text-accent-blue hover:underline"
				>
					{showAllDeps ? 'Show less' : `Show all ${data.dependencies.length} dependencies`}
				</button>
			{/if}
		</div>
	{/if}

	<!-- Git Branches -->
	{#if data.branches.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Git Branches</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3">
				<div class="flex flex-wrap gap-2">
					{#each data.branches as branch}
						<span class="text-xs font-mono px-2 py-1 rounded {branch === data.defaultBranch ? 'bg-accent-green/20 text-accent-green' : 'bg-bg-tertiary text-text-secondary'}">
							{branch}
						</span>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- CI/CD Workflows -->
	{#if data.workflows.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">CI/CD Workflows</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each data.workflows as wf}
					<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
						<span class="text-sm text-text-primary font-medium flex-1">{wf.name}</span>
						<span class="text-xs font-mono text-text-secondary">{wf.file}</span>
						<div class="flex gap-1">
							{#each wf.triggers as trigger}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-accent-purple/20 text-accent-purple">{trigger}</span>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Release Process -->
	{#if data.releaseProcess.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Release Process</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-3">
				<div class="flex flex-wrap gap-2">
					{#each data.releaseProcess as process}
						<span class="text-xs px-2 py-1 rounded bg-accent-green/20 text-accent-green">{process}</span>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- Agents -->
	{#if data.agents.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Agent Types</h2>
			<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
				{#each data.agents as agent}
					<div class="bg-bg-secondary border border-border rounded-lg p-3">
						<p class="text-sm font-medium text-text-primary">{agent.name}</p>
						<p class="text-xs text-text-secondary mt-1">{agent.fileCount} files</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
