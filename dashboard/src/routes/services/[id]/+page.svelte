<script lang="ts">
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
		<div class="flex items-center gap-3">
			<a href="/services" class="text-text-secondary hover:text-text-primary transition-colors">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</a>
			<div>
				<h1 class="text-2xl font-bold text-text-primary">{data.service.name}</h1>
				<p class="text-sm text-text-secondary mt-1">{data.service.type}</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<a href="/services/{data.service.id}/config" class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Config
			</a>
			<a href="/services/{data.service.id}/logs" class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Logs
			</a>
			{#if data.service.status === 'running'}
				<button class="px-3 py-1.5 text-xs font-medium text-accent-yellow border border-accent-yellow/30 rounded-lg hover:bg-accent-yellow/10 transition-colors">
					Restart
				</button>
				<button class="px-3 py-1.5 text-xs font-medium text-accent-red border border-accent-red/30 rounded-lg hover:bg-accent-red/10 transition-colors">
					Stop
				</button>
			{:else if data.service.status === 'stopped'}
				<button class="px-3 py-1.5 text-xs font-medium text-accent-green border border-accent-green/30 rounded-lg hover:bg-accent-green/10 transition-colors">
					Start
				</button>
			{:else if data.service.status === 'errored'}
				<button class="px-3 py-1.5 text-xs font-medium text-accent-yellow border border-accent-yellow/30 rounded-lg hover:bg-accent-yellow/10 transition-colors">
					Force Restart
				</button>
			{/if}
		</div>
	</div>

	<!-- Status Banner -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4 flex items-center gap-3">
		<span class="w-3 h-3 rounded-full shrink-0 {statusDots[data.service.status]}"></span>
		<span class="text-sm font-medium {statusColors[data.service.status]}">
			{statusLabels[data.service.status]}
		</span>
		{#if data.service.uptime}
			<span class="text-xs text-text-secondary ml-2">Uptime: {data.service.uptime}</span>
		{/if}
	</div>

	{#if data.service.errorMessage}
		<div class="px-4 py-3 bg-accent-red/10 border border-accent-red/20 rounded-lg text-sm text-accent-red">
			{data.service.errorMessage}
		</div>
	{/if}

	<!-- Info Grid -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			<h2 class="text-xs uppercase tracking-wider text-text-secondary">Service Info</h2>
			<div class="space-y-2">
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">ID</span>
					<span class="text-text-primary font-mono">{data.service.id}</span>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">Type</span>
					<span class="text-text-primary">{data.service.type}</span>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">Config Path</span>
					<span class="text-text-primary font-mono text-xs truncate ml-4">{data.service.configPath}</span>
				</div>
			</div>
		</div>

		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			<h2 class="text-xs uppercase tracking-wider text-text-secondary">Runtime</h2>
			<div class="space-y-2">
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">PID</span>
					<span class="text-text-primary font-mono">{data.service.pid ?? '---'}</span>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">Port</span>
					<span class="text-text-primary font-mono">{data.service.port ?? '---'}</span>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">RAM</span>
					<span class="text-text-primary font-mono">{data.service.ram ?? '---'}</span>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-text-secondary">CPU</span>
					<span class="text-text-primary font-mono">{data.service.cpu ?? '---'}</span>
				</div>
			</div>
		</div>
	</div>

	<!-- Quick Links -->
	<div class="flex gap-3">
		<a href="/services/{data.service.id}/config" class="flex-1 bg-bg-secondary border border-border rounded-lg p-4 hover:border-text-secondary transition-colors">
			<h3 class="text-sm font-medium text-text-primary">Configuration</h3>
			<p class="text-xs text-text-secondary mt-1">View and edit service configuration</p>
		</a>
		<a href="/services/{data.service.id}/logs" class="flex-1 bg-bg-secondary border border-border rounded-lg p-4 hover:border-text-secondary transition-colors">
			<h3 class="text-sm font-medium text-text-primary">Logs</h3>
			<p class="text-xs text-text-secondary mt-1">View recent service output</p>
		</a>
	</div>
</div>
