<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import '../app.css';
	import { goto } from '$app/navigation';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
<<<<<<< HEAD
	import { apiGet } from '$lib/api-client.js';
	import { badgeCount, notifications } from '$lib/stores/index.js';
=======
>>>>>>> worktree-agent-a855fd15
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	// Hide global sidebar when inside a project detail view (project has its own nav)
	const inProjectView = $derived(
		/^\/projects\/[^/]+/.test(page.url.pathname) &&
		!page.url.pathname.endsWith('/projects/create') &&
		!page.url.pathname.endsWith('/projects/import')
	);

<<<<<<< HEAD
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
=======
	let toasts = $state<Array<{ id: string; variant: 'success' | 'error' | 'warning' | 'info'; title: string; message?: string }>>([]);
	let commandPaletteOpen = $state(false);
	let sidebarCollapsed = $state(false);
	let sidebarMobileOpen = $state(false);
>>>>>>> worktree-agent-a855fd15

	function dismissToast(id: string) {
		toasts = toasts.filter((t) => t.id !== id);
		// Also dismiss from store (no-op if id doesn't exist there)
		notifications.dismiss(id);
	}

<<<<<<< HEAD
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

	// Desktop notification support via browser Notification API
	let desktopEnabled = $state(false);

	async function requestDesktopPermission() {
		if (typeof Notification === 'undefined') return;
		if (Notification.permission === 'granted') {
			desktopEnabled = true;
			return;
		}
		if (Notification.permission === 'denied') return;
		const result = await Notification.requestPermission();
		desktopEnabled = result === 'granted';
	}

	async function fetchDesktopPref(): Promise<boolean> {
		try {
			const res = await fetch('/api/settings/notifications', { signal: AbortSignal.timeout(3000) });
			if (!res.ok) return true;
			const settings = await res.json();
			return settings.desktop !== false;
		} catch {
			return true;
		}
	}

	function showDesktopNotification(title: string, body: string, severity?: string) {
		if (!desktopEnabled) return;
		if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
		// Don't show desktop notification if the tab is focused
		if (document.hasFocus()) return;
		try {
			new Notification(title, { body, tag: `notif-${Date.now()}` });
		} catch {
			// Browser may block in certain contexts
		}
	}

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

				// Show browser desktop notification when enabled
				showDesktopNotification(notif.title, notif.message, notif.severity);
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

	onMount(async () => {
		pollTimer = setInterval(() => {
			pollHealth();
			pollNotifCount();
		}, 15000);
		pollNotifCount();
		connectNotificationStream();

		// Request desktop notification permission if the server setting is enabled
		const pref = await fetchDesktopPref();
		if (pref) {
			await requestDesktopPermission();
		}
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
=======
	// Keyboard shortcuts
	let chordPrefix = $state('');
	let chordTimeout: ReturnType<typeof setTimeout> | null = null;

	const chordRoutes: Record<string, string> = {
		h: '/',
		p: '/projects',
		a: '/agents',
		c: '/inbox',
		m: '/models',
		s: '/settings'
	};

	$effect(() => {
		function handleKeydown(e: KeyboardEvent) {
			const target = e.target as HTMLElement;
			const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

			// Cmd/Ctrl+K - toggle command palette (works even in inputs)
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				commandPaletteOpen = !commandPaletteOpen;
				return;
			}

			// Cmd/Ctrl+/ - toggle sidebar
			if ((e.metaKey || e.ctrlKey) && e.key === '/') {
				e.preventDefault();
				sidebarCollapsed = !sidebarCollapsed;
				sidebarMobileOpen = false;
				return;
			}

			// Escape - close modals
			if (e.key === 'Escape') {
				if (commandPaletteOpen) {
					commandPaletteOpen = false;
					return;
				}
				if (sidebarMobileOpen) {
					sidebarMobileOpen = false;
					return;
				}
			}

			// Skip chord shortcuts when in input fields or command palette is open
			if (isInput || commandPaletteOpen) return;

			// G-chord sequences (vim-style)
			if (chordPrefix === 'g') {
				const route = chordRoutes[e.key.toLowerCase()];
				if (route) {
					e.preventDefault();
					goto(route);
				}
				chordPrefix = '';
				if (chordTimeout) clearTimeout(chordTimeout);
				chordTimeout = null;
				return;
			}

			if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
				chordPrefix = 'g';
				if (chordTimeout) clearTimeout(chordTimeout);
				chordTimeout = setTimeout(() => {
					chordPrefix = '';
					chordTimeout = null;
				}, 800);
				return;
			}
		}

		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
>>>>>>> worktree-agent-a855fd15
</script>

<svelte:head>
	<title>AI Playground Dashboard</title>
</svelte:head>

<div class="flex min-h-screen bg-bg-primary">
<<<<<<< HEAD
	{#if !inProjectView}
		<Sidebar {unreadCount} featureFlags={data.featureFlags} />
	{/if}

	<div class="flex-1 flex flex-col" class:ml-56={!inProjectView}>
		<StatusBar {services} lastSync={health.timestamp} />
=======
	<!-- Mobile sidebar backdrop -->
	{#if sidebarMobileOpen}
		<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
		<div
			class="fixed inset-0 bg-black/50 z-40 lg:hidden"
			role="presentation"
			onclick={() => (sidebarMobileOpen = false)}
		></div>
	{/if}

	<Sidebar collapsed={sidebarCollapsed} mobileOpen={sidebarMobileOpen} onNavigate={() => (sidebarMobileOpen = false)} />

	<div class="flex-1 {sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-56'} flex flex-col transition-[margin] duration-200">
		<!-- Mobile header with hamburger -->
		<div class="flex items-center gap-3 lg:hidden px-4 py-3 border-b border-border bg-bg-secondary">
			<button
				class="p-1.5 rounded-lg hover:bg-bg-tertiary text-text-secondary"
				onclick={() => (sidebarMobileOpen = !sidebarMobileOpen)}
				aria-label="Toggle sidebar"
			>
				<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<span class="text-sm font-bold text-accent-cyan tracking-wider">ai-playground</span>
		</div>

		<StatusBar {services} lastSync={data.health.timestamp} />
>>>>>>> worktree-agent-a855fd15

		<main class="flex-1 p-4 md:p-6">
			{@render children()}
		</main>
	</div>
</div>

<<<<<<< HEAD
<Toast toasts={allToasts} onDismiss={dismissToast} />
<CommandPalette />
=======
<Toast {toasts} onDismiss={dismissToast} />
<CommandPalette bind:open={commandPaletteOpen} />

<!-- Chord indicator -->
{#if chordPrefix}
	<div class="fixed bottom-4 right-4 px-3 py-1.5 bg-bg-secondary border border-border rounded-lg text-xs text-text-secondary font-mono z-50">
		g + ...
	</div>
{/if}
>>>>>>> worktree-agent-a855fd15
