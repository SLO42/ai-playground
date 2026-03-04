<script lang="ts">
	import { page } from '$app/state';

	const navItems = [
		{ href: '/', label: 'Home', icon: '⌂' },
		{ href: '/models', label: 'Models', icon: '◈' },
		{ href: '/agents', label: 'Agents', icon: '◎' },
		{ href: '/channels', label: 'Channels', icon: '⚡' },
		{ href: '/apps', label: 'Apps', icon: '▦' },
		{ href: '/memory', label: 'Memory', icon: '◉' },
		{ href: '/security', label: 'Security', icon: '⛨' },
		{ href: '/hooks', label: 'Hooks', icon: '⚙' }
	];

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname.startsWith(href);
	}
</script>

<nav class="fixed left-0 top-0 h-full w-56 bg-bg-secondary border-r border-border flex flex-col z-50">
	<div class="p-4 border-b border-border">
		<h1 class="text-sm font-bold text-accent-cyan tracking-wider uppercase">AI Playground</h1>
		<p class="text-xs text-text-secondary mt-1 font-mono">Dashboard v2</p>
	</div>

	<div class="flex-1 py-2">
		{#each navItems as item}
			<a
				href={item.href}
				class="flex items-center gap-3 px-4 py-2.5 mx-2 rounded-md text-sm transition-colors
					{isActive(item.href)
						? 'bg-bg-tertiary text-accent-blue font-medium'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50'}"
			>
				<span class="text-base w-5 text-center">{item.icon}</span>
				{item.label}
			</a>
		{/each}
	</div>

	<div class="p-4 border-t border-border">
		<div class="flex items-center gap-2">
			<span class="text-xs text-text-secondary font-mono">Claude Flow v3</span>
		</div>
	</div>
</nav>
