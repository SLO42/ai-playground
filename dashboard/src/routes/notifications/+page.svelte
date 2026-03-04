<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type TabFilter = 'all' | 'jobs' | 'agents' | 'security' | 'system';
	let activeTab = $state<TabFilter>('all');

	let filtered = $derived(
		activeTab === 'all'
			? data.notifications
			: data.notifications.filter((n) => n.category === activeTab)
	);

	const severityColors: Record<string, string> = {
		critical: 'bg-accent-red/10 text-accent-red border-accent-red/30',
		warning: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30',
		info: 'bg-accent-blue/10 text-accent-blue border-accent-blue/30'
	};

	const severityDots: Record<string, string> = {
		critical: 'bg-accent-red',
		warning: 'bg-accent-yellow',
		info: 'bg-accent-blue'
	};

	const tabs: { label: string; value: TabFilter }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'Jobs', value: 'jobs' },
		{ label: 'Agents', value: 'agents' },
		{ label: 'Security', value: 'security' },
		{ label: 'System', value: 'system' }
	];
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Notifications</h1>
			<p class="text-sm text-text-secondary mt-1">Job progress, agent alerts, and system notifications</p>
		</div>
		<div class="flex items-center gap-2">
			<button class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Mark All Read
			</button>
			<button class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Settings
			</button>
		</div>
	</div>

	<!-- Filter Tabs -->
	<div class="flex items-center gap-2">
		{#each tabs as tab}
			<button
				class="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors {activeTab === tab.value ? 'bg-accent-blue text-white' : 'text-text-secondary hover:bg-bg-secondary'}"
				onclick={() => (activeTab = tab.value)}
			>
				{tab.label}
				{#if tab.value === 'all' && data.stats.unread > 0}
					<span class="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-accent-red text-[10px] text-white">{data.stats.unread}</span>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Stat Cards -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Unread" value={data.stats.unread} subtitle="{data.stats.critical} critical" accent="red" />
		<MetricCard label="Today" value={data.stats.today} subtitle="notifications" accent="blue" />
		<MetricCard label="Active Jobs" value={data.stats.activeJobs} subtitle="2 building, 1 testing" accent="green" />
		<MetricCard label="Alerts" value={data.stats.alerts} subtitle="VRAM + security" accent="yellow" />
	</div>

	<!-- Main content: Notification list + Preferences -->
	<div class="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
		<!-- Notification List -->
		<div class="space-y-2">
			{#each filtered as notif}
				<div class="bg-bg-secondary border border-border rounded-lg p-4 flex items-start gap-3 {!notif.read ? 'border-l-2 border-l-accent-blue' : ''}">
					<span class="w-2 h-2 rounded-full mt-1.5 shrink-0 {severityDots[notif.severity]}"></span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center justify-between gap-2 mb-1">
							<span class="text-sm font-medium text-text-primary">{notif.title}</span>
							<span class="text-xs text-text-secondary shrink-0">{notif.timestamp}</span>
						</div>
						<p class="text-xs text-text-secondary">{notif.message}</p>
						{#if notif.link}
							<a href={notif.link} class="text-xs text-accent-blue hover:underline mt-1 inline-block">{notif.linkLabel}</a>
						{/if}
					</div>
				</div>
			{/each}
			{#if filtered.length === 0}
				<p class="text-sm text-text-secondary text-center py-8">No notifications in this category.</p>
			{/if}
		</div>

		<!-- Notification Preferences -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Preferences</h2>
			<div class="space-y-4">
				{#each data.preferences as pref}
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm text-text-primary">{pref.type}</p>
						</div>
						<label class="relative inline-flex items-center cursor-pointer">
							<input type="checkbox" checked={pref.desktop || pref.sound} class="sr-only peer" />
							<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
						</label>
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>
