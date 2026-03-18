<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';
	import type { DaemonWorkerStats } from '$lib/types/daemon.js';

	let { data }: { data: PageData } = $props();

	let hooks = $derived(data.hooks ?? {});
	let workers = $derived(data.workers ?? []);
	let learning = $derived(data.learning ?? null);
	let workerStats = $derived(data.workerStats ?? {});
	let workerConfigs = $derived(data.workerConfigs ?? []);

	const projectName = $derived(data.project?.name ?? data.projectId ?? 'Project');

	let expandedHook: number | null = $state(null);

	// Flatten HooksConfig into a displayable table of rows
	let hookRegistry = $derived.by(() => {
		const rows: Array<{ family: string; type: string; command: string; timeout: string; status: string; matcher: string }> = [];
		for (const [family, matchers] of Object.entries(hooks)) {
			for (const matcher of matchers) {
				for (const entry of matcher.hooks) {
					rows.push({
						family,
						type: entry.type,
						command: entry.command,
						timeout: entry.timeout ? `${entry.timeout}ms` : '-',
						status: 'Active',
						matcher: matcher.matcher ?? '*'
					});
				}
			}
		}
		return rows;
	});

	let totalHooks = $derived(hookRegistry.length);

	// Live daemon worker entries
	let daemonWorkerEntries = $derived(Object.entries(workerStats) as [string, DaemonWorkerStats][]);
	let activeWorkerCount = $derived(daemonWorkerEntries.filter(([, w]) => w.runCount > 0).length);
	let totalRuns = $derived(daemonWorkerEntries.reduce((sum, [, w]) => sum + w.runCount, 0));
	let totalFailures = $derived(daemonWorkerEntries.reduce((sum, [, w]) => sum + w.failureCount, 0));

	// Worker config descriptions
	let configMap = $derived(
		new Map(workerConfigs.map((c) => [c.type, c]))
	);

	// Build learning config display rows
	let learningRows = $derived.by(() => {
		if (!learning) return [];
		const rows: Array<{ label: string; value: string }> = [];
		rows.push({
			label: 'Auto-Train',
			value: learning.autoTrain ? 'Enabled' : 'Disabled'
		});
		if (learning.patterns && learning.patterns.length > 0) {
			rows.push({
				label: 'Pattern Types',
				value: learning.patterns.join(', ')
			});
			rows.push({
				label: 'Pattern Count',
				value: String(learning.patterns.length)
			});
		}
		if (learning.retention) {
			for (const [key, val] of Object.entries(learning.retention)) {
				rows.push({ label: `Retention: ${key}`, value: val });
			}
		}
		return rows;
	});

	let patternLabel = $derived.by(() => {
		if (!learning?.patterns) return '0';
		return String(learning.patterns.length);
	});

	function successRate(w: DaemonWorkerStats): string {
		if (w.runCount === 0) return '-';
		return Math.round((w.successCount / w.runCount) * 100) + '%';
	}

	function formatDuration(ms: number): string {
		if (ms === 0) return '-';
		if (ms < 1000) return ms.toFixed(0) + 'ms';
		return (ms / 1000).toFixed(1) + 's';
	}

	function formatNextRun(iso?: string): string {
		if (!iso) return '-';
		const diff = new Date(iso).getTime() - Date.now();
		if (diff < 0) return 'overdue';
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return '<1m';
		return mins + 'm';
	}

	function timeAgo(iso: string | null): string {
		if (!iso) return '-';
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 5) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		return `${Math.floor(diff / 3600)}h ago`;
	}

	const priorityLabels: Record<string, string> = {
		critical: 'Critical',
		high: 'High',
		normal: 'Normal',
		low: 'Low'
	};

	const priorityColors: Record<string, string> = {
		critical: 'text-accent-red',
		high: 'text-accent-yellow',
		normal: 'text-accent-blue',
		low: 'text-accent-cyan'
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="type-page-title text-text-primary">Hooks</h1>
		<p class="text-xs text-text-secondary mt-0.5">
			Hook registry and worker activity for <span class="font-mono text-accent-cyan">{projectName}</span>
		</p>
	</div>

	<!-- Metric Cards -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Total Hooks" value={totalHooks} subtitle="across all phases" accent="blue" />
		<MetricCard
			label="Daemon Workers"
			value="{activeWorkerCount}/{daemonWorkerEntries.length}"
			subtitle={data.daemonRunning ? 'daemon running' : 'daemon stopped'}
			accent={data.daemonRunning ? 'green' : 'yellow'}
		/>
		<MetricCard label="Total Runs" value={totalRuns} subtitle="{totalFailures} failure{totalFailures === 1 ? '' : 's'}" accent={totalFailures > 0 ? 'red' : 'cyan'} />
		<MetricCard
			label="Auto-Train"
			value={learning?.autoTrain ? 'On' : 'Off'}
			subtitle="{patternLabel} pattern type{patternLabel === '1' ? '' : 's'}"
			accent="purple"
		/>
	</div>

	<!-- Hook Registry -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Hook Registry</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#if hookRegistry.length === 0}
				<div class="px-4 py-12 flex flex-col items-center justify-center text-center">
					<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.1-3.93a1.125 1.125 0 01-.26-1.56l.46-.6a1.125 1.125 0 011.56-.26l3.22 2.48 5.76-7.1a1.125 1.125 0 011.56-.22l.58.47a1.125 1.125 0 01.22 1.56l-6.84 8.43a1.125 1.125 0 01-1.56.23z" />
					</svg>
					<h2 class="text-text-primary text-sm font-medium mb-1">No hooks configured</h2>
					<p class="text-text-secondary text-xs">Hooks will appear here once registered in settings</p>
				</div>
			{:else}
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border">
							<th class="text-left px-4 py-3 text-text-secondary font-medium">Hook</th>
							<th class="text-left px-4 py-3 text-text-secondary font-medium">Phase</th>
							<th class="text-left px-4 py-3 text-text-secondary font-medium">Status</th>
							<th class="text-left px-4 py-3 text-text-secondary font-medium">Command</th>
							<th class="text-right px-4 py-3 text-text-secondary font-medium">Timeout</th>
						</tr>
					</thead>
					<tbody>
						{#each hookRegistry as h, i}
							<tr
								class="border-b border-border last:border-0 cursor-pointer hover:bg-bg-primary/50 transition-colors"
								onclick={() => expandedHook = expandedHook === i ? null : i}
							>
								<td class="px-4 py-3 font-mono text-text-primary">{h.family}</td>
								<td class="px-4 py-3 text-text-secondary">{h.type}</td>
								<td class="px-4 py-3 text-accent-green">{h.status}</td>
								<td class="px-4 py-3 font-mono text-text-secondary text-sm truncate max-w-xs">{h.command.split('/').pop()}</td>
								<td class="px-4 py-3 font-mono text-text-secondary text-right">{h.timeout}</td>
							</tr>
							{#if expandedHook === i}
								<tr class="border-b border-border last:border-0 bg-bg-primary/30">
									<td colspan="5" class="px-4 py-3">
										<div class="space-y-2 text-xs">
											<div class="flex gap-2">
												<span class="text-text-secondary w-16 shrink-0">Command</span>
												<code class="font-mono text-text-primary break-all select-all bg-bg-primary px-2 py-1 rounded border border-border">{h.command}</code>
											</div>
											<div class="flex gap-2">
												<span class="text-text-secondary w-16 shrink-0">Matcher</span>
												<code class="font-mono text-accent-cyan">{h.matcher}</code>
											</div>
											<div class="flex gap-2">
												<span class="text-text-secondary w-16 shrink-0">Timeout</span>
												<span class="font-mono text-text-primary">{h.timeout}</span>
											</div>
										</div>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</section>

	<!-- Live Worker Stats + Learning Config -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Live Worker Stats -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-4">
				<h2 class="type-section-title text-text-primary">Worker Activity</h2>
				{#if data.daemonStartedAt}
					<span class="text-xs text-text-secondary">up since {timeAgo(data.daemonStartedAt)}</span>
				{/if}
			</div>
			{#if daemonWorkerEntries.length === 0}
				<p class="text-sm text-text-secondary">No daemon state available.</p>
			{:else}
				<div class="space-y-3">
					{#each daemonWorkerEntries as [name, w]}
						{@const config = configMap.get(name)}
						<div class="flex items-center gap-3">
							<span class="w-2 h-2 rounded-full shrink-0 {w.isRunning ? 'bg-accent-green animate-pulse' : w.runCount > 0 ? 'bg-accent-blue' : 'bg-text-secondary'}"></span>
							<div class="flex-1 min-w-0">
								<div class="flex items-center justify-between">
									<span class="text-xs font-mono text-text-primary">{name}</span>
									<span class="text-xs font-mono {w.failureCount > 0 ? 'text-accent-red' : 'text-accent-green'}">{successRate(w)}</span>
								</div>
								<div class="flex items-center justify-between text-[10px] text-text-secondary">
									<span>{config?.description ?? ''}</span>
									<span>{w.runCount} run{w.runCount === 1 ? '' : 's'} &middot; {formatDuration(w.averageDurationMs)} avg</span>
								</div>
								{#if w.nextRun || w.lastRun}
									<div class="flex items-center justify-between text-[10px] text-text-secondary mt-0.5">
										{#if config}
											<span class="{priorityColors[config.priority] ?? 'text-text-secondary'}">{priorityLabels[config.priority] ?? config.priority}</span>
										{:else}
											<span></span>
										{/if}
										<span>
											{#if w.lastRun}last {timeAgo(w.lastRun)}{/if}
											{#if w.nextRun} &middot; next in {formatNextRun(w.nextRun)}{/if}
										</span>
									</div>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Learning Configuration -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Learning Configuration</p>
			{#if !learning}
				<p class="text-sm text-text-secondary">No learning configuration found.</p>
			{:else if learningRows.length === 0}
				<p class="text-sm text-text-secondary">Learning configured but no details available.</p>
			{:else}
				<div class="space-y-2">
					{#each learningRows as item}
						<div class="flex justify-between text-sm">
							<span class="text-text-secondary">{item.label}</span>
							<span class="font-mono text-text-primary">{item.value}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
