<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	const healthColors: Record<string, string> = {
		healthy: 'bg-accent-green',
		warning: 'bg-accent-yellow',
		error: 'bg-accent-red'
	};

	const workspaceNav = [
		{ href: 'overview', label: 'Overview' },
		{ href: 'models', label: 'Models' },
		{ href: 'agents', label: 'Agents' },
		{ href: 'sessions', label: 'Sessions' },
		{ href: 'memory', label: 'Memory' },
		{ href: 'hooks', label: 'Hooks' }
	];

	const platformNav = [
		{ href: 'channels', label: 'Channels' },
		{ href: 'services', label: 'Apps & MCP' },
		{ href: 'security', label: 'Security' },
		{ href: 'settings', label: 'Settings' },
		{ href: 'about', label: 'About / Stack' }
	];

	function isActive(segment: string): boolean {
		const path = page.url.pathname;
		const base = `/projects/${data.projectId}`;
		if (segment === 'overview') return path === base || path === `${base}/`;
		return path.includes(`/${segment}`);
	}
</script>

<!-- Project Shell replaces global layout's main area -->
<div class="flex min-h-[calc(100vh-48px)] -m-6">
	<!-- Project Sidebar -->
	<nav class="w-52 bg-bg-secondary border-r border-border flex flex-col shrink-0">
		<!-- Project Identity -->
		<div class="p-4 border-b border-border">
			<a href="/projects" class="text-xs text-accent-cyan hover:underline uppercase tracking-wider">
				{data.project.name}
			</a>
			<div class="flex items-center gap-2 mt-2 bg-bg-tertiary rounded-lg px-3 py-2">
				<span class="w-6 h-6 rounded bg-accent-blue/20 text-accent-blue text-xs flex items-center justify-center font-bold">
					ai
				</span>
				<div class="min-w-0">
					<p class="text-sm font-medium text-text-primary truncate">{data.project.name}</p>
					<p class="text-[10px] text-text-secondary truncate">{data.project.path}</p>
				</div>
			</div>
		</div>

		<!-- Workspace Nav -->
		<div class="py-2">
			<p class="px-4 py-1 text-[10px] text-text-secondary uppercase tracking-widest">Workspace</p>
			{#each workspaceNav as item}
				<a
					href="/projects/{data.projectId}/{item.href === 'overview' ? '' : item.href}"
					class="flex items-center px-4 py-2 mx-2 rounded-md text-sm transition-colors
						{isActive(item.href)
						? 'text-accent-blue font-medium bg-bg-tertiary'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50'}"
				>
					{item.label}
				</a>
			{/each}
		</div>

		<!-- Platform Nav -->
		<div class="py-2">
			<p class="px-4 py-1 text-[10px] text-text-secondary uppercase tracking-widest">Platform</p>
			{#each platformNav as item}
				<a
					href="/projects/{data.projectId}/{item.href}"
					class="flex items-center px-4 py-2 mx-2 rounded-md text-sm transition-colors
						{isActive(item.href)
						? 'text-accent-blue font-medium bg-bg-tertiary'
						: 'text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/50'}"
				>
					{item.label}
				</a>
			{/each}
		</div>

		<!-- Footer -->
		<div class="mt-auto p-4 border-t border-border">
			<p class="text-[10px] text-text-secondary font-mono">v0.1.0-dev</p>
			<p class="text-[10px] text-text-secondary font-mono">{data.project.branch} &middot; {data.project.commits} commits</p>
		</div>
	</nav>

	<!-- Content Area -->
	<div class="flex-1 min-w-0">
		<!-- Breadcrumb -->
		<div class="px-6 py-2 border-b border-border flex items-center gap-2 text-xs">
			<a href="/projects/{data.projectId}" class="text-accent-blue hover:underline">{data.project.name}</a>
			<span class="text-text-secondary">&rsaquo;</span>
			<span class="text-text-secondary capitalize">
				{page.url.pathname.split('/').pop() || 'Overview'}
			</span>
		</div>

		<!-- Page Content -->
		<div class="p-6">
			{@render children()}
		</div>
	</div>
</div>
