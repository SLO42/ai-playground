<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiFetch } from '$lib/api-client.js';
	import { servicesStore } from '$lib/stores/services.js';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';
	import type { Service, ServiceAction } from '$lib/types/services.js';

	const HAS_LOGS = new Set(['openclaw', 'claude-flow']);

	let { data }: { data: PageData } = $props();

	// Merge SSR data with live store — prefer store once connected
	let liveServices = $derived($servicesStore.connected ? $servicesStore.services : data.services);
	let liveTimestamp = $derived($servicesStore.timestamp);
	let storeError = $derived($servicesStore.error);
	let isLoading_ = $derived(!$servicesStore.connected && !storeError && liveServices.length === 0);

	let stats = $derived({
		running: liveServices.filter((s: Service) => s.status === 'running').length,
		stopped: liveServices.filter((s: Service) => s.status === 'stopped').length,
		errored: liveServices.filter((s: Service) => s.status === 'errored').length,
		total: liveServices.length
	});

	let loadingActions: Record<string, boolean> = $state({});

	// Filtering + Pagination
	let statusFilter = $state<'all' | 'running' | 'stopped' | 'errored'>('all');
	let search = $state('');
	let page = $state(1);
	const perPage = 10;

	const filteredServices = $derived(
		liveServices
			.filter((s: Service) => statusFilter === 'all' || s.status === statusFilter)
			.filter((s: Service) =>
				!search ||
				s.name.toLowerCase().includes(search.toLowerCase()) ||
				s.type.toLowerCase().includes(search.toLowerCase()) ||
				s.id.toLowerCase().includes(search.toLowerCase())
			)
	);

	const totalFiltered = $derived(filteredServices.length);
	const totalPages = $derived(Math.max(1, Math.ceil(totalFiltered / perPage)));
	const pagedServices = $derived(filteredServices.slice((page - 1) * perPage, page * perPage));

	const pageNumbers = $derived(() => {
		const pages: number[] = [];
		const delta = 2;
		for (let i = 1; i <= totalPages; i++) {
			if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) {
				pages.push(i);
			}
		}
		return pages;
	});

	// Reset page when filters change
	$effect(() => {
		statusFilter; search;
		page = 1;
	});

	const statusColors: Record<string, string> = {
		running: 'text-accent-green',
		stopped: 'text-text-secondary',
		errored: 'text-accent-red'
	};

	const statusDots: Record<string, string> = {
		running: 'bg-accent-green',
		stopped: 'bg-text-secondary',
		errored: 'bg-accent-red'
	};

	const statusLabels: Record<string, string> = {
		running: 'Running',
		stopped: 'Stopped',
		errored: 'Errored'
	};

	function timeAgo(iso: string | null): string {
		if (!iso) return '';
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 5) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		return `${Math.floor(diff / 60)}m ago`;
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
				// Delay refresh to let the process start/stop
				setTimeout(() => servicesStore.refresh(), 2000);
			} else {
				notifications.push('error', 'Service Action Failed', result.message);
			}
		} catch (e) {
			notifications.push('error', 'Service Action Failed', e instanceof Error ? e.message : 'Unknown error');
		} finally {
			loadingActions[key] = false;
		}
	}

	function isLoading(serviceId: string, action: string): boolean {
		return !!loadingActions[`${serviceId}-${action}`];
	}

	onMount(() => servicesStore.start());
	onDestroy(() => servicesStore.stop());
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Services</h1>
			<p class="text-sm text-text-secondary mt-1">
				Manage MCP servers, project services, and background processes{#if totalPages > 1} — page {page} of {totalPages}{/if}
			</p>
		</div>
		<div class="flex items-center gap-3">
			{#if liveTimestamp}
				<span class="text-xs text-text-secondary">Updated {timeAgo(liveTimestamp)}</span>
			{/if}
			<button
				onclick={() => servicesStore.refresh()}
				class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors"
			>
				Refresh
			</button>
		</div>
	</div>

	<!-- Stat Cards -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Running" value={stats.running} accent="green" />
		<MetricCard label="Stopped" value={stats.stopped} accent="yellow" />
		<MetricCard label="Errored" value={stats.errored} accent="red" />
		<MetricCard label="Total Services" value={stats.total} accent="blue" />
	</div>

	<!-- Search + Filters -->
	<div class="flex items-center gap-3">
		<input
			type="text"
			placeholder="Search services..."
			bind:value={search}
			class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
		/>
		<div class="flex gap-1">
			{#each ['all', 'running', 'stopped', 'errored'] as f}
				<button
					class="px-3 py-2 text-xs rounded-md border transition-colors
						{statusFilter === f
						? 'bg-accent-blue text-white border-accent-blue'
						: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
					onclick={() => (statusFilter = f as typeof statusFilter)}
				>
					{f.charAt(0).toUpperCase() + f.slice(1)}
				</button>
			{/each}
		</div>
	</div>

	{#if isLoading_}
		<!-- Loading State -->
		<div class="flex flex-col items-center justify-center py-16 px-4">
			<div class="w-16 h-16 rounded-full bg-bg-secondary border border-border flex items-center justify-center mb-4 animate-pulse">
				<svg class="w-8 h-8 text-text-secondary animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
			</div>
			<h2 class="text-lg font-semibold text-text-primary mb-1">Detecting services...</h2>
			<p class="text-sm text-text-secondary text-center max-w-md">
				Scanning for running MCP servers, daemons, and background processes.
			</p>
		</div>
	{:else if storeError && liveServices.length === 0}
		<!-- Error State -->
		<div class="flex flex-col items-center justify-center py-16 px-4">
			<div class="w-16 h-16 rounded-full bg-accent-red/10 border border-accent-red/20 flex items-center justify-center mb-4">
				<svg class="w-8 h-8 text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold text-text-primary mb-1">Failed to load services</h2>
			<p class="text-sm text-text-secondary text-center max-w-md mb-6">
				{storeError}
			</p>
			<button
				onclick={() => servicesStore.refresh()}
				class="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				Retry
			</button>
		</div>
	{:else if pagedServices.length === 0 && liveServices.length === 0}
		<!-- Empty State: No services at all -->
		<div class="flex flex-col items-center justify-center py-16 px-4">
			<div class="w-16 h-16 rounded-full bg-bg-secondary border border-border flex items-center justify-center mb-4">
				<svg class="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0h.375a2.625 2.625 0 0 1 0 5.25H3.375a2.625 2.625 0 0 1 0-5.25H4.5" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold text-text-primary mb-1">No services configured</h2>
			<p class="text-sm text-text-secondary text-center max-w-md mb-6">
				Services let you manage MCP servers, background processes, and project daemons from a single dashboard.
			</p>
			<button
				onclick={() => goto('/services/new')}
				class="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/90 transition-colors"
			>
				Add a Service
			</button>
		</div>
	{:else if pagedServices.length === 0}
		<!-- Empty State: No results matching filters -->
		<div class="flex flex-col items-center justify-center py-16 px-4">
			<div class="w-16 h-16 rounded-full bg-bg-secondary border border-border flex items-center justify-center mb-4">
				<svg class="w-8 h-8 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
				</svg>
			</div>
			<h2 class="text-lg font-semibold text-text-primary mb-1">No matching services</h2>
			<p class="text-sm text-text-secondary text-center max-w-md mb-6">
				No services match your current filters. Try changing the status filter or clearing the search.
			</p>
			<button
				onclick={() => { statusFilter = 'all'; search = ''; }}
				class="px-4 py-2 text-sm font-medium text-text-primary bg-bg-secondary border border-border rounded-lg hover:bg-bg-tertiary transition-colors"
			>
				Clear Filters
			</button>
		</div>
	{:else}
		<!-- Stale data warning -->
		{#if storeError}
			<div class="flex items-center gap-3 px-4 py-3 bg-accent-yellow/10 border border-accent-yellow/20 rounded-lg text-sm">
				<svg class="w-5 h-5 text-accent-yellow shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
				</svg>
				<span class="text-text-primary">Unable to refresh — showing last known state.</span>
				<button
					onclick={() => servicesStore.refresh()}
					class="ml-auto text-xs font-medium text-accent-blue hover:underline"
				>
					Retry
				</button>
			</div>
		{/if}

		<!-- Active Services label -->
		<div class="text-xs text-text-secondary uppercase tracking-wider">Active Services</div>

		<!-- Service List -->
		<div class="space-y-2">
			{#each pagedServices as service (service.id)}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-4">
						<!-- Status + Name -->
						<div class="flex items-center gap-3 min-w-0 flex-1">
							<span class="w-2.5 h-2.5 rounded-full shrink-0 {statusDots[service.status]}"></span>
							<div class="min-w-0">
								<a href="/services/{service.id}" class="text-sm font-medium text-text-primary hover:text-accent-blue transition-colors">{service.name}</a>
								<div class="text-xs text-text-secondary">{service.type}</div>
								<div class="text-xs font-mono text-text-secondary truncate">{service.configPath}</div>
							</div>
						</div>

						<!-- PID / Port -->
						<div class="hidden md:flex items-center gap-6 text-xs shrink-0">
							{#if service.pid}
								<div>
									<span class="text-text-secondary">PID</span>
									<span class="text-text-primary font-mono ml-1">{service.pid}</span>
								</div>
							{/if}
							{#if service.port}
								<div>
									<span class="text-text-secondary">Port</span>
									<span class="text-text-primary font-mono ml-1">{service.port}</span>
								</div>
							{/if}
							{#if service.ram}
								<div>
									<span class="text-text-secondary">RAM</span>
									<span class="text-text-primary font-mono ml-1">{service.ram}</span>
								</div>
							{/if}
						</div>

						<!-- Status + Actions -->
						<div class="flex items-center gap-2 shrink-0">
							<span class="text-xs font-medium {statusColors[service.status]}">{statusLabels[service.status]}</span>

							{#if service.status === 'running'}
								<button
									onclick={() => handleAction(service.id, 'stop')}
									disabled={isLoading(service.id, 'stop')}
									class="px-2 py-1 text-xs text-accent-red border border-accent-red/30 rounded hover:bg-accent-red/10 transition-colors disabled:opacity-50"
								>
									{isLoading(service.id, 'stop') ? '...' : 'Stop'}
								</button>
								<button
									onclick={() => handleAction(service.id, 'restart')}
									disabled={isLoading(service.id, 'restart')}
									class="px-2 py-1 text-xs text-accent-yellow border border-accent-yellow/30 rounded hover:bg-accent-yellow/10 transition-colors disabled:opacity-50"
								>
									{isLoading(service.id, 'restart') ? '...' : 'Restart'}
								</button>
							{:else if service.status === 'stopped'}
								<button
									onclick={() => handleAction(service.id, 'start')}
									disabled={isLoading(service.id, 'start')}
									class="px-2 py-1 text-xs text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors disabled:opacity-50"
								>
									{isLoading(service.id, 'start') ? '...' : 'Start'}
								</button>
							{:else if service.status === 'errored'}
								<button
									onclick={() => handleAction(service.id, 'restart')}
									disabled={isLoading(service.id, 'restart')}
									class="px-2 py-1 text-xs text-accent-yellow border border-accent-yellow/30 rounded hover:bg-accent-yellow/10 transition-colors disabled:opacity-50"
								>
									{isLoading(service.id, 'restart') ? '...' : 'Force Restart'}
								</button>
							{/if}

							<button
									onclick={() => goto(`/services/${service.id}/logs`)}
									disabled={!HAS_LOGS.has(service.id)}
									class="px-2 py-1 text-xs border rounded transition-colors
										{HAS_LOGS.has(service.id)
											? 'text-text-secondary border-border hover:bg-bg-tertiary'
											: 'text-text-secondary/40 border-border/40 cursor-not-allowed'}"
								>Logs</button>
							<button
									onclick={() => goto(`/services/${service.id}/config`)}
									class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors"
								>Config</button>
						</div>
					</div>

					{#if service.errorMessage}
						<div class="mt-2 px-3 py-1.5 rounded text-xs
							{service.status === 'running'
								? 'bg-accent-cyan/10 border border-accent-cyan/20 text-accent-cyan'
								: 'bg-accent-red/10 border border-accent-red/20 text-accent-red'}">
							{#if service.uptime}<span class="text-text-secondary">Uptime: {service.uptime}</span> — {/if}{service.errorMessage}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		{#if totalPages > 1}
			<nav class="flex items-center justify-center gap-1 pt-2">
				<button
					disabled={page <= 1}
					class="px-3 py-2 text-xs rounded-md border transition-colors {page <= 1 ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
					onclick={() => (page = Math.max(1, page - 1))}
				>
					Prev
				</button>

				{#each pageNumbers() as pageNum, i}
					{@const prev = i > 0 ? pageNumbers()[i - 1] : 0}
					{#if prev && pageNum - prev > 1}
						<span class="px-1 text-xs text-text-secondary">…</span>
					{/if}
					<button
						class="px-3 py-2 text-xs rounded-md border transition-colors {pageNum === page ? 'bg-accent-blue text-white border-accent-blue' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
						onclick={() => (page = pageNum)}
					>
						{pageNum}
					</button>
				{/each}

				<button
					disabled={page >= totalPages}
					class="px-3 py-2 text-xs rounded-md border transition-colors {page >= totalPages ? 'bg-bg-secondary text-text-secondary/40 border-border cursor-not-allowed' : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary hover:bg-bg-tertiary'}"
					onclick={() => (page = Math.min(totalPages, page + 1))}
				>
					Next
				</button>
			</nav>
		{/if}
	{/if}
</div>
