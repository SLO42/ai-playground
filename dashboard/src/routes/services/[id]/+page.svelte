<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { notifications } from '$lib/stores/notifications.js';
	import { apiPost } from '$lib/api-client.js';
	import type { PageData } from './$types.js';
	import type { ServiceAction } from '$lib/types/services.js';

	let { data }: { data: PageData } = $props();

	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let autoRefresh = $state(true);
	let refreshing = $state(false);
	let lastRefresh = $state(new Date().toISOString());
	let loadingAction: string | null = $state(null);

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

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
			lastRefresh = new Date().toISOString();
		} finally {
			refreshing = false;
		}
	}

	function startAutoRefresh() {
		stopAutoRefresh();
		if (autoRefresh) {
			refreshTimer = setInterval(refresh, 10000);
		}
	}

	function stopAutoRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	function toggleAutoRefresh() {
		autoRefresh = !autoRefresh;
		if (autoRefresh) startAutoRefresh();
		else stopAutoRefresh();
	}

	async function handleAction(action: ServiceAction) {
		loadingAction = action;
		try {
			const result = await apiPost<{ success: boolean; message: string }>(`/api/services/${data.service.id}`, { action }, { silent: true });
			if (result?.success) {
				notifications.push('success', 'Service Action', result.message);
				setTimeout(refresh, 2000);
			} else {
				notifications.push('error', 'Action Failed', result?.message ?? 'Unknown error');
			}
		} catch (e: unknown) {
			const err = e as { message?: string };
			notifications.push('error', 'Action Failed', err.message ?? 'Unknown error');
		} finally {
			loadingAction = null;
		}
	}

	function timeAgo(iso: string): string {
		const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
		if (diff < 5) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		return `${Math.floor(diff / 60)}m ago`;
	}

	onMount(startAutoRefresh);
	onDestroy(stopAutoRefresh);
</script>

<div class="space-y-6">
	<!-- Health Status Banner -->
	<div class="bg-bg-secondary border border-border rounded-lg p-6">
		<div class="flex items-center justify-between mb-4">
			<div class="flex items-center gap-3">
				<span class="w-3 h-3 rounded-full {statusDots[data.service.status]}"></span>
				<span class="text-lg font-semibold {statusColors[data.service.status]}">
					{data.service.status === 'running' ? 'Healthy' : data.service.status === 'errored' ? 'Unhealthy' : 'Offline'}
				</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-xs text-text-secondary">
					{refreshing ? 'Refreshing...' : `Updated ${timeAgo(lastRefresh)}`}
				</span>
				<button
					onclick={toggleAutoRefresh}
					class="px-2 py-1 text-xs border rounded transition-colors
						{autoRefresh
							? 'text-accent-green border-accent-green/30 bg-accent-green/10'
							: 'text-text-secondary border-border hover:bg-bg-tertiary'}"
				>
					{autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
				</button>
				<button
					onclick={refresh}
					disabled={refreshing}
					class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors disabled:opacity-50"
				>
					Refresh
				</button>
			</div>
		</div>

		{#if data.service.errorMessage}
			<div class="mb-4 px-3 py-2 bg-accent-red/10 border border-accent-red/20 rounded text-xs text-accent-red">
				{data.service.errorMessage}
			</div>
		{/if}

		<!-- Service Details Grid -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
			<div>
				<p class="text-xs text-text-secondary mb-1">Port</p>
				<p class="text-sm font-mono text-text-primary">{data.service.port ?? '—'}</p>
			</div>
			<div>
				<p class="text-xs text-text-secondary mb-1">PID</p>
				<p class="text-sm font-mono text-text-primary">{data.service.pid ?? '—'}</p>
			</div>
			<div>
				<p class="text-xs text-text-secondary mb-1">Memory</p>
				<p class="text-sm font-mono text-text-primary">{data.service.ram ?? '—'}</p>
			</div>
			<div>
				<p class="text-xs text-text-secondary mb-1">Health Latency</p>
				<p class="text-sm font-mono text-text-primary">
					{data.service.latencyMs ? `${data.service.latencyMs}ms` : '—'}
				</p>
			</div>
		</div>
	</div>

	<!-- Actions -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<h2 class="text-sm font-medium text-text-primary mb-3">Actions</h2>
		<div class="flex gap-2">
			{#if data.service.status === 'running'}
				<button
					onclick={() => handleAction('restart')}
					disabled={!!loadingAction}
					class="px-3 py-1.5 text-xs font-medium text-accent-yellow border border-accent-yellow/30 rounded-lg hover:bg-accent-yellow/10 transition-colors disabled:opacity-50"
				>
					{loadingAction === 'restart' ? 'Restarting...' : 'Restart'}
				</button>
				<button
					onclick={() => handleAction('stop')}
					disabled={!!loadingAction}
					class="px-3 py-1.5 text-xs font-medium text-accent-red border border-accent-red/30 rounded-lg hover:bg-accent-red/10 transition-colors disabled:opacity-50"
				>
					{loadingAction === 'stop' ? 'Stopping...' : 'Stop'}
				</button>
			{:else if data.service.status === 'stopped'}
				<button
					onclick={() => handleAction('start')}
					disabled={!!loadingAction}
					class="px-3 py-1.5 text-xs font-medium text-accent-green border border-accent-green/30 rounded-lg hover:bg-accent-green/10 transition-colors disabled:opacity-50"
				>
					{loadingAction === 'start' ? 'Starting...' : 'Start'}
				</button>
			{:else if data.service.status === 'errored'}
				<button
					onclick={() => handleAction('restart')}
					disabled={!!loadingAction}
					class="px-3 py-1.5 text-xs font-medium text-accent-yellow border border-accent-yellow/30 rounded-lg hover:bg-accent-yellow/10 transition-colors disabled:opacity-50"
				>
					{loadingAction === 'restart' ? 'Restarting...' : 'Force Restart'}
				</button>
				<button
					onclick={() => handleAction('stop')}
					disabled={!!loadingAction}
					class="px-3 py-1.5 text-xs font-medium text-accent-red border border-accent-red/30 rounded-lg hover:bg-accent-red/10 transition-colors disabled:opacity-50"
				>
					{loadingAction === 'stop' ? 'Killing...' : 'Kill Process'}
				</button>
			{/if}
		</div>
	</div>

	<!-- Service Info -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<h2 class="text-sm font-medium text-text-primary mb-3">Service Info</h2>
		<dl class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
			<div>
				<dt class="text-text-secondary">ID</dt>
				<dd class="text-text-primary font-mono">{data.service.id}</dd>
			</div>
			<div>
				<dt class="text-text-secondary">Type</dt>
				<dd class="text-text-primary">{data.service.type}</dd>
			</div>
			<div>
				<dt class="text-text-secondary">Config Path</dt>
				<dd class="text-text-primary font-mono">{data.service.configPath}</dd>
			</div>
			{#if data.service.healthUrl}
				<div>
					<dt class="text-text-secondary">Health URL</dt>
					<dd class="text-text-primary font-mono">{data.service.healthUrl}</dd>
				</div>
			{/if}
		</dl>
	</div>
</div>
