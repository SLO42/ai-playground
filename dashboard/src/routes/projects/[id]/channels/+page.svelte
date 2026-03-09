<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	let loading = $state(false);
	let error = $state<string | null>(data.loadError ?? null);
	let showConnectModal = $state(false);
	let connectingId = $state<string | null>(null);

	const statusDots: Record<string, string> = {
		connected: 'bg-accent-green',
		disconnected: 'bg-accent-red',
		connecting: 'bg-accent-yellow'
	};

	const typeIcons: Record<string, string> = {
		twitch: '📺',
		discord: '💬',
		telegram: '✈️',
		whatsapp: '📱',
		imessage: '🍎',
		dashboard: '🖥️',
		custom: '🔌'
	};

	function getProjectId(): string {
		return $page.params.id;
	}

	async function navigatePage(newPage: number) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('page', String(newPage));
		loading = true;
		error = null;
		try {
			await goto(`?${params.toString()}`, { replaceState: true, invalidateAll: true });
		} catch {
			error = 'Failed to load page.';
		} finally {
			loading = false;
		}
	}

	async function filterByType(type: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (type) {
			params.set('type', type);
		} else {
			params.delete('type');
		}
		params.set('page', '1');
		loading = true;
		error = null;
		try {
			await goto(`?${params.toString()}`, { replaceState: true, invalidateAll: true });
		} catch {
			error = 'Failed to apply filter.';
		} finally {
			loading = false;
		}
	}

	async function refreshChannels() {
		loading = true;
		error = null;
		try {
			await goto($page.url.pathname + $page.url.search, { replaceState: true, invalidateAll: true });
		} catch {
			error = 'Network error — could not reach server.';
		} finally {
			loading = false;
		}
	}

	async function connectChannel(channelId: string, channelName: string) {
		connectingId = channelId;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/channels`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channelId, name: channelName })
			});
			const result = await res.json();
			if (!res.ok) {
				error = result.error ?? 'Failed to connect channel';
				return;
			}
			showConnectModal = false;
			await invalidateAll();
		} catch {
			error = 'Network error connecting channel';
		} finally {
			connectingId = null;
		}
	}

	async function disconnectChannel(channelId: string) {
		if (!confirm(`Disconnect ${channelId}?`)) return;
		loading = true;
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/channels`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channelId })
			});
			const result = await res.json();
			if (!res.ok) {
				error = result.error ?? 'Failed to disconnect';
				return;
			}
			await invalidateAll();
		} catch {
			error = 'Network error disconnecting channel';
		} finally {
			loading = false;
		}
	}

	async function toggleChannel(channelId: string, enabled: boolean) {
		try {
			const res = await fetch(`/api/projects/${getProjectId()}/channels`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channelId, enabled })
			});
			if (!res.ok) {
				const result = await res.json();
				error = result.error ?? 'Failed to update channel';
				return;
			}
			await invalidateAll();
		} catch {
			error = 'Network error updating channel';
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Channels</h1>
			<p class="text-sm text-text-secondary mt-1">Messaging channels connected to this project</p>
		</div>
		<div class="flex items-center gap-2">
			<button onclick={refreshChannels} disabled={loading} class="px-3 py-2 text-sm bg-bg-tertiary text-text-secondary rounded-lg hover:text-text-primary transition-colors disabled:opacity-40" title="Refresh channels">
				<svg class="h-4 w-4 {loading ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 11-2.63-6.36" stroke-linecap="round"/>
					<path d="M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<button onclick={() => (showConnectModal = true)} class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
				+ Connect Channel
			</button>
		</div>
	</div>

	<!-- Error banner -->
	{#if error}
		<div class="flex items-center justify-between px-4 py-3 bg-accent-red/10 border border-accent-red/30 rounded-lg text-sm text-accent-red">
			<span>{error}</span>
			<div class="flex items-center gap-2">
				<button onclick={refreshChannels} disabled={loading} class="text-xs font-mono px-2 py-1 rounded bg-accent-red/20 hover:bg-accent-red/30 transition-colors disabled:opacity-40">retry</button>
				<button onclick={() => (error = null)} class="text-accent-red hover:text-accent-red/70 text-xs font-mono">dismiss</button>
			</div>
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Connected" value={data.summary.total} accent="blue" />
		<MetricCard label="Active" value={data.summary.connected} accent="green" />
		<MetricCard label="Available" value={data.summary.available} accent="cyan" />
		<MetricCard label="Messages" value={data.summary.messages.toLocaleString()} accent="purple" />
	</div>

	<!-- Type Filter -->
	{#if data.types.length > 1}
		<div class="flex items-center gap-2">
			<span class="text-xs text-text-secondary uppercase tracking-wider">Filter:</span>
			<button
				onclick={() => filterByType('')}
				class="px-2.5 py-1 text-xs rounded-lg transition-colors {!data.typeFilter ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
			>
				All
			</button>
			{#each data.types as type}
				<button
					onclick={() => filterByType(type)}
					class="px-2.5 py-1 text-xs rounded-lg transition-colors flex items-center gap-1 {data.typeFilter === type ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
				>
					<span>{typeIcons[type] ?? '📡'}</span>
					{type}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Channel Cards -->
	<div class="relative">
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Connected Channels</h2>
		{#if loading}
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
				{#each Array(3) as _}
					<div class="bg-bg-secondary border border-border rounded-lg p-4 animate-pulse">
						<div class="flex items-center justify-between mb-3">
							<div class="flex items-center gap-2">
								<div class="w-6 h-6 rounded bg-bg-tertiary"></div>
								<div class="h-4 w-24 rounded bg-bg-tertiary"></div>
							</div>
							<div class="flex items-center gap-1.5">
								<div class="w-2 h-2 rounded-full bg-bg-tertiary"></div>
								<div class="h-3 w-16 rounded bg-bg-tertiary"></div>
							</div>
						</div>
						<div class="space-y-2">
							<div class="flex justify-between">
								<div class="h-3 w-16 rounded bg-bg-tertiary"></div>
								<div class="h-3 w-10 rounded bg-bg-tertiary"></div>
							</div>
						</div>
						<div class="flex gap-2 mt-3 pt-3 border-t border-border">
							<div class="flex-1 h-7 rounded bg-bg-tertiary"></div>
							<div class="h-7 w-20 rounded bg-bg-tertiary"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if !error && data.channels.length === 0}
			<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-10 text-center">
				<div class="text-4xl mb-3 opacity-40">📡</div>
				<p class="text-text-primary text-sm font-medium">No channels connected</p>
				<p class="text-text-secondary text-xs mt-2 max-w-xs mx-auto">
					Connect a channel to enable messaging for this project.
					{#if data.availableChannels.length > 0}
						{data.availableChannels.length} channel{data.availableChannels.length === 1 ? '' : 's'} available.
					{/if}
				</p>
				<button onclick={() => (showConnectModal = true)} class="mt-4 px-4 py-2 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
					+ Connect Channel
				</button>
			</div>
		{:else if data.channels.length > 0}
		<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
			{#each data.channels as channel}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<span class="text-lg">{typeIcons[channel.type] ?? '📡'}</span>
							<span class="text-sm font-bold text-text-primary">{channel.name}</span>
						</div>
						<div class="flex items-center gap-1.5">
							<span class="w-2 h-2 rounded-full {statusDots[channel.status] ?? 'bg-bg-tertiary'}"></span>
							<span class="text-xs text-text-secondary">{channel.status}</span>
						</div>
					</div>
					<div class="space-y-2 text-xs">
						<div class="flex justify-between">
							<span class="text-text-secondary">Type</span>
							<span class="font-mono text-text-primary">{channel.type}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Uptime</span>
							<span class="font-mono text-text-primary">{channel.uptime}</span>
						</div>
						{#if channel.description}
							<p class="text-text-secondary pt-1 border-t border-border">{channel.description}</p>
						{/if}
					</div>
					<div class="flex gap-2 mt-3 pt-3 border-t border-border">
						<button
							onclick={() => toggleChannel(channel.id, !channel.enabled)}
							class="flex-1 px-2 py-1.5 text-xs rounded transition-colors {channel.enabled ? 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
						>
							{channel.enabled ? 'Enabled' : 'Disabled'}
						</button>
						<button
							onclick={() => disconnectChannel(channel.id)}
							class="px-2 py-1.5 text-xs bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors"
						>
							Disconnect
						</button>
					</div>
				</div>
			{/each}
		</div>
		{/if}
	</div>

	<!-- Pagination -->
	{#if data.pagination.totalPages > 1}
		<div class="flex items-center justify-between">
			<span class="text-xs text-text-secondary">
				Showing {(data.pagination.page - 1) * data.pagination.perPage + 1}–{Math.min(data.pagination.page * data.pagination.perPage, data.pagination.total)} of {data.pagination.total}
			</span>
			<div class="flex items-center gap-1">
				<button
					onclick={() => navigatePage(data.pagination.page - 1)}
					disabled={data.pagination.page <= 1 || loading}
					class="px-3 py-1.5 text-xs rounded bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Prev
				</button>
				{#each Array.from({ length: data.pagination.totalPages }, (_, i) => i + 1) as p}
					<button
						onclick={() => navigatePage(p)}
						disabled={loading}
						class="px-3 py-1.5 text-xs rounded transition-colors {p === data.pagination.page ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}"
					>
						{p}
					</button>
				{/each}
				<button
					onclick={() => navigatePage(data.pagination.page + 1)}
					disabled={data.pagination.page >= data.pagination.totalPages || loading}
					class="px-3 py-1.5 text-xs rounded bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Next
				</button>
			</div>
		</div>
	{/if}

	<!-- Available Channels -->
	{#if data.availableChannels.length > 0}
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Available Channels</h2>
			<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
				{#each data.availableChannels as ch}
					<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-4 opacity-70 hover:opacity-100 transition-opacity">
						<div class="flex items-center justify-between mb-2">
							<div class="flex items-center gap-2">
								<span class="text-lg">{typeIcons[ch.type] ?? '📡'}</span>
								<span class="text-sm font-bold text-text-primary">{ch.name}</span>
							</div>
							<span class="text-xs px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{ch.type}</span>
						</div>
						{#if ch.description}
							<p class="text-xs text-text-secondary mb-3">{ch.description}</p>
						{/if}
						<button
							onclick={() => connectChannel(ch.id, ch.name)}
							disabled={connectingId === ch.id}
							class="w-full px-3 py-1.5 text-xs bg-accent-blue/20 text-accent-blue rounded hover:bg-accent-blue/30 transition-colors disabled:opacity-40"
						>
							{connectingId === ch.id ? 'Connecting...' : '+ Connect'}
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Connect Channel Modal -->
{#if showConnectModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center">
		<!-- backdrop -->
		<button class="absolute inset-0 bg-black/50" onclick={() => (showConnectModal = false)} aria-label="Close"></button>
		<!-- modal -->
		<div class="relative bg-bg-primary border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6">
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-bold text-text-primary">Connect Channel</h2>
				<button onclick={() => (showConnectModal = false)} class="text-text-secondary hover:text-text-primary text-xl leading-none">&times;</button>
			</div>
			{#if data.availableChannels.length === 0}
				<div class="text-center py-8">
					<div class="text-3xl mb-2 opacity-40">📡</div>
					<p class="text-sm text-text-secondary">No channels available to connect.</p>
					<p class="text-xs text-text-secondary mt-1">All gateway channels are already connected, or no channel configs exist yet.</p>
				</div>
			{:else}
				<p class="text-sm text-text-secondary mb-4">Select a channel from the gateway to connect to this project.</p>
				<div class="space-y-2 max-h-80 overflow-y-auto">
					{#each data.availableChannels as ch}
						<div class="flex items-center justify-between p-3 bg-bg-secondary border border-border rounded-lg hover:border-accent-blue/50 transition-colors">
							<div class="flex items-center gap-3">
								<span class="text-xl">{typeIcons[ch.type] ?? '📡'}</span>
								<div>
									<p class="text-sm font-medium text-text-primary">{ch.name}</p>
									{#if ch.description}
										<p class="text-xs text-text-secondary">{ch.description}</p>
									{/if}
								</div>
							</div>
							<button
								onclick={() => connectChannel(ch.id, ch.name)}
								disabled={connectingId === ch.id}
								class="px-3 py-1.5 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors disabled:opacity-40 whitespace-nowrap"
							>
								{connectingId === ch.id ? 'Connecting...' : 'Connect'}
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
