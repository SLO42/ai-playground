<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { apiFetch } from '$lib/api-client.js';
	import type { AgentDefinition } from '$lib/types/agents.js';

	interface ActiveAgent {
		taskId: string;
		pid: number;
		startedAt: string;
		label: string;
		color: string;
		sessionId: string;
	}

	interface SessionSlot {
		slotId: string;
		sessionId: string;
		model: string;
		area: string;
		createdAt: string;
		lastUsedAt: string;
		taskCount: number;
		totalTokens: number;
		totalCost: number;
		status: 'idle' | 'active';
	}

	interface McpPoolAgent {
		id: string;
		type: string;
		model: string;
		role: string;
		status: string;
	}

	interface McpPool {
		poolId: string;
		size: number;
		maxSize: number;
		utilization: number;
		agents: McpPoolAgent[];
		byModel: Record<string, number>;
		byStatus: Record<string, number>;
	}

	interface PoolStats {
		slots: SessionSlot[];
		maxSlots: number;
		coldStarts: number;
		warmResumes: number;
		mcpPool?: McpPool;
		hasConfig?: boolean;
	}

	interface AnalyticsModelStat {
		model: string;
		tier: string;
		count: number;
		completedCount: number;
		failedCount: number;
		totalCost: number;
		totalDuration: number;
		avgCost: number;
		avgDuration: number;
		totalInput: number;
		totalOutput: number;
	}

	interface AnalyticsEvent {
		id: string;
		taskId: string;
		taskTitle: string;
		type: string;
		timestamp: string;
		route?: string;
		escalated?: boolean;
		escalationReason?: string;
		model?: string;
		modelTier?: string;
		provider?: string;
		durationMs?: number;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
		exitCode?: number;
		fromProvider?: string;
		toProvider?: string;
		handoffReason?: string;
	}

	interface AgentAnalytics {
		summary: {
			totalTasks: number;
			completedTasks: number;
			failedTasks: number;
			totalCostUsd: number;
			totalDurationMs: number;
			avgCostPerTask: number;
			avgDurationMs: number;
		};
		byModel: Record<string, AnalyticsModelStat>;
		byRoute: {
			openclaw: { count: number; escalated: number; completedLocally: number; totalCost: number };
			claudeCode: { count: number; sonnet: number; opus: number; totalCost: number };
		};
		escalationRate: number;
		modelDistribution: { model: string; percentage: number; count: number }[];
		timeline: { hour: string; events: number; cost: number; tasks: number }[];
		recentEvents: AnalyticsEvent[];
	}

	interface PageData {
		agents: AgentDefinition[];
		total: number;
		page: number;
		perPage: number;
		totalPages: number;
		swarmStatus: {
			active: boolean;
			agentCount: number;
			coordinationActive: boolean;
			processes: { agentic_flow: number; mcp_server: number; estimated_agents: number } | null;
		};
		v3Progress: {
			activeAgents: number;
			maxAgents: number;
			topology: string;
		};
		swarmConfig: Record<string, unknown> | null;
		analytics: AgentAnalytics;
		poolStats: PoolStats;
		activeAgents: ActiveAgent[];
	}

	let { data }: { data: PageData } = $props();

	let searchQuery = $state('');
	let selectedCategory = $state('all');
	let loading = $state(false);
	let error = $state('');

	// Live-polling state
	let liveActive = $state<ActiveAgent[]>(data.activeAgents);
	let livePool = $state<PoolStats>(data.poolStats);
	let analytics = $state<AgentAnalytics>(data.analytics);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function pollActivity() {
		try {
			const [activeRes, poolRes, analyticsRes] = await Promise.all([
				apiFetch('/api/agents/active', { signal: AbortSignal.timeout(5000) }),
				apiFetch('/api/agents/pool', { signal: AbortSignal.timeout(5000) }),
				apiFetch('/api/agents/analytics', { signal: AbortSignal.timeout(5000) })
			]);
			if (activeRes.ok) { const body = await activeRes.json(); liveActive = body.agents; }
			if (poolRes.ok) livePool = await poolRes.json();
			if (analyticsRes.ok) analytics = await analyticsRes.json();
		} catch { /* keep last */ }
	}

	onMount(() => {
		pollTimer = setInterval(pollActivity, 10_000);
	});
	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	// Session Pool actions
	let poolAction = $state('');

	async function populatePool() {
		poolAction = 'populating';
		try {
			const res = await apiFetch('/api/agents/pool', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'populate' })
			});
			const body = await res.json();
			if (body.success) {
				if (body.pool) livePool = body.pool;
				else await pollActivity();
			} else {
				error = body.error ?? 'Populate failed';
			}
		} catch (e: unknown) {
			const err = e as { message?: string };
			error = err.message ?? 'Populate failed';
		} finally {
			poolAction = '';
		}
	}

	async function resetPoolAction() {
		if (!confirm('Reset the session pool? All sessions will be lost.')) return;
		poolAction = 'resetting';
		try {
			const res = await apiFetch('/api/agents/pool', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reset' })
			});
			const body = await res.json();
			if (body.success) {
				if (body.pool) livePool = body.pool;
				else await pollActivity();
			} else {
				error = body.error ?? 'Reset failed';
			}
		} catch (e: unknown) {
			const err = e as { message?: string };
			error = err.message ?? 'Reset failed';
		} finally {
			poolAction = '';
		}
	}

	async function removeSlot(slotId: string) {
		try {
			const res = await apiFetch('/api/agents/pool', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'remove', slotId })
			});
			const body = await res.json();
			if (body.success && body.pool) livePool = body.pool;
			else if (!body.success) error = body.error ?? 'Remove failed';
		} catch { /* ignore */ }
	}

	// Derive model from the model string in slot
	function slotModel(model: string): string {
		if (model.includes('opus')) return 'opus';
		if (model.includes('sonnet')) return 'sonnet';
		if (model.includes('haiku')) return 'haiku';
		if (model.includes('ollama') || model.includes('gpt-oss')) return 'claw';
		return 'opus';
	}

	const poolByModel = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const s of livePool.slots) {
			const m = slotModel(s.model);
			counts[m] = (counts[m] ?? 0) + 1;
		}
		return counts;
	});

	const modelColors: Record<string, string> = {
		opus: 'bg-accent-purple',
		sonnet: 'bg-accent-cyan',
		haiku: 'bg-accent-yellow',
		claw: 'bg-accent-green'
	};

	const modelTextColors: Record<string, string> = {
		opus: 'text-accent-purple',
		sonnet: 'text-accent-cyan',
		haiku: 'text-accent-yellow',
		claw: 'text-accent-green'
	};

	// Agent definitions
	function apiToDefinition(agent: { name: string; description: string; type: string; category: string; file: string }): AgentDefinition {
		const cat = agent.category.split('/')[0] || 'uncategorized';
		return {
			name: agent.name,
			category: cat,
			description: agent.description || 'No description available',
			filename: agent.file,
			type: agent.type || undefined
		};
	}

	async function refreshAgents() {
		loading = true;
		error = '';
		try {
			const params = new URLSearchParams();
			params.set('page', String(data.page));
			params.set('perPage', String(data.perPage));
			if (selectedCategory !== 'all') params.set('category', selectedCategory);
			if (searchQuery.trim()) params.set('search', searchQuery.trim());
			const res = await apiFetch(`/api/agents?${params.toString()}`);
			if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
			const result = await res.json();
			data.agents = (result.agents ?? []).map(apiToDefinition);
			data.total = result.total ?? data.agents.length;
			data.page = result.page ?? 1;
			data.totalPages = result.totalPages ?? 1;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load agents';
		} finally {
			loading = false;
		}
	}

	async function deleteAgent(filename: string) {
		if (!confirm(`Delete agent "${filename}"?`)) return;
		try {
			const res = await fetch(`/api/agents?file=${encodeURIComponent(filename)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Delete failed');
			await refreshAgents();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete agent';
		}
	}

	const categories = $derived.by(() => {
		const cats = new Set(data.agents.map((a) => a.category));
		return ['all', ...Array.from(cats).sort()];
	});

	const filteredAgents = $derived.by(() => {
		let result = data.agents;
		if (selectedCategory !== 'all') {
			result = result.filter((a) => a.category === selectedCategory);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(a) =>
					a.name.toLowerCase().includes(q) ||
					a.description.toLowerCase().includes(q) ||
					a.category.toLowerCase().includes(q)
			);
		}
		return result;
	});

	const groupedAgents = $derived.by(() => {
		const groups = new Map<string, AgentDefinition[]>();
		for (const agent of filteredAgents) {
			const list = groups.get(agent.category) ?? [];
			list.push(agent);
			groups.set(agent.category, list);
		}
		return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
	});

	const capacityPercent = $derived(
		data.v3Progress.maxAgents > 0
			? Math.round((data.v3Progress.activeAgents / data.v3Progress.maxAgents) * 100)
			: 0
	);

	const capacityBarColor = $derived(
		capacityPercent >= 90 ? 'bg-accent-red' : capacityPercent >= 70 ? 'bg-accent-yellow' : 'bg-accent-blue'
	);

	const warmRate = $derived(
		livePool.warmResumes + livePool.coldStarts > 0
			? (livePool.warmResumes / (livePool.warmResumes + livePool.coldStarts)) * 100
			: 0
	);

	function getCategoryCount(cat: string): number {
		if (cat === 'all') return data.total;
		return data.agents.filter((a) => a.category === cat).length;
	}

	function formatCategoryLabel(cat: string): string {
		return cat.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
	}

	function goToPage(p: number) {
		data.page = p;
		refreshAgents();
	}

	const pageNumbers = $derived.by(() => {
		const pages: number[] = [];
		const total = data.totalPages;
		const current = data.page;
		const delta = 2;
		for (let i = 1; i <= total; i++) {
			if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) {
				pages.push(i);
			}
		}
		return pages;
	});

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

	const tierColors: Record<string, string> = {
		local: 'text-accent-green',
		sonnet: 'text-accent-cyan',
		opus: 'text-accent-purple'
	};

	const eventTypeColors: Record<string, string> = {
		classified: 'text-text-secondary',
		escalation_check: 'text-accent-yellow',
		model_selected: 'text-accent-cyan',
		spawned: 'text-accent-green',
		handoff: 'text-accent-yellow',
		completed: 'text-accent-green',
		failed: 'text-accent-red'
	};

	const eventTypeIcons: Record<string, string> = {
		classified: '◇',
		escalation_check: '⬡',
		model_selected: '◈',
		spawned: '▶',
		handoff: '⇄',
		completed: '✓',
		failed: '✕'
	};

	const eventTypeLabels: Record<string, string> = {
		classified: 'Classified',
		escalation_check: 'Escalation Check',
		model_selected: 'Model Selected',
		spawned: 'Agent Spawned',
		handoff: 'Handoff',
		completed: 'Completed',
		failed: 'Failed'
	};

	// Group recent events by task for routing flow view
	interface TaskGroup {
		taskId: string;
		taskTitle: string;
		events: AnalyticsEvent[];
		status: 'running' | 'completed' | 'failed' | 'in_progress';
		model?: string;
		modelTier?: string;
		provider?: string;
		totalCost: number;
		totalDuration: number;
		startTime: string;
		endTime: string;
	}

	let expandedTasks = $state<Record<string, boolean>>({});

	function toggleTask(taskId: string) {
		expandedTasks = { ...expandedTasks, [taskId]: !expandedTasks[taskId] };
	}

	const taskGroups = $derived.by((): TaskGroup[] => {
		const groups = new Map<string, TaskGroup>();
		for (const event of analytics.recentEvents) {
			let group = groups.get(event.taskId);
			if (!group) {
				group = {
					taskId: event.taskId,
					taskTitle: event.taskTitle,
					events: [],
					status: 'in_progress',
					totalCost: 0,
					totalDuration: 0,
					startTime: event.timestamp,
					endTime: event.timestamp
				};
				groups.set(event.taskId, group);
			}
			group.events.push(event);
			if (event.timestamp < group.startTime) group.startTime = event.timestamp;
			if (event.timestamp > group.endTime) group.endTime = event.timestamp;
			if (event.model) group.model = event.model;
			if (event.modelTier) group.modelTier = event.modelTier;
			if (event.provider) group.provider = event.provider;
			if (event.costUsd) group.totalCost += event.costUsd;
			if (event.durationMs) group.totalDuration += event.durationMs;
			if (event.type === 'completed') group.status = 'completed';
			if (event.type === 'failed') group.status = 'failed';
		}
		// Sort events within each group chronologically
		for (const group of groups.values()) {
			group.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
			// Check if running (has spawned but no completion)
			const hasSpawn = group.events.some(e => e.type === 'spawned');
			if (hasSpawn && group.status === 'in_progress') {
				const isLive = liveActive.some(a => a.taskId === group.taskId);
				group.status = isLive ? 'running' : 'in_progress';
			}
		}
		return Array.from(groups.values()).sort((a, b) => b.startTime.localeCompare(a.startTime));
	});

	const taskStatusColors: Record<string, string> = {
		running: 'bg-accent-green/15 text-accent-green border-accent-green/30',
		completed: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
		failed: 'bg-accent-red/15 text-accent-red border-accent-red/30',
		in_progress: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30'
	};

	const taskStatusLabels: Record<string, string> = {
		running: 'Running',
		completed: 'Done',
		failed: 'Failed',
		in_progress: 'In Progress'
	};

	const slotStatusColors: Record<string, string> = {
		idle: 'bg-accent-green',
		active: 'bg-accent-cyan animate-pulse'
	};
</script>

<svelte:head>
	<title>Agent Management | OpenClaw Dashboard</title>
	<meta name="description" content="Manage AI agents, monitor swarm activity, session pools, and routing analytics. View agent definitions, running agents, and model performance." />
	<meta property="og:title" content="Agent Management | OpenClaw Dashboard" />
	<meta property="og:description" content="Manage AI agents, monitor swarm activity, session pools, and routing analytics." />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Agent Management | OpenClaw Dashboard" />
	<meta name="twitter:description" content="Manage AI agents, monitor swarm activity, session pools, and routing analytics." />
</svelte:head>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="type-page-title text-text-primary">Agent Management</h1>
		<div class="flex items-center gap-2">
			<a
				href="/chat?session=claw-monitor"
				class="px-3 py-1.5 text-xs rounded-md border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10 transition-colors"
			>
				Claw Monitor
			</a>
			<button
				onclick={refreshAgents}
				disabled={loading}
				class="px-3 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/30 transition-colors disabled:opacity-50"
			>
				{loading ? 'Refreshing...' : 'Refresh'}
			</button>
			<a
				href="/agents/create"
				class="px-3 py-1.5 text-xs rounded-md bg-accent-blue text-white hover:bg-accent-blue/80 transition-colors"
			>
				+ New Agent
			</a>
		</div>
	</div>

	{#if error}
		<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3 flex items-center justify-between">
			<div class="flex items-center gap-2 text-sm text-accent-red">
				<svg class="w-4 h-4 shrink-0" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
				{error}
			</div>
			<div class="flex items-center gap-3">
				<button onclick={refreshAgents} class="text-xs text-accent-red hover:text-accent-red/80 underline underline-offset-2">Retry</button>
				<button onclick={() => (error = '')} class="text-text-secondary hover:text-text-primary text-sm leading-none">&times;</button>
			</div>
		</div>
	{/if}

	<!-- Overview Metrics -->
	<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
		<MetricCard label="Definitions" value={data.total} subtitle="agent templates" accent="blue" />
		<MetricCard label="Running Now" value={liveActive.length} subtitle="active agents" accent="green" />
		<MetricCard label="Tasks Done" value={analytics.summary.completedTasks} subtitle="{analytics.summary.failedTasks} failed" accent="cyan" />
		<MetricCard label="Total Cost" value="${analytics.summary.totalCostUsd.toFixed(2)}" subtitle="${analytics.summary.avgCostPerTask.toFixed(2)} avg" accent={analytics.summary.totalCostUsd > 5 ? 'red' : 'yellow'} />
		<MetricCard label="Session Pool" value="{livePool.slots.length}" subtitle="{Object.keys(poolByModel).length} models" accent="purple" />
		<MetricCard label="Warm Rate" value="{warmRate.toFixed(0)}%" subtitle="{livePool.warmResumes}W / {livePool.coldStarts}C" accent={warmRate > 70 ? 'green' : warmRate > 40 ? 'yellow' : 'red'} />
	</div>

	<!-- Active Agents (live) -->
	{#if liveActive.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-3">Running Agents</h2>
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each liveActive as agent}
					<a
						href="/chat?session={agent.sessionId}"
						class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-cyan/40 transition-colors block"
					>
						<div class="flex items-center gap-2 mb-2">
							<span class="w-2.5 h-2.5 rounded-full bg-accent-green animate-pulse" aria-hidden="true"></span>
							<span class="sr-only">Running:</span>
							<span class="text-sm font-medium text-text-primary truncate" style="color: {agent.color}">{agent.label}</span>
							<span class="ml-auto text-xs font-mono text-text-secondary">PID {agent.pid}</span>
						</div>
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-secondary">Running for <span class="font-mono text-text-primary">{runningFor(agent.startedAt)}</span></span>
							<span class="text-accent-cyan text-[10px]">View chat &rarr;</span>
						</div>
						<div class="text-[10px] font-mono text-text-secondary mt-1 truncate">{agent.taskId}</div>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Session Pool -->
	<section>
		<div class="flex items-center justify-between mb-3">
			<div>
				<h2 class="type-section-title text-text-primary">Session Pool</h2>
				<p class="text-xs text-text-secondary mt-0.5">Persistent sessions — warm resumes save ~44K tokens ($0.05) per task</p>
			</div>
			<div class="flex items-center gap-2">
				{#if livePool.slots.length > 0}
					<button
						onclick={resetPoolAction}
						disabled={!!poolAction}
						class="px-3 py-1.5 text-xs rounded-md border border-accent-red/30 text-accent-red hover:bg-accent-red/10 transition-colors disabled:opacity-50"
					>
						{poolAction === 'resetting' ? 'Resetting...' : 'Reset Pool'}
					</button>
				{/if}
				<button
					onclick={populatePool}
					disabled={!!poolAction}
					class="px-3 py-1.5 text-xs rounded-md bg-accent-green/20 text-accent-green border border-accent-green/30 hover:bg-accent-green/30 transition-colors disabled:opacity-50"
				>
					{poolAction === 'populating' ? 'Populating...' : 'Spawn Pool'}
				</button>
			</div>
		</div>

		{#if livePool.slots.length > 0}
			<!-- Model distribution bar -->
			<div class="mb-4 bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-2">
					<span class="text-xs text-text-secondary">{livePool.slots.length} sessions across {Object.keys(poolByModel).length} models</span>
					<span class="text-xs text-text-secondary">
						{livePool.warmResumes}W / {livePool.coldStarts}C
						<span class="font-mono ml-1">({livePool.warmResumes + livePool.coldStarts > 0 ? Math.round(livePool.warmResumes / (livePool.warmResumes + livePool.coldStarts) * 100) : 0}% warm)</span>
					</span>
				</div>
				<div class="flex h-3 rounded-full overflow-hidden gap-0.5">
					{#each Object.entries(poolByModel) as [model, count]}
						<div
							class="rounded-full {modelColors[model] ?? 'bg-accent-blue'}"
							style="flex: {count}"
							title="{model}: {count} sessions"
						></div>
					{/each}
				</div>
				<div class="flex gap-4 mt-2">
					{#each Object.entries(poolByModel) as [model, count]}
						<span class="text-[11px] {modelTextColors[model] ?? 'text-text-secondary'}">
							{model} ({count})
						</span>
					{/each}
				</div>
			</div>

			<!-- Session cards -->
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
				{#each livePool.slots as slot (slot.slotId)}
					{@const model = slotModel(slot.model)}
					<div class="bg-bg-secondary border border-border rounded-lg p-3 hover:border-{model === 'opus' ? 'accent-purple' : model === 'sonnet' ? 'accent-cyan' : model === 'haiku' ? 'accent-yellow' : 'accent-green'}/40 transition-colors">
						<div class="flex items-center gap-2 mb-2">
							<span class="w-2 h-2 rounded-full {slotStatusColors[slot.status]}"></span>
							<span class="text-xs font-mono text-text-primary truncate">{slot.slotId}</span>
							<span class="ml-auto text-[10px] px-1.5 py-0.5 rounded-full {slot.status === 'active' ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-bg-tertiary text-text-secondary'}">{slot.status}</span>
						</div>
						<div class="space-y-1 text-[11px]">
							<div class="flex justify-between">
								<span class="text-text-secondary">Model</span>
								<span class="font-mono {modelTextColors[model] ?? 'text-text-primary'}">{model}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Area</span>
								<span class="text-text-primary">{slot.area}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Tasks</span>
								<span class="font-mono text-text-primary">{slot.taskCount}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Cost</span>
								<span class="font-mono {slot.totalCost > 0 ? 'text-accent-yellow' : 'text-accent-green'}">${slot.totalCost.toFixed(2)}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Last Used</span>
								<span class="font-mono text-text-secondary">{timeAgo(slot.lastUsedAt)}</span>
							</div>
						</div>
						<div class="mt-2 pt-2 border-t border-border flex items-center justify-between">
							<a
								href="/chat?session={slot.sessionId || slot.slotId}"
								class="text-[10px] text-accent-cyan hover:underline"
							>
								Open session
							</a>
							<button
								onclick={() => removeSlot(slot.slotId)}
								class="text-[10px] text-text-secondary hover:text-accent-red transition-colors"
							>
								Remove
							</button>
						</div>
					</div>
				{/each}
				<!-- Empty slots -->
				{#each Array(Math.max(0, livePool.maxSlots - livePool.slots.length)) as _}
					<div class="bg-bg-secondary border border-border/50 border-dashed rounded-lg p-3 flex items-center justify-center min-h-[120px]">
						<span class="text-xs text-text-secondary/50">Empty slot</span>
					</div>
				{/each}
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border/50 border-dashed rounded-lg p-8 text-center">
				<p class="text-sm text-text-secondary mb-2">No sessions in pool</p>
				<p class="text-xs text-text-secondary/70 mb-4">Click "Spawn Pool" to create sessions from config/agent-pool.yaml</p>
			</div>
		{/if}
	</section>

	<!-- Routing Flow: OpenClaw → Claude Code -->
	{#if analytics.summary.totalTasks > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-3">Agent Routing Flow</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center gap-3 flex-wrap text-sm">
					<div class="bg-bg-tertiary rounded-lg px-3 py-2 border border-border">
						<div class="text-text-secondary text-xs">Classified</div>
						<div class="font-mono text-text-primary">{analytics.byRoute.openclaw.count + analytics.byRoute.claudeCode.count}</div>
					</div>
					<span class="text-text-secondary">&rarr;</span>
					<div class="bg-bg-tertiary rounded-lg px-3 py-2 border border-accent-green/30">
						<div class="text-accent-green text-xs">OpenClaw (local)</div>
						<div class="font-mono text-text-primary">{analytics.byRoute.openclaw.count}
							<span class="text-xs text-text-secondary">({analytics.byRoute.openclaw.completedLocally} local, {analytics.byRoute.openclaw.escalated} escalated)</span>
						</div>
					</div>
					<span class="text-text-secondary">&rarr;</span>
					<div class="bg-bg-tertiary rounded-lg px-3 py-2 border border-accent-purple/30">
						<div class="text-accent-purple text-xs">Claude Code (API)</div>
						<div class="font-mono text-text-primary">{analytics.byRoute.claudeCode.count}
							<span class="text-xs text-text-secondary">({analytics.byRoute.claudeCode.sonnet} sonnet, {analytics.byRoute.claudeCode.opus} opus)</span>
						</div>
					</div>
				</div>
			</div>
		</section>

		<!-- Model Tier Performance -->
		{#if Object.keys(analytics.byModel).length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-3">Model Performance</h2>
				<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
					{#each Object.values(analytics.byModel).sort((a, b) => b.totalCost - a.totalCost) as m}
						<div class="bg-bg-secondary border border-border rounded-lg p-4">
							<div class="flex items-center justify-between mb-2">
								<span class="font-mono text-sm {tierColors[m.tier] ?? 'text-text-primary'}">{m.model}</span>
								<span class="text-xs px-2 py-0.5 rounded-full bg-bg-tertiary {tierColors[m.tier] ?? 'text-text-secondary'}">{m.tier}</span>
							</div>
							<div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
								<div class="flex justify-between">
									<span class="text-text-secondary">Tasks</span>
									<span class="font-mono text-text-primary">{m.count}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Success</span>
									<span class="font-mono {m.failedCount === 0 ? 'text-accent-green' : 'text-accent-yellow'}">{m.completedCount}/{m.count}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Total Cost</span>
									<span class="font-mono text-accent-yellow">${m.totalCost.toFixed(2)}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Cost</span>
									<span class="font-mono text-text-primary">${m.avgCost.toFixed(2)}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Duration</span>
									<span class="font-mono text-text-primary">{(m.avgDuration / 1000).toFixed(0)}s</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">I/O Ratio</span>
									<span class="font-mono text-text-primary">{m.totalOutput > 0 ? (m.totalInput / m.totalOutput).toFixed(0) : '\u2014'}:1</span>
								</div>
							</div>
							<div class="mt-2 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
								<div class="h-full rounded-full {m.tier === 'local' ? 'bg-accent-green' : m.tier === 'sonnet' ? 'bg-accent-cyan' : 'bg-accent-purple'}" style="width: {(m.totalCost / Math.max(...Object.values(analytics.byModel).map(x => x.totalCost), 0.01)) * 100}%"></div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- 24h Activity Timeline -->
		{#if analytics.timeline.length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-3">24h Activity</h2>
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-end gap-1 h-24">
						{#each analytics.timeline as bucket}
							{@const maxEvents = Math.max(...analytics.timeline.map(t => t.events), 1)}
							{@const height = (bucket.events / maxEvents) * 100}
							<div class="flex-1 flex flex-col items-center gap-0.5" title="{bucket.hour}: {bucket.tasks} tasks, ${bucket.cost.toFixed(2)}">
								<div class="w-full rounded-t bg-accent-cyan/70 transition-all" style="height: {height}%"></div>
								{#if analytics.timeline.length <= 12}
									<span class="text-[9px] text-text-secondary font-mono">{bucket.hour.slice(11, 16)}</span>
								{/if}
							</div>
						{/each}
					</div>
					<div class="flex justify-between mt-1 text-[10px] text-text-secondary">
						<span>{analytics.timeline[0]?.hour.slice(11, 16) ?? ''}</span>
						<span>{analytics.timeline[analytics.timeline.length - 1]?.hour.slice(11, 16) ?? ''}</span>
					</div>
				</div>
			</section>
		{/if}

		<!-- Recent Agent Events — grouped by task -->
		<section>
			<h2 class="type-section-title text-text-primary mb-3">Recent Agent Events</h2>
			<div class="space-y-2 max-h-[600px] overflow-y-auto pr-1">
				{#each taskGroups as group (group.taskId)}
					<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
						<!-- Task header (clickable) -->
						<button
							onclick={() => toggleTask(group.taskId)}
							class="w-full px-4 py-3 flex items-center gap-3 hover:bg-bg-tertiary/50 transition-colors text-left"
						>
							<!-- Expand chevron -->
							<svg
								class="w-3.5 h-3.5 text-text-secondary shrink-0 transition-transform {expandedTasks[group.taskId] ? 'rotate-90' : ''}"
								fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
							>
								<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
							</svg>

							<!-- Status badge -->
							<span class="shrink-0 text-[10px] px-2 py-0.5 rounded-full border font-medium {taskStatusColors[group.status]}">
								{taskStatusLabels[group.status]}
							</span>

							<!-- Task title -->
							<span class="text-sm text-text-primary truncate flex-1" title={group.taskTitle}>
								{group.taskTitle}
							</span>

							<!-- Flow summary (mini pipeline) -->
							<div class="hidden sm:flex items-center gap-0.5 shrink-0">
								{#each group.events as event, i}
									<span
										class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] border {event.type === 'failed' ? 'border-accent-red/40 bg-accent-red/10' : event.type === 'completed' ? 'border-accent-green/40 bg-accent-green/10' : 'border-border bg-bg-tertiary'}"
										title="{eventTypeLabels[event.type] ?? event.type}"
									>
										<span class="{eventTypeColors[event.type] ?? 'text-text-secondary'}">{eventTypeIcons[event.type] ?? '·'}</span>
									</span>
									{#if i < group.events.length - 1}
										<span class="text-border text-[8px]">→</span>
									{/if}
								{/each}
							</div>

							<!-- Meta -->
							<div class="flex items-center gap-3 shrink-0 text-[11px]">
								{#if group.model}
									<span class="font-mono {tierColors[group.modelTier ?? ''] ?? 'text-text-secondary'}">
										{group.modelTier ?? group.model}
									</span>
								{/if}
								{#if group.totalCost > 0}
									<span class="font-mono text-accent-yellow">${group.totalCost.toFixed(2)}</span>
								{/if}
								<span class="font-mono text-text-secondary">{timeAgo(group.startTime)}</span>
							</div>
						</button>

						<!-- Expanded: event flow timeline -->
						{#if expandedTasks[group.taskId]}
							<div class="border-t border-border px-4 py-3">
								<!-- Routing flow visualization -->
								<div class="flex items-center gap-1.5 mb-3 flex-wrap">
									{#each group.events as event, i}
										<div class="flex items-center gap-1.5">
											<div
												class="px-2 py-1 rounded text-[11px] font-mono border {event.type === 'completed' ? 'border-accent-green/40 bg-accent-green/10' : event.type === 'failed' ? 'border-accent-red/40 bg-accent-red/10' : 'border-border bg-bg-tertiary'}"
											>
												<span class="{eventTypeColors[event.type] ?? 'text-text-primary'}">{eventTypeLabels[event.type] ?? event.type}</span>
											</div>
											{#if i < group.events.length - 1}
												<svg class="w-4 h-4 text-text-secondary/50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
													<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
												</svg>
											{/if}
										</div>
									{/each}
								</div>

								<!-- Event detail rows -->
								<div class="space-y-1.5">
									{#each group.events as event}
										<div class="flex items-start gap-3 text-xs py-1.5 border-b border-border/20 last:border-0">
											<!-- Time -->
											<span class="text-text-secondary font-mono w-16 shrink-0 text-[11px]">{timeAgo(event.timestamp)}</span>

											<!-- Event icon + type -->
											<span class="w-20 shrink-0">
												<span class="{eventTypeColors[event.type] ?? 'text-text-primary'} font-mono">
													{eventTypeIcons[event.type] ?? '·'} {event.type}
												</span>
											</span>

											<!-- Event details -->
											<div class="flex-1 text-text-secondary text-[11px]">
												{#if event.type === 'classified'}
													Route: <span class="text-text-primary font-mono">{event.route ?? '—'}</span>
												{:else if event.type === 'escalation_check'}
													{#if event.escalated}
														<span class="text-accent-yellow">Escalated</span> — {event.escalationReason ?? 'complexity threshold'}
													{:else}
														<span class="text-accent-green">Kept local</span>
													{/if}
												{:else if event.type === 'model_selected'}
													<span class="font-mono {tierColors[event.modelTier ?? ''] ?? 'text-text-primary'}">{event.model}</span>
													<span class="text-text-secondary ml-1">({event.modelTier} tier)</span>
												{:else if event.type === 'spawned'}
													PID <span class="font-mono text-text-primary">{event.exitCode ?? '—'}</span>
													{#if event.provider}
														via <span class="text-text-primary">{event.provider}</span>
													{/if}
												{:else if event.type === 'handoff'}
													<span class="text-text-primary">{event.fromProvider}</span>
													<span class="text-text-secondary mx-1">&rarr;</span>
													<span class="text-text-primary">{event.toProvider}</span>
													{#if event.handoffReason}
														<span class="text-text-secondary ml-1">— {event.handoffReason}</span>
													{/if}
												{:else if event.type === 'completed' || event.type === 'failed'}
													{#if event.durationMs != null}
														<span class="font-mono text-text-primary">{(event.durationMs / 1000).toFixed(0)}s</span>
													{/if}
													{#if event.costUsd != null}
														<span class="font-mono text-accent-yellow ml-2">${event.costUsd.toFixed(2)}</span>
													{/if}
													{#if event.inputTokens}
														<span class="text-text-secondary ml-2">{(event.inputTokens / 1000).toFixed(0)}K in / {((event.outputTokens ?? 0) / 1000).toFixed(0)}K out</span>
													{/if}
													{#if event.exitCode != null && event.exitCode !== 0}
														<span class="text-accent-red ml-2">exit {event.exitCode}</span>
													{/if}
												{/if}
											</div>

											<!-- Chat link for spawn/complete -->
											<div class="w-10 shrink-0 text-right">
												{#if event.type === 'spawned' || event.type === 'completed' || event.type === 'failed'}
													<a href="/chat?session=task-{event.taskId}" class="text-accent-cyan hover:underline text-[10px]">view</a>
												{/if}
											</div>
										</div>
									{/each}
								</div>

								<!-- Task footer -->
								<div class="flex items-center justify-between mt-3 pt-2 border-t border-border/30 text-[11px]">
									<span class="text-text-secondary font-mono">{group.taskId}</span>
									<div class="flex items-center gap-4">
										<span class="text-text-secondary">{group.events.length} events</span>
										{#if group.totalDuration > 0}
											<span class="font-mono text-text-primary">{(group.totalDuration / 1000).toFixed(0)}s total</span>
										{/if}
										{#if group.totalCost > 0}
											<span class="font-mono text-accent-yellow">${group.totalCost.toFixed(2)} total</span>
										{/if}
										<a href="/tasks" class="text-accent-cyan hover:underline">Task details &rarr;</a>
									</div>
								</div>
							</div>
						{/if}
					</div>
				{/each}

				{#if taskGroups.length === 0}
					<div class="bg-bg-secondary border border-border/50 border-dashed rounded-lg p-8 text-center">
						<p class="text-sm text-text-secondary">No agent events recorded yet</p>
						<p class="text-xs text-text-secondary/70 mt-1">Events appear here as the heartbeat dispatches tasks to agents</p>
					</div>
				{/if}
			</div>
		</section>
	{/if}

	<!-- Swarm Status Bar -->
	<section>
		<h2 class="type-section-title text-text-primary mb-3">Swarm Status</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-3">
				<span
					class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
						{data.swarmStatus.active
						? 'bg-accent-green/15 text-accent-green border border-accent-green/30'
						: 'bg-bg-tertiary text-text-secondary border border-border'}"
				>
					<span class="w-1.5 h-1.5 rounded-full {data.swarmStatus.active ? 'bg-accent-green animate-pulse' : 'bg-text-secondary'}"></span>
					{data.swarmStatus.active ? 'Active' : 'Inactive'}
				</span>
				<span class="text-xs text-text-secondary">Topology: <span class="font-mono text-text-primary">{data.v3Progress.topology}</span></span>
			</div>
			<!-- Capacity gauge -->
			<div class="mb-2">
				<div class="flex items-center justify-between text-xs mb-1">
					<span class="text-text-secondary">Agent Capacity</span>
					<span class="font-mono text-text-primary">{data.v3Progress.activeAgents} / {data.v3Progress.maxAgents} slots</span>
				</div>
				<div class="w-full h-2.5 bg-bg-tertiary border border-border rounded-full overflow-hidden" role="progressbar" aria-valuenow={capacityPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Agent capacity: {capacityPercent}%">
					<div class="h-full rounded-full transition-all duration-500 {capacityBarColor}" style="width: {capacityPercent}%"></div>
				</div>
			</div>
			{#if data.swarmStatus.processes}
				<div class="grid grid-cols-3 gap-4 text-xs mt-3">
					<div class="flex items-center gap-2">
						<span class="text-text-secondary">Coordination:</span>
						<span class="font-mono {data.swarmStatus.coordinationActive ? 'text-accent-green' : 'text-text-secondary'}">{data.swarmStatus.coordinationActive ? 'Active' : 'Inactive'}</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-text-secondary">Agentic Flows:</span>
						<span class="font-mono text-text-primary">{data.swarmStatus.processes.agentic_flow}</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-text-secondary">MCP Servers:</span>
						<span class="font-mono text-text-primary">{data.swarmStatus.processes.mcp_server}</span>
					</div>
				</div>
			{/if}
		</div>
	</section>

	<!-- Agent Definitions -->
	<section>
		<div class="flex items-center justify-between mb-3">
			<h2 class="type-section-title text-text-primary">Agent Definitions</h2>
			<span class="text-xs text-text-secondary">{filteredAgents.length} of {data.total}</span>
		</div>

		<!-- Search + Category Filters -->
		<div class="space-y-3 mb-4">
			<div class="relative">
				<label for="agent-search" class="sr-only">Search agents</label>
				<input
					id="agent-search"
					type="text"
					bind:value={searchQuery}
					placeholder="Search agents by name, description, or category..."
					class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm
						text-text-primary placeholder:text-text-secondary
						focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25
						transition-colors"
				/>
				{#if searchQuery}
					<button
						aria-label="Clear search"
						class="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary text-xs"
						onclick={() => (searchQuery = '')}
					>
						Clear
					</button>
				{/if}
			</div>

			<div class="flex flex-wrap gap-2">
				{#each categories as cat}
					<button
						class="px-3 py-1.5 text-xs rounded-md border transition-colors
							{selectedCategory === cat
							? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40'
							: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
						onclick={() => (selectedCategory = cat)}
					>
						{cat === 'all' ? 'All' : formatCategoryLabel(cat)}
						({getCategoryCount(cat)})
					</button>
				{/each}
			</div>
		</div>

		<!-- Agent Grid grouped by category -->
		{#if loading}
			<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
				<svg class="w-8 h-8 animate-spin text-accent-blue mx-auto mb-3" aria-hidden="true" viewBox="0 0 24 24" fill="none">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				<p class="text-sm text-text-secondary">Fetching agents...</p>
				<p class="text-xs text-text-secondary/60 mt-1">Loading definitions from .claude/agents/</p>
			</div>
		{:else if filteredAgents.length === 0}
			<div class="bg-bg-secondary border border-border rounded-lg p-12 text-center">
				{#if searchQuery || selectedCategory !== 'all'}
					<p class="text-text-secondary text-sm mb-1">No agents match your filter.</p>
					<button
						onclick={() => { searchQuery = ''; selectedCategory = 'all'; }}
						class="text-xs text-accent-blue hover:text-accent-blue/80 underline underline-offset-2"
					>
						Clear filters
					</button>
				{:else}
					<p class="text-text-secondary text-sm mb-1">No agent definitions found.</p>
					<p class="text-text-secondary/70 text-xs mb-3">Add agent markdown files to <code class="font-mono">.claude/agents/</code></p>
					<a href="/agents/create" class="inline-block px-3 py-1.5 text-xs rounded-md bg-accent-blue text-white hover:bg-accent-blue/80 transition-colors">+ Create Agent</a>
				{/if}
			</div>
		{:else}
			{#each groupedAgents as [category, agents]}
				<div class="mb-4">
					<h3 class="type-section-title text-text-secondary mb-3">
						{formatCategoryLabel(category)}
						<span class="text-xs font-normal ml-1">({agents.length})</span>
					</h3>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
						{#each agents as agent (agent.filename)}
							<div class="bg-bg-secondary border border-border rounded-lg p-4 hover:border-accent-blue/30 transition-colors group">
								<div class="flex items-start justify-between gap-2 mb-2">
									<a href="/agents/{agent.filename}" class="type-card-title text-text-primary group-hover:text-accent-blue transition-colors">
										{agent.name}
									</a>
									<StatusBadge status="online" label="available" />
								</div>
								<p class="text-xs text-text-secondary leading-relaxed line-clamp-2 mb-2">
									{agent.description}
								</p>
								<div class="flex items-center justify-between mb-3">
									<p class="text-[10px] font-mono text-text-secondary truncate" title={agent.filename}>
										{agent.filename}
									</p>
									{#if agent.type}
										<span class="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full bg-accent-purple/15 text-accent-purple border border-accent-purple/25">
											{agent.type}
										</span>
									{/if}
								</div>
								<div class="flex items-center gap-2 pt-2 border-t border-border">
									<a
										href="/agents/{agent.filename}"
										class="px-2 py-1 text-[10px] rounded border border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/30 transition-colors"
									>
										View
									</a>
									<button
										onclick={() => deleteAgent(agent.filename)}
										class="px-2 py-1 text-[10px] rounded border border-border text-text-secondary hover:text-accent-red hover:border-accent-red/30 transition-colors"
									>
										Delete
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	</section>

	<!-- Pagination -->
	{#if data.totalPages > 1}
		<div class="flex items-center justify-between pt-4">
			<p class="text-xs text-text-secondary">
				Showing {(data.page - 1) * data.perPage + 1}&ndash;{Math.min(data.page * data.perPage, data.total)} of {data.total} agents
			</p>
			<div class="flex items-center gap-1">
				<button
					onclick={() => goToPage(data.page - 1)}
					disabled={data.page <= 1}
					class="px-2.5 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/30 transition-colors disabled:opacity-30 disabled:pointer-events-none"
				>
					Prev
				</button>
				{#each pageNumbers as p, i}
					{#if i > 0 && p - pageNumbers[i - 1] > 1}
						<span class="px-1 text-xs text-text-secondary">...</span>
					{/if}
					<button
						onclick={() => goToPage(p)}
						class="px-2.5 py-1.5 text-xs rounded-md border transition-colors
							{p === data.page
							? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40 font-medium'
							: 'border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/30'}"
					>
						{p}
					</button>
				{/each}
				<button
					onclick={() => goToPage(data.page + 1)}
					disabled={data.page >= data.totalPages}
					class="px-2.5 py-1.5 text-xs rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-accent-blue/30 transition-colors disabled:opacity-30 disabled:pointer-events-none"
				>
					Next
				</button>
			</div>
		</div>
	{/if}
</div>
