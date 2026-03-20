<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div class="flex items-center gap-3">
			<a href="/services/{data.service.id}" class="text-text-secondary hover:text-text-primary transition-colors">
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
				</svg>
			</a>
			<div>
				<h1 class="text-2xl font-bold text-text-primary">{data.service.name}</h1>
				<p class="text-sm text-text-secondary mt-1">Logs</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			<a href="/services/{data.service.id}" class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Overview
			</a>
			<a href="/services/{data.service.id}/config" class="px-3 py-1.5 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-secondary transition-colors">
				Config
			</a>
		</div>
	</div>

	<!-- Log Source -->
	{#if data.logPath}
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="text-xs uppercase tracking-wider text-text-secondary mb-2">Log File</div>
			<div class="text-sm font-mono text-text-primary">{data.logPath}</div>
		</div>
	{/if}

	<!-- Log Content -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-3">
			<div class="text-xs uppercase tracking-wider text-text-secondary">Last 100 Lines</div>
		</div>
		{#if data.logError}
			<div class="px-4 py-3 bg-accent-yellow/10 border border-accent-yellow/20 rounded text-sm text-accent-yellow">
				{data.logError}
			</div>
		{:else if data.logLines.length > 0}
			<pre class="text-xs font-mono text-text-primary bg-bg-primary border border-border rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words max-h-[600px] overflow-y-auto">{data.logLines.join('\n')}</pre>
		{:else}
			<p class="text-sm text-text-secondary">Log file is empty.</p>
		{/if}
	</div>
</div>
