<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let gw = $derived(data.gateway?.gateway);
	let dm = $derived(data.gateway?.dm);
	let twitch = $derived(data.twitch);

	let allowlistUsers = $derived(twitch?.users?.allowlist ?? []);

	const gatewayConfig = [
		{ label: 'Bind Address', value: '127.0.0.1:18789' },
		{ label: 'TLS', value: '1.3 (enforced)' },
		{ label: 'DM Policy', value: 'pairing (short-code)' },
		{ label: 'Auth Mode', value: 'allowlist + pairing' },
		{ label: 'Max Connections', value: '50' },
		{ label: 'Audit Logging', value: 'enabled' }
	];

	const channels = [
		{ name: 'Twitch', status: 'Connected', statusColor: 'text-accent-green', dotColor: 'bg-accent-purple', desc: 'Family stream channel', users: 4 },
		{ name: 'Telegram', status: 'Ready', statusColor: 'text-accent-green', dotColor: 'bg-accent-blue', desc: 'Private family group', users: 3 },
		{ name: 'Discord', status: 'Disabled', statusColor: 'text-text-secondary', dotColor: 'bg-text-secondary', desc: 'Age verification concerns', users: 0 },
		{ name: 'WhatsApp', status: 'Planned', statusColor: 'text-text-secondary', dotColor: 'bg-text-secondary', desc: 'Future integration', users: 0 }
	];

	const allowlist = [
		{ username: 'dad_coder', platform: 'Twitch', role: 'Admin', added: 'Jan 2026' },
		{ username: 'mom_stream', platform: 'Twitch', role: 'Member', added: 'Jan 2026' },
		{ username: 'kid_one', platform: 'Twitch', role: 'Member', added: 'Feb 2026' },
		{ username: 'kid_two', platform: 'Telegram', role: 'Member', added: 'Feb 2026' }
	];
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Channels & Gateway</h1>

	<!-- Gateway + DM Policy -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- Gateway Configuration -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">Gateway Configuration</p>
			<div class="space-y-2">
				{#each gatewayConfig as item}
					<div class="flex justify-between text-sm">
						<span class="text-text-secondary">{item.label}</span>
						<span class="font-mono text-text-primary">{item.value}</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- DM Pairing Policy -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="type-label text-text-secondary mb-3">DM Pairing Policy</p>
			<p class="text-sm mb-1">
				<span class="text-text-secondary">Mode: </span>
				<span class="text-accent-cyan font-mono">Pairing</span>
			</p>
			<p class="text-xs text-text-secondary mb-3">New contacts must enter a short-code to pair.</p>
			<div class="space-y-1 text-sm">
				<p class="text-text-primary">Active Pairings: <span class="font-mono">4</span></p>
				<p class="text-accent-yellow">Pending Requests: <span class="font-mono">1</span></p>
				<p class="text-text-secondary">Blocked: <span class="font-mono">0</span></p>
			</div>
		</div>
	</div>

	<!-- Connected Channels -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Connected Channels</h2>
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			{#each channels as ch}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full {ch.dotColor}"></span>
						<span class="type-card-title text-text-primary">{ch.name}</span>
					</div>
					<p class="text-xs font-mono {ch.statusColor}">{ch.status}</p>
					<p class="text-xs text-text-secondary mt-2">{ch.desc}</p>
					<p class="text-sm font-mono text-text-primary mt-2">Users: {ch.users}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Allowlist -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Allowlist</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-border">
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Username</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Platform</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Role</th>
						<th class="text-left px-4 py-3 text-text-secondary font-medium">Added</th>
					</tr>
				</thead>
				<tbody>
					{#each allowlist as user}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 font-mono text-text-primary">{user.username}</td>
							<td class="px-4 py-3 text-text-secondary">{user.platform}</td>
							<td class="px-4 py-3 text-text-secondary">{user.role}</td>
							<td class="px-4 py-3 text-text-secondary">{user.added}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>
