<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiGet, apiPost } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type TabFilter = 'all' | 'task' | 'service' | 'agent' | 'chat' | 'memory' | 'model' | 'system';
	let activeTab = $state<TabFilter>('all');

	let notifications = $state(data.notifications);
	let stats = $state(data.stats);

	let filtered = $derived(
		activeTab === 'all'
			? notifications
			: notifications.filter((n) => n.category === activeTab)
	);

	// Live sync: insert notifications directly from SSE stream
	let sseSource: EventSource | null = null;
	let destroyed = false;
	let streamConnected = $state(false);

	async function refreshNotifications() {
		const body = await apiGet<{ notifications: typeof notifications; stats: typeof stats }>('/api/notifications?limit=100', { silent: true, timeout: 5000 });
		if (body) {
			notifications = body.notifications;
			stats = body.stats;
		}
	}

	function connectSSE() {
		if (typeof EventSource === 'undefined' || destroyed) return;

		sseSource?.close();
		sseSource = new EventSource('/api/notifications/stream');

		sseSource.onopen = () => {
			streamConnected = true;
		};

		sseSource.onmessage = (event) => {
			try {
				const notif = JSON.parse(event.data);
				// Insert at front if not already present
				if (!notifications.some((n) => n.id === notif.id)) {
					notifications = [notif, ...notifications];
				} else {
					// Update existing (stacked notification)
					notifications = notifications.map((n) => n.id === notif.id ? notif : n);
				}
				// Refresh stats
				stats = {
					...stats,
					total: notifications.length,
					unread: notifications.filter((n: any) => !n.read).length,
					critical: notifications.filter((n: any) => n.severity === 'critical' && !n.read).length,
					alerts: notifications.filter((n: any) => (n.severity === 'critical' || n.severity === 'warning') && !n.read).length
				};
			} catch {
				// skip malformed
			}
		};

		sseSource.onerror = () => {
			streamConnected = false;
			sseSource?.close();
			sseSource = null;
			if (!destroyed) {
				setTimeout(connectSSE, 5000);
			}
		};
	}

	onMount(() => {
		refreshNotifications();
		connectSSE();
	});

	onDestroy(() => {
		destroyed = true;
		sseSource?.close();
		sseSource = null;
	});

	const severityDots: Record<string, string> = {
		critical: 'bg-accent-red',
		warning: 'bg-accent-yellow',
		info: 'bg-accent-blue',
		success: 'bg-green-400'
	};

	const tabs: { label: string; value: TabFilter }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'Tasks', value: 'task' },
		{ label: 'Services', value: 'service' },
		{ label: 'Agents', value: 'agent' },
		{ label: 'Chat', value: 'chat' },
		{ label: 'Memory', value: 'memory' },
		{ label: 'Models', value: 'model' },
		{ label: 'System', value: 'system' }
	];

	async function markRead(id: string) {
		await apiPost('/api/notifications', { action: 'mark_read', id }, { silent: true });
		notifications = notifications.map((n) => n.id === id ? { ...n, read: true } : n);
		stats = { ...stats, unread: Math.max(0, stats.unread - 1) };
	}

	async function markAllRead() {
		await apiPost('/api/notifications', { action: 'mark_all_read' }, { silent: true });
		notifications = notifications.map((n) => ({ ...n, read: true }));
		stats = { ...stats, unread: 0, critical: 0, alerts: 0 };
	}

	async function dismissNotif(id: string) {
		await apiPost('/api/notifications', { action: 'dismiss', id }, { silent: true });
		notifications = notifications.filter((n) => n.id !== id);
		stats = {
			...stats,
			total: Math.max(0, stats.total - 1),
			unread: notifications.filter((n: any) => !n.read).length,
			critical: notifications.filter((n: any) => n.severity === 'critical' && !n.read).length,
			alerts: notifications.filter((n: any) => (n.severity === 'critical' || n.severity === 'warning') && !n.read).length
		};
	}

	function timeAgo(ts: string): string {
		const diff = Date.now() - new Date(ts).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}
</script>

<svelte:head>
	<title>Notifications — ai-playground</title>
</svelte:head>

<div class="space-y-6">
	<div class="flex items-start justify-between">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-2xl font-bold text-text-primary">Notifications</h1>
				{#if streamConnected}
					<span class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 text-[10px] font-medium">
						<span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
						Live
					</span>
				{:else}
					<span class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-secondary text-text-secondary text-[10px] font-medium">
						<span class="w-1.5 h-1.5 rounded-full bg-text-secondary"></span>
						Polling
					</span>
				{/if}
			</div>
			<p class="text-sm text-text-secondary mt-1">Task updates, service alerts, agent events, and system notifications</p>
		</div>
		<div class="flex items-center gap-2">
			<button
				onclick={markAllRead}
				class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors"
			>
				Mark All Read
			</button>
		</div>
	</div>

	<div class="flex items-center gap-2 flex-wrap">
		{#each tabs as tab}
			<button
				class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors {activeTab === tab.value ? 'bg-accent-blue text-white' : 'text-text-secondary hover:bg-bg-secondary'}"
				onclick={() => (activeTab = tab.value)}
			>
				{tab.label}
				{#if tab.value === 'all' && stats.unread > 0}
					<span class="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-accent-red text-[10px] text-white">{stats.unread}</span>
				{/if}
			</button>
		{/each}
	</div>

	<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Unread" value={stats.unread} subtitle="{stats.critical} critical" accent="red" />
		<MetricCard label="Today" value={stats.today} subtitle="notifications" accent="blue" />
		<MetricCard label="Active Tasks" value={stats.activeJobs} subtitle="pending attention" accent="green" />
		<MetricCard label="Alerts" value={stats.alerts} subtitle="warnings + critical" accent="yellow" />
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
		<div class="space-y-2">
			{#each filtered as notif (notif.id)}
				<div
					class="relative bg-bg-secondary border border-border rounded-lg p-4 flex items-start gap-3 transition-colors hover:bg-bg-secondary/80 group
						{!notif.read ? 'border-l-2 border-l-accent-blue' : ''}"
				>
					<button
						onclick={() => { if (!notif.read) markRead(notif.id); }}
						class="flex-1 flex items-start gap-3 text-left min-w-0"
					>
						<span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {severityDots[notif.severity] ?? 'bg-accent-blue'}"></span>
						<div class="flex-1 min-w-0">
							<div class="flex items-center justify-between gap-2 mb-1">
								<span class="text-sm font-medium text-text-primary">
									{notif.title}
									{#if notif.stackCount && notif.stackCount > 1}
										<span class="ml-1 text-[10px] text-text-secondary font-normal">({notif.stackCount}x)</span>
									{/if}
								</span>
								<span class="text-xs text-text-secondary shrink-0">{timeAgo(notif.timestamp)}</span>
							</div>
							<p class="text-xs text-text-secondary">{notif.message}</p>
							<div class="flex items-center gap-2 mt-1.5">
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary border border-border/50">{notif.category}</span>
								{#if notif.source}
									<span class="text-[10px] text-text-secondary">via {notif.source}</span>
								{/if}
								{#if notif.link}
									<a href={notif.link} onclick={(e) => e.stopPropagation()} class="text-[10px] text-accent-blue hover:underline">{notif.linkLabel ?? 'View'}</a>
								{/if}
							</div>
						</div>
					</button>
					<button
						onclick={() => dismissNotif(notif.id)}
						class="shrink-0 p-1 rounded text-text-secondary hover:text-accent-red hover:bg-bg-primary transition-colors opacity-0 group-hover:opacity-100"
						title="Dismiss"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
						</svg>
					</button>
				</div>
			{/each}
			{#if filtered.length === 0}
				<div class="flex flex-col items-center justify-center py-16 px-4" role="status" aria-label="No notifications">
					<svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 text-text-secondary/30 mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
						<path d="M13.73 21a2 2 0 0 1-3.46 0" />
						<line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="1.5" opacity="0.5" />
					</svg>
					<p class="text-sm font-medium text-text-primary mb-1">
						{#if activeTab !== 'all'}
							No {activeTab} notifications
						{:else}
							All caught up
						{/if}
					</p>
					<p class="text-xs text-text-secondary text-center max-w-xs">
						{#if activeTab !== 'all'}
							There are no notifications in the <span class="font-medium">{activeTab}</span> category right now.
							<button class="text-accent-blue hover:underline ml-1" onclick={() => (activeTab = 'all')}>View all</button>
						{:else}
							You have no notifications. New alerts, task updates, and system events will appear here.
						{/if}
					</p>
				</div>
			{/if}
		</div>

		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Preferences</h2>
			<div class="space-y-4">
				{#each data.preferences as pref}
					<div class="flex items-center justify-between">
						<p class="text-sm text-text-primary">{pref.type}</p>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" checked={pref.desktop || pref.sound} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
