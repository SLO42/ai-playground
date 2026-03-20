<script lang="ts">
	import '../app.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { startLiveUpdates, isConnected } from '$lib/stores/live-updates.js';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	// Start SSE live updates — guards against non-browser and duplicate calls
	$effect(() => {
		startLiveUpdates();
	});

	// Live health polling — refreshes every 15s so status bar stays current
	let liveHealth = $state(data.health);
	let lastSync = $state(data.health?.timestamp ?? new Date().toISOString());

	$effect(() => {
		const interval = setInterval(async () => {
			try {
				const res = await fetch('/api/health');
				if (res.ok) {
					const h = await res.json();
					liveHealth = h;
					lastSync = h.timestamp ?? new Date().toISOString();
				}
			} catch { /* silent */ }
		}, 15_000);
		return () => clearInterval(interval);
	});

	// Map health API response to StatusBar format
	let services = $derived([
		{ label: 'Gateway', status: (liveHealth?.services?.openclaw?.status === 'healthy' ? 'online' : 'offline') as 'online' | 'offline' },
		{ label: 'Ollama', status: (liveHealth?.services?.ollama?.status === 'healthy' ? 'online' : 'offline') as 'online' | 'offline' },
		{ label: 'Daemon', status: (liveHealth?.daemon?.online ? 'online' : 'offline') as 'online' | 'offline' },
		{ label: 'Swarm', status: ((liveHealth?.daemon?.activeWorkers ?? 0) > 0 ? 'online' : 'warning') as 'online' | 'warning' }
	]);

	let toasts = $state<Array<{ id: string; variant: 'success' | 'error' | 'warning' | 'info'; title: string; message?: string }>>([]);
	let commandPaletteOpen = $state(false);
	let sidebarCollapsed = $state(false);
	let sidebarMobileOpen = $state(false);

	// Hide global sidebar when inside a project (project layout has its own nav)
	// Matches /projects/[id] and /projects/[id]/anything — but NOT /projects, /projects/create, /projects/import
	let isProjectRoute = $derived(
		page.url.pathname.match(/^\/projects\/(?!create$|import$)[^/]+/) !== null
	);

	function dismissToast(id: string) {
		toasts = toasts.filter((t) => t.id !== id);
	}

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
</script>

<svelte:head>
	<title>AI Playground Dashboard</title>
</svelte:head>

<div class="flex min-h-screen bg-bg-primary">
	<!-- Mobile sidebar backdrop -->
	{#if sidebarMobileOpen && !isProjectRoute}
		<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
		<div
			class="fixed inset-0 bg-black/50 z-40 lg:hidden"
			role="presentation"
			onclick={() => (sidebarMobileOpen = false)}
		></div>
	{/if}

	{#if !isProjectRoute}
		<Sidebar collapsed={sidebarCollapsed} mobileOpen={sidebarMobileOpen} onNavigate={() => (sidebarMobileOpen = false)} />
	{/if}

	<div class="flex-1 {isProjectRoute ? '' : sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-56'} flex flex-col transition-[margin] duration-200">
		<!-- Mobile header with hamburger (hidden on project routes) -->
		{#if !isProjectRoute}
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
		{/if}

		<StatusBar {services} {lastSync}>
			{#snippet trailing()}
				<div class="flex items-center gap-1.5 text-[11px] text-text-secondary" title={isConnected() ? 'Live updates connected' : 'Live updates disconnected'}>
					<span class="inline-block w-1.5 h-1.5 rounded-full {isConnected() ? 'bg-accent-green' : 'bg-text-tertiary'}"></span>
					<span class="hidden sm:inline">Live</span>
				</div>
			{/snippet}
		</StatusBar>

		<main class="flex-1 p-4 md:p-6">
			{@render children()}
		</main>
	</div>
</div>

<Toast {toasts} onDismiss={dismissToast} />
<CommandPalette bind:open={commandPaletteOpen} />

<!-- Chord indicator -->
{#if chordPrefix}
	<div class="fixed bottom-4 right-4 px-3 py-1.5 bg-bg-secondary border border-border rounded-lg text-xs text-text-secondary font-mono z-50">
		g + ...
	</div>
{/if}
