<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import ChannelCard from '$lib/components/ChannelCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let gw = $derived(data.gateway?.gateway);
	let dm = $derived(data.gateway?.dm);
	let twitch = $derived(data.twitch);
	let policy = $derived(data.policy);

	let allowlistUsers = $derived(twitch?.users?.allowlist ?? []);

	let validationRules = $derived((policy as any)?.inputValidation?.rules ?? []);
	const validationColumns = [
		{ key: 'name', label: 'Rule', mono: true },
		{ key: 'action', label: 'Action' },
		{ key: 'severity', label: 'Severity' }
	];
</script>

<div class="space-y-6">
	<h1 class="text-lg font-semibold text-text-primary">Channels</h1>

	<!-- Gateway Configuration -->
	<section class="space-y-4">
		<h2 class="text-sm text-text-secondary uppercase tracking-wider">Gateway Configuration</h2>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			<MetricCard label="Host" value={gw?.host ?? '—'} accent="cyan" />
			<MetricCard label="Port" value={gw?.port ?? '—'} accent="blue" />
			<MetricCard label="Protocol" value={gw?.protocol ?? '—'} accent="purple" />
			<MetricCard
				label="TLS"
				value={gw?.tls?.enabled ? gw.tls.minVersion : 'Disabled'}
				accent={gw?.tls?.enabled ? 'green' : 'red'}
			/>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
			<!-- Auth -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Authentication</h3>
				<div class="space-y-2 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Mode</span>
						<span class="font-mono text-text-primary">{gw?.auth?.mode ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Token Rotation</span>
						<span class="font-mono text-text-primary">{gw?.auth?.tokenRotationInterval ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Max Session</span>
						<span class="font-mono text-text-primary">{gw?.auth?.maxSessionDuration ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">MFA Required</span>
						<StatusBadge
							status={gw?.auth?.requireMFA ? 'online' : 'warning'}
							label={gw?.auth?.requireMFA ? 'Yes' : 'No'}
						/>
					</div>
				</div>
			</div>

			<!-- Rate Limiting -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Rate Limiting</h3>
				<div class="space-y-2 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Status</span>
						<StatusBadge
							status={gw?.rateLimit?.enabled ? 'online' : 'offline'}
							label={gw?.rateLimit?.enabled ? 'Enabled' : 'Disabled'}
						/>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Max Req/min</span>
						<span class="font-mono text-text-primary">{gw?.rateLimit?.maxRequestsPerMinute ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Max Conn/IP</span>
						<span class="font-mono text-text-primary">{gw?.rateLimit?.maxConnectionsPerIP ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Burst Limit</span>
						<span class="font-mono text-text-primary">{gw?.rateLimit?.burstLimit ?? '—'}</span>
					</div>
				</div>
			</div>

			<!-- CORS -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">CORS</h3>
				<div class="space-y-2 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Status</span>
						<StatusBadge
							status={gw?.cors?.enabled ? 'online' : 'offline'}
							label={gw?.cors?.enabled ? 'Enabled' : 'Disabled'}
						/>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Credentials</span>
						<span class="font-mono text-text-primary">{gw?.cors?.allowCredentials ? 'Yes' : 'No'}</span>
					</div>
					<div class="mt-2">
						<span class="text-text-secondary block mb-1">Allowed Origins</span>
						{#each gw?.cors?.allowedOrigins ?? [] as origin}
							<span class="inline-block bg-bg-tertiary text-text-primary font-mono px-2 py-0.5 rounded mr-1 mb-1">{origin}</span>
						{/each}
						{#if !gw?.cors?.allowedOrigins?.length}
							<span class="text-text-secondary">None</span>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Channels -->
	<section class="space-y-4">
		<h2 class="text-sm text-text-secondary uppercase tracking-wider">Channels</h2>

		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
			{#if twitch}
				<ChannelCard
					name={twitch.channel}
					enabled={twitch.enabled}
					activation={twitch.activation}
					commandPrefix={twitch.commandPrefix}
					userMode={twitch.users?.mode ?? 'open'}
					userCount={allowlistUsers.length}
				/>
			{:else}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<p class="text-sm text-text-secondary">No channel configurations found.</p>
				</div>
			{/if}
		</div>
	</section>

	<!-- User Access -->
	<section class="space-y-4">
		<h2 class="text-sm text-text-secondary uppercase tracking-wider">User Access</h2>

		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<!-- DM Policy -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center gap-2 mb-3">
					<h3 class="text-xs text-text-secondary uppercase tracking-wider">DM Policy</h3>
					<StatusBadge
						status={dm?.policy === 'pairing' ? 'online' : 'warning'}
						label={dm?.policy ?? 'unknown'}
					/>
				</div>
				<div class="space-y-2 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Mode</span>
						<span class="font-mono text-text-primary">{dm?.policy ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Pairing Code Expiry</span>
						<span class="font-mono text-text-primary">{dm?.pairingCodeExpiry ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Max Attempts</span>
						<span class="font-mono text-text-primary">{dm?.maxPairingAttempts ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Allowlist</span>
						<span class="font-mono text-text-primary">{dm?.allowlist?.length ?? 0} users</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Blocklist</span>
						<span class="font-mono text-text-primary">{dm?.blocklist?.length ?? 0} users</span>
					</div>
				</div>
			</div>

			<!-- Channel Allowlist -->
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Twitch Allowlist</h3>
				{#if allowlistUsers.length > 0}
					<div class="space-y-1.5">
						{#each allowlistUsers as user}
							<div class="flex items-center gap-2 text-xs">
								<span class="w-2 h-2 rounded-full bg-accent-green"></span>
								<span class="font-mono text-text-primary">{user}</span>
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-text-secondary">No users in the allowlist. Add family Twitch usernames to the channel config.</p>
				{/if}
				<div class="mt-3 pt-3 border-t border-border space-y-1.5 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Access Mode</span>
						<span class="font-mono text-text-primary">{twitch?.users?.mode ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Ignore Unknown</span>
						<StatusBadge
							status={twitch?.users?.ignoreUnknown ? 'online' : 'warning'}
							label={twitch?.users?.ignoreUnknown ? 'Yes' : 'No'}
						/>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Log Denied</span>
						<StatusBadge
							status={twitch?.users?.logDenied ? 'online' : 'offline'}
							label={twitch?.users?.logDenied ? 'Yes' : 'No'}
						/>
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Security Summary -->
	<section class="space-y-4">
		<h2 class="text-sm text-text-secondary uppercase tracking-wider">Security Summary</h2>

		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Firewall</h3>
				<div class="space-y-2 text-xs">
					<div class="flex justify-between">
						<span class="text-text-secondary">Default Action</span>
						<StatusBadge
							status={(policy as any)?.firewall?.defaultAction === 'deny' ? 'online' : 'warning'}
							label={(policy as any)?.firewall?.defaultAction ?? 'unknown'}
						/>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Inbound Rules</span>
						<span class="font-mono text-text-primary">{(policy as any)?.firewall?.inbound?.length ?? 0}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">Outbound Rules</span>
						<span class="font-mono text-text-primary">{(policy as any)?.firewall?.outbound?.length ?? 0}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">TLS Minimum</span>
						<span class="font-mono text-text-primary">{(policy as any)?.transport?.minTLSVersion ?? '—'}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-text-secondary">HTTPS Enforced</span>
						<StatusBadge
							status={(policy as any)?.transport?.enforceHTTPS ? 'online' : 'warning'}
							label={(policy as any)?.transport?.enforceHTTPS ? 'Yes' : 'No'}
						/>
					</div>
				</div>
			</div>

			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<h3 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Input Validation</h3>
				<div class="mb-3">
					<StatusBadge
						status={(policy as any)?.inputValidation?.enabled ? 'online' : 'warning'}
						label={(policy as any)?.inputValidation?.enabled ? 'Enabled' : 'Disabled'}
					/>
				</div>
				{#if validationRules.length > 0}
					<DataTable columns={validationColumns} rows={validationRules} />
				{:else}
					<p class="text-xs text-text-secondary">No validation rules configured.</p>
				{/if}
			</div>
		</div>
	</section>
</div>
