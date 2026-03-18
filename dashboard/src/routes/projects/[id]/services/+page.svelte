<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let actionLoading = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	const statusColors: Record<string, string> = {
		running: 'bg-accent-green/20 text-accent-green',
		stopped: 'bg-accent-red/20 text-accent-red',
		unknown: 'bg-accent-yellow/20 text-accent-yellow'
	};

	const statusDotColors: Record<string, string> = {
		running: 'bg-accent-green',
		stopped: 'bg-accent-red',
		unknown: 'bg-accent-yellow'
	};

	const sourceColors: Record<string, string> = {
		detected: 'bg-accent-blue/20 text-accent-blue',
		config: 'bg-accent-purple/20 text-accent-purple',
		global: 'bg-accent-cyan/20 text-accent-cyan'
	};

	async function toggleService(serviceId: string, action: 'start' | 'stop') {
		actionLoading = serviceId;
		actionError = null;
		try {
			const res = await fetch(`/api/services/${serviceId}/${action}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ projectId: data.projectId })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Request failed' }));
				actionError = body.error ?? `Failed to ${action} service`;
			}
		} catch (e) {
			actionError = e instanceof Error ? e.message : `Failed to ${action} service`;
		} finally {
			actionLoading = null;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Services</h1>
			<p class="text-sm text-text-secondary mt-1">
				Services and infrastructure for {data.projectName}
			</p>
		</div>
	</div>

	<!-- Error Banner -->
	{#if actionError}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
			<span class="flex-1">{actionError}</span>
			<button onclick={() => actionError = null} class="text-accent-red/70 hover:text-accent-red transition-colors">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Total" value={data.stats.total} accent="blue" />
		<MetricCard label="With Port" value={data.stats.withPort} accent="cyan" />
		<MetricCard label="Detected" value={data.stats.detected} accent="green" />
		<MetricCard label="Global" value={data.stats.global} accent="purple" />
	</div>

	<!-- Service Cards -->
	{#if data.services.length === 0}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No services detected</h2>
			<p class="text-text-secondary text-xs">
				Add services via <span class="font-mono text-accent-cyan">.playground/custom-services.json</span> or docker-compose
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
			{#each data.services as svc}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-2">
						<div class="flex items-center gap-2">
							<span class="w-2.5 h-2.5 rounded-full {statusDotColors[svc.status]}"></span>
							<h3 class="text-sm font-bold text-text-primary">{svc.name}</h3>
						</div>
						<span class="text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wider {statusColors[svc.status]}">
							{svc.status}
						</span>
					</div>

					<div class="flex items-center gap-2 mb-2">
						<span class="text-[10px] px-1.5 py-0.5 rounded {sourceColors[svc.source]}">{svc.source}</span>
						<span class="text-xs text-text-secondary">{svc.type}</span>
					</div>

					<div class="flex items-center gap-6 mt-3 pt-3 border-t border-border">
						<div>
							<p class="text-[10px] text-text-secondary uppercase">Port</p>
							<p class="text-sm font-mono text-text-primary">{svc.port ?? '---'}</p>
						</div>
						{#if svc.command}
							<div class="flex-1 min-w-0">
								<p class="text-[10px] text-text-secondary uppercase">Command</p>
								<p class="text-xs font-mono text-text-secondary truncate" title={svc.command}>{svc.command}</p>
							</div>
						{/if}
						<div class="ml-auto flex gap-2">
							{#if svc.status === 'running'}
								<button
									onclick={() => toggleService(svc.id, 'stop')}
									disabled={actionLoading === svc.id}
									class="p-1.5 rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors disabled:opacity-50"
									title="Stop"
								>
									&#x25A0;
								</button>
							{:else}
								<button
									onclick={() => toggleService(svc.id, 'start')}
									disabled={actionLoading === svc.id}
									class="p-1.5 rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-50"
									title="Start"
								>
									&#x25B6;
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Package Scripts -->
	{#if Object.keys(data.scripts).length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Available Scripts</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each Object.entries(data.scripts) as [name, cmd]}
					<div class="flex items-center gap-4 px-4 py-2.5 border-b border-border last:border-0">
						<span class="text-sm font-mono text-accent-blue shrink-0 w-28">{name}</span>
						<span class="text-xs font-mono text-text-secondary truncate flex-1" title={cmd}>{cmd}</span>
						<button
							class="text-[10px] px-2 py-1 rounded bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/80 transition-colors shrink-0"
						>
							Run
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
