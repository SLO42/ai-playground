<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Services</h1>
			<p class="text-sm text-text-secondary mt-1">Services configured for ai-playground</p>
		</div>
		<div class="flex gap-2">
			<button class="px-4 py-2 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors">
				Edit .mcp.json
			</button>
			<button class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
				+ Add Service
			</button>
		</div>
	</div>

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-5 gap-4">
		<MetricCard label="Running" value={data.summary.running} accent="green" />
		<MetricCard label="Stopped" value={data.summary.stopped} accent="red" />
		<MetricCard label="From Config" value={data.summary.fromConfig} accent="blue" />
		<MetricCard label="Manual" value={data.summary.manual} accent="purple" />
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<p class="text-xs text-text-secondary uppercase tracking-wider mb-1">Config Source</p>
			{#each data.summary.configSource as src}
				<p class="text-xs font-mono text-accent-cyan">{src}</p>
			{/each}
		</div>
	</div>

	<!-- Service Cards -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
		{#each data.services as svc}
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-2">
					<div class="flex items-center gap-2">
						<span class="w-2.5 h-2.5 rounded-full {svc.status === 'running' ? 'bg-accent-green' : 'bg-accent-red'}"></span>
						<h3 class="text-sm font-bold text-text-primary">{svc.name}</h3>
					</div>
					<span class="text-xs px-2 py-0.5 rounded font-mono uppercase tracking-wider
						{svc.status === 'running' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-red/20 text-accent-red'}">
						{svc.status}
					</span>
				</div>
				{#if svc.configFile}
					<span class="text-[10px] font-mono text-accent-blue bg-accent-blue/10 px-1.5 py-0.5 rounded">{svc.configFile}</span>
				{/if}
				<p class="text-xs text-text-secondary mt-2">{svc.description}</p>

				<div class="flex items-center gap-6 mt-3 pt-3 border-t border-border">
					<div>
						<p class="text-[10px] text-text-secondary uppercase">Port</p>
						<p class="text-sm font-mono text-text-primary">{svc.port}</p>
					</div>
					<div>
						<p class="text-[10px] text-text-secondary uppercase">PID</p>
						<p class="text-sm font-mono text-text-primary">{svc.pid ?? '—'}</p>
					</div>
					<div>
						<p class="text-[10px] text-text-secondary uppercase">Uptime</p>
						<p class="text-sm font-mono text-text-primary">{svc.uptime ?? '—'}</p>
					</div>
					<div class="ml-auto flex gap-2">
						{#if svc.status === 'running'}
							<button class="p-1.5 rounded bg-bg-tertiary text-text-secondary hover:text-accent-yellow transition-colors" title="Restart">
								&#x21BA;
							</button>
							<button class="p-1.5 rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30 transition-colors" title="Stop">
								&#x25A0;
							</button>
						{:else}
							<button class="p-1.5 rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30 transition-colors" title="Start">
								&#x25B6;
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/each}
	</div>

	<!-- Auto-Start Configuration -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Auto-Start Configuration</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.autoStart as item}
				<div class="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm text-text-primary font-medium">{item.name}</span>
					<span class="text-xs font-mono text-text-secondary">{item.config}</span>
					<button
						class="w-10 h-5 rounded-full transition-colors {item.enabled ? 'bg-accent-green' : 'bg-bg-tertiary'}"
					>
						<div class="w-4 h-4 bg-white rounded-full transition-transform {item.enabled ? 'translate-x-5' : 'translate-x-0.5'}"></div>
					</button>
					<span class="text-xs font-mono text-text-secondary w-8 text-center">{item.order ?? '—'}</span>
					<span class="text-xs font-mono text-text-secondary w-12 text-center">{item.delay ?? '—'}</span>
				</div>
			{/each}
		</div>
	</div>

	<!-- Recent Logs -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Recent Service Logs</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 font-mono text-xs space-y-1">
			{#each data.logs as log}
				<div class="flex gap-4">
					<span class="text-text-secondary shrink-0">{log.time}</span>
					<span class="text-accent-cyan shrink-0">[{log.source}]</span>
					<span class="{log.level === 'error' ? 'text-accent-red' : 'text-accent-green'}">{log.message}</span>
				</div>
			{/each}
		</div>
	</div>
</div>
