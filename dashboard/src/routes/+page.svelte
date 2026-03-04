<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import GaugeChart from '$lib/components/GaugeChart.svelte';
	import VramGauge from '$lib/components/VramGauge.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const sessionId = crypto.randomUUID().slice(0, 8);

	let v3 = $derived(data.v3Progress);
	let learn = $derived(data.learning);
	let swarm = $derived(data.swarmActivity);
	let models = $derived(data.runningModels);

	let activeAgents = $derived(v3?.swarm?.activeAgents ?? swarm?.swarm?.agent_count ?? 0);
	let maxAgents = $derived(v3?.swarm?.maxAgents ?? 15);
	let domainsCompleted = $derived(v3?.domains?.completed ?? 0);
	let domainsTotal = $derived(v3?.domains?.total ?? 0);
	let dddProgress = $derived(v3?.ddd?.progress ?? 0);
	let patternsLearned = $derived(v3?.learning?.patternsLearned ?? learn?.patterns?.shortTerm ?? 0);

	let routingAccuracy = $derived(learn?.routing?.accuracy ?? 0);
	let shortTermPatterns = $derived(learn?.patterns?.shortTerm ?? 0);
	let longTermPatterns = $derived(learn?.patterns?.longTerm ?? 0);

	let runningModel = $derived(models?.[0]);
	let vramUsedGb = $derived(runningModel ? runningModel.size_vram / (1024 ** 3) : 0);
	const totalVramGb = 24;
</script>

<div class="space-y-6">
	<!-- Metric Cards Row -->
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Session" value={sessionId} accent="cyan" />
		<MetricCard
			label="Swarm Agents"
			value="{activeAgents} / {maxAgents}"
			subtitle={v3?.swarm?.topology ?? 'hierarchical'}
			accent={activeAgents > 0 ? 'green' : 'yellow'}
		/>
		<MetricCard
			label="Domains"
			value="{domainsCompleted} / {domainsTotal}"
			subtitle={v3?.domains?.status ?? 'idle'}
			accent={domainsCompleted === domainsTotal && domainsTotal > 0 ? 'green' : 'blue'}
		/>
		<MetricCard
			label="Patterns Learned"
			value={patternsLearned}
			subtitle="{learn?.sessions?.total ?? 0} sessions"
			accent="purple"
		/>
	</div>

	<!-- V3 Progress + VRAM -->
	<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
		<!-- V3 Progress -->
		<div class="lg:col-span-2 bg-bg-secondary border border-border rounded-lg p-4 space-y-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider">V3 Progress</h2>

			<!-- Domain Progress -->
			<div>
				<div class="flex justify-between text-xs mb-1">
					<span class="text-text-secondary">Domains</span>
					<span class="text-text-primary font-mono">{domainsCompleted}/{domainsTotal}</span>
				</div>
				<div class="h-2.5 bg-bg-primary rounded-full overflow-hidden">
					<div
						class="h-full bg-accent-blue rounded-full transition-all"
						style="width: {domainsTotal > 0 ? (domainsCompleted / domainsTotal) * 100 : 0}%"
					></div>
				</div>
			</div>

			<!-- DDD Progress -->
			<div>
				<div class="flex justify-between text-xs mb-1">
					<span class="text-text-secondary">DDD Refactor</span>
					<span class="text-text-primary font-mono">{dddProgress}%</span>
				</div>
				<div class="h-2.5 bg-bg-primary rounded-full overflow-hidden">
					<div
						class="h-full bg-accent-purple rounded-full transition-all"
						style="width: {dddProgress}%"
					></div>
				</div>
			</div>

			{#if v3}
				<div class="flex gap-4 text-xs text-text-secondary">
					<span>v{v3.version}</span>
					<span>{v3.ddd?.modules ?? 0} modules</span>
					<span>{v3.ddd?.totalFiles ?? 0} files</span>
					<span>{(v3.ddd?.totalLines ?? 0).toLocaleString()} lines</span>
				</div>
			{/if}
		</div>

		<!-- VRAM Gauge -->
		<div>
			<VramGauge
				usedGb={vramUsedGb}
				totalGb={totalVramGb}
				modelName={runningModel?.name ?? 'No model loaded'}
			/>
		</div>
	</div>

	<!-- Learning + Memory -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Learning -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Learning</h2>
			<div class="flex items-center gap-6">
				<GaugeChart
					value={routingAccuracy}
					max={100}
					label="Routing Accuracy"
					color="#3b82f6"
				/>
				<div class="space-y-3 flex-1">
					<div class="flex justify-between items-center">
						<span class="text-xs text-text-secondary">Short-term</span>
						<span class="text-sm font-mono text-accent-cyan">{shortTermPatterns}</span>
					</div>
					<div class="flex justify-between items-center">
						<span class="text-xs text-text-secondary">Long-term</span>
						<span class="text-sm font-mono text-accent-purple">{longTermPatterns}</span>
					</div>
					<div class="flex justify-between items-center">
						<span class="text-xs text-text-secondary">Quality</span>
						<span class="text-sm font-mono text-accent-green">{learn?.patterns?.quality ?? 0}%</span>
					</div>
					<div class="flex justify-between items-center">
						<span class="text-xs text-text-secondary">Decisions</span>
						<span class="text-sm font-mono text-text-primary">{learn?.routing?.decisions ?? 0}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Top Memory Nodes -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Top Memory Nodes</h2>
			{#if data.topEntries.length > 0}
				<ul class="space-y-2">
					{#each data.topEntries as entry}
						<li class="flex items-start justify-between gap-2 py-1.5 border-b border-border last:border-0">
							<div class="min-w-0 flex-1">
								<p class="text-sm text-text-primary truncate">{entry.summary}</p>
								<p class="text-xs text-text-secondary font-mono">{entry.category}</p>
							</div>
							<StatusBadge
								status={entry.confidence > 0.7 ? 'online' : entry.confidence > 0.4 ? 'warning' : 'pending'}
								label="{Math.round(entry.confidence * 100)}%"
								size="sm"
							/>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-text-secondary">No ranked context entries available.</p>
			{/if}
		</div>
	</div>
</div>
