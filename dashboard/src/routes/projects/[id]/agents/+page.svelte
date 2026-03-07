<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';
	import { page, navigating } from '$app/stores';
	import { invalidateAll, goto } from '$app/navigation';
	import { onMount } from 'svelte';

	let { data }: { data: PageData } = $props();

	const isNavigating = $derived(!!$navigating);
	const capacityPct = $derived(
		data.capacity.max > 0 ? Math.min(100, Math.round((data.capacity.current / data.capacity.max) * 100)) : 0
	);

	let showAddPanel = $state(false);
	let selectedAgents = $state<Set<string>>(new Set());
	let loading = $state(false);
	let error = $state<string | null>(null);
	let poolAction = $state('');
	let poolSlots = $state<Array<{ slotId: string; model: string; area: string; status: string; taskCount: number }>>(data.poolSlots ?? []);

	// Lazy-load the heavy AgentGrid component
	let AgentGrid = $state<typeof import('$lib/components/AgentGrid.svelte').default | null>(null);
	onMount(() => {
		import('$lib/components/AgentGrid.svelte').then((m) => {
			AgentGrid = m.default;
		});
	});

	const typeColors: Record<string, string> = {
		coder: 'bg-accent-blue/20 text-accent-blue',
		researcher: 'bg-accent-purple/20 text-accent-purple',
		tester: 'bg-accent-green/20 text-accent-green',
		reviewer: 'bg-accent-cyan/20 text-accent-cyan',
		planner: 'bg-accent-yellow/20 text-accent-yellow',
		security: 'bg-accent-red/20 text-accent-red',
		documenter: 'bg-accent-cyan/20 text-accent-cyan',
		general: 'bg-bg-tertiary text-text-secondary'
	};

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		idle: 'bg-accent-yellow',
		stopped: 'bg-accent-red'
	};

	// Recommended agent templates for project-specific agent creation
	const agentTemplates = [
		{
			id: 'coder',
			name: 'Code Agent',
			type: 'coder',
			description: 'Writes and refactors code, implements features, fixes bugs',
			workflow: 'Receives task → reads codebase → implements changes → runs build → commits',
			value: 'Handles the bulk of implementation work autonomously',
			when: 'Any code change, feature implementation, or bug fix'
		},
		{
			id: 'reviewer',
			name: 'Code Reviewer',
			type: 'reviewer',
			description: 'Reviews code changes for quality, security, and correctness',
			workflow: 'Reads diffs → checks patterns → flags issues → suggests improvements',
			value: 'Catches bugs, security issues, and quality problems before merge',
			when: 'After code agents complete work, or on PR review'
		},
		{
			id: 'tester',
			name: 'Test Agent',
			type: 'tester',
			description: 'Writes and runs tests, validates functionality',
			workflow: 'Reads code → writes unit/integration tests → runs test suite → reports coverage',
			value: 'Ensures code correctness and prevents regressions',
			when: 'After new features, after bug fixes, or on test coverage gaps'
		},
		{
			id: 'documenter',
			name: 'Documentation Agent',
			type: 'documenter',
			description: 'Updates docs, API contracts, and architecture notes',
			workflow: 'Reads recent changes → updates relevant docs → verifies build',
			value: 'Keeps documentation in sync with code changes',
			when: 'After multi-file features, API changes, or architecture changes'
		},
		{
			id: 'security',
			name: 'Security Auditor',
			type: 'security',
			description: 'Scans for vulnerabilities, credential leaks, and OWASP issues',
			workflow: 'Scans codebase → checks dependencies → reports vulnerabilities',
			value: 'Proactive security scanning prevents vulnerabilities from shipping',
			when: 'On new endpoints, auth changes, or dependency updates'
		},
		{
			id: 'researcher',
			name: 'Research Agent',
			type: 'researcher',
			description: 'Investigates approaches, reads docs, evaluates options',
			workflow: 'Reads requirements → researches approaches → summarizes findings',
			value: 'Provides informed recommendations before implementation begins',
			when: 'Architecture decisions, new library evaluation, unfamiliar domains'
		}
	];

	let showTemplates = $state(false);
	let expandedTemplate = $state<string | null>(null);

	function getProjectId(): string {
		return $page.params.id;
	}

	async function addAgents() {
		if (selectedAgents.size === 0) return;
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ agents: [...selectedAgents] })
			});
			if (res.ok) {
				selectedAgents = new Set();
				showAddPanel = false;
				await invalidateAll();
			} else {
				const body = await res.json().catch(() => null);
				error = body?.error ?? `Failed to add agents (${res.status})`;
			}
		} catch {
			error = 'Network error — could not reach server.';
		} finally {
			loading = false;
		}
	}

	async function removeAgent(filename: string) {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ agents: [filename] })
			});
			if (res.ok) {
				await invalidateAll();
			} else {
				const body = await res.json().catch(() => null);
				error = body?.error ?? `Failed to remove agent (${res.status})`;
			}
		} catch {
			error = 'Network error — could not reach server.';
		} finally {
			loading = false;
		}
	}

	function toggleSelection(filename: string) {
		const next = new Set(selectedAgents);
		if (next.has(filename)) {
			next.delete(filename);
		} else {
			next.add(filename);
		}
		selectedAgents = next;
	}

	async function spawnPool() {
		if (data.summary.associated === 0) {
			error = 'Add agents to this project first before spawning a pool.';
			return;
		}
		poolAction = 'spawning';
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'spawn-pool' })
			});
			const body = await res.json();
			if (res.ok && body.success) {
				if (body.pool?.slots) poolSlots = body.pool.slots;
			} else {
				error = body?.error ?? `Failed to spawn pool (${res.status})`;
			}
		} catch {
			error = 'Network error — could not spawn pool.';
		} finally {
			poolAction = '';
		}
	}

	async function resetPool() {
		if (!confirm('Reset this project\'s session pool? All project sessions will be removed.')) return;
		poolAction = 'resetting';
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reset-pool' })
			});
			const body = await res.json();
			if (res.ok && body.success) {
				poolSlots = body.pool?.slots ?? [];
			} else {
				error = body?.error ?? `Failed to reset pool (${res.status})`;
			}
		} catch {
			error = 'Network error — could not reset pool.';
		} finally {
			poolAction = '';
		}
	}

	function goToPage(p: number) {
		const url = new URL($page.url);
		url.searchParams.set('page', String(p));
		goto(url.toString(), { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Project Agents | AI Playground</title>
	<meta name="description" content="Manage AI agents for this project — configure capacity, add agents, spawn pools, and monitor status." />
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Agents</h1>
			<p class="text-sm text-text-secondary mt-1">
				Max {data.projectMaxAgents} concurrent agent{data.projectMaxAgents !== 1 ? 's' : ''} for this project
				<a href="/projects/{getProjectId()}/settings" class="text-accent-blue hover:underline ml-1">(change)</a>
			</p>
		</div>
		<div class="flex gap-2">
			<button
				onclick={() => { showTemplates = !showTemplates; showAddPanel = false; }}
				class="px-4 py-2 text-sm border border-accent-purple/50 text-accent-purple rounded-lg hover:bg-accent-purple/10 transition-colors"
			>
				{showTemplates ? 'Hide' : 'Agent Guide'}
			</button>
			<button
				onclick={() => { showAddPanel = !showAddPanel; showTemplates = false; }}
				aria-expanded={showAddPanel}
				class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				{showAddPanel ? 'Cancel' : '+ Add Agent'}
			</button>
		</div>
	</div>

	<!-- Loading indicator -->
	{#if loading || isNavigating}
		<div role="status" aria-live="polite" class="flex items-center gap-2 px-4 py-2 bg-accent-blue/10 border border-accent-blue/30 rounded-lg text-sm text-accent-blue">
			<svg class="animate-spin h-4 w-4" aria-hidden="true" viewBox="0 0 24 24" fill="none">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			{isNavigating ? 'Loading agents…' : 'Working…'}
		</div>
	{/if}

	<!-- Server load error -->
	{#if data.loadError}
		<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-6 text-center">
			<div class="text-2xl mb-2 opacity-50" aria-hidden="true">&#9888;</div>
			<p class="text-sm font-medium text-accent-red mb-1">Failed to load agents</p>
			<p class="text-xs text-text-secondary mb-3">{data.loadError}</p>
			<button
				onclick={() => invalidateAll()}
				class="px-4 py-2 text-xs bg-accent-red/20 text-accent-red rounded-lg hover:bg-accent-red/30 transition-colors"
			>
				Retry
			</button>
		</div>
	{/if}

	<!-- Client action error -->
	{#if error}
		<div role="alert" class="flex items-center justify-between px-4 py-2 bg-accent-red/10 border border-accent-red/30 rounded-lg text-sm text-accent-red">
			<span>{error}</span>
			<button onclick={() => (error = null)} aria-label="Dismiss error" class="text-accent-red hover:text-accent-red/70 text-xs font-mono">dismiss</button>
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Associated" value={data.summary.associated} accent="green" />
		<MetricCard label="Available" value={data.summary.available} accent="blue" />
		<MetricCard label="Max Concurrent" value={data.projectMaxAgents} accent="purple" />
		<MetricCard label="Pool Sessions" value={poolSlots.length} accent="cyan" />
	</div>

	<!-- Capacity Bar -->
	<div class="flex items-center gap-3">
		<span id="capacity-label" class="text-xs text-text-secondary uppercase tracking-wider">Capacity</span>
		<span class="text-xs font-mono text-text-primary">{data.capacity.current} / {data.capacity.max} agents</span>
		<div class="flex-1 h-2 bg-bg-tertiary rounded-full overflow-hidden" role="progressbar" aria-labelledby="capacity-label" aria-valuenow={data.capacity.current} aria-valuemin={0} aria-valuemax={data.capacity.max} aria-valuetext="{data.capacity.current} of {data.capacity.max} agents configured">
			<div
				class="h-full rounded-full transition-all {capacityPct > 80 ? 'bg-accent-red' : capacityPct > 50 ? 'bg-accent-yellow' : 'bg-accent-green'}"
				style="width: {capacityPct}%"
			></div>
		</div>
	</div>

	<!-- Claw Monitor -->
	<section aria-label="Claw Monitor" class="bg-bg-secondary border border-accent-cyan/30 rounded-lg p-4">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-3">
				<span class="w-2 h-2 rounded-full bg-accent-cyan animate-pulse"></span>
				<div>
					<h2 class="text-sm font-bold text-text-primary">Claw Monitor</h2>
					<p class="text-xs text-text-secondary">Global system — monitors all projects, scans tasks, spawns agents</p>
				</div>
			</div>
			<a
				href="/chat?session=claw-monitor"
				class="px-3 py-1.5 text-xs border border-accent-cyan/40 text-accent-cyan rounded hover:bg-accent-cyan/10 transition-colors"
			>
				View Monitor
			</a>
		</div>
	</section>

	<!-- Agent Guide / Templates -->
	{#if showTemplates}
		<section aria-label="Agent templates" class="bg-bg-secondary border border-accent-purple/30 rounded-lg p-4 space-y-3">
			<div>
				<h2 class="text-sm font-bold text-text-primary">Agent Guide</h2>
				<p class="text-xs text-text-secondary mt-0.5">
					Recommended agent types for this project. Add agents from the global pool, then spawn them.
					You can add the same type multiple times for parallel work.
				</p>
			</div>
			<div class="space-y-2">
				{#each agentTemplates as tmpl}
					<button
						onclick={() => expandedTemplate = expandedTemplate === tmpl.id ? null : tmpl.id}
						class="w-full text-left"
					>
						<div class="p-3 rounded-lg border border-border bg-bg-primary hover:border-accent-purple/40 transition-colors">
							<div class="flex items-center gap-3">
								<span class="text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 {typeColors[tmpl.type] ?? typeColors.general}">{tmpl.type}</span>
								<span class="text-sm font-medium text-text-primary">{tmpl.name}</span>
								<span class="text-xs text-text-secondary flex-1 truncate">{tmpl.description}</span>
								<span class="text-text-secondary text-xs">{expandedTemplate === tmpl.id ? '▲' : '▼'}</span>
							</div>
							{#if expandedTemplate === tmpl.id}
								<div class="mt-3 pt-3 border-t border-border grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
									<div>
										<span class="text-text-secondary uppercase tracking-wider text-[10px]">Workflow</span>
										<p class="text-text-primary mt-1">{tmpl.workflow}</p>
									</div>
									<div>
										<span class="text-text-secondary uppercase tracking-wider text-[10px]">Value</span>
										<p class="text-accent-green mt-1">{tmpl.value}</p>
									</div>
									<div>
										<span class="text-text-secondary uppercase tracking-wider text-[10px]">When to Use</span>
										<p class="text-text-primary mt-1">{tmpl.when}</p>
									</div>
								</div>
							{/if}
						</div>
					</button>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Session Pool -->
	<section aria-label="Project session pool" class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-sm font-bold text-text-primary">Session Pool</h2>
				<p class="text-xs text-text-secondary mt-0.5">
					{poolSlots.length} session{poolSlots.length !== 1 ? 's' : ''} for this project
					(max {data.projectMaxAgents} concurrent)
				</p>
			</div>
			<div class="flex gap-2">
				<button
					onclick={resetPool}
					disabled={!!poolAction || poolSlots.length === 0}
					class="px-3 py-1.5 text-xs border border-border text-text-secondary rounded hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{poolAction === 'resetting' ? 'Resetting...' : 'Reset Pool'}
				</button>
				<button
					onclick={spawnPool}
					disabled={!!poolAction || data.summary.associated === 0}
					class="px-3 py-1.5 text-xs bg-accent-green text-white rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{poolAction === 'spawning' ? 'Spawning...' : 'Spawn Pool'}
				</button>
			</div>
		</div>
		{#if poolSlots.length > 0}
			<div class="grid grid-cols-1 md:grid-cols-2 gap-2">
				{#each poolSlots as slot}
					<div class="flex items-center gap-3 p-2 bg-bg-primary rounded border border-border">
						<span class="w-2 h-2 rounded-full shrink-0 {slot.status === 'active' ? 'bg-accent-green animate-pulse' : 'bg-accent-yellow'}"></span>
						<div class="min-w-0 flex-1">
							<span class="text-xs font-mono text-text-primary truncate block">{slot.slotId}</span>
							<span class="text-[10px] text-text-secondary">{slot.area} · {slot.taskCount} tasks</span>
						</div>
						<span class="text-[10px] text-text-secondary font-mono">{slot.model.split('/').pop()?.split('-').slice(0, 2).join('-') ?? slot.model}</span>
					</div>
				{/each}
			</div>
		{:else}
			<p class="text-xs text-text-secondary/70 text-center py-2">No sessions. Click "Spawn Pool" to create sessions for associated agents.</p>
		{/if}
	</section>

	<!-- Add Agent Panel -->
	{#if showAddPanel}
		<section aria-label="Add agents" class="bg-bg-secondary border border-accent-blue/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-sm font-bold text-text-primary">Select agents to add</h2>
					<p class="text-xs text-text-secondary mt-0.5">
						Pick from the global agent pool. You can add the same type multiple times to run parallel instances.
					</p>
				</div>
				<button
					onclick={addAgents}
					disabled={selectedAgents.size === 0 || loading}
					class="px-3 py-1.5 text-xs bg-accent-green text-white rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Add {selectedAgents.size} Agent{selectedAgents.size !== 1 ? 's' : ''}
				</button>
			</div>
			{#if data.availableAgents.length > 0}
				<div role="listbox" aria-label="Available agents" aria-multiselectable="true" class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-80 overflow-y-auto">
					{#each data.availableAgents as agent}
						<button
							role="option"
							aria-selected={selectedAgents.has(agent.filename)}
							onclick={() => toggleSelection(agent.filename)}
							class="flex items-center gap-3 p-3 rounded-lg border transition-colors text-left {selectedAgents.has(agent.filename) ? 'border-accent-blue bg-accent-blue/10' : 'border-border bg-bg-primary hover:border-border'}"
						>
							<div class="w-4 h-4 rounded border flex items-center justify-center shrink-0 {selectedAgents.has(agent.filename) ? 'border-accent-blue bg-accent-blue' : 'border-border'}" aria-hidden="true">
								{#if selectedAgents.has(agent.filename)}
									<span class="text-white text-[10px]">&#10003;</span>
								{/if}
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-text-primary truncate">{agent.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 {typeColors[agent.type] ?? typeColors.general}">{agent.type}</span>
								</div>
								{#if agent.description}
									<p class="text-xs text-text-secondary truncate mt-0.5">{agent.description}</p>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{:else}
				<p class="text-text-secondary text-sm text-center py-4">All agents are already associated with this project.</p>
			{/if}
		</section>
	{/if}

	<!-- Associated Agents (lazy-loaded) -->
	<section aria-label="Associated agents">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Associated Agents</h2>
		{#if AgentGrid}
			<AgentGrid
				agents={data.agents}
				pagination={data.pagination}
				{typeColors}
				{statusDots}
				{loading}
				onremove={removeAgent}
				ongoToPage={goToPage}
			/>
			{#if data.agents.length === 0}
				<div class="text-center py-6">
					<p class="text-text-secondary text-sm mb-3">No agents associated yet. Add agents from the global pool to get started.</p>
					<div class="flex justify-center gap-2">
						<button
							onclick={() => { showTemplates = true; showAddPanel = false; }}
							class="px-4 py-2 text-xs border border-accent-purple/50 text-accent-purple rounded-lg hover:bg-accent-purple/10 transition-colors"
						>
							View Agent Guide
						</button>
						<button
							onclick={() => { showAddPanel = true; showTemplates = false; }}
							class="px-4 py-2 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
						>
							+ Add Agent
						</button>
					</div>
				</div>
			{/if}
		{:else}
			<div role="status" aria-live="polite" class="flex items-center justify-center py-8 text-text-secondary text-sm">
				<svg class="animate-spin h-4 w-4 mr-2" aria-hidden="true" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				Loading agents…
			</div>
		{/if}
	</section>
</div>
