<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const statusColors: Record<string, string> = {
		pass: 'bg-accent-green',
		warn: 'bg-accent-yellow',
		fail: 'bg-accent-red'
	};

	const statusLabels: Record<string, string> = {
		pass: 'Pass',
		warn: 'Warning',
		fail: 'Fail'
	};

	let passed = $derived(data.checks.filter((c) => c.status === 'pass').length);
	let warnings = $derived(data.checks.filter((c) => c.status === 'warn').length);
	let failed = $derived(data.checks.filter((c) => c.status === 'fail').length);
</script>

<div class="space-y-6">
	<PageHeader title="System Diagnostics" subtitle="Health checks for local tools, services, and dependencies" />

	<!-- Summary -->
	<div class="flex items-center gap-4 text-sm">
		<span class="text-accent-green font-medium">{passed} passed</span>
		{#if warnings > 0}
			<span class="text-accent-yellow font-medium">{warnings} warnings</span>
		{/if}
		{#if failed > 0}
			<span class="text-accent-red font-medium">{failed} failed</span>
		{/if}
		<a
			href="/diagnostics"
			data-sveltekit-reload
			class="ml-auto text-xs text-accent-blue hover:underline"
		>Re-run Checks</a>
	</div>

	<!-- Checks list -->
	<div class="bg-bg-secondary border border-border rounded-lg divide-y divide-border">
		{#each data.checks as check}
			<div class="flex items-start gap-3 px-4 py-3">
				<span
					class="mt-1.5 w-2.5 h-2.5 rounded-full flex-shrink-0 {statusColors[check.status]}"
					title={statusLabels[check.status]}
				></span>
				<div class="flex-1 min-w-0">
					<div class="flex items-baseline gap-2">
						<span class="text-sm font-medium text-text-primary">{check.name}</span>
						<span class="text-xs text-text-secondary truncate">{check.detail}</span>
					</div>
					{#if check.fix && check.status !== 'pass'}
						<p class="text-xs text-text-tertiary mt-0.5">{check.fix}</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<!-- Build Output -->
	{#if data.buildInfo}
		<div class="mt-8">
			<h2 class="text-sm font-bold text-text-primary mb-3">Build Output</h2>
			<div class="space-y-1">
				<div class="flex items-center justify-between py-2 px-3 bg-bg-secondary rounded-lg">
					<span class="text-sm text-text-primary">dashboard/build</span>
					<span class="text-xs text-text-secondary font-mono">
						{data.buildInfo.exists ? `${data.buildInfo.sizeMB} MB` : 'not built'}
					</span>
				</div>
			</div>
		</div>
	{/if}

	<!-- Data Stores -->
	{#if data.databases?.length}
		<div class="mt-8">
			<h2 class="text-sm font-bold text-text-primary mb-3">Data Stores</h2>
			<div class="space-y-1">
				{#each data.databases as db}
					<div class="flex items-center justify-between py-2 px-3 bg-bg-secondary rounded-lg">
						<span class="text-sm text-text-primary">{db.name}</span>
						<span class="text-xs text-text-secondary font-mono">
							{db.exists ? `${db.sizeKB} KB` : 'not created'}
						</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
