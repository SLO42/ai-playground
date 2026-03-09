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

	// Add panel search/filter
	let agentSearch = $state('');
	let agentTypeFilter = $state('all');

	let availableTypes = $derived(() => {
		const types = new Set<string>();
		for (const a of data.availableAgents) types.add(a.type);
		return [...types].sort();
	});

	let filteredAvailableAgents = $derived(() => {
		let agents = data.availableAgents as Array<{ filename: string; name: string; type: string; description?: string }>;
		if (agentTypeFilter !== 'all') {
			agents = agents.filter(a => a.type === agentTypeFilter);
		}
		if (agentSearch.trim()) {
			const q = agentSearch.toLowerCase().trim();
			agents = agents.filter(a =>
				a.name.toLowerCase().includes(q) ||
				a.type.toLowerCase().includes(q) ||
				(a.description ?? '').toLowerCase().includes(q) ||
				a.filename.toLowerCase().includes(q)
			);
		}
		return agents;
	});

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

	// Category metadata — explains what each agent type does and when to use it
	const categoryInfo: Record<string, { label: string; description: string; when: string; priority: number }> = {
		coder: { label: 'Coders', description: 'Write code, implement features, fix bugs', when: 'Any code change or feature work', priority: 1 },
		reviewer: { label: 'Reviewers', description: 'Review code for quality, security, and correctness', when: 'After code changes, PR review', priority: 2 },
		tester: { label: 'Testers', description: 'Write and run tests, validate functionality', when: 'After features, bug fixes, coverage gaps', priority: 3 },
		security: { label: 'Security', description: 'Scan for vulnerabilities, credential leaks, OWASP issues', when: 'New endpoints, auth changes, dependency updates', priority: 4 },
		documenter: { label: 'Documenters', description: 'Update docs, API contracts, architecture notes', when: 'Multi-file features, API changes', priority: 5 },
		researcher: { label: 'Researchers', description: 'Investigate approaches, evaluate options', when: 'Architecture decisions, unfamiliar domains', priority: 6 },
		planner: { label: 'Planners', description: 'Break down work, create task plans', when: 'Complex features, sprint planning', priority: 7 }
	};

	// Group available agents by type, sorted by priority
	type AgentEntry = { filename: string; name: string; type: string; description?: string };
	let guideCategories = $derived(() => {
		const groups = new Map<string, AgentEntry[]>();
		for (const agent of data.availableAgents as AgentEntry[]) {
			const list = groups.get(agent.type) ?? [];
			list.push(agent);
			groups.set(agent.type, list);
		}
		return [...groups.entries()]
			.map(([type, agents]) => ({
				type,
				info: categoryInfo[type] ?? { label: type, description: '', when: '', priority: 99 },
				agents
			}))
			.sort((a, b) => a.info.priority - b.info.priority);
	});

	let showTemplates = $state(false);
	let expandedTemplate = $state<string | null>(null);
	let suggesting = $state(false);
	let suggestLoading = $state(false);
	let suggestions = $state<Array<{ type: string; name: string; filename: string; description?: string; reason: string; priority: number }>>([]);
	let missingTypes = $state<Array<{ type: string; reason: string; suggestedName: string; suggestedDescription: string }>>([]);
	let suggestionReason = $state('');
	let projectProfile = $state<Record<string, unknown> | null>(null);

	// Agent creation
	let creating = $state(false);
	let createSuccess = $state<string | null>(null);

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

	async function suggestAgents() {
		suggestLoading = true;
		suggesting = true;
		error = null;
		suggestions = [];
		missingTypes = [];
		projectProfile = null;

		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'suggest' })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body?.error ?? `Failed to analyze project (${res.status})`;
				return;
			}

			suggestions = body.suggestions ?? [];
			missingTypes = body.missingTypes ?? [];
			projectProfile = body.projectProfile ?? null;

			if (suggestions.length === 0) {
				suggestionReason = 'No matching agents found for this project. Try adding agents to the global pool first.';
			} else {
				const typeSummary = suggestions.reduce((acc: Record<string, number>, s: { type: string }) => {
					acc[s.type] = (acc[s.type] ?? 0) + 1;
					return acc;
				}, {} as Record<string, number>);
				const parts = Object.entries(typeSummary).map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`);
				suggestionReason = `Based on project analysis: ${parts.join(', ')}`;
			}
		} catch {
			error = 'Network error — could not analyze project.';
		} finally {
			suggestLoading = false;
		}
	}

	async function applySuggestions() {
		const toAdd = suggestions.filter(s => s.filename).map(s => s.filename!);
		if (toAdd.length === 0) {
			error = 'No agents to add.';
			return;
		}

		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ agents: toAdd })
			});
			if (res.ok) {
				suggestions = [];
				suggesting = false;
				await invalidateAll();
			} else {
				const body = await res.json().catch(() => null);
				error = body?.error ?? `Failed to add agents (${res.status})`;
			}
		} catch {
			error = 'Network error — could not add agents.';
		} finally {
			loading = false;
		}
	}

	async function designAgentWithAI(mt: { type: string; suggestedName: string; suggestedDescription: string }) {
		creating = true;
		error = null;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'design-agent',
					type: mt.type,
					name: mt.suggestedName,
					description: mt.suggestedDescription,
					language: projectProfile?.language ?? '',
					framework: projectProfile?.framework ?? ''
				})
			});
			const body = await res.json();
			if (!res.ok) {
				error = body?.error ?? 'Failed to spawn agent designer';
				return;
			}
			// Navigate to the chat session to watch Claude Code work
			goto(`/chat?session=${body.sessionId}`);
		} catch {
			error = 'Network error — could not spawn agent designer.';
		} finally {
			creating = false;
		}
	}

	async function quickCreateAgent(mt: { type: string; suggestedName: string; suggestedDescription: string }) {
		creating = true;
		error = null;
		createSuccess = null;
		try {
			// Generate the markdown server-side
			const genRes = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'generate-agent',
					type: mt.type,
					name: mt.suggestedName,
					description: mt.suggestedDescription,
					language: projectProfile?.language ?? '',
					framework: projectProfile?.framework ?? ''
				})
			});
			const genBody = await genRes.json();
			if (!genRes.ok) {
				error = genBody?.error ?? 'Failed to generate agent';
				return;
			}

			// Create the file
			const createRes = await fetch(`/api/projects/${getProjectId()}/agents`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'create-agent',
					filename: genBody.filename,
					markdown: genBody.markdown
				})
			});
			const createBody = await createRes.json();
			if (!createRes.ok) {
				error = createBody?.error ?? 'Failed to create agent';
				return;
			}
			createSuccess = genBody.filename;
			missingTypes = missingTypes.filter(m => m.suggestedName !== mt.suggestedName);
			await invalidateAll();
		} catch {
			error = 'Network error — could not create agent.';
		} finally {
			creating = false;
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
				onclick={() => { if (suggesting) { suggesting = false; suggestions = []; missingTypes = []; projectProfile = null; } else { suggestAgents(); showTemplates = false; showAddPanel = false; } }}
				disabled={suggestLoading}
				class="px-4 py-2 text-sm border border-accent-green/50 text-accent-green rounded-lg hover:bg-accent-green/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{suggestLoading ? 'Analyzing...' : suggesting ? 'Hide Suggestions' : 'Suggest Agents'}
			</button>
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

	<!-- Suggestions Panel -->
	{#if suggesting}
		<section aria-label="Agent suggestions" class="bg-bg-secondary border border-accent-green/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-sm font-bold text-text-primary">
						{suggestLoading ? 'Analyzing Project...' : 'Recommended Agents'}
					</h2>
					{#if !suggestLoading}
						<p class="text-xs text-text-secondary mt-0.5">{suggestionReason}</p>
					{/if}
				</div>
				{#if suggestions.length > 0 && !suggestLoading}
					<button
						onclick={applySuggestions}
						disabled={loading}
						class="px-3 py-1.5 text-xs bg-accent-green text-white rounded hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{loading ? 'Adding...' : `Add All ${suggestions.length} Agents`}
					</button>
				{/if}
			</div>

			{#if suggestLoading}
				<div class="flex items-center gap-2 py-4 justify-center text-text-secondary text-sm">
					<svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
					</svg>
					Scanning project files, dependencies, and structure...
				</div>
			{/if}

			<!-- Project Profile -->
			{#if projectProfile && !suggestLoading}
				<div class="flex flex-wrap gap-2 text-[10px]">
					{#if projectProfile.language}
						<span class="px-2 py-0.5 rounded bg-accent-blue/15 text-accent-blue">{projectProfile.language}</span>
					{/if}
					{#if projectProfile.framework}
						<span class="px-2 py-0.5 rounded bg-accent-purple/15 text-accent-purple">{projectProfile.framework}</span>
					{/if}
					<span class="px-2 py-0.5 rounded {projectProfile.hasTests ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-yellow/15 text-accent-yellow'}">
						{projectProfile.hasTests ? 'Tests configured' : 'No tests detected'}
					</span>
					<span class="px-2 py-0.5 rounded {projectProfile.hasCi ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-yellow/15 text-accent-yellow'}">
						{projectProfile.hasCi ? 'CI/CD found' : 'No CI/CD'}
					</span>
					<span class="px-2 py-0.5 rounded {projectProfile.hasDocs ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-yellow/15 text-accent-yellow'}">
						{projectProfile.hasDocs ? 'Docs exist' : 'No docs'}
					</span>
					{#if projectProfile.dependencyCount}
						<span class="px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{projectProfile.dependencyCount} deps</span>
					{/if}
					{#if projectProfile.serviceCount}
						<span class="px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{projectProfile.serviceCount} service{projectProfile.serviceCount !== 1 ? 's' : ''}</span>
					{/if}
				</div>
			{/if}

			<!-- Suggestion Cards -->
			{#if suggestions.length > 0 && !suggestLoading}
				<div class="space-y-2">
					{#each suggestions as suggestion, i}
						<div class="flex items-start gap-3 p-2.5 bg-bg-primary rounded border border-accent-green/20">
							<span class="text-sm text-text-secondary font-mono w-5 text-center mt-0.5">{i + 1}</span>
							<span class="text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5 {typeColors[suggestion.type] ?? typeColors.general}">{suggestion.type}</span>
							<div class="min-w-0 flex-1">
								<span class="text-sm font-medium text-text-primary">{suggestion.name}</span>
								<p class="text-xs text-accent-green mt-0.5">{suggestion.reason}</p>
								{#if suggestion.description}
									<p class="text-xs text-text-secondary mt-0.5 truncate">{suggestion.description}</p>
								{/if}
								<p class="text-[10px] text-text-secondary/50 font-mono truncate mt-0.5">{suggestion.filename}</p>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Missing Types — agents that should exist but don't -->
			{#if missingTypes.length > 0 && !suggestLoading}
				<div class="border-t border-border pt-3 mt-1">
					<h3 class="text-xs font-bold text-accent-yellow mb-2">Agents to Create</h3>
					<p class="text-[10px] text-text-secondary mb-2">
						These agent types would help this project but don't exist in the pool yet. Click "Design" to preview and create them.
					</p>
					<div class="space-y-2">
						{#each missingTypes as mt}
							<div class="flex items-start gap-3 p-2.5 bg-bg-primary rounded border border-accent-yellow/20">
								<span class="text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5 bg-accent-yellow/20 text-accent-yellow">{mt.type}</span>
								<div class="min-w-0 flex-1">
									<span class="text-sm font-medium text-text-primary">{mt.suggestedName}</span>
									<p class="text-xs text-accent-yellow mt-0.5">{mt.reason}</p>
									<p class="text-xs text-text-secondary mt-0.5">{mt.suggestedDescription}</p>
								</div>
								<div class="flex gap-1 shrink-0 mt-0.5">
									<button
										onclick={() => designAgentWithAI(mt)}
										class="px-2.5 py-1 text-[10px] font-medium bg-accent-cyan/20 text-accent-cyan rounded hover:bg-accent-cyan/30 transition-colors"
										title="Open Claude Code chat with agent-creator skill"
									>
										Design with AI
									</button>
									<button
										onclick={() => quickCreateAgent(mt)}
										disabled={creating}
										class="px-2.5 py-1 text-[10px] font-medium bg-accent-yellow/20 text-accent-yellow rounded hover:bg-accent-yellow/30 transition-colors disabled:opacity-50"
										title="Create from template instantly"
									>
										{creating ? '...' : 'Quick Create'}
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Create Success -->
			{#if createSuccess}
				<div class="flex items-center gap-2 px-3 py-2 bg-accent-green/10 border border-accent-green/30 rounded text-xs text-accent-green">
					Agent created and associated: <span class="font-mono">{createSuccess}</span>
					<button onclick={() => createSuccess = null} class="ml-auto text-accent-green/60 hover:text-accent-green">dismiss</button>
				</div>
			{/if}

		</section>
	{/if}

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

	<!-- Agent Guide — real agents grouped by category -->
	{#if showTemplates}
		<section aria-label="Agent guide" class="bg-bg-secondary border border-accent-purple/30 rounded-lg p-4 space-y-3">
			<div class="flex items-center justify-between">
				<div>
					<h2 class="text-sm font-bold text-text-primary">Agent Guide</h2>
					<p class="text-xs text-text-secondary mt-0.5">
						{data.availableAgents.length} agents available, grouped by role. Click a category to see agents, then add them directly.
					</p>
				</div>
			</div>
			{#if guideCategories().length === 0}
				<p class="text-xs text-text-secondary text-center py-3">All agents are already associated with this project.</p>
			{:else}
				<div class="space-y-2">
					{#each guideCategories() as category}
						<button
							onclick={() => expandedTemplate = expandedTemplate === category.type ? null : category.type}
							class="w-full text-left"
						>
							<div class="p-3 rounded-lg border border-border bg-bg-primary hover:border-accent-purple/40 transition-colors">
								<div class="flex items-center gap-3">
									<span class="text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 {typeColors[category.type] ?? typeColors.general}">{category.type}</span>
									<span class="text-sm font-medium text-text-primary">{category.info.label}</span>
									<span class="text-xs text-text-secondary flex-1 truncate">{category.info.description}</span>
									<span class="text-[10px] text-text-secondary font-mono">{category.agents.length}</span>
									<span class="text-text-secondary text-xs">{expandedTemplate === category.type ? '▲' : '▼'}</span>
								</div>
								{#if category.info.when}
									<p class="text-[10px] text-text-secondary mt-1 ml-[4.5rem]">When: {category.info.when}</p>
								{/if}
							</div>
						</button>
						{#if expandedTemplate === category.type}
							<div class="ml-4 space-y-1">
								{#each category.agents as agent}
									<div class="flex items-center gap-3 p-2 bg-bg-primary rounded border border-border/50">
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<span class="text-sm font-medium text-text-primary">{agent.name}</span>
											</div>
											{#if agent.description}
												<p class="text-xs text-text-secondary truncate mt-0.5">{agent.description}</p>
											{/if}
											<p class="text-[10px] text-text-secondary/50 font-mono truncate">{agent.filename}</p>
										</div>
										<button
											onclick={(e) => { e.stopPropagation(); const s = new Set(selectedAgents); s.add(agent.filename); selectedAgents = s; showAddPanel = true; showTemplates = false; }}
											class="px-2 py-1 text-[10px] font-medium border border-accent-blue/40 text-accent-blue rounded hover:bg-accent-blue/10 transition-colors shrink-0"
										>
											+ Add
										</button>
									</div>
								{/each}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
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
						{data.availableAgents.length} agents in global pool — search or filter by type
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
				<!-- Search + Type Filter -->
				<div class="flex flex-col sm:flex-row gap-2">
					<div class="relative flex-1">
						<svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
						</svg>
						<input
							type="text"
							bind:value={agentSearch}
							placeholder="Search agents..."
							class="w-full pl-8 pr-3 py-1.5 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue"
						/>
					</div>
					<div class="flex gap-1 flex-wrap">
						<button
							onclick={() => agentTypeFilter = 'all'}
							class="px-2 py-1 text-[10px] font-medium rounded transition-colors {agentTypeFilter === 'all' ? 'bg-accent-blue/20 text-accent-blue' : 'bg-bg-primary text-text-secondary hover:text-text-primary'}"
						>All</button>
						{#each availableTypes() as type}
							<button
								onclick={() => agentTypeFilter = type}
								class="px-2 py-1 text-[10px] font-medium rounded transition-colors {agentTypeFilter === type ? typeColors[type] ?? 'bg-bg-primary text-text-primary' : 'bg-bg-primary text-text-secondary hover:text-text-primary'}"
							>{type}</button>
						{/each}
					</div>
				</div>

				<!-- Results count -->
				<div class="text-[10px] text-text-secondary">
					{filteredAvailableAgents().length} of {data.availableAgents.length} agents
					{#if selectedAgents.size > 0}
						<span class="text-accent-blue ml-1">· {selectedAgents.size} selected</span>
					{/if}
				</div>

				<!-- Agent List -->
				<div role="listbox" aria-label="Available agents" aria-multiselectable="true" class="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-80 overflow-y-auto">
					{#each filteredAvailableAgents() as agent (agent.filename)}
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

				{#if filteredAvailableAgents().length === 0}
					<p class="text-text-secondary text-xs text-center py-3">
						No agents match "{agentSearch || agentTypeFilter}" — try a different search or filter
					</p>
				{/if}
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
					<p class="text-text-secondary text-sm mb-3">No agents associated yet. Add agents from the global pool or let Claw suggest the best combination.</p>
					<div class="flex justify-center gap-2">
						<button
							onclick={() => { suggestAgents(); showTemplates = false; showAddPanel = false; }}
							disabled={suggestLoading}
							class="px-4 py-2 text-xs border border-accent-green/50 text-accent-green rounded-lg hover:bg-accent-green/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{suggestLoading ? 'Analyzing...' : 'Suggest Agents'}
						</button>
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
