<script lang="ts">
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { notifications } from '$lib/stores/notifications.js';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';
	import type { ServiceAction } from '$lib/types/services.js';

	let { data }: { data: PageData } = $props();

	let loadingActions: Record<string, boolean> = $state({});
	let searchQuery = $state('');

	function updateFilter(key: string, value: string) {
		const url = new URL($page.url);
		if (value) url.searchParams.set(key, value);
		else url.searchParams.delete(key);
		url.searchParams.set('page', '1');
		goto(url.toString(), { replaceState: true, invalidateAll: true });
	}

	async function handleAction(serviceId: string, action: ServiceAction) {
		const key = `${serviceId}-${action}`;
		loadingActions[key] = true;
		try {
			const res = await apiFetch(`/api/services/${serviceId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action })
			});
			const result = await res.json();
			if (result.success) {
				notifications.push('success', 'Service Action', result.message);
				setTimeout(() => invalidateAll(), 2000);
			} else {
				notifications.push('error', 'Service Action Failed', result.message);
			}
		} catch (e) {
			notifications.push('error', 'Service Action Failed', e instanceof Error ? e.message : 'Unknown error');
		} finally {
			loadingActions[key] = false;
		}
	}

	function isActionLoading(serviceId: string, action: string): boolean {
		return !!loadingActions[`${serviceId}-${action}`];
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Services</h1>
			<p class="text-sm text-text-secondary mt-1">Services configured for {data.projectName}</p>
		</div>
		<div class="flex gap-2">
			<button class="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors">
				Edit .mcp.json
			</button>
			<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
				+ Add Service
			</button>
		</div>
	</div>

	{#if data.error}
		<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3 text-sm text-accent-red">
			Failed to load services: {data.error}
		</div>
	{/if}

	<!-- Filters -->
	<div class="flex items-center gap-3">
		<input
			type="text"
			placeholder="Search services..."
			value={searchQuery}
			oninput={(e) => { searchQuery = e.currentTarget.value; }}
			onkeydown={(e) => { if (e.key === 'Enter') updateFilter('q', searchQuery); }}
			class="px-3 py-1.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue w-56"
		/>
		<select
			onchange={(e) => updateFilter('status', e.currentTarget.value)}
			class="px-3 py-1.5 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent-blue"
		>
			<option value="">All statuses</option>
			<option value="running">Running</option>
			<option value="stopped">Stopped</option>
			<option value="errored">Errored</option>
		</select>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-4">
		<MetricCard label="Running" value={data.summary.running} accent="green" />
		<MetricCard label="Stopped" value={data.summary.stopped} accent="red" />
		<MetricCard label="From Config" value={data.summary.fromConfig} accent="blue" />
		<MetricCard label="Manual" value={data.summary.manual} accent="purple" />
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="text-xs text-text-secondary uppercase tracking-wider mb-1">Config Source</p>
			{#each data.summary.configSource as src}
				<p class="text-xs font-mono text-accent-cyan">{src}</p>
			{/each}
		</div>
	</div>

	<!-- Service Cards -->
	{#if data.services.length === 0 && !data.error}
		<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
			<p class="text-text-secondary text-sm">No services found.</p>
		</div>
	{/if}
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		{#each data.services as svc}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-2">
					<div class="flex items-center gap-2">
						<span class="w-2.5 h-2.5 rounded-full {svc.status === 'running' ? 'bg-accent-green' : svc.status === 'errored' ? 'bg-accent-yellow' : 'bg-accent-red'}"></span>
						<h3 class="text-sm font-bold text-text-primary">{svc.name}</h3>
					</div>
					<span class="text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wider
						{svc.status === 'running' ? 'bg-accent-green/20 text-accent-green' : svc.status === 'errored' ? 'bg-accent-yellow/20 text-accent-yellow' : 'bg-accent-red/20 text-accent-red'}">
						{svc.status}
					</span>
				</div>
				{#if svc.configFile}
					<span class="text-[10px] font-mono text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded">{svc.configFile}</span>
				{/if}
				<p class="text-xs text-text-secondary mt-2">{svc.description}</p>

				<div class="flex items-center gap-6 mt-3 pt-3 border-t border-border">
					<div>
						<p class="text-[10px] text-text-secondary uppercase">Port</p>
						<p class="text-sm font-mono text-text-primary">{svc.port ?? '—'}</p>
					</div>
					<div>
						<p class="text-[10px] text-text-secondary uppercase">PID</p>
						<p class="text-sm font-mono text-text-primary">{svc.pid ?? '—'}</p>
					</div>
					<div>
						<p class="text-[10px] text-text-secondary uppercase">Uptime</p>
						<p class="text-sm font-mono text-text-primary">{svc.uptime ?? '—'}</p>
					</div>
					<div class="ml-auto flex gap-2">
						{#if svc.status === 'running'}
							<button
								onclick={() => handleAction(svc.id, 'restart')}
								disabled={isActionLoading(svc.id, 'restart')}
								class="p-1.5 rounded bg-bg-tertiary text-text-secondary hover:text-accent-yellow transition-colors disabled:opacity-50"
								title="Restart"
								aria-label="Restart {svc.name}"
							>
								{isActionLoading(svc.id, 'restart') ? '...' : '&#x21BA;'}
							</button>
							<button
								onclick={() => handleAction(svc.id, 'stop')}
								disabled={isActionLoading(svc.id, 'stop')}
								class="p-1.5 rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors disabled:opacity-50"
								title="Stop"
								aria-label="Stop {svc.name}"
							>
								{isActionLoading(svc.id, 'stop') ? '...' : '&#x25A0;'}
							</button>
						{:else}
							<button
								onclick={() => handleAction(svc.id, 'start')}
								disabled={isActionLoading(svc.id, 'start')}
								class="p-1.5 rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors disabled:opacity-50"
								title="Start"
								aria-label="Start {svc.name}"
							>
								{isActionLoading(svc.id, 'start') ? '...' : '&#x25B6;'}
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Pagination -->
	{#if data.pagination.totalPages > 1}
		<div class="flex items-center justify-between">
			<p class="text-xs text-text-secondary">
				Showing {(data.pagination.page - 1) * data.pagination.pageSize + 1}–{Math.min(data.pagination.page * data.pagination.pageSize, data.pagination.total)} of {data.pagination.total}
			</p>
			<div class="flex gap-1">
				{#each Array.from({ length: data.pagination.totalPages }, (_, i) => i + 1) as pg}
					<button
						onclick={() => updateFilter('page', String(pg))}
						class="px-2.5 py-1 text-xs rounded {pg === data.pagination.page ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
					>
						{pg}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Auto-Start Configuration -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Auto-Start Configuration</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.autoStart as item}
				<div class="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm text-text-primary font-medium">{item.name}</span>
					<span class="text-xs font-mono text-text-secondary">{item.config}</span>
					<button
						class="w-10 h-5 rounded-full transition-colors {item.enabled ? 'bg-accent-green' : 'bg-bg-tertiary'}"
					>
						<div class="w-4 h-4 bg-white rounded-full transition-transform {item.enabled ? 'translate-x-5' : 'translate-x-0.5'}"></div>
					</button>
					<span class="text-xs font-mono text-text-secondary w-8 text-center">{item.order ?? '—'}</span>
					<span class="text-xs font-mono text-text-secondary w-12 text-center">{item.delay ?? '—'}</span>
				</div>
			{/each}
		</div>
	</div>

	<!-- Recent Logs -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Service Logs</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 font-mono text-xs space-y-1">
			{#each data.logs as log}
				<div class="flex gap-4">
					<span class="text-text-secondary shrink-0">{log.time}</span>
					<span class="text-accent-cyan shrink-0">[{log.source}]</span>
					<span class="{log.level === 'error' ? 'text-accent-red' : 'text-accent-green'}">{log.message}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
