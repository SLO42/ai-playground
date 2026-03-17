<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';

	import type { FeatureFlags } from '$lib/server/feature-flags.js';

	interface Props {
		activePath?: string;
		unreadCount?: number;
		featureFlags?: FeatureFlags;
		mobileOpen?: boolean;
		onClose?: () => void;
	}

	let { activePath, unreadCount = 0, featureFlags, mobileOpen = false, onClose }: Props = $props();

	function handleNavClick() {
		onClose?.();
	}

	let navEl: HTMLElement | undefined = $state();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose?.();
		if (e.key === 'Tab' && mobileOpen && navEl) {
			const focusable = navEl.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	$effect(() => {
		if (mobileOpen && navEl) {
			const first = navEl.querySelector<HTMLElement>(
				'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
			);
			first?.focus();
		}
	});

	/** Routes gated by feature flags */
	const routeFlagMap: Record<string, keyof FeatureFlags> = {
		'/memory': 'memory',
		'/security': 'security',
		'/hooks': 'hooks',
		'/reports': 'reports',
		'/tasks': 'tasks',
		'/chat': 'chat',
		'/inbox': 'inbox',
		'/notifications': 'notifications',
		// '/agents' — ungated
	};

	const allNavItems = [
		{ href: '/', label: 'Home', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4' },
		{ href: '/chat', label: 'Chat', icon: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
		{ href: '/projects', label: 'Projects', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
		{ href: '/tasks', label: 'Tasks', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
		{ href: '/models', label: 'Models', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z' },
		{ href: '/agents', label: 'Agents', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
		{ href: '/channels', label: 'Channels', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
		{ href: '/apps', label: 'Apps', icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
{ href: '/memory', label: 'Memory', icon: 'M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7M4 7c0-2 1-3 3-3h10c2 0 3 1 3 3M4 7h16M9 11h.01M15 11h.01M9 15h.01M15 15h.01' },
		{ href: '/security', label: 'Security', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
		{ href: '/hooks', label: 'Hooks', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
		{ href: '/reports', label: 'Reports', icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
		{ href: '/sessions', label: 'Sessions', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
		{ href: '/inbox', label: 'Inbox', icon: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4' },
		{ href: '/settings', label: 'Settings', icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
		{ href: '/services', label: 'Services', icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01' },
		{ href: '/about', label: 'About', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
	];

	const navItems = $derived(
		featureFlags
			? allNavItems.filter((item) => {
					const flag = routeFlagMap[item.href];
					return !flag || featureFlags[flag];
				})
			: allNavItems
	);

	function isActive(href: string): boolean {
		const path = activePath ?? page.url.pathname;
		if (href === '/') return path === '/';
		return path.startsWith(href);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if mobileOpen}
	<!-- Backdrop overlay (mobile only) -->
	<div
		class="fixed inset-0 bg-black/50 z-40 md:hidden"
		onclick={onClose}
		role="presentation"
		transition:fade={{ duration: 200 }}
	></div>
{/if}

<nav
	bind:this={navEl}
	aria-label="Main navigation"
	onkeydown={handleKeydown}
	role={mobileOpen ? 'dialog' : undefined}
	aria-modal={mobileOpen ? 'true' : undefined}
	class="fixed left-0 top-0 h-full w-56 bg-bg-secondary border-r border-border flex flex-col z-50
		transition-transform duration-300 ease-in-out
		max-md:-translate-x-full {mobileOpen ? 'max-md:translate-x-0' : ''}"
>
	<div class="px-4 py-5 border-b border-border">
		<h1 class="text-sm font-bold text-accent-cyan tracking-wider">ai-playground</h1>
	</div>

	<div class="mx-2 mt-3 mb-1">
		<button
			aria-label="Search pages and actions (Ctrl+K)"
			onclick={() => { const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }); window.dispatchEvent(e); }}
			class="flex items-center gap-2 w-full px-3 h-9 rounded-lg text-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50 border border-border transition-colors cursor-pointer"
		>
			<svg aria-hidden="true" class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
			</svg>
			<span class="flex-1 text-left">Search...</span>
			<kbd class="text-[10px] font-mono px-1 py-0.5 rounded bg-bg-primary border border-border">Ctrl K</kbd>
		</button>
	</div>

	<div class="flex-1 py-3 overflow-y-auto">
		{#each navItems as item}
			<a
				href={item.href}
				onclick={handleNavClick}
				aria-current={isActive(item.href) ? 'page' : undefined}
				class="group relative flex items-center gap-3 mx-2 px-3 h-10 rounded-lg text-sm transition-colors
					{isActive(item.href)
						? 'bg-accent-blue/10 text-accent-blue font-medium'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50'}"
			>
				{#if isActive(item.href)}
					<span aria-hidden="true" class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-accent-blue rounded-r"></span>
				{/if}
				<svg aria-hidden="true" class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d={item.icon} />
				</svg>
				{item.label}
				{#if item.href === '/inbox' && unreadCount > 0}
					<span aria-label="{unreadCount > 99 ? '99+' : unreadCount} unread" class="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent-red text-[10px] font-medium text-white">
						{unreadCount > 99 ? '99+' : unreadCount}
					</span>
				{/if}
			</a>
		{/each}
	</div>

	<div class="px-4 py-3 border-t border-border">
		<span class="text-xs text-text-secondary font-mono">ai-playground v{__APP_VERSION__}</span>
	</div>
</nav>
