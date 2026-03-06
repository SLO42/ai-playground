<script lang="ts">
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let gw = $derived(data.gateway?.gateway);
	let dm = $derived(data.gateway?.dm);
	let twitch = $derived(data.twitch);
	let channelConfigs = $derived(data.channelConfigs ?? []);

	let gatewayConfig = $derived.by(() => {
		if (!gw) return [];
		return [
			{ label: 'Bind Address', value: `${gw.host}:${gw.port}` },
			{ label: 'Protocol', value: gw.protocol?.toUpperCase() ?? 'N/A' },
			{ label: 'TLS', value: gw.tls?.enabled ? `${gw.tls.minVersion} (enforced)` : 'Disabled' },
			{ label: 'Auth Mode', value: gw.auth?.mode ?? 'N/A' },
			{ label: 'MFA Required', value: gw.auth?.requireMFA ? 'Yes' : 'No' },
			{ label: 'Rate Limit', value: gw.rateLimit?.enabled ? `${gw.rateLimit.maxRequestsPerMinute} req/min` : 'Disabled' },
			{ label: 'Max Connections/IP', value: String(gw.rateLimit?.maxConnectionsPerIP ?? 'N/A') },
			{ label: 'Burst Limit', value: String(gw.rateLimit?.burstLimit ?? 'N/A') },
			{ label: 'Verbose Logging', value: gw.verbose ? 'Enabled' : 'Disabled' }
		];
	});

	const channelColors: Record<string, string> = {
		twitch: 'bg-accent-purple',
		discord: 'bg-accent-blue',
		telegram: 'bg-accent-cyan',
		whatsapp: 'bg-accent-green',
		imessage: 'bg-accent-green'
	};

	let channels = $derived.by(() => {
		return channelConfigs.map((cfg) => {
			const key = cfg.channel?.toLowerCase() ?? '';
			const displayName = key.charAt(0).toUpperCase() + key.slice(1);
			return {
				name: displayName === 'Imessage' ? 'iMessage' : displayName,
				status: cfg.enabled ? 'Connected' : 'Disabled',
				statusColor: cfg.enabled ? 'text-accent-green' : 'text-text-secondary',
				dotColor: cfg.enabled ? (channelColors[key] ?? 'bg-accent-cyan') : 'bg-text-secondary',
				desc: cfg.channel ? `#${cfg.channel}` : 'Not configured',
				users: cfg.users?.allowlist?.length ?? 0
			};
		});
	});

	const availableChannels = [
		{ name: 'Telegram', desc: 'Messaging bot via Telegram Bot API' },
		{ name: 'Discord', desc: 'Discord bot with slash commands' },
		{ name: 'WhatsApp', desc: 'WhatsApp Business API integration' },
		{ name: 'Twitch', desc: 'Twitch chat bot integration' },
		{ name: 'iMessage', desc: 'iMessage via BlueBubbles (requires Mac server)' }
	];

	let addableChannels = $derived(
		availableChannels.filter((ac) => !channels.some((c) => c.name === ac.name))
	);

	let showAddModal = $state(false);
	let creating = $state<string | null>(null);
	let createError = $state<string | null>(null);

	async function createChannel(name: string) {
		creating = name;
		createError = null;
		try {
			const res = await apiFetch('/api/channels', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const result = await res.json();
			if (!res.ok) {
				createError = result.error ?? 'Failed to create channel';
				return;
			}
			showAddModal = false;
			window.location.reload();
		} catch {
			createError = 'Network error';
		} finally {
			creating = null;
		}
	}

	let allowlist = $derived.by(() => {
		const users = twitch?.users?.allowlist ?? [];
		return users.map((username: string, i: number) => ({
			username,
			platform: 'Twitch',
			role: i === 0 ? 'Admin' : 'Member'
		}));
	});
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
				<span class="text-accent-cyan font-mono">{dm?.policy ?? 'N/A'}</span>
			</p>
			<p class="text-xs text-text-secondary mb-1">
				Code Expiry: <span class="font-mono text-text-primary">{dm?.pairingCodeExpiry ?? 'N/A'}</span>
			</p>
			<p class="text-xs text-text-secondary mb-3">
				Max Attempts: <span class="font-mono text-text-primary">{dm?.maxPairingAttempts ?? 'N/A'}</span>
			</p>
			<div class="space-y-1 text-sm">
				<p class="text-text-primary">Allowlisted: <span class="font-mono">{dm?.allowlist?.length ?? 0}</span></p>
				<p class="text-text-secondary">Blocked: <span class="font-mono">{dm?.blocklist?.length ?? 0}</span></p>
			</div>
		</div>
	</div>

	<!-- Connected Channels -->
	<section>
		<h2 class="type-section-title text-text-primary mb-4">Connected Channels</h2>
		{#if channels.length > 0}
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
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-8 text-center">
				<p class="text-text-secondary">No channels configured yet.</p>
			</div>
		{/if}
	</section>

	<!-- Connected Channels grid includes Add card -->
	{#if channels.length > 0}
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 -mt-2">
			{#if addableChannels.length > 0}
				<button
					onclick={() => (showAddModal = true)}
					class="bg-bg-secondary border border-dashed border-border rounded-lg p-4 text-left hover:border-accent-blue/50 hover:bg-bg-tertiary/30 transition-colors group flex flex-col items-center justify-center min-h-[120px]"
				>
					<span class="w-8 h-8 rounded-lg bg-bg-tertiary text-text-secondary text-lg flex items-center justify-center group-hover:bg-accent-blue/20 group-hover:text-accent-blue transition-colors mb-2">+</span>
					<span class="text-sm text-text-secondary group-hover:text-text-primary transition-colors">Add Channel</span>
				</button>
			{/if}
		</div>
	{/if}

	<!-- Show Add button when no channels exist -->
	{#if channels.length === 0}
		<div class="flex justify-center">
			<button
				onclick={() => (showAddModal = true)}
				class="px-4 py-2 text-sm font-medium rounded-lg bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
			>
				+ Add Channel
			</button>
		</div>
	{/if}

	<!-- Add Channel Modal -->
	{#if showAddModal}
		<div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onclick={() => (showAddModal = false)} onkeydown={(e) => { if (e.key === 'Escape') showAddModal = false; }} role="dialog" aria-modal="true" aria-label="Add Channel">
			<div class="bg-bg-secondary border border-border rounded-xl w-full max-w-md mx-4 shadow-xl" onclick={(e) => e.stopPropagation()} role="document">
				<div class="flex items-center justify-between px-5 py-4 border-b border-border">
					<h2 class="text-sm font-bold text-text-primary">Add Channel</h2>
					<button onclick={() => (showAddModal = false)} class="text-text-secondary hover:text-text-primary transition-colors text-lg leading-none" aria-label="Close">&times;</button>
				</div>
				<div class="p-5 space-y-2">
					<p class="text-xs text-text-secondary mb-2">Scaffold a channel config in <code class="font-mono">config/openclaw/channels/</code>:</p>
					{#if createError}
						<p class="text-xs text-accent-red bg-accent-red/10 rounded px-3 py-2">{createError}</p>
					{/if}
					{#each addableChannels as ch}
						<div class="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-bg-tertiary/30 text-left">
							<span class="w-8 h-8 rounded-lg bg-bg-tertiary text-text-secondary text-xs flex items-center justify-center font-bold">
								{ch.name.charAt(0)}
							</span>
							<div class="min-w-0 flex-1">
								<p class="text-sm text-text-primary font-medium">{ch.name}</p>
								<p class="text-xs text-text-secondary">{ch.desc}</p>
							</div>
							<button
								onclick={() => createChannel(ch.name)}
								disabled={creating !== null}
								class="ml-auto flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								{creating === ch.name ? 'Creating...' : 'Create'}
							</button>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

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
					</tr>
				</thead>
				<tbody>
					{#each allowlist as user}
						<tr class="border-b border-border last:border-0">
							<td class="px-4 py-3 font-mono text-text-primary">{user.username}</td>
							<td class="px-4 py-3 text-text-secondary">{user.platform}</td>
							<td class="px-4 py-3 text-text-secondary">{user.role}</td>
						</tr>
					{/each}
					{#if allowlist.length === 0}
						<tr>
							<td colspan="3" class="px-4 py-3 text-text-secondary text-center">No users in allowlist</td>
						</tr>
					{/if}
				</tbody>
			</table>
		</div>
	</section>
</div>
