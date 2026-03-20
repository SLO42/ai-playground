<script lang="ts">
	interface ServiceStatus {
		label: string;
		status: 'online' | 'offline' | 'warning';
	}

	import type { Snippet } from 'svelte';

	interface Props {
		services?: ServiceStatus[];
		lastSync?: string;
		trailing?: Snippet;
	}

	let {
		services = [
			{ label: 'Ollama', status: 'online' },
			{ label: 'Gateway', status: 'online' },
			{ label: 'Daemon', status: 'online' }
		],
		lastSync = 'just now',
		trailing
	}: Props = $props();

	const dotColors: Record<string, string> = {
		online: 'bg-accent-green',
		offline: 'bg-accent-red',
		warning: 'bg-accent-yellow'
	};

	const pillColors: Record<string, string> = {
		online: 'bg-accent-green/15 text-accent-green border-accent-green/30',
		offline: 'bg-accent-red/15 text-accent-red border-accent-red/30',
		warning: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30'
	};

	const allOnline = $derived(services.every((s) => s.status === 'online'));
	const syncLabel = $derived(() => {
		if (!lastSync || lastSync === 'just now') return 'just now';
		try {
			const d = new Date(lastSync);
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		} catch {
			return lastSync;
		}
	});
</script>

<header role="banner" aria-label="System status" class="sticky top-0 z-40 h-10 bg-bg-secondary/80 backdrop-blur-sm border-b border-border px-6 flex items-center justify-between">
	<div role="status" class="flex items-center gap-2">
		{#each services as svc}
			<span aria-label="{svc.label}: {svc.status}" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border {pillColors[svc.status]}">
				<span aria-hidden="true" class="w-1.5 h-1.5 rounded-full {dotColors[svc.status]} {svc.status === 'online' ? 'animate-pulse' : ''}"></span>
				{svc.label}
			</span>
		{/each}
	</div>

	<div class="flex items-center gap-4">
		{#if trailing}
			{@render trailing()}
		{/if}
		<span class="text-[11px] text-text-secondary">
			Synced {syncLabel()}
		</span>
		<span class="text-[11px] font-medium {allOnline ? 'text-accent-green' : 'text-accent-yellow'}">
			{allOnline ? 'All systems operational' : 'Degraded'}
		</span>
	</div>
</header>
