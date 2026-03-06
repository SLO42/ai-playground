<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	let { data }: { data: PageData } = $props();

	let loading = $state(false);
	let error = $state<string | null>(data.loadError ?? null);

	const statusDots: Record<string, string> = {
		connected: 'bg-accent-green',
		disconnected: 'bg-accent-red',
		connecting: 'bg-accent-yellow'
	};

	const typeIcons: Record<string, string> = {
		twitch: '📺',
		discord: '💬',
		telegram: '✈️'
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
			<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
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
		<MetricCard label="Total Channels" value={data.summary.total} accent="blue" />
		<MetricCard label="Connected" value={data.summary.connected} accent="green" />
		<MetricCard label="Messages" value={data.summary.messages.toLocaleString()} accent="cyan" />
		<MetricCard label="Active Users" value={data.summary.users} accent="purple" />
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
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Channels</h2>
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
							<div class="flex justify-between">
								<div class="h-3 w-12 rounded bg-bg-tertiary"></div>
								<div class="h-3 w-14 rounded bg-bg-tertiary"></div>
							</div>
						</div>
						<div class="flex gap-2 mt-3 pt-3 border-t border-border">
							<div class="flex-1 h-7 rounded bg-bg-tertiary"></div>
							<div class="h-7 w-20 rounded bg-bg-tertiary"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if !error && data.channels.length === 0 && data.typeFilter}
			<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-10 text-center">
				<div class="text-4xl mb-3 opacity-40">🔍</div>
				<p class="text-text-primary text-sm font-medium">No {data.typeFilter} channels found</p>
				<p class="text-text-secondary text-xs mt-2 max-w-xs mx-auto">No channels match the current filter. Try a different type or clear the filter.</p>
				<button onclick={() => filterByType('')} class="mt-4 px-4 py-2 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
					Clear Filter
				</button>
			</div>
		{:else if !error && data.channels.length === 0}
			<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-10 text-center">
				<div class="text-4xl mb-3 opacity-40">📡</div>
				<p class="text-text-primary text-sm font-medium">No channels connected</p>
				<p class="text-text-secondary text-xs mt-2 max-w-xs mx-auto">Connect a messaging channel like Twitch, Discord, or Telegram to start receiving messages in this project.</p>
				<button class="mt-4 px-4 py-2 text-xs bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
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
							<span class="text-text-secondary">Messages</span>
							<span class="font-mono text-text-primary">{channel.messages}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Uptime</span>
							<span class="font-mono text-text-primary">{channel.uptime}</span>
						</div>
					</div>
					<div class="flex gap-2 mt-3 pt-3 border-t border-border">
						<button class="flex-1 px-2 py-1.5 text-xs bg-bg-tertiary text-text-secondary rounded hover:text-text-primary transition-colors">
							Configure
						</button>
						{#if channel.status === 'connected'}
							<button class="px-2 py-1.5 text-xs bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors">
								Disconnect
							</button>
						{:else}
							<button class="px-2 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors">
								Connect
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
		{/if}
	</div><!-- /channel cards -->

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

	<!-- DM Pairing Policy -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">DM Pairing Policy</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Mode</p>
					<p class="font-mono text-accent-blue">{data.dmPolicy.mode}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Approval</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.approvalRequired ? 'Required' : 'Auto'}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Timeout</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.pairingTimeout}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Max Sessions</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.maxSessions}</p>
				</div>
			</div>
		</div>
	</div>

	<!-- Allowlist -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Allowlist</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-left">
				<thead>
					<tr class="border-b border-border text-xs text-text-secondary uppercase">
						<th class="px-4 py-2 font-medium">Username</th>
						<th class="px-4 py-2 font-medium">Platform</th>
						<th class="px-4 py-2 font-medium">Role</th>
						<th class="px-4 py-2 font-medium">Added</th>
					</tr>
				</thead>
				<tbody>
					{#each data.allowlist as entry}
						<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
							<td class="px-4 py-3 text-sm font-mono text-text-primary">{entry.username}</td>
							<td class="px-4 py-3 text-sm text-text-secondary">{entry.platform}</td>
							<td class="px-4 py-3"><span class="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue">{entry.role}</span></td>
							<td class="px-4 py-3 text-sm text-text-secondary">{entry.added}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="px-4 py-6 text-center text-sm text-text-secondary">No users in allowlist</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Recent Messages -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Messages</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-left">
				<thead>
					<tr class="border-b border-border text-xs text-text-secondary uppercase">
						<th class="px-4 py-2 font-medium w-24">Channel</th>
						<th class="px-4 py-2 font-medium w-28">User</th>
						<th class="px-4 py-2 font-medium">Message</th>
						<th class="px-4 py-2 font-medium text-right w-20">Time</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentMessages as msg}
						<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
							<td class="px-4 py-3"><span class="text-xs px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{msg.channel}</span></td>
							<td class="px-4 py-3 text-sm font-mono text-accent-cyan">{msg.user}</td>
							<td class="px-4 py-3 text-sm text-text-primary">{msg.message}</td>
							<td class="px-4 py-3 text-xs text-text-secondary text-right">{msg.time}</td>
						</tr>
					{:else}
						<tr><td colspan="4" class="px-4 py-6 text-center text-sm text-text-secondary">No recent messages</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
