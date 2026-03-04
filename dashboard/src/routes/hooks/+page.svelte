<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import TimelineChart from '$lib/components/TimelineChart.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let hooks = $derived(data.hooks);
	let workers = $derived(data.workers);
	let learning = $derived(data.learning);

	let hookRows = $derived.by(() => {
		const rows: Record<string, unknown>[] = [];
		const families = Object.keys(hooks);
		for (const family of families) {
			const matchers = hooks[family];
			if (!Array.isArray(matchers)) continue;
			for (const matcherObj of matchers) {
				const matcherLabel = matcherObj.matcher ?? '*';
				for (const hook of matcherObj.hooks) {
					rows.push({
						family,
						matcher: matcherLabel,
						command: hook.command,
						timeout: hook.timeout ? `${hook.timeout}ms` : '--'
					});
				}
			}
		}
		return rows;
	});

	const hookColumns = [
		{ key: 'family', label: 'Family' },
		{ key: 'matcher', label: 'Matcher', mono: true },
		{ key: 'command', label: 'Command', mono: true },
		{ key: 'timeout', label: 'Timeout', mono: true }
	];

	// Statistics
	let totalFamilies = $derived(Object.keys(hooks).length);
	let totalHooks = $derived(hookRows.length);
	let hooksWithTimeout = $derived(hookRows.filter((r) => r['timeout'] !== '--').length);
</script>

<div class="space-y-6">
	<!-- Hook Statistics -->
	<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
		<MetricCard
			label="Hook Families"
			value={totalFamilies}
			subtitle="Event categories"
			accent="blue"
		/>
		<MetricCard
			label="Total Hooks"
			value={totalHooks}
			subtitle="Individual handlers"
			accent="cyan"
		/>
		<MetricCard
			label="With Timeouts"
			value={hooksWithTimeout}
			subtitle="{totalHooks - hooksWithTimeout} unlimited"
			accent="yellow"
		/>
	</div>

	<!-- Hook Registry -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Hook Registry</h2>
		<DataTable columns={hookColumns} rows={hookRows} />
	</div>

	<!-- Daemon Workers + Learning Config -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Daemon Workers -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-sm text-text-secondary uppercase tracking-wider">Daemon Workers</h2>
				{#if data.daemonAutoStart}
					<StatusBadge status="online" label="Auto-start" size="sm" />
				{/if}
			</div>
			{#if workers.length > 0}
				<TimelineChart items={workers} />
			{:else}
				<p class="text-sm text-text-secondary">No daemon workers configured</p>
			{/if}
		</div>

		<!-- Learning Config -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Learning Config</h2>
			{#if learning}
				<div class="grid grid-cols-2 gap-3">
					<MetricCard
						label="Auto-Train"
						value={learning.autoTrain ? 'Enabled' : 'Disabled'}
						accent={learning.autoTrain ? 'green' : 'red'}
					/>
					<MetricCard
						label="Pattern Types"
						value={learning.patterns?.length ?? 0}
						subtitle={learning.patterns?.join(', ') ?? 'none'}
						accent="purple"
					/>
					{#if learning.retention}
						<MetricCard
							label="Short-Term"
							value={learning.retention.shortTerm ?? '--'}
							subtitle="Retention window"
							accent="cyan"
						/>
						<MetricCard
							label="Long-Term"
							value={learning.retention.longTerm ?? '--'}
							subtitle="Retention window"
							accent="blue"
						/>
					{/if}
				</div>
			{:else}
				<p class="text-sm text-text-secondary">No learning configuration found</p>
			{/if}
		</div>
	</div>
</div>
