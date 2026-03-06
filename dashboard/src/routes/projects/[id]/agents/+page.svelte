<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';
	import { page, navigating } from '$app/stores';
	import { invalidateAll, goto } from '$app/navigation';
	import { onMount } from 'svelte';

	let { data }: { data: PageData } = $props();

	const isNavigating = $derived(!!$navigating);

	const capacityPct = $derived(Math.round((data.capacity.current / data.capacity.max) * 100));

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
		general: 'bg-bg-tertiary text-text-secondary'
	};

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		idle: 'bg-accent-yellow',
		stopped: 'bg-accent-red'
	};

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
		} catch (e) {
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
		} catch (e) {
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
	<meta name="description" content="Manage AI agents associated with this project — view capacity, add or remove agents, and monitor agent status." />
	<meta name="robots" content="noindex, nofollow" />
	<meta property="og:title" content="Project Agents | AI Playground" />
	<meta property="og:description" content="Manage AI agents associated with this project — view capacity, add or remove agents, and monitor agent status." />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Project Agents | AI Playground" />
	<meta name="twitter:description" content="Manage AI agents associated with this project — view capacity, add or remove agents, and monitor agent status." />
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Agents</h1>
			<p class="text-sm text-text-secondary mt-1">Agents associated with this project</p>
		</div>
		<button
			onclick={() => (showAddPanel = !showAddPanel)}
			aria-expanded={showAddPanel}
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
		>
			{showAddPanel ? 'Cancel' : '+ Add Agent'}
		</button>
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
		<MetricCard label="Types" value={data.summary.types} accent="purple" />
		<MetricCard label="Total" value={data.summary.total} accent="cyan" />
	</div>

	<!-- Capacity Bar -->
	<div class="flex items-center gap-3">
		<span id="capacity-label" class="text-xs text-text-secondary uppercase tracking-wider">Capacity</span>
		<span class="text-xs font-mono text-text-primary">{data.capacity.current} / {data.capacity.max} slots</span>
		<div class="flex-1 h-2 bg-bg-tertiary rounded-full overflow-hidden" role="progressbar" aria-labelledby="capacity-label" aria-valuenow={data.capacity.current} aria-valuemin={0} aria-valuemax={data.capacity.max} aria-valuetext="{data.capacity.current} of {data.capacity.max} slots used">
			<div
				class="h-full rounded-full transition-all {capacityPct > 80 ? 'bg-accent-red' : capacityPct > 50 ? 'bg-accent-yellow' : 'bg-accent-green'}"
				style="width: {capacityPct}%"
			></div>
		</div>
	</div>

	<!-- Session Pool -->
	<section aria-label="Project session pool" class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-sm font-bold text-text-primary">Session Pool</h2>
				<p class="text-xs text-text-secondary mt-0.5">{poolSlots.length} session{poolSlots.length !== 1 ? 's' : ''} for this project</p>
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
				<h2 class="text-sm font-bold text-text-primary">Select agents to add</h2>
				<button
					onclick={addAgents}
					disabled={selectedAgents.size === 0 || loading}
					class="px-3 py-1.5 text-xs bg-accent-green text-white rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Add {selectedAgents.size} Agent{selectedAgents.size !== 1 ? 's' : ''}
				</button>
			</div>
			{#if data.availableAgents.length > 0}
				<div role="listbox" aria-label="Available agents" aria-multiselectable="true" class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
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
				<button
					onclick={() => (showAddPanel = true)}
					class="mt-4 px-4 py-2 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
				>
					+ Add Agent
				</button>
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
