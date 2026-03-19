<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let loaded = $derived(data?.items != null);
	let filter = $state<'all' | 'awaiting' | 'active' | 'notifications'>('all');

	let selectedId = $state(data.items?.[0]?.id ?? '');
	let selected = $derived(data.items?.find((i: any) => i.id === selectedId));
	let replyText = $state('');

	const filtered = $derived(
		(data.items ?? []).filter((item: any) => {
			if (filter === 'all') return true;
			if (filter === 'awaiting') return item.status === 'awaiting';
			if (filter === 'active') return item.status === 'active';
			if (filter === 'notifications') return item.type === 'notification';
			return true;
		})
	);

	const statusColors: Record<string, string> = {
		awaiting: 'bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/30',
		active: 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30',
		paused: 'bg-bg-tertiary text-text-secondary border border-border',
		resolved: 'bg-accent-green/10 text-accent-green border border-accent-green/30',
		info: 'bg-bg-tertiary text-text-secondary border border-border'
	};
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Inbox</h1>
		<p class="text-sm text-text-secondary mt-1">Sessions and notifications from Claw agents</p>
	</div>

	{#if loaded}
		<!-- Metrics -->
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			<MetricCard label="Awaiting Input" value={data.stats?.awaitingInput ?? 0} accent="yellow" />
			<MetricCard label="Active" value={data.stats?.active ?? 0} accent="blue" />
			<MetricCard label="Paused" value={data.stats?.paused ?? 0} accent="cyan" />
			<MetricCard label="Unread" value={data.notifStats?.unread ?? 0} accent="green" />
		</div>

		<!-- Filter tabs -->
		<div class="flex gap-2">
			{#each [
				{ key: 'all', label: `All (${data.items?.length ?? 0})` },
				{ key: 'awaiting', label: `Awaiting (${data.stats?.awaitingInput ?? 0})` },
				{ key: 'active', label: `Active (${data.stats?.active ?? 0})` },
				{ key: 'notifications', label: `Notifications (${data.notifTotal ?? 0})` }
			] as tab}
				<button
					class="px-3 py-1.5 text-xs rounded-md border transition-colors
						{filter === tab.key
						? 'bg-accent-blue/20 text-accent-blue border-accent-blue/40'
						: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
					onclick={() => (filter = tab.key as typeof filter)}
				>{tab.label}</button>
			{/each}
		</div>

		<!-- Item list + detail -->
		<div class="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
			<!-- Left: Item list -->
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
				{#if filtered.length === 0}
					<div class="p-6 text-center text-sm text-text-secondary">No items</div>
				{:else}
					<div class="divide-y divide-border max-h-[550px] overflow-y-auto">
						{#each filtered as item}
							<button
								class="w-full text-left p-3 hover:bg-bg-tertiary transition-colors {item.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-blue' : ''}"
								onclick={() => (selectedId = item.id)}
							>
								<div class="flex items-center gap-2 mb-1">
									{#if item.type === 'notification'}
										<span class="w-2 h-2 rounded-full bg-accent-purple shrink-0"></span>
									{:else}
										<span class="w-2 h-2 rounded-full bg-accent-cyan shrink-0"></span>
									{/if}
									<span class="text-sm font-medium text-text-primary truncate flex-1">{item.title}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded {statusColors[item.status] ?? statusColors.info}">{item.status}</span>
								</div>
								<div class="flex items-center justify-between text-xs text-text-secondary">
									<span>{item.source}</span>
									<span>{item.timeAgo ?? ''}</span>
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Right: Detail -->
			{#if selected}
				<div class="bg-bg-secondary border border-border rounded-lg flex flex-col">
					<div class="p-4 border-b border-border">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium text-text-primary">{selected.title}</span>
							<span class="text-[10px] px-1.5 py-0.5 rounded {statusColors[selected.status] ?? statusColors.info}">{selected.status}</span>
						</div>
						<p class="text-xs text-text-secondary mt-1">
							{selected.source} · {selected.provider ?? ''} {selected.model ?? ''} · {selected.timeAgo ?? ''}
						</p>
					</div>

					<div class="flex-1 p-4 space-y-3 overflow-y-auto max-h-[400px]">
						{#if selected.subtitle}
							<div class="text-sm text-text-primary">
								<Markdown content={selected.subtitle} />
							</div>
						{/if}
						{#if selected.lastMessage}
							<div class="bg-bg-primary border border-border rounded-lg p-3 text-sm text-text-secondary">
								<Markdown content={selected.lastMessage} />
							</div>
						{/if}
						{#if selected.link}
							<a href={selected.link} class="text-sm text-accent-blue hover:underline">{selected.linkLabel ?? 'View'}</a>
						{/if}
						{#if selected.sessionId}
							<a href="/chat?session={selected.sessionId}" class="text-sm text-accent-blue hover:underline">Open in Chat</a>
						{/if}
					</div>

					{#if selected.type === 'session' && selected.status === 'awaiting'}
						<div class="p-4 border-t border-border">
							<div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
								<input
									type="text"
									bind:value={replyText}
									placeholder="Type a response..."
									class="flex-1 bg-bg-primary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"
								/>
								<div class="flex gap-2">
									<button class="flex-1 sm:flex-none px-3 py-2 text-xs font-medium text-white bg-accent-green rounded-lg hover:bg-accent-green/80 transition-colors">Approve</button>
									<button class="flex-1 sm:flex-none px-3 py-2 text-xs font-medium text-white bg-accent-red rounded-lg hover:bg-accent-red/80 transition-colors">Reject</button>
								</div>
							</div>
						</div>
					{/if}
				</div>
			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg flex items-center justify-center p-8">
					<p class="text-sm text-text-secondary">Select an item to view details</p>
				</div>
			{/if}
		</div>
	{:else}
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each Array(4) as _}
				<Skeleton variant="metric" />
			{/each}
		</div>
		<Skeleton variant="card" lines={6} />
	{/if}
</div>
