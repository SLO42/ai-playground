<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const statusDots: Record<string, string> = {
		connected: 'bg-accent-green',
		disconnected: 'bg-accent-red',
		connecting: 'bg-accent-yellow'
	};

	const typeIcons: Record<string, string> = {
		twitch: '📺',
		discord: '💬',
		telegram: '✈️'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Channels</h1>
			<p class="text-sm text-text-secondary mt-1">Messaging channels connected to this project</p>
		</div>
		<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			+ Connect Channel
		</button>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Total Channels" value={data.summary.total} accent="blue" />
		<MetricCard label="Connected" value={data.summary.connected} accent="green" />
		<MetricCard label="Messages" value={data.summary.messages.toLocaleString()} accent="cyan" />
		<MetricCard label="Active Users" value={data.summary.users} accent="purple" />
	</div>

	<!-- Channel Cards -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Channels</h2>
		<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
			{#each data.channels as channel}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<span class="text-lg">{typeIcons[channel.type]}</span>
							<span class="text-sm font-bold text-text-primary">{channel.name}</span>
						</div>
						<div class="flex items-center gap-1.5">
							<span class="w-2 h-2 rounded-full {statusDots[channel.status]}"></span>
							<span class="text-xs text-text-secondary">{channel.status}</span>
						</div>
					</div>
					<div class="space-y-2 text-xs">
						<div class="flex justify-between">
							<span class="text-text-secondary">Messages</span>
							<span class="font-mono text-text-primary">{channel.messages}</span>
						</div>
						<div class="flex justify-between">
							<span class="text-text-secondary">Uptime</span>
							<span class="font-mono text-text-primary">{channel.uptime}</span>
						</div>
					</div>
					<div class="flex gap-2 mt-3 pt-3 border-t border-border">
						<button class="flex-1 px-2 py-1.5 text-xs bg-bg-tertiary text-text-secondary rounded hover:text-text-primary transition-colors">
							Configure
						</button>
						{#if channel.status === 'connected'}
							<button class="px-2 py-1.5 text-xs bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors">
								Disconnect
							</button>
						{:else}
							<button class="px-2 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors">
								Connect
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>

	<!-- DM Pairing Policy -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">DM Pairing Policy</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Mode</p>
					<p class="font-mono text-accent-blue">{data.dmPolicy.mode}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Approval</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.approvalRequired ? 'Required' : 'Auto'}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Timeout</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.pairingTimeout}</p>
				</div>
				<div>
					<p class="text-xs text-text-secondary uppercase mb-1">Max Sessions</p>
					<p class="font-mono text-text-primary">{data.dmPolicy.maxSessions}</p>
				</div>
			</div>
		</div>
	</div>

	<!-- Allowlist -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Allowlist</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-left">
				<thead>
					<tr class="border-b border-border text-xs text-text-secondary uppercase">
						<th class="px-4 py-2 font-medium">Username</th>
						<th class="px-4 py-2 font-medium">Platform</th>
						<th class="px-4 py-2 font-medium">Role</th>
						<th class="px-4 py-2 font-medium">Added</th>
					</tr>
				</thead>
				<tbody>
					{#each data.allowlist as entry}
						<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
							<td class="px-4 py-3 text-sm font-mono text-text-primary">{entry.username}</td>
							<td class="px-4 py-3 text-sm text-text-secondary">{entry.platform}</td>
							<td class="px-4 py-3"><span class="text-xs px-2 py-0.5 rounded bg-accent-blue/20 text-accent-blue">{entry.role}</span></td>
							<td class="px-4 py-3 text-sm text-text-secondary">{entry.added}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<!-- Recent Messages -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Messages</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-left">
				<thead>
					<tr class="border-b border-border text-xs text-text-secondary uppercase">
						<th class="px-4 py-2 font-medium w-24">Channel</th>
						<th class="px-4 py-2 font-medium w-28">User</th>
						<th class="px-4 py-2 font-medium">Message</th>
						<th class="px-4 py-2 font-medium text-right w-20">Time</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentMessages as msg}
						<tr class="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors">
							<td class="px-4 py-3"><span class="text-xs px-2 py-0.5 rounded bg-bg-tertiary text-text-secondary">{msg.channel}</span></td>
							<td class="px-4 py-3 text-sm font-mono text-accent-cyan">{msg.user}</td>
							<td class="px-4 py-3 text-sm text-text-primary">{msg.message}</td>
							<td class="px-4 py-3 text-xs text-text-secondary text-right">{msg.time}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</div>
