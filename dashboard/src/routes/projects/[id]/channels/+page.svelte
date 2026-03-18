<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const projectName = $derived(data.project?.name ?? data.projectId ?? 'Project');
	let channels = $derived(data.channels ?? []);
	let availableChannels = $derived(data.availableChannels ?? []);

	const channelColors: Record<string, string> = {
		twitch: 'bg-accent-purple',
		discord: 'bg-accent-blue',
		telegram: 'bg-accent-cyan',
		whatsapp: 'bg-accent-green',
		imessage: 'bg-accent-green',
		dashboard: 'bg-accent-yellow',
		custom: 'bg-accent-red'
	};

	const statusDots: Record<string, string> = {
		connected: 'bg-accent-green',
		disconnected: 'bg-accent-red',
		connecting: 'bg-accent-yellow'
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="type-page-title text-text-primary">Channels</h1>
		<p class="text-xs text-text-secondary mt-0.5">
			Messaging channels for <span class="font-mono text-accent-cyan">{projectName}</span>
		</p>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
		<MetricCard label="Connected" value={data.summary.total} accent="blue" />
		<MetricCard label="Active" value={data.summary.connected} accent="green" />
		<MetricCard label="Available" value={data.summary.available} accent="cyan" />
	</div>

	<!-- Connected Channels -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Connected Channels</h2>
		{#if channels.length > 0}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each channels as channel}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<div class="flex items-center justify-between mb-3">
							<div class="flex items-center gap-2">
								<span class="w-2.5 h-2.5 rounded-full {channelColors[channel.type] ?? 'bg-accent-cyan'}"></span>
								<span class="text-sm font-bold text-text-primary">{channel.name}</span>
							</div>
							<div class="flex items-center gap-1.5">
								<span class="w-2 h-2 rounded-full {statusDots[channel.status] ?? 'bg-text-secondary'}"></span>
								<span class="text-xs text-text-secondary">{channel.status}</span>
							</div>
						</div>
						<div class="space-y-2 text-xs">
							<div class="flex justify-between">
								<span class="text-text-secondary">Type</span>
								<span class="font-mono text-text-primary">{channel.type}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-text-secondary">Uptime</span>
								<span class="font-mono text-text-primary">{channel.uptime}</span>
							</div>
							{#if channel.description}
								<p class="text-text-secondary pt-1 border-t border-border">{channel.description}</p>
							{/if}
						</div>
						<div class="mt-3 pt-3 border-t border-border">
							<span class="text-xs px-2 py-1 rounded {channel.enabled ? 'bg-accent-green/20 text-accent-green' : 'bg-bg-tertiary text-text-secondary'}">
								{channel.enabled ? 'Enabled' : 'Disabled'}
							</span>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg px-4 py-12 flex flex-col items-center justify-center text-center">
				<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
				</svg>
				<h2 class="text-text-primary text-sm font-medium mb-1">No channels connected</h2>
				<p class="text-text-secondary text-xs">Connect a channel to enable messaging for this project</p>
			</div>
		{/if}
	</section>

	<!-- Available Channels -->
	{#if availableChannels.length > 0}
		<section>
			<h2 class="type-section-title text-text-primary mb-4">Available Channels</h2>
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each availableChannels as ch}
					<div class="bg-bg-secondary border border-dashed border-border rounded-lg p-4 opacity-70 hover:opacity-100 transition-opacity">
						<div class="flex items-center justify-between mb-2">
							<div class="flex items-center gap-2">
								<span class="w-2.5 h-2.5 rounded-full {channelColors[ch.type] ?? 'bg-accent-cyan'}"></span>
								<span class="text-sm font-bold text-text-primary">{ch.name}</span>
							</div>
							<span class="text-xs px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{ch.type}</span>
						</div>
						{#if ch.description}
							<p class="text-xs text-text-secondary mb-2">{ch.description}</p>
						{/if}
						<div class="flex items-center gap-2 text-xs">
							<span class="{ch.enabled ? 'text-accent-green' : 'text-text-secondary'}">{ch.enabled ? 'Gateway enabled' : 'Gateway disabled'}</span>
							<span class="text-text-secondary">&middot;</span>
							<span class="text-text-secondary">{ch.activation}</span>
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
