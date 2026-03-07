<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { apiGet } from '$lib/api-client.js';
	import { badgeCount, notifications } from '$lib/stores/index.js';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	// Hide global sidebar when inside a project detail view (project has its own nav)
	const inProjectView = $derived(
		/^\/projects\/[^/]+/.test(page.url.pathname) &&
		!page.url.pathname.endsWith('/projects/create') &&
		!page.url.pathname.endsWith('/projects/import')
	);

	// Live health state — seeded from SSR, then polled client-side
	let health = $state({ ...data.health });
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function pollHealth() {
		const data = await apiGet<typeof health>('/api/health', { silent: true, timeout: 5000 });
		if (data) health = data;
	}

	// Notification badge count — shared via store so inbox can reset it
	let unreadCount = $state(0);
	const unsubBadge = badgeCount.subscribe((v) => { unreadCount = v; });

	async function pollNotifCount() {
		const data = await apiGet<{ stats?: { unread?: number } }>('/api/notifications?limit=1', { silent: true, timeout: 3000 });
		if (data) badgeCount.set(data.stats?.unread ?? 0);
	}

	// Toast system
	interface ToastItem {
		id: string;
		variant: 'success' | 'error' | 'warning' | 'info';
		title: string;
		message?: string;
		timestamp?: string;
		autoDismiss?: boolean;
	}

	let toasts = $state<ToastItem[]>([]);
	let toastIdCounter = 0;

	function addToast(variant: ToastItem['variant'], title: string, message?: string) {
		const id = `toast-${++toastIdCounter}`;
		toasts = [...toasts, { id, variant, title, message }];
		// Auto-dismiss after 6s (critical stays longer)
		const delay = variant === 'error' ? 10000 : 6000;
		setTimeout(() => {
			toasts = toasts.filter((t) => t.id !== id);
		}, delay);
	}

	function dismissToast(id: string) {
		toasts = toasts.filter((t) => t.id !== id);
		// Also dismiss from store (no-op if id doesn't exist there)
		notifications.dismiss(id);
	}

	// Merge store-driven toasts (from apiFetch etc.) into local toast list
	let storeToasts = $state<ToastItem[]>([]);
	const unsubToasts = notifications.toasts.subscribe((items) => {
		storeToasts = items.map((t) => ({
			id: t.id,
			variant: t.type,
			title: t.title,
			message: t.message
		}));
	});

	let allToasts = $derived([...toasts, ...storeToasts]);

	// SSE stream for real-time notifications
	let eventSource: EventSource | null = null;

	function connectNotificationStream() {
		if (typeof EventSource === 'undefined') return;

		eventSource = new EventSource('/api/notifications/stream');

		eventSource.onmessage = (event) => {
			try {
				const notif = JSON.parse(event.data);
				// Map severity to toast variant
				const variantMap: Record<string, ToastItem['variant']> = {
					critical: 'error',
					warning: 'warning',
					success: 'success',
					info: 'info'
				};
				addToast(
					variantMap[notif.severity] ?? 'info',
					notif.title,
					notif.message
				);
				badgeCount.update((n) => n + 1);
			} catch {
				// skip malformed
			}
		};

		eventSource.onerror = () => {
			eventSource?.close();
			// Reconnect after 5s
			setTimeout(connectNotificationStream, 5000);
		};
	}

	onMount(() => {
		pollTimer = setInterval(() => {
			pollHealth();
			pollNotifCount();
		}, 15000);
		pollNotifCount();
		connectNotificationStream();
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		eventSource?.close();
		unsubBadge();
		unsubToasts();
	});

	let services = $derived([
		{ label: 'Ollama', status: (health.services?.ollama?.status === 'healthy' ? 'online' : 'offline') as 'online' | 'offline' },
		{ label: 'Gateway', status: (health.services?.openclaw?.status === 'healthy' ? 'online' : 'offline') as 'online' | 'offline' },
		{ label: 'Daemon', status: (health.daemon?.online ? 'online' : 'offline') as 'online' | 'offline' },
	]);
</script>

<svelte:head>
	<title>AI Playground Dashboard</title>
</svelte:head>

<div class="flex min-h-screen bg-bg-primary">
	{#if !inProjectView}
		<Sidebar {unreadCount} featureFlags={data.featureFlags} />
	{/if}

	<div class="flex-1 flex flex-col" class:ml-56={!inProjectView}>
		<StatusBar {services} lastSync={health.timestamp} />

		<main class="flex-1 p-6">
			{@render children()}
		</main>
	</div>
</div>

<Toast toasts={allToasts} onDismiss={dismissToast} />
<CommandPalette />
