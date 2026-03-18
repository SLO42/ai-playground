<script lang="ts">
	import '../app.css';
	import { goto } from '$app/navigation';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Toast from '$lib/components/Toast.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	let services = $derived([
		{ label: 'Gateway', status: (data.health.gateway ? 'online' : 'offline') as 'online' | 'offline', text: data.health.gateway ? 'Online' : 'Offline' },
		{ label: 'Ollama', status: (data.health.ollama ? 'online' : 'offline') as 'online' | 'offline', text: data.health.ollama ? 'Running' : 'Stopped' },
		{ label: 'Memory DB', status: ('online' as const), text: 'Connected' },
		{ label: 'Swarm', status: (data.health.swarm ? 'online' : 'warning') as 'online' | 'warning', text: data.health.swarm ? 'Active' : 'Idle' }
	]);

	let toasts = $state<Array<{ id: string; variant: 'success' | 'error' | 'warning' | 'info'; title: string; message?: string }>>([]);
	let commandPaletteOpen = $state(false);
	let sidebarCollapsed = $state(false);
	let sidebarMobileOpen = $state(false);

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
