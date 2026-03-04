<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const o = $derived(data.overview);

	const healthStatus: Record<string, 'online' | 'warning' | 'error'> = {
		healthy: 'online',
		warning: 'warning',
		error: 'error'
	};

	const serviceStatus: Record<string, 'online' | 'offline' | 'warning'> = {
		online: 'online',
		offline: 'offline',
		degraded: 'warning'
	};

	const accentMap: Record<string, 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'cyan'> = {
		blue: 'blue',
		green: 'green',
		yellow: 'yellow',
		red: 'red',
		purple: 'purple',
		cyan: 'cyan'
	};
</script>

<div class="space-y-6">
	<!-- Project Identity -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-start justify-between mb-3">
			<div class="flex items-center gap-3">
				<StatusBadge status={healthStatus[o.health]} size="md" />
				<div>
					<h1 class="text-xl font-bold text-text-primary">{data.project.name}</h1>
					<p class="text-sm text-text-secondary mt-0.5">{o.description}</p>
				</div>
			</div>
			<div class="text-right text-xs text-text-secondary">
				<p class="font-mono">{data.project.branch}</p>
				<p>{data.project.commits} commits</p>
			</div>
		</div>
		<div class="flex flex-wrap gap-1.5 pt-3 border-t border-border">
			{#each o.techStack as tech}
				<span class="text-[10px] px-2 py-0.5 bg-bg-tertiary text-text-secondary rounded font-mono">
					{tech}
				</span>
			{/each}
		</div>
	</div>

	<!-- Stats -->
	<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
		<MetricCard label="Models" value={o.stats.models} accent="blue" />
		<MetricCard label="Agents" value={o.stats.agents} accent="green" />
		<MetricCard label="Sessions" value={o.stats.sessions} accent="purple" />
		<MetricCard label="Channels" value={o.stats.channels} accent="cyan" />
		<MetricCard label="Memory" value={o.stats.memoryNodes} accent="blue" />
		<MetricCard label="Hooks" value={o.stats.hooks} accent="yellow" />
	</div>

	<!-- Quick Links Grid -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Quick Links</h2>
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			{#each o.quickLinks as link}
				<a
					href={link.href}
					class="bg-bg-secondary border border-border rounded-lg p-3 hover:border-accent-blue/50 transition-colors group"
				>
					<p class="text-xs text-text-secondary uppercase tracking-wider">{link.label}</p>
					<p class="text-sm font-mono text-text-primary mt-1 group-hover:text-accent-blue transition-colors">
						{link.stat}
					</p>
				</a>
			{/each}
		</div>
	</div>

	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- Services -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Services</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each o.services as svc}
					<div class="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
						<div class="flex items-center gap-2">
							<StatusBadge status={serviceStatus[svc.status]} />
							<span class="text-sm text-text-primary">{svc.name}</span>
						</div>
						{#if svc.port}
							<span class="text-xs font-mono text-text-secondary">:{svc.port}</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Recent Activity -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Activity</h2>
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#each o.recentActivity as event}
					<div class="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
						<div class="min-w-0">
							<p class="text-sm text-text-primary">{event.action}</p>
							<p class="text-xs text-text-secondary truncate">{event.detail}</p>
						</div>
						<span class="text-xs text-text-secondary whitespace-nowrap ml-3">{event.time}</span>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
