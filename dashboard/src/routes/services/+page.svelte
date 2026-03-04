<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	const statusColors: Record<string, string> = {
		running: 'text-accent-green',
		stopped: 'text-text-secondary',
		errored: 'text-accent-red'
	};

	const statusDots: Record<string, string> = {
		running: 'bg-accent-green',
		stopped: 'bg-text-secondary',
		errored: 'bg-accent-red'
	};

	const statusLabels: Record<string, string> = {
		running: 'Running',
		stopped: 'Stopped',
		errored: 'Errored'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="text-2xl font-bold text-text-primary">Services</h1>
			<p class="text-sm text-text-secondary mt-1">Manage MCP servers, project services, and background processes</p>
		</div>
		<div class="flex items-center gap-2">
			<button class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Import Config
			</button>
			<a href="/services/new" class="px-3 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors">
				+ New Service
			</a>
		</div>
	</div>

	<!-- Stat Cards -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Running" value={data.stats.running} accent="green" />
		<MetricCard label="Stopped" value={data.stats.stopped} accent="yellow" />
		<MetricCard label="Errored" value={data.stats.errored} accent="red" />
		<MetricCard label="Total Services" value={data.stats.total} accent="blue" />
	</div>

	<!-- Active Services label -->
	<div class="text-xs text-text-secondary uppercase tracking-wider">Active Services</div>

	<!-- Service List -->
	<div class="space-y-2">
		{#each data.services as service}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center gap-4">
					<!-- Status + Name -->
					<div class="flex items-center gap-3 min-w-0 flex-1">
						<span class="w-2.5 h-2.5 rounded-full shrink-0 {statusDots[service.status]}"></span>
						<div class="min-w-0">
							<div class="text-sm font-medium text-text-primary">{service.name}</div>
							<div class="text-xs text-text-secondary">{service.type}</div>
							<div class="text-xs font-mono text-text-secondary truncate">{service.configPath}</div>
						</div>
					</div>

					<!-- PID / Port -->
					<div class="hidden md:flex items-center gap-6 text-xs shrink-0">
						{#if service.pid}
							<div>
								<span class="text-text-secondary">PID</span>
								<span class="text-text-primary font-mono ml-1">{service.pid}</span>
							</div>
						{/if}
						{#if service.port}
							<div>
								<span class="text-text-secondary">Port</span>
								<span class="text-text-primary font-mono ml-1">{service.port}</span>
							</div>
						{/if}
						{#if service.uptime}
							<div>
								<span class="text-text-secondary">{service.uptime}</span>
							</div>
						{/if}
						{#if service.ram}
							<div>
								<span class="text-text-secondary">RAM</span>
								<span class="text-text-primary font-mono ml-1">{service.ram}</span>
							</div>
						{/if}
						{#if service.cpu}
							<div>
								<span class="text-text-secondary">CPU</span>
								<span class="text-text-primary font-mono ml-1">{service.cpu}</span>
							</div>
						{/if}
					</div>

					<!-- Status + Actions -->
					<div class="flex items-center gap-2 shrink-0">
						<span class="text-xs font-medium {statusColors[service.status]}">{statusLabels[service.status]}</span>

						{#if service.status === 'running'}
							<button class="px-2 py-1 text-xs text-accent-red border border-accent-red/30 rounded hover:bg-accent-red/10 transition-colors">Stop</button>
							<button class="px-2 py-1 text-xs text-accent-yellow border border-accent-yellow/30 rounded hover:bg-accent-yellow/10 transition-colors">Restart</button>
						{:else if service.status === 'stopped'}
							<button class="px-2 py-1 text-xs text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors">Start</button>
						{:else if service.status === 'errored'}
							<button class="px-2 py-1 text-xs text-accent-yellow border border-accent-yellow/30 rounded hover:bg-accent-yellow/10 transition-colors">Force Restart</button>
						{/if}

						<button class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors">Logs</button>
						<button class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors">Config</button>
					</div>
				</div>

				{#if service.errorMessage}
					<div class="mt-2 px-3 py-1.5 bg-accent-red/10 border border-accent-red/20 rounded text-xs text-accent-red">
						PID {service.pid} - CRASHED: {service.errorMessage}
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
