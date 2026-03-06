<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const TOTAL_VRAM_GB = 24;

	// Live-updating running models state
	let liveRunning = $state(data.runningModels);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function pollRunning() {
		try {
			const res = await apiFetch('/api/ollama/ps', { signal: AbortSignal.timeout(5000) });
			if (res.ok) {
				const ps = await res.json();
				liveRunning = ps.models ?? [];
			}
		} catch {
			// keep last known state
		}
	}

	onMount(() => {
		pollTimer = setInterval(pollRunning, 5000);
		usagePollTimer = setInterval(pollAgentUsage, 15_000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (usagePollTimer) clearInterval(usagePollTimer);
	});

	let vramUsedGb = $derived(
		liveRunning.length > 0
			? liveRunning.reduce((sum: number, m: any) => sum + (m.size_vram ?? 0), 0) / (1024 * 1024 * 1024)
			: 0
	);

	let runningNames = $derived(new Set(liveRunning.map((m: any) => m.name)));

	let apiModels = $derived(
		(() => {
			if (!data.modelsConfig) return [];
			const providers = data.modelsConfig.models.providers;
			const result: { id: string; name: string; provider: string; cost?: { input: number; output: number } }[] = [];
			for (const [providerKey, provider] of Object.entries(providers)) {
				if (providerKey === 'ollama') continue;
				for (const model of provider.models) {
					result.push({ id: model.id, name: model.name, provider: providerKey, cost: model.cost });
				}
			}
			return result;
		})()
	);

	let totalModelsCount = $derived(data.ollamaModels.length + apiModels.length);

	let primaryModelId = $derived(data.modelsConfig?.models.defaults.primary ?? '');
	let fallbackIds = $derived(data.modelsConfig?.models.defaults.fallbacks ?? []);

	function getTier(modelId: string): { label: string; color: string } {
		if (modelId === primaryModelId) return { label: 'Primary', color: 'text-accent-cyan' };
		const idx = fallbackIds.indexOf(modelId);
		if (idx === 0) return { label: 'Fallback 1', color: 'text-accent-yellow' };
		if (idx >= 1) return { label: `Fallback ${idx + 1}`, color: 'text-accent-purple' };
		return { label: 'Available', color: 'text-text-secondary' };
	}

	function formatBytes(bytes: number): string {
		const gb = bytes / (1024 * 1024 * 1024);
		if (gb >= 1) return `${gb.toFixed(1)} GB`;
		const mb = bytes / (1024 * 1024);
		return `${mb.toFixed(0)} MB`;
	}

	function getRunningVram(modelName: string): string {
		const running = liveRunning.find((m: any) => m.name === modelName);
		if (!running) return '\u2014';
		return formatBytes(running.size_vram);
	}

	let routingChain = $derived(
		(() => {
			const primaryName = primaryModelId || 'Local Model';
			const fallbackNames = fallbackIds.length > 0 ? fallbackIds.join(' / ') : 'API Fallback';
			return [
				{ label: 'Input', sublabel: 'User message', color: '' },
				{ label: 'Router', sublabel: 'Keyword + semantic match', color: 'text-accent-cyan' },
				{ label: primaryName, sublabel: 'Primary handler', color: 'text-accent-green' },
				{ label: 'Escalation?', sublabel: 'Complexity > 30%', color: 'text-accent-yellow' },
				{ label: fallbackNames, sublabel: 'API fallback chain', color: 'text-accent-purple' }
			];
		})()
	);

	interface LearningData {
		routing?: { accuracy?: number; decisions?: number };
		patterns?: { shortTerm?: number; longTerm?: number; quality?: number };
	}

	let learning = $derived(data.learning as LearningData | null);
	let routingAccuracy = $derived(learning?.routing?.accuracy ?? null);
	let routingDecisions = $derived(learning?.routing?.decisions ?? null);
	let shortTermPatterns = $derived(learning?.patterns?.shortTerm ?? null);
	let longTermPatterns = $derived(learning?.patterns?.longTerm ?? null);
	let patternQuality = $derived(learning?.patterns?.quality ?? null);

	// Routing telemetry
	interface RoutingDecision {
		id: string;
		timestamp: string;
		model: string;
		provider: string;
		agent: string;
		taskType: string;
		complexity: number;
		latencyMs: number;
		success: boolean;
		source: string;
		reason?: string;
	}

	interface ModelStats {
		model: string;
		provider: string;
		count: number;
		successRate: number;
		avgLatencyMs: number;
		avgComplexity: number;
		costEstimate: number;
	}

	interface AgentStats {
		agent: string;
		count: number;
		successRate: number;
		avgLatencyMs: number;
		taskTypes: string[];
	}

	interface RoutingStatsData {
		totalDecisions: number;
		successRate: number;
		avgLatencyMs: number;
		byModel: Record<string, ModelStats>;
		byAgent: Record<string, AgentStats>;
		byTaskType: Record<string, { taskType: string; count: number; preferredAgent: string; avgComplexity: number; successRate: number }>;
		recentDecisions: RoutingDecision[];
		hourlyActivity: { hour: string; count: number; successRate: number }[];
	}

	let rs = $state(data.routingStats as RoutingStatsData | null);

	// Poll routing stats every 10s
	let routingPollTimer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		routingPollTimer = setInterval(async () => {
			try {
				const res = await apiFetch('/api/routing', { signal: AbortSignal.timeout(5000) });
				if (res.ok) {
					const body = await res.json();
					const { workflowStats: wfData, ...rest } = body;
					rs = rest;
					if (wfData) wf = wfData;
				}
			} catch { /* keep last */ }
		}, 10_000);
	});

	onDestroy(() => {
		if (routingPollTimer) clearInterval(routingPollTimer);
	});

	const agentColors: Record<string, string> = {
		'gpt-oss': 'text-accent-green',
		'claude-code': 'text-accent-blue',
		'claude-api': 'text-accent-purple',
		'claude': 'text-accent-purple',
		'claude-flow-swarm': 'text-accent-cyan',
		'openclaw': 'text-accent-yellow',
		'internal': 'text-accent-green',
		'claw': 'text-accent-cyan'
	};

	const sourceColors: Record<string, string> = {
		'claw': 'text-accent-cyan',
		'user': 'text-accent-green',
		'heartbeat': 'text-accent-yellow',
		'auto': 'text-accent-purple'
	};

	// Agent usage stats
	interface AgentUsageEntry {
		taskId: string;
		taskTitle: string;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		model: string;
		durationMs: number;
		timestamp: string;
		usedClaudeFlow?: boolean;
		claudeFlowTools?: string[];
	}

	interface ModelStats {
		input: number;
		output: number;
		cost: number;
		count: number;
		avgDurationMs: number;
		avgInput: number;
		avgOutput: number;
		inputOutputRatio: number;
		costPerOutputToken: number;
	}

	interface ClaudeFlowStats {
		agentsUsing: number;
		agentsTotal: number;
		adoptionRate: number;
		toolUsage: Record<string, number>;
	}

	interface AgentUsageStats {
		entries: AgentUsageEntry[];
		totals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; durationMs: number; taskCount: number; inputOutputRatio: number; costPerOutputToken: number };
		byModel: Record<string, ModelStats>;
		recentAgents: AgentUsageEntry[];
		claudeFlow: ClaudeFlowStats;
	}

	let agentUsage = $state(data.agentUsage as AgentUsageStats);

	// Poll agent usage every 15s
	let usagePollTimer: ReturnType<typeof setInterval> | null = null;

	async function pollAgentUsage() {
		try {
			const res = await apiFetch('/api/agents/usage', { signal: AbortSignal.timeout(5000) });
			if (res.ok) {
				agentUsage = await res.json();
			}
		} catch { /* keep last */ }
	}

	// Workflow stats
	interface WorkflowStep {
		agent: string;
		model: string;
		provider: string;
		taskType: string;
		complexity: number;
		latencyMs: number;
		success: boolean;
	}

	interface WorkflowChain {
		sessionId: string;
		source: string;
		steps: WorkflowStep[];
		totalLatencyMs: number;
		escalated: boolean;
		startTime: string;
	}

	interface SourceStats {
		source: string;
		count: number;
		successRate: number;
		avgLatencyMs: number;
		escalationRate: number;
		topAgents: { agent: string; count: number }[];
		topTaskTypes: { taskType: string; count: number }[];
	}

	interface ChainPattern {
		pattern: string[];
		count: number;
		successRate: number;
		avgLatencyMs: number;
		escalationRate: number;
		sources: { source: string; count: number }[];
	}

	interface AgentRoutingProfile {
		agent: string;
		totalRouted: number;
		asFirst: number;
		asLast: number;
		escalatedFrom: number;
		escalatedTo: number;
		avgComplexityHandled: number;
		modelsUsed: { model: string; count: number }[];
		taskTypes: { taskType: string; count: number }[];
		successRate: number;
		avgLatencyMs: number;
	}

	interface WorkflowStatsData {
		bySource: Record<string, SourceStats>;
		recentWorkflows: WorkflowChain[];
		escalationRate: number;
		avgChainLength: number;
		clawInitiated: number;
		userInitiated: number;
		chainPatterns: ChainPattern[];
		agentProfiles: Record<string, AgentRoutingProfile>;
	}

	let wf = $state(data.workflowStats as WorkflowStatsData | null);

	function timeAgo(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return `${Math.floor(hrs / 24)}d ago`;
	}
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Model Routing</h1>

	<!-- Metric Cards -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Total Models" value={totalModelsCount} subtitle="{data.ollamaModels.length} local + {apiModels.length} API" accent="cyan" />
		<MetricCard label="Running" value={liveRunning.length} subtitle={liveRunning.length > 0 ? liveRunning.map((m: any) => m.name).join(', ') : 'None loaded'} accent="green" />
		<MetricCard label="VRAM Used" value="{vramUsedGb.toFixed(1)} GB" subtitle="of {TOTAL_VRAM_GB} GB total" accent="yellow" />
		<MetricCard label="Total VRAM" value="{TOTAL_VRAM_GB} GB" subtitle="RTX 3090" accent="blue" />
	</div>

	<!-- VRAM Gauge -->
	<VramGauge
		usedGb={vramUsedGb}
		totalGb={TOTAL_VRAM_GB}
		modelName={liveRunning.length > 0 ? liveRunning.map((m: any) => `${m.name} (${formatBytes(m.size_vram)})`).join(' + ') : 'No models loaded'}
	/>

	<!-- Available Models -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Available Models</h2>
		<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
			{#each data.ollamaModels as model}
				{@const isRunning = runningNames.has(model.name)}
				{@const tier = getTier(model.name)}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full {isRunning ? 'bg-accent-green' : 'bg-accent-yellow'}"></span>
						<span class="type-card-title text-text-primary">{model.name}</span>
					</div>
					<p class="text-xs text-text-secondary mb-3">Local &middot; {model.details.family}</p>
					<div class="space-y-2 text-xs">
						<div class="flex justify-between">
							<span class="text-text-secondary">Status</span>
							<span class="font-mono {isRunning ? 'text-accent-green' : 'text-accent-yellow'}">{isRunning ? 'Running' : 'Loaded'}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Size</span>
							<span class="font-mono text-text-primary">{formatBytes(model.size)}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">VRAM</span>
							<span class="font-mono text-text-primary">{getRunningVram(model.name)}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Parameters</span>
							<span class="font-mono text-text-primary">{model.details.parameter_size}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Quantization</span>
							<span class="font-mono text-text-primary">{model.details.quantization_level}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Tier</span>
							<span class="font-mono {tier.color}">{tier.label}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Cost/req</span>
							<span class="font-mono text-accent-green">$0</span>
						</div>
					</div>
				</div>
			{/each}

			{#each apiModels as model}
				{@const tier = getTier(model.id)}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full bg-accent-blue"></span>
						<span class="type-card-title text-text-primary">{model.name}</span>
					</div>
					<p class="text-xs text-text-secondary mb-3">API &middot; {model.provider}</p>
					<div class="space-y-2 text-xs">
						<div class="flex justify-between">
							<span class="text-text-secondary">Status</span>
							<span class="font-mono text-accent-green">Available</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">VRAM</span>
							<span class="font-mono text-text-primary">&mdash;</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Tier</span>
							<span class="font-mono {tier.color}">{tier.label}</span>
						</div>
						{#if model.cost}
							<div class="flex justify-between">
								<span class="text-text-secondary">Cost (in/out)</span>
								<span class="font-mono text-accent-yellow">${model.cost.input} / ${model.cost.output}</span>
							</div>
						{/if}
					</div>
				</div>
			{/each}

			{#if data.ollamaModels.length === 0 && apiModels.length === 0}
				<div class="col-span-full bg-bg-secondary border border-border rounded-lg p-8 text-center">
					<p class="text-text-secondary">No models found. Is Ollama running?</p>
				</div>
			{/if}
		</div>
	</section>

	<!-- Claw Workflow Routing Chain -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Claw Workflow Routing Chain</h2>
		<div class="space-y-4">
			<!-- Full routing chain -->
			<div class="flex flex-wrap items-center gap-3">
				{#each routingChain as step, i}
					<div class="bg-bg-secondary border border-border rounded-lg px-4 py-3 min-w-[160px]">
						<p class="text-sm font-medium {step.color || 'text-text-primary'}">{step.label}</p>
						<p class="text-xs text-text-secondary mt-0.5">{step.sublabel}</p>
					</div>
					{#if i < routingChain.length - 1}
						<svg class="w-5 h-5 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
						</svg>
					{/if}
				{/each}
			</div>

			<!-- Workflow overview metrics -->
			{#if wf}
				<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
					<MetricCard label="Claw Initiated" value={wf.clawInitiated} subtitle="auto-sessions by Claw" accent="cyan" />
					<MetricCard label="User Initiated" value={wf.userInitiated} subtitle="direct user requests" accent="green" />
					<MetricCard label="Escalation Rate" value="{(wf.escalationRate * 100).toFixed(1)}%" subtitle="routed to API model" accent={wf.escalationRate > 0.3 ? 'yellow' : 'green'} />
					<MetricCard label="Avg Chain Length" value="{wf.avgChainLength.toFixed(1)}" subtitle="steps per workflow" accent="blue" />
				</div>
			{/if}
		</div>
	</section>

	<!-- Agent Token Usage -->
	{#if agentUsage && agentUsage.totals.taskCount > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Spawned Agent Usage</h2>

			<!-- Agent usage metrics -->
			<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
				<MetricCard label="Agent Tasks" value={agentUsage.totals.taskCount} subtitle="total spawned" accent="cyan" />
				<MetricCard label="Input Tokens" value="{(agentUsage.totals.inputTokens / 1000).toFixed(0)}K" subtitle="context loaded" accent={agentUsage.totals.inputTokens > 1_000_000 ? 'red' : 'blue'} />
				<MetricCard label="Output Tokens" value="{(agentUsage.totals.outputTokens / 1000).toFixed(0)}K" subtitle="generated" accent="green" />
				<MetricCard label="Input:Output" value="{agentUsage.totals.inputOutputRatio.toFixed(0)}:1" subtitle={agentUsage.totals.inputOutputRatio > 50 ? 'very input-heavy' : agentUsage.totals.inputOutputRatio > 20 ? 'input-heavy' : 'balanced'} accent={agentUsage.totals.inputOutputRatio > 50 ? 'red' : agentUsage.totals.inputOutputRatio > 20 ? 'yellow' : 'green'} />
				<MetricCard label="Total Cost" value="${agentUsage.totals.costUsd.toFixed(2)}" subtitle="all agents combined" accent={agentUsage.totals.costUsd > 5 ? 'red' : agentUsage.totals.costUsd > 1 ? 'yellow' : 'green'} />
				<MetricCard label="Avg Duration" value="{agentUsage.totals.taskCount > 0 ? (agentUsage.totals.durationMs / agentUsage.totals.taskCount / 1000).toFixed(0) : 0}s" subtitle="per agent task" accent="purple" />
			</div>

			<!-- Claude Flow Adoption -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4 mb-4">
				<div class="flex items-center gap-3 mb-3">
					<span class="text-sm font-medium text-text-primary">Claude Flow / Ruflo Integration</span>
					{#if agentUsage.claudeFlow.adoptionRate > 0}
						<span class="text-xs px-2 py-0.5 rounded-full bg-accent-green/15 text-accent-green font-medium">
							{(agentUsage.claudeFlow.adoptionRate * 100).toFixed(0)}% adoption
						</span>
					{:else}
						<span class="text-xs px-2 py-0.5 rounded-full bg-accent-yellow/15 text-accent-yellow font-medium">
							not yet detected
						</span>
					{/if}
				</div>
				<div class="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
					<div>
						<span class="text-text-secondary">Agents Using CF</span>
						<div class="font-mono text-text-primary text-lg">{agentUsage.claudeFlow.agentsUsing} / {agentUsage.claudeFlow.agentsTotal}</div>
					</div>
					{#if Object.keys(agentUsage.claudeFlow.toolUsage).length > 0}
						<div class="col-span-2">
							<span class="text-text-secondary">MCP Tools Used</span>
							<div class="flex flex-wrap gap-1.5 mt-1">
								{#each Object.entries(agentUsage.claudeFlow.toolUsage).sort((a, b) => b[1] - a[1]) as [tool, count]}
									<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan font-mono text-[11px]">
										{tool} <span class="text-text-secondary">{count}x</span>
									</span>
								{/each}
							</div>
						</div>
					{:else}
						<div class="col-span-2">
							<span class="text-text-secondary">MCP Tools Used</span>
							<div class="text-text-secondary mt-1 italic">No Claude Flow tool calls detected yet. New agents will report usage after completion.</div>
						</div>
					{/if}
				</div>
			</div>

			<!-- Per-model agent breakdown -->
			{#if Object.keys(agentUsage.byModel).length > 0}
				<h3 class="text-sm font-medium text-text-secondary mb-3">Per-Model Breakdown</h3>
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
					{#each Object.entries(agentUsage.byModel).sort((a, b) => b[1].cost - a[1].cost) as [model, stats]}
						<div class="bg-bg-secondary border border-border rounded-lg p-4">
							<div class="flex items-center justify-between mb-3">
								<span class="text-sm font-medium text-text-primary truncate" title={model}>{model}</span>
								<span class="text-xs font-mono text-text-secondary">{stats.count} task{stats.count !== 1 ? 's' : ''}</span>
							</div>

							<!-- Input/output bar visualization -->
							<div class="mb-3">
								<div class="flex items-center gap-2 text-[10px] text-text-secondary mb-1">
									<span>Token distribution</span>
									<span class="ml-auto font-mono">{stats.inputOutputRatio.toFixed(0)}:1 ratio</span>
								</div>
								<div class="flex h-2 rounded-full overflow-hidden bg-bg-tertiary">
									<div class="bg-accent-yellow/60 transition-all" style="width: {stats.input / (stats.input + stats.output) * 100}%" title="Input: {(stats.input / 1000).toFixed(0)}K"></div>
									<div class="bg-accent-green/60 transition-all" style="width: {stats.output / (stats.input + stats.output) * 100}%" title="Output: {(stats.output / 1000).toFixed(0)}K"></div>
								</div>
								<div class="flex justify-between text-[10px] mt-1">
									<span class="text-accent-yellow">{(stats.input / 1000).toFixed(0)}K in</span>
									<span class="text-accent-green">{(stats.output / 1000).toFixed(0)}K out</span>
								</div>
							</div>

							<div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Input/Task</span>
									<span class="font-mono {stats.avgInput > 400000 ? 'text-accent-red' : stats.avgInput > 100000 ? 'text-accent-yellow' : 'text-text-primary'}">{(stats.avgInput / 1000).toFixed(0)}K</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Output/Task</span>
									<span class="font-mono text-text-primary">{(stats.avgOutput / 1000).toFixed(1)}K</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Total Cost</span>
									<span class="font-mono {stats.cost > 1 ? 'text-accent-red' : stats.cost > 0.5 ? 'text-accent-yellow' : stats.cost === 0 ? 'text-accent-green' : 'text-text-primary'}">${stats.cost.toFixed(4)}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">$/1K Output</span>
									<span class="font-mono text-text-primary">${(stats.costPerOutputToken * 1000).toFixed(4)}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Duration</span>
									<span class="font-mono text-text-primary">{(stats.avgDurationMs / 1000).toFixed(0)}s</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Avg Cost/Task</span>
									<span class="font-mono {stats.cost / stats.count > 0.5 ? 'text-accent-yellow' : 'text-text-primary'}">${(stats.cost / stats.count).toFixed(4)}</span>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Recent agent tasks (detailed) -->
			{#if agentUsage.recentAgents.length > 0}
				<h3 class="text-sm font-medium text-text-secondary mb-3">Recent Agent Tasks</h3>
				<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
					<div class="max-h-[400px] overflow-y-auto">
						<table class="w-full text-xs">
							<thead class="sticky top-0 bg-bg-secondary">
								<tr class="border-b border-border text-text-secondary uppercase tracking-wider">
									<th class="text-left px-3 py-2">Time</th>
									<th class="text-left px-3 py-2">Task</th>
									<th class="text-left px-3 py-2">Model</th>
									<th class="text-center px-3 py-2" title="Claude Flow">CF</th>
									<th class="text-right px-3 py-2">Input</th>
									<th class="text-right px-3 py-2">Output</th>
									<th class="text-right px-3 py-2">Ratio</th>
									<th class="text-right px-3 py-2">Cost</th>
									<th class="text-right px-3 py-2">Duration</th>
								</tr>
							</thead>
							<tbody>
								{#each agentUsage.recentAgents as entry}
									{@const ratio = entry.outputTokens > 0 ? entry.inputTokens / entry.outputTokens : 0}
									<tr class="border-b border-border/30 hover:bg-bg-tertiary transition-colors">
										<td class="px-3 py-2 text-text-secondary font-mono whitespace-nowrap">{timeAgo(entry.timestamp)}</td>
										<td class="px-3 py-2 text-text-primary truncate max-w-[180px]" title={entry.taskTitle}>{entry.taskTitle}</td>
										<td class="px-3 py-2 font-mono text-text-primary whitespace-nowrap">{entry.model}</td>
										<td class="text-center px-3 py-2" title={entry.usedClaudeFlow ? 'Claude Flow: ' + (entry.claudeFlowTools ?? []).join(', ') : 'Claude Flow not used'}>
											{#if entry.usedClaudeFlow}
												<span class="inline-block w-2 h-2 rounded-full bg-accent-green" title={entry.claudeFlowTools?.join(', ')}></span>
											{:else if entry.usedClaudeFlow === false}
												<span class="inline-block w-2 h-2 rounded-full bg-accent-red/50"></span>
											{:else}
												<span class="text-text-secondary">\u2014</span>
											{/if}
										</td>
										<td class="text-right px-3 py-2 font-mono {entry.inputTokens > 400000 ? 'text-accent-red' : entry.inputTokens > 100000 ? 'text-accent-yellow' : 'text-text-primary'}">{(entry.inputTokens / 1000).toFixed(0)}K</td>
										<td class="text-right px-3 py-2 font-mono text-accent-green">{(entry.outputTokens / 1000).toFixed(1)}K</td>
										<td class="text-right px-3 py-2 font-mono {ratio > 80 ? 'text-accent-red' : ratio > 40 ? 'text-accent-yellow' : 'text-text-secondary'}">{ratio > 0 ? ratio.toFixed(0) + ':1' : '\u2014'}</td>
										<td class="text-right px-3 py-2 font-mono {entry.costUsd > 0.5 ? 'text-accent-red' : entry.costUsd > 0 ? 'text-accent-yellow' : 'text-accent-green'}">${entry.costUsd.toFixed(4)}</td>
										<td class="text-right px-3 py-2 font-mono text-text-primary">{(entry.durationMs / 1000).toFixed(0)}s</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Workflow Source Breakdown -->
	{#if wf && Object.keys(wf.bySource).length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Routing by Source</h2>
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each Object.values(wf.bySource).sort((a, b) => b.count - a.count) as src}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-2 mb-3">
							<span class="w-2 h-2 rounded-full {src.source === 'claw' ? 'bg-accent-cyan' : src.source === 'user' ? 'bg-accent-green' : 'bg-accent-yellow'}"></span>
							<span class="text-sm font-medium {sourceColors[src.source] ?? 'text-text-primary'} capitalize">{src.source}</span>
							<span class="ml-auto text-xs font-mono text-text-secondary">{src.count} workflow{src.count !== 1 ? 's' : ''}</span>
						</div>
						<div class="space-y-2 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Success Rate</span>
								<span class="font-mono {src.successRate >= 0.9 ? 'text-accent-green' : src.successRate >= 0.7 ? 'text-accent-yellow' : 'text-accent-red'}">{(src.successRate * 100).toFixed(0)}%</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Latency</span>
								<span class="font-mono text-text-primary">{src.avgLatencyMs < 1000 ? src.avgLatencyMs.toFixed(0) + 'ms' : (src.avgLatencyMs / 1000).toFixed(1) + 's'}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Escalation</span>
								<span class="font-mono {src.escalationRate > 0.3 ? 'text-accent-yellow' : 'text-accent-green'}">{(src.escalationRate * 100).toFixed(0)}%</span>
							</div>
							{#if src.topAgents.length > 0}
								<div>
									<span class="text-text-secondary block mb-1">Top Agents</span>
									<div class="flex flex-wrap gap-1">
										{#each src.topAgents as a}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary {agentColors[a.agent] ?? 'text-text-secondary'}">{a.agent} ({a.count})</span>
										{/each}
									</div>
								</div>
							{/if}
							{#if src.topTaskTypes.length > 0}
								<div>
									<span class="text-text-secondary block mb-1">Task Types</span>
									<div class="flex flex-wrap gap-1">
										{#each src.topTaskTypes as t}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary capitalize">{t.taskType} ({t.count})</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Recent Workflow Chains -->
	{#if wf && wf.recentWorkflows.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Recent Workflow Chains</h2>
			<div class="space-y-3">
				{#each wf.recentWorkflows.slice(0, 6) as chain}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-3 mb-3">
							<span class="text-xs font-mono {sourceColors[chain.source] ?? 'text-text-secondary'} capitalize">{chain.source}</span>
							<span class="text-xs text-text-secondary">{timeAgo(chain.startTime)}</span>
							{#if chain.escalated}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-accent-yellow/20 text-accent-yellow">Escalated</span>
							{/if}
							<span class="ml-auto text-xs font-mono text-text-secondary">{chain.totalLatencyMs < 1000 ? chain.totalLatencyMs + 'ms' : (chain.totalLatencyMs / 1000).toFixed(1) + 's'} total</span>
						</div>
						<div class="flex flex-wrap items-center gap-2">
							{#each chain.steps as step, si}
								<div class="flex items-center gap-1.5 bg-bg-primary rounded px-2.5 py-1.5">
									<span class="w-1.5 h-1.5 rounded-full {step.success ? 'bg-accent-green' : 'bg-accent-red'}"></span>
									<span class="text-xs font-mono {agentColors[step.agent] ?? 'text-text-primary'}">{step.agent}</span>
									<span class="text-[10px] text-text-secondary">{step.model}</span>
									<span class="text-[10px] text-text-secondary capitalize">({step.taskType})</span>
								</div>
								{#if si < chain.steps.length - 1}
									<svg class="w-3.5 h-3.5 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
									</svg>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Agent Chain Patterns -->
	{#if wf && wf.chainPatterns && wf.chainPatterns.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Agent Chain Patterns</h2>
			<p class="text-xs text-text-secondary mb-3">Most common agent routing sequences across all workflows</p>
			<div class="space-y-2">
				{#each wf.chainPatterns.slice(0, 8) as cp}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-2">
							<div class="flex flex-wrap items-center gap-1.5">
								{#each cp.pattern as agent, ai}
									<span class="text-xs font-mono px-2 py-1 rounded bg-bg-primary {agentColors[agent] ?? 'text-text-primary'}">{agent}</span>
									{#if ai < cp.pattern.length - 1}
										<svg class="w-3 h-3 text-text-secondary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
											<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
										</svg>
									{/if}
								{/each}
							</div>
							<span class="text-sm font-mono text-text-primary ml-3">{cp.count}x</span>
						</div>
						<div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
							<div>
								<span class="text-text-secondary">Success</span>
								<span class="font-mono ml-1 {cp.successRate >= 0.9 ? 'text-accent-green' : cp.successRate >= 0.7 ? 'text-accent-yellow' : 'text-accent-red'}">{(cp.successRate * 100).toFixed(0)}%</span>
							</div>
							<div>
								<span class="text-text-secondary">Avg Latency</span>
								<span class="font-mono ml-1 text-text-primary">{cp.avgLatencyMs < 1000 ? cp.avgLatencyMs.toFixed(0) + 'ms' : (cp.avgLatencyMs / 1000).toFixed(1) + 's'}</span>
							</div>
							<div>
								<span class="text-text-secondary">Escalation</span>
								<span class="font-mono ml-1 {cp.escalationRate > 0.3 ? 'text-accent-yellow' : 'text-accent-green'}">{(cp.escalationRate * 100).toFixed(0)}%</span>
							</div>
							<div>
								<span class="text-text-secondary">Sources</span>
								<span class="flex gap-1 ml-1">
									{#each cp.sources.slice(0, 3) as src}
										<span class="font-mono {sourceColors[src.source] ?? 'text-text-secondary'} capitalize">{src.source}({src.count})</span>
									{/each}
								</span>
							</div>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Agent Routing Profiles -->
	{#if wf && wf.agentProfiles && Object.keys(wf.agentProfiles).length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Agent Routing Profiles</h2>
			<p class="text-xs text-text-secondary mb-3">Per-agent workflow participation, escalation, and model usage</p>
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each Object.values(wf.agentProfiles).sort((a, b) => b.totalRouted - a.totalRouted) as ap}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center gap-2 mb-3">
							<span class="w-2 h-2 rounded-full {ap.successRate >= 0.9 ? 'bg-accent-green' : ap.successRate >= 0.7 ? 'bg-accent-yellow' : 'bg-accent-red'}"></span>
							<span class="text-sm font-medium {agentColors[ap.agent] ?? 'text-text-primary'}">{ap.agent}</span>
							<span class="ml-auto text-xs font-mono text-text-secondary">{ap.totalRouted} routed</span>
						</div>
						<div class="space-y-2 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Success Rate</span>
								<span class="font-mono {ap.successRate >= 0.9 ? 'text-accent-green' : ap.successRate >= 0.7 ? 'text-accent-yellow' : 'text-accent-red'}">{(ap.successRate * 100).toFixed(0)}%</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Latency</span>
								<span class="font-mono text-text-primary">{ap.avgLatencyMs < 1000 ? ap.avgLatencyMs.toFixed(0) + 'ms' : (ap.avgLatencyMs / 1000).toFixed(1) + 's'}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Complexity</span>
								<div class="flex items-center gap-1.5">
									<div class="w-14 h-1.5 rounded-full bg-bg-primary overflow-hidden">
										<div class="h-full rounded-full bg-accent-cyan" style="width: {ap.avgComplexityHandled * 100}%"></div>
									</div>
									<span class="font-mono text-text-primary">{(ap.avgComplexityHandled * 100).toFixed(0)}%</span>
								</div>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Chain Position</span>
								<span class="font-mono text-text-primary">{ap.asFirst} first / {ap.asLast} last</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Escalation</span>
								<span class="font-mono text-text-primary">{ap.escalatedFrom} out / {ap.escalatedTo} in</span>
							</div>
							{#if ap.modelsUsed.length > 0}
								<div>
									<span class="text-text-secondary block mb-1">Models Used</span>
									<div class="flex flex-wrap gap-1">
										{#each ap.modelsUsed as mu}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary">{mu.model} ({mu.count})</span>
										{/each}
									</div>
								</div>
							{/if}
							{#if ap.taskTypes.length > 0}
								<div>
									<span class="text-text-secondary block mb-1">Task Types</span>
									<div class="flex flex-wrap gap-1">
										{#each ap.taskTypes as tt}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary capitalize">{tt.taskType} ({tt.count})</span>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Routing Telemetry -->
	{#if rs && rs.totalDecisions > 0}
		<!-- Routing Overview Metrics -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Routing Telemetry</h2>
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
				<MetricCard label="Decisions" value={rs.totalDecisions} subtitle="total routing decisions" accent="cyan" />
				<MetricCard label="Success Rate" value="{(rs.successRate * 100).toFixed(1)}%" subtitle="across all models" accent="green" />
				<MetricCard label="Avg Latency" value="{rs.avgLatencyMs < 1000 ? rs.avgLatencyMs.toFixed(0) + 'ms' : (rs.avgLatencyMs / 1000).toFixed(1) + 's'}" subtitle="response time" accent="yellow" />
				<MetricCard
					label="Cost"
					value="${Object.values(rs.byModel).reduce((s, m) => s + m.costEstimate, 0).toFixed(4)}"
					subtitle="estimated total"
					accent={Object.values(rs.byModel).reduce((s, m) => s + m.costEstimate, 0) === 0 ? 'green' : 'yellow'}
				/>
			</div>
		</section>

		<!-- Per-Model Routing Stats -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Per-Model Stats</h2>
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each Object.values(rs.byModel).sort((a, b) => b.count - a.count) as modelStat}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-3">
							<span class="text-sm font-medium text-text-primary">{modelStat.model}</span>
							<span class="text-xs font-mono text-text-secondary">{modelStat.provider}</span>
						</div>
						<div class="space-y-2 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Requests</span>
								<span class="font-mono text-text-primary">{modelStat.count}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Success Rate</span>
								<span class="font-mono {modelStat.successRate >= 0.9 ? 'text-accent-green' : modelStat.successRate >= 0.7 ? 'text-accent-yellow' : 'text-accent-red'}">{(modelStat.successRate * 100).toFixed(0)}%</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Latency</span>
								<span class="font-mono text-text-primary">{modelStat.avgLatencyMs < 1000 ? modelStat.avgLatencyMs.toFixed(0) + 'ms' : (modelStat.avgLatencyMs / 1000).toFixed(1) + 's'}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Avg Complexity</span>
								<div class="flex items-center gap-1.5">
									<div class="w-16 h-1.5 rounded-full bg-bg-primary overflow-hidden">
										<div class="h-full rounded-full bg-accent-cyan" style="width: {modelStat.avgComplexity * 100}%"></div>
									</div>
									<span class="font-mono text-text-primary">{(modelStat.avgComplexity * 100).toFixed(0)}%</span>
								</div>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Cost</span>
								<span class="font-mono {modelStat.costEstimate === 0 ? 'text-accent-green' : 'text-accent-yellow'}">${modelStat.costEstimate.toFixed(4)}</span>
							</div>
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- Per-Agent Breakdown -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Agent Routing</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border text-xs text-text-secondary uppercase tracking-wider">
							<th class="text-left px-4 py-3">Agent</th>
							<th class="text-right px-4 py-3">Requests</th>
							<th class="text-right px-4 py-3">Success</th>
							<th class="text-right px-4 py-3">Avg Latency</th>
							<th class="text-left px-4 py-3">Task Types</th>
						</tr>
					</thead>
					<tbody>
						{#each Object.values(rs.byAgent).sort((a, b) => b.count - a.count) as agentStat}
							<tr class="border-b border-border/50 hover:bg-bg-tertiary transition-colors">
								<td class="px-4 py-3 font-mono {agentColors[agentStat.agent] ?? 'text-text-primary'}">{agentStat.agent}</td>
								<td class="text-right px-4 py-3 font-mono text-text-primary">{agentStat.count}</td>
								<td class="text-right px-4 py-3 font-mono {agentStat.successRate >= 0.9 ? 'text-accent-green' : 'text-accent-yellow'}">{(agentStat.successRate * 100).toFixed(0)}%</td>
								<td class="text-right px-4 py-3 font-mono text-text-primary">{agentStat.avgLatencyMs < 1000 ? agentStat.avgLatencyMs.toFixed(0) + 'ms' : (agentStat.avgLatencyMs / 1000).toFixed(1) + 's'}</td>
								<td class="px-4 py-3">
									<div class="flex flex-wrap gap-1">
										{#each agentStat.taskTypes as tt}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary">{tt}</span>
										{/each}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<!-- Task Type Distribution -->
		{#if Object.keys(rs.byTaskType).length > 0}
			<section>
				<h2 class="type-section-title text-text-primary mb-4">Task Type Distribution</h2>
				<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
					{#each Object.values(rs.byTaskType).sort((a, b) => b.count - a.count) as tt}
						<div class="bg-bg-secondary border border-border rounded-lg p-3">
							<div class="flex items-center justify-between mb-2">
								<span class="text-sm font-medium text-text-primary capitalize">{tt.taskType}</span>
								<span class="text-xs font-mono text-text-secondary">{tt.count}x</span>
							</div>
							<div class="text-xs space-y-1">
								<div class="flex justify-between">
									<span class="text-text-secondary">Preferred</span>
									<span class="font-mono {agentColors[tt.preferredAgent] ?? 'text-text-primary'}">{tt.preferredAgent}</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Complexity</span>
									<span class="font-mono text-text-primary">{(tt.avgComplexity * 100).toFixed(0)}%</span>
								</div>
								<div class="flex justify-between">
									<span class="text-text-secondary">Success</span>
									<span class="font-mono {tt.successRate >= 0.9 ? 'text-accent-green' : 'text-accent-yellow'}">{(tt.successRate * 100).toFixed(0)}%</span>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Recent Routing Decisions -->
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Recent Decisions</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				<div class="max-h-[350px] overflow-y-auto">
					<table class="w-full text-xs">
						<thead class="sticky top-0 bg-bg-secondary">
							<tr class="border-b border-border text-text-secondary uppercase tracking-wider">
								<th class="text-left px-3 py-2">Time</th>
								<th class="text-left px-3 py-2">Agent</th>
								<th class="text-left px-3 py-2">Model</th>
								<th class="text-left px-3 py-2">Type</th>
								<th class="text-right px-3 py-2">Latency</th>
								<th class="text-center px-3 py-2">Status</th>
								<th class="text-left px-3 py-2">Source</th>
							</tr>
						</thead>
						<tbody>
							{#each rs.recentDecisions as decision}
								<tr class="border-b border-border/30 hover:bg-bg-tertiary transition-colors">
									<td class="px-3 py-2 text-text-secondary font-mono">{timeAgo(decision.timestamp)}</td>
									<td class="px-3 py-2 font-mono {agentColors[decision.agent] ?? 'text-text-primary'}">{decision.agent}</td>
									<td class="px-3 py-2 font-mono text-text-primary">{decision.model}</td>
									<td class="px-3 py-2 capitalize text-text-primary">{decision.taskType}</td>
									<td class="text-right px-3 py-2 font-mono text-text-primary">{decision.latencyMs < 1000 ? decision.latencyMs + 'ms' : (decision.latencyMs / 1000).toFixed(1) + 's'}</td>
									<td class="text-center px-3 py-2">
										<span class="w-2 h-2 rounded-full inline-block {decision.success ? 'bg-accent-green' : 'bg-accent-red'}"></span>
									</td>
									<td class="px-3 py-2 text-text-secondary">{decision.source}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	{/if}

	<!-- Routing Intelligence (Claude Flow learning data) -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<p class="type-label text-text-secondary mb-3">Routing Intelligence</p>
		{#if learning}
			<div class="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-2 text-sm">
				{#if routingAccuracy !== null}
					<div>
						<span class="text-text-secondary">Accuracy: </span>
						<span class="font-mono text-accent-green">{(routingAccuracy * 100).toFixed(1)}%</span>
					</div>
				{/if}
				{#if routingDecisions !== null}
					<div>
						<span class="text-text-secondary">Decisions: </span>
						<span class="font-mono text-text-primary">{routingDecisions.toLocaleString()}</span>
					</div>
				{/if}
				{#if shortTermPatterns !== null}
					<div>
						<span class="text-text-secondary">Short-term patterns: </span>
						<span class="font-mono text-accent-cyan">{shortTermPatterns}</span>
					</div>
				{/if}
				{#if longTermPatterns !== null}
					<div>
						<span class="text-text-secondary">Long-term patterns: </span>
						<span class="font-mono text-accent-purple">{longTermPatterns}</span>
					</div>
				{/if}
				{#if patternQuality !== null}
					<div>
						<span class="text-text-secondary">Pattern quality: </span>
						<span class="font-mono text-accent-yellow">{(patternQuality * 100).toFixed(1)}%</span>
					</div>
				{/if}
			</div>
		{:else if !rs || rs.totalDecisions === 0}
			<p class="text-sm text-text-secondary">No routing data yet. Send a chat message or let Claw start a session to see routing telemetry.</p>
		{:else}
			<p class="text-sm text-text-secondary">Claude Flow learning data not available. Routing telemetry is shown above.</p>
		{/if}
	</div>

</div>
