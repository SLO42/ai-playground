<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<div class="space-y-8">
	<!-- Platform Header -->
	<div>
		<h1 class="text-2xl font-bold text-text-primary">
			About
		</h1>
		<p class="text-sm text-text-secondary mt-1">Services, integrations, and project stack details</p>
	</div>

	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center gap-3 mb-2">
			<h2 class="text-lg font-semibold text-text-primary">{data.platform.name}</h2>
			<span class="text-xs font-mono text-accent-cyan bg-accent-cyan/10 px-2 py-0.5 rounded">{data.platform.version}</span>
		</div>
		<p class="text-sm text-text-secondary">{data.platform.description}</p>
	</div>

	<!-- Core Technologies -->
	<section>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Core Technologies</h2>
		<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
			{#each data.coreTech as tech}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-1">
						<span class="w-2 h-2 rounded-full bg-{tech.color}"></span>
						<span class="text-sm font-medium text-text-primary">{tech.name}</span>
					</div>
					<p class="text-xs font-mono text-text-secondary">{tech.version}</p>
					<p class="text-xs text-text-secondary mt-1">{tech.description}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- Stack Panels -->
	<section>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Stack</h2>
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			{#each data.stack as panel}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center gap-2 mb-2">
						<span class="w-2.5 h-2.5 rounded-full bg-{panel.color}"></span>
						<h3 class="text-sm font-semibold text-text-primary">{panel.name}</h3>
					</div>
					<p class="text-xs text-text-secondary mb-3">{panel.description}</p>
					<ul class="space-y-1">
						{#each panel.details as detail}
							<li class="text-xs text-text-secondary font-mono flex items-center gap-2">
								<span class="text-text-secondary">&bull;</span>
								{detail}
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>
	</section>

	<!-- Connected MCP + Channels -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
		<!-- MCP Servers -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Connected MCP Servers</h2>
			<div class="space-y-2">
				{#each data.mcpServers as server}
					<div class="flex items-center justify-between py-1.5 border-b border-border last:border-0">
						<span class="text-sm text-text-primary">{server.name}</span>
						<StatusBadge
							status={server.status === 'connected' ? 'online' : 'offline'}
							label={server.status}
							size="sm"
						/>
					</div>
				{/each}
			</div>
		</div>

		<!-- Active Channels -->
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Active Channels</h2>
			<div class="space-y-2">
				{#each data.channels as channel}
					<div class="flex items-center justify-between py-1.5 border-b border-border last:border-0">
						<div>
							<span class="text-sm text-text-primary">{channel.name}</span>
							<span class="text-xs text-text-secondary ml-2">{channel.type}</span>
						</div>
						<StatusBadge
							status={channel.status === 'active' ? 'online' : 'offline'}
							label={channel.status}
							size="sm"
						/>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Resources -->
	<section>
		<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Resources</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
				<div>
					<p class="text-text-secondary text-xs mb-1">Ruflo / Claude Flow</p>
					<p class="text-accent-blue font-mono text-xs">github.com/ruvnet/ruflo</p>
				</div>
				<div>
					<p class="text-text-secondary text-xs mb-1">OpenClaw</p>
					<p class="text-accent-blue font-mono text-xs">docs.openclaw.ai</p>
				</div>
				<div>
					<p class="text-text-secondary text-xs mb-1">Community</p>
					<p class="text-accent-blue font-mono text-xs">discord.gg/clawd</p>
				</div>
			</div>
		</div>
	</section>
</div>
