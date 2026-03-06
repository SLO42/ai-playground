<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiGet, apiPost, apiPut } from '$lib/api-client.js';
	import { badgeCount } from '$lib/stores/index.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type InboxStatus = 'awaiting' | 'active' | 'paused' | 'resolved' | 'info';
	type FilterType = 'all' | 'sessions' | 'notifications' | 'awaiting';
	type NotifCategory = 'all' | 'task' | 'service' | 'agent' | 'chat' | 'memory' | 'model' | 'system';

	let filter = $state<FilterType>('awaiting');
	let notifCategory = $state<NotifCategory>('all');
	let selectedId = $state<string | null>(null);

	// Live notification data (refreshed via SSE)
	let notifItems = $state(data.items.filter((i: any) => i.type === 'notification'));
	let notifStats = $state(data.notifStats);
	let notifTotal = $state(data.notifTotal);
	let notifOffset = $state(notifItems.length);
	let loadingMore = $state(false);
	let hasMore = $derived(notifOffset < notifTotal);

	// Merge live notifItems with session items from server data
	let sessionItems = $derived(data.items.filter((i: any) => i.type === 'session'));
	let allItems = $derived([...sessionItems, ...notifItems].sort((a: any, b: any) =>
		new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
	));

	let filteredItems = $derived.by(() => {
		switch (filter) {
			case 'sessions':
				return sessionItems;
			case 'notifications':
				// Use live notifItems with category sub-filter
				if (notifCategory === 'all') return notifItems;
				return notifItems.filter((i: any) => i.category === notifCategory);
			case 'awaiting':
				return allItems.filter((i: any) => i.status === 'awaiting' || i.status === 'paused');
			default:
				return allItems;
		}
	});

	let selected = $derived(filteredItems.find((i: any) => i.id === selectedId) ?? filteredItems[0]);

	let replyText = $state('');
	let sending = $state(false);
	let showDelegateModal = $state(false);
	let delegateAgents = $state<{ name: string; type: string; description: string }[]>([]);
	let delegateLoading = $state(false);

	// Notification preferences (reactive so toggles update UI)
	let preferences = $state(data.preferences.map((p: any) => ({ ...p })));

	async function togglePreference(index: number) {
		const pref = preferences[index];
		// Toggle the active field (desktop || sound)
		if (pref.desktop) {
			pref.desktop = !pref.desktop;
		} else if (pref.sound) {
			pref.sound = !pref.sound;
		} else {
			// Was off, turn on desktop by default
			pref.desktop = true;
		}

		// Build settings payload from current preferences state
		const desktopPref = preferences.find((p: any) => p.type === 'Desktop Notifications');
		const soundPref = preferences.find((p: any) => p.type === 'Sound Alerts');
		const toastPref = preferences.find((p: any) => p.type === 'In-App Toasts');

		try {
			const existing = await apiGet<Record<string, unknown>>('/api/settings/notifications', { silent: true }) ?? {};
			await apiPut('/api/settings/notifications', {
				...existing,
				desktop: desktopPref?.desktop ?? true,
				sound: soundPref?.sound ?? false,
				inAppToasts: toastPref?.desktop ?? true
			}, { silent: true });
		} catch (err) {
			console.error('Failed to save notification preference:', err);
		}
	}

	// SSE for live notification sync
	let sseSource: EventSource | null = null;
	let mounted = false;

	function mapNotif(n: any) {
		return {
			id: `notif-${n.id}`,
			type: 'notification' as const,
			title: n.title,
			subtitle: n.message,
			status: n.severity === 'critical' ? 'awaiting' : 'info',
			source: n.source ?? 'system',
			timestamp: n.timestamp,
			notificationId: n.id,
			severity: n.severity,
			category: n.category,
			link: n.link,
			linkLabel: n.linkLabel,
			read: n.read,
			stackCount: n.stackCount,
			timeAgo: timeAgo(n.timestamp)
		};
	}

	async function refreshNotifications() {
		const body = await apiGet<{ notifications: any[]; stats: typeof notifStats; total: number }>('/api/notifications?limit=50', { silent: true, timeout: 5000 });
		if (body) {
			notifItems = body.notifications.map(mapNotif);
			notifStats = body.stats;
			notifTotal = body.total;
			notifOffset = notifItems.length;
			badgeCount.set(notifStats.unread);
		}
	}

	async function loadMoreNotifications() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			const body = await apiGet<{ notifications: any[]; total: number }>(`/api/notifications?limit=50&offset=${notifOffset}`, { silent: true, timeout: 5000 });
			if (body) {
				const more = body.notifications.map(mapNotif);
				const existingIds = new Set(notifItems.map((n: any) => n.id));
				const unique = more.filter((n: any) => !existingIds.has(n.id));
				notifItems = [...notifItems, ...unique];
				notifTotal = body.total;
				notifOffset += more.length;
			}
		} finally {
			loadingMore = false;
		}
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

	function connectSSE() {
		if (!mounted || typeof EventSource === 'undefined') return;
		sseSource = new EventSource('/api/notifications/stream');
		sseSource.onmessage = (event) => {
			try {
				const notif = JSON.parse(event.data);
				const mapped = mapNotif(notif);
				// Deduplicate — update existing or prepend new
				const existingIdx = notifItems.findIndex((n) => n.notificationId === notif.id);
				if (existingIdx >= 0) {
					notifItems = notifItems.map((n, i) => i === existingIdx ? mapped : n);
				} else {
					notifItems = [mapped, ...notifItems];
					notifTotal += 1;
					notifOffset += 1;
				}
				// Recompute stats from live data
				notifStats = {
					...notifStats,
					unread: notifItems.filter((n) => !n.read).length,
					critical: notifItems.filter((n) => n.severity === 'critical' && !n.read).length,
					alerts: notifItems.filter((n) => (n.severity === 'critical' || n.severity === 'warning') && !n.read).length
				};
				badgeCount.set(notifStats.unread);
			} catch {
				// Fallback to full refresh on parse error
				refreshNotifications();
			}
		};
		sseSource.onerror = () => {
			sseSource?.close();
			sseSource = null;
			setTimeout(() => {
				if (mounted) connectSSE();
			}, 5000);
		};
	}

	onMount(() => {
		mounted = true;
		refreshNotifications();
		connectSSE();
	});

	onDestroy(() => {
		mounted = false;
		sseSource?.close();
		sseSource = null;
	});

	const actionStyles: Record<string, { color: string; icon: string }> = {
		approve: { color: 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30', icon: '\u2713' },
		reject: { color: 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30', icon: '\u2717' },
		skip: { color: 'bg-bg-tertiary text-text-secondary hover:bg-bg-primary', icon: '\u2014' },
		delegate: { color: 'bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30', icon: '\u2192' }
	};

	const statusConfig: Record<InboxStatus, { color: string; label: string; dot: string }> = {
		awaiting: { color: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30', label: 'Awaiting Input', dot: 'bg-accent-yellow' },
		active: { color: 'bg-accent-green/10 text-accent-green border-accent-green/30', label: 'Streaming', dot: 'bg-accent-green animate-pulse' },
		paused: { color: 'bg-accent-blue/10 text-accent-blue border-accent-blue/30', label: 'Paused', dot: 'bg-accent-blue' },
		resolved: { color: 'bg-text-secondary/10 text-text-secondary border-border', label: 'Idle', dot: 'bg-text-secondary' },
		info: { color: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30', label: 'Info', dot: 'bg-accent-cyan' }
	};

	const severityDots: Record<string, string> = {
		critical: 'bg-accent-red',
		warning: 'bg-accent-yellow',
		info: 'bg-accent-blue',
		success: 'bg-green-400'
	};

	const categoryTabs: { label: string; value: NotifCategory }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'Tasks', value: 'task' },
		{ label: 'Services', value: 'service' },
		{ label: 'Agents', value: 'agent' },
		{ label: 'Chat', value: 'chat' },
		{ label: 'Memory', value: 'memory' },
		{ label: 'Models', value: 'model' },
		{ label: 'System', value: 'system' }
	];

	async function injectReply() {
		if (!replyText.trim() || !selected || selected.type !== 'session' || !selected.sessionId) return;
		sending = true;
		try {
			await apiPost('/api/chat/auto', {
				action: 'inject',
				sessionId: selected.sessionId,
				message: replyText.trim()
			}, { silent: true });
			replyText = '';
		} finally {
			sending = false;
		}
	}

	async function resumeSession() {
		if (!selected?.sessionId) return;
		await apiPost('/api/chat/auto', { action: 'resume', sessionId: selected.sessionId }, { silent: true });
	}

	async function pauseSession() {
		if (!selected?.sessionId) return;
		await apiPost('/api/chat/auto', { action: 'pause', sessionId: selected.sessionId }, { silent: true });
	}

	async function markNotifRead(id?: string) {
		const notifId = id ?? selected?.notificationId;
		if (!notifId) return;
		await apiPost('/api/notifications', { action: 'mark_read', id: notifId }, { silent: true });
		notifItems = notifItems.map((n) => n.notificationId === notifId ? { ...n, read: true } : n);
		notifStats = { ...notifStats, unread: Math.max(0, notifStats.unread - 1) };
		badgeCount.update((n) => Math.max(0, n - 1));
	}

	async function markAllRead() {
		await apiPost('/api/notifications', { action: 'mark_all_read' }, { silent: true });
		notifItems = notifItems.map((n) => ({ ...n, read: true }));
		notifStats = { ...notifStats, unread: 0, critical: 0, alerts: 0 };
		badgeCount.set(0);
	}

	async function handleQuickAction(actionId: string) {
		if (!selected?.sessionId) return;
		sending = true;
		try {
			const actionMessages: Record<string, string> = {
				approve: '[USER_ACTION:APPROVE] Approved. Continue with your suggestion.',
				reject: '[USER_ACTION:REJECT] Rejected. Please rethink your approach and try again.',
				skip: '[USER_ACTION:SKIP] Skipped. Proceed with default behavior.'
			};

			if (actionId === 'delegate') {
				openDelegateModal();
				return;
			}

			const message = actionMessages[actionId];
			if (message) {
				await apiPost('/api/chat/auto', {
					action: 'inject',
					sessionId: selected.sessionId,
					message
				}, { silent: true });
			}
		} finally {
			sending = false;
		}
	}

	async function openDelegateModal() {
		sending = false;
		delegateLoading = true;
		showDelegateModal = true;
		try {
			const body = await apiGet<{ agents: typeof delegateAgents }>('/api/agents', { silent: true, timeout: 5000 });
			delegateAgents = body?.agents ?? [];
		} finally {
			delegateLoading = false;
		}
	}

	async function delegateTo(agentName: string) {
		if (!selected?.sessionId) return;
		showDelegateModal = false;
		sending = true;
		try {
			await apiPost('/api/chat/auto', {
				action: 'inject',
				sessionId: selected.sessionId,
				message: `[USER_ACTION:DELEGATE agent=${agentName}] Hand off this task to the ${agentName} agent.`
			}, { silent: true });
		} finally {
			sending = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			injectReply();
		}
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		// Only handle when a session is selected and in actionable state
		if (!selected?.sessionId || selected.type !== 'session') return;
		if (selected.status !== 'awaiting' && selected.status !== 'active') return;
		// Don't fire when typing in the reply input
		if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') {
			// Only handle Ctrl+Enter in input (approve shortcut)
			if (e.ctrlKey && e.key === 'Enter') {
				e.preventDefault();
				handleQuickAction('approve');
			}
			return;
		}

		if (e.ctrlKey && e.key === 'Enter') {
			e.preventDefault();
			handleQuickAction('approve');
		} else if (e.ctrlKey && e.key === 'Backspace') {
			e.preventDefault();
			handleQuickAction('reject');
		} else if (e.ctrlKey && e.key === 's') {
			e.preventDefault();
			handleQuickAction('skip');
		} else if (e.ctrlKey && e.key === 'd') {
			e.preventDefault();
			handleQuickAction('delegate');
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
	<title>Inbox — ai-playground</title>
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Agent Inbox</h1>
			<p class="text-sm text-text-secondary mt-1">Sessions, notifications, and items waiting for your attention</p>
		</div>
		{#if filter === 'notifications'}
			<button
				onclick={markAllRead}
				class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors"
			>
				Mark All Read
			</button>
		{/if}
	</div>

	<!-- Stats -->
	{#if filter === 'notifications'}
		<!-- Notification-specific stats -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			<MetricCard label="Unread" value={notifStats.unread} subtitle="{notifStats.critical} critical" accent="red" />
			<MetricCard label="Today" value={notifStats.today} subtitle="notifications" accent="blue" />
			<MetricCard label="Active Tasks" value={notifStats.activeJobs} subtitle="pending attention" accent="green" />
			<MetricCard label="Alerts" value={notifStats.alerts} subtitle="warnings + critical" accent="yellow" />
		</div>
	{:else}
		<div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
			<MetricCard label="Awaiting Input" value={data.stats.awaitingInput} accent="yellow" />
			<MetricCard label="Active" value={data.stats.active} accent="green" />
			<MetricCard label="Paused" value={data.stats.paused} accent="blue" />
			<MetricCard label="Total Sessions" value={data.stats.totalSessions} accent="cyan" />
			<MetricCard label="Unread Notifs" value={data.stats.unreadNotifs} accent="red" />
		</div>
	{/if}

	<!-- Filter Tabs -->
	<div class="flex items-center gap-1 border-b border-border pb-0">
		{#each [
			{ key: 'awaiting', label: 'Needs Attention' },
			{ key: 'all', label: 'All' },
			{ key: 'sessions', label: 'Sessions' },
			{ key: 'notifications', label: 'Notifications' }
		] as tab}
			<button
				onclick={() => { filter = tab.key as FilterType; notifCategory = 'all'; }}
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px
					{filter === tab.key
						? 'text-accent-cyan border-accent-cyan'
						: 'text-text-secondary border-transparent hover:text-text-primary hover:border-border'}"
			>
				{tab.label}
				{#if tab.key === 'notifications' && notifStats.unread > 0}
					<span class="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-accent-red text-[10px] text-white px-1">{notifStats.unread}</span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Category sub-tabs when on Notifications -->
	{#if filter === 'notifications'}
		<div class="flex items-center gap-2 flex-wrap">
			{#each categoryTabs as tab}
				<button
					class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors {notifCategory === tab.value ? 'bg-accent-blue text-white' : 'text-text-secondary hover:bg-bg-secondary'}"
					onclick={() => (notifCategory = tab.value)}
				>
					{tab.label}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Main: List + Detail (or Notification-specific layout) -->
	{#if filter === 'notifications'}
		<!-- Full notification layout with preferences sidebar -->
		<div class="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
			<div class="space-y-2">
				{#each filteredItems as item (item.id)}
					<button
						onclick={() => { selectedId = item.id; if (!item.read) markNotifRead(item.notificationId); }}
						class="w-full text-left bg-bg-secondary border border-border rounded-lg p-4 flex items-start gap-3 transition-colors hover:bg-bg-secondary/80
							{!item.read ? 'border-l-2 border-l-accent-blue' : ''}"
					>
						<span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {severityDots[item.severity ?? 'info'] ?? 'bg-accent-blue'}"></span>
						<div class="flex-1 min-w-0">
							<div class="flex items-center justify-between gap-2 mb-1">
								<span class="text-sm font-medium text-text-primary">{item.title}{#if item.stackCount && item.stackCount > 1}<span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue font-mono">{item.stackCount}x</span>{/if}</span>
								<span class="text-xs text-text-secondary shrink-0">{item.timeAgo}</span>
							</div>
							<p class="text-xs text-text-secondary">{item.subtitle}</p>
							<div class="flex items-center gap-2 mt-1.5">
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary border border-border/50">{item.category}</span>
								{#if item.source}
									<span class="text-[10px] text-text-secondary">via {item.source}</span>
								{/if}
								{#if item.link}
									<a href={item.link} onclick={(e) => e.stopPropagation()} class="text-[10px] text-accent-blue hover:underline">{item.linkLabel ?? 'View'}</a>
								{/if}
							</div>
						</div>
					</button>
				{/each}
				{#if filteredItems.length === 0}
					<p class="text-sm text-text-secondary text-center py-8">No notifications{notifCategory !== 'all' ? ` in ${notifCategory}` : ''}.</p>
				{/if}
				{#if hasMore && notifCategory === 'all'}
					<button
						onclick={loadMoreNotifications}
						disabled={loadingMore}
						class="w-full py-3 text-sm font-medium text-accent-cyan hover:bg-bg-secondary/80 transition-colors disabled:opacity-50"
					>
						{loadingMore ? 'Loading...' : `Load More (${notifTotal - notifOffset} remaining)`}
					</button>
				{/if}
			</div>

			<!-- Preferences sidebar -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Preferences</h2>
				<div class="space-y-4">
					{#each preferences as pref, i}
						<div class="flex items-center justify-between">
							<p class="text-sm text-text-primary">{pref.type}</p>
							<label class="relative inline-flex items-center cursor-pointer">
								<input type="checkbox" checked={pref.desktop || pref.sound} class="sr-only peer" onchange={() => togglePreference(i)} />
								<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
							</label>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{:else}
		<!-- Standard inbox layout: list + detail panel -->
		<div class="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
			<!-- Left: Item List -->
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				<div class="divide-y divide-border max-h-[600px] overflow-y-auto">
					{#each filteredItems as item (item.id)}
						<button
							class="w-full text-left p-3 hover:bg-bg-tertiary transition-colors
								{item.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-cyan' : ''}"
							onclick={() => (selectedId = item.id)}
						>
							<div class="flex items-center gap-2 mb-1">
								<span class="w-2 h-2 rounded-full shrink-0 {statusConfig[item.status as InboxStatus]?.dot ?? 'bg-text-secondary'}"></span>
								{#if item.source === 'claw'}
									<span class="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-accent-green/20 text-accent-green uppercase">claw</span>
								{/if}
								<span class="text-sm font-medium text-text-primary truncate flex-1">{item.title}{#if item.stackCount && item.stackCount > 1}<span class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-accent-blue/20 text-accent-blue font-mono">{item.stackCount}x</span>{/if}</span>
								<span class="text-xs border rounded px-1.5 py-0.5 shrink-0
									{statusConfig[item.status as InboxStatus]?.color ?? 'border-border text-text-secondary'}">
									{statusConfig[item.status as InboxStatus]?.label ?? item.status}
								</span>
							</div>
							<div class="flex items-center justify-between text-xs text-text-secondary mt-0.5">
								<span class="truncate">{item.subtitle}</span>
								<span class="shrink-0 ml-2">{item.timeAgo}</span>
							</div>
						</button>
					{/each}
					{#if filteredItems.length === 0}
						<p class="px-4 py-8 text-sm text-text-secondary text-center">Nothing here yet</p>
					{/if}
				</div>
			</div>

			<!-- Right: Detail -->
			{#if selected}
				<div class="bg-bg-secondary border border-border rounded-lg flex flex-col">
					<!-- Detail Header -->
					<div class="p-4 border-b border-border">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<span class="w-2.5 h-2.5 rounded-full {statusConfig[selected.status as InboxStatus]?.dot ?? 'bg-text-secondary'}"></span>
								<h3 class="text-sm font-semibold text-text-primary">{selected.title}</h3>
								<span class="text-xs border rounded px-1.5 py-0.5
									{statusConfig[selected.status as InboxStatus]?.color}">
									{statusConfig[selected.status as InboxStatus]?.label}
								</span>
							</div>
							<span class="text-xs text-text-secondary">{selected.timeAgo}</span>
						</div>
						{#if selected.model}
							<div class="flex items-center gap-3 mt-2 text-xs text-text-secondary">
								<span>Model: <span class="text-text-primary font-mono">{selected.model}</span></span>
								<span>Provider: <span class="text-text-primary">{selected.provider}</span></span>
								{#if selected.messageCount}
									<span>{selected.messageCount} messages</span>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Content -->
					<div class="flex-1 p-4 overflow-y-auto max-h-[400px]">
						{#if selected.type === 'session'}
							{#if selected.lastMessage}
								<div class="bg-bg-primary border border-border rounded-lg px-4 py-3 mb-4">
									<div class="text-xs text-text-secondary mb-1">Last message</div>
									<p class="text-sm text-text-primary whitespace-pre-wrap">{selected.lastMessage}</p>
								</div>
							{/if}

							<a
								href="/chat?session={selected.sessionId}"
								class="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
									bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 transition-colors"
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
								</svg>
								Open in Chat
							</a>

						{:else if selected.type === 'notification'}
							<div class="space-y-3">
								<div class="flex items-center gap-2">
									{#if selected.severity}
										<span class="text-xs font-medium px-2 py-0.5 rounded-full border
											{selected.severity === 'critical' ? 'bg-accent-red/10 text-accent-red border-accent-red/30' :
											 selected.severity === 'warning' ? 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30' :
											 selected.severity === 'success' ? 'bg-accent-green/10 text-accent-green border-accent-green/30' :
											 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30'}">
											{selected.severity}
										</span>
									{/if}
									{#if selected.category}
										<span class="text-xs text-text-secondary px-2 py-0.5 rounded bg-bg-tertiary">{selected.category}</span>
									{/if}
									<span class="text-xs text-text-secondary">from {selected.source}</span>
								</div>

								<p class="text-sm text-text-primary">{selected.subtitle}</p>

								{#if selected.link}
									<a
										href={selected.link}
										class="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
											bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 transition-colors"
									>
										{selected.linkLabel ?? 'View Details'}
									</a>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Actions -->
					<div class="p-4 border-t border-border space-y-3">
						{#if selected.type === 'session'}
							<!-- Quick Actions -->
							{#if selected.status === 'awaiting' || selected.status === 'active'}
								<div class="flex items-center gap-2">
									{#each data.quickActions as action}
										<button
											onclick={() => handleQuickAction(action.id)}
											disabled={sending}
											class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-40
												{actionStyles[action.id]?.color ?? 'bg-bg-tertiary text-text-secondary'}"
											title="{action.description} ({action.shortcut})"
										>
											<span>{actionStyles[action.id]?.icon ?? ''}</span>
											{action.name}
										</button>
									{/each}
								</div>
							{/if}

							<div class="flex items-center gap-2">
								<input
									type="text"
									bind:value={replyText}
									onkeydown={handleKeydown}
									placeholder="Send a message to this session..."
									disabled={sending}
									class="flex-1 bg-bg-primary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
										placeholder:text-text-secondary disabled:opacity-50
										focus:outline-none focus:border-accent-cyan"
								/>
								<button
									onclick={injectReply}
									disabled={!replyText.trim() || sending}
									class="px-4 py-2 text-xs font-medium text-white bg-accent-green rounded-lg
										hover:bg-accent-green/80 transition-colors disabled:opacity-40"
								>
									{sending ? 'Sending...' : 'Send'}
								</button>
								{#if selected.status === 'active'}
									<button
										onclick={pauseSession}
										class="px-3 py-2 text-xs font-medium bg-accent-yellow/20 text-accent-yellow rounded-lg
											hover:bg-accent-yellow/30 transition-colors"
									>
										Pause
									</button>
								{:else if selected.status === 'paused'}
									<button
										onclick={resumeSession}
										class="px-3 py-2 text-xs font-medium bg-accent-blue/20 text-accent-blue rounded-lg
											hover:bg-accent-blue/30 transition-colors"
									>
										Resume
									</button>
								{/if}
							</div>
						{:else if selected.type === 'notification'}
							<div class="flex items-center gap-2">
								<button
									onclick={() => markNotifRead()}
									class="px-4 py-2 text-xs font-medium bg-accent-green/20 text-accent-green rounded-lg
										hover:bg-accent-green/30 transition-colors"
								>
									Mark Read
								</button>
								{#if selected.link}
									<a
										href={selected.link}
										class="px-4 py-2 text-xs font-medium border border-border text-text-secondary rounded-lg
											hover:bg-bg-tertiary transition-colors"
									>
										{selected.linkLabel ?? 'Go to'}
									</a>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg flex items-center justify-center min-h-[300px]">
					<p class="text-sm text-text-secondary">Select an item to view details</p>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Delegate Agent Picker Modal -->
{#if showDelegateModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label="Delegate to Agent" onkeydown={(e) => { if (e.key === 'Escape') showDelegateModal = false; }}>
		<div class="bg-bg-secondary border border-border rounded-xl w-full max-w-md mx-4 shadow-xl">
			<div class="flex items-center justify-between p-4 border-b border-border">
				<h3 class="text-sm font-semibold text-text-primary">Delegate to Agent</h3>
				<button
					onclick={() => (showDelegateModal = false)}
					class="text-text-secondary hover:text-text-primary text-lg leading-none"
					aria-label="Close"
				>&times;</button>
			</div>
			<div class="p-4 max-h-[400px] overflow-y-auto">
				{#if delegateLoading}
					<p class="text-sm text-text-secondary text-center py-4">Loading agents...</p>
				{:else if delegateAgents.length === 0}
					<p class="text-sm text-text-secondary text-center py-4">No agents found</p>
				{:else}
					<div class="space-y-1">
						{#each delegateAgents as agent}
							<button
								onclick={() => delegateTo(agent.name)}
								class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-tertiary transition-colors"
							>
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-text-primary">{agent.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-accent-purple/10 text-accent-purple">{agent.type}</span>
								</div>
								{#if agent.description}
									<p class="text-xs text-text-secondary mt-0.5 truncate">{agent.description}</p>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
