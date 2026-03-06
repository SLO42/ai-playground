<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	const tabs = $derived([
		{ href: `/services/${data.serviceId}`, label: 'Status', segment: '' },
		...(data.hasLogs ? [{ href: `/services/${data.serviceId}/logs`, label: 'Logs', segment: 'logs' }] : []),
		...(data.hasConfig ? [{ href: `/services/${data.serviceId}/config`, label: 'Config', segment: 'config' }] : [])
	]);

	function isActive(segment: string): boolean {
		const path = page.url.pathname;
		const base = `/services/${data.serviceId}`;
		const sub = path.slice(base.length).replace(/^\//, '');
		if (segment === '') return sub === '' || sub === '/';
		return sub === segment || sub.startsWith(`${segment}/`);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-3">
			<a href="/services" class="text-sm text-text-secondary hover:text-text-primary transition-colors">&larr; Services</a>
			<h1 class="text-lg font-bold text-text-primary">{data.serviceName}</h1>
			<span class="text-xs text-text-secondary px-2 py-0.5 bg-bg-tertiary rounded">{data.serviceType}</span>
		</div>
	</div>

	<!-- Tabs -->
	<div class="flex gap-1 border-b border-border">
		{#each tabs as tab}
			<a
				href={tab.href}
				class="px-4 py-2 text-sm transition-colors border-b-2 -mb-px
					{isActive(tab.segment)
						? 'text-accent-blue border-accent-blue font-medium'
						: 'text-text-secondary border-transparent hover:text-text-primary hover:border-border'}"
			>
				{tab.label}
			</a>
		{/each}
	</div>

	<!-- Tab Content -->
	{@render children()}
</div>
