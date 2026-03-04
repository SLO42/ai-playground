<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();
</script>

<svelte:head>
	<title>AI Playground Dashboard</title>
</svelte:head>

<div class="flex min-h-screen">
	<Sidebar />

	<div class="flex-1 ml-56">
		<!-- Status Bar -->
		<header class="sticky top-0 z-40 bg-bg-primary/80 backdrop-blur border-b border-border px-6 py-2 flex items-center justify-between">
			<div class="flex items-center gap-4">
				<StatusBadge status={data.health.ollama ? 'online' : 'offline'} label="Ollama" size="sm" />
				<StatusBadge status={data.health.gateway ? 'online' : 'offline'} label="Gateway" size="sm" />
				<StatusBadge status={data.health.swarm ? 'online' : 'offline'} label="Swarm" size="sm" />
				<StatusBadge status={data.health.security ? 'clean' : 'warning'} label="Security" size="sm" />
			</div>
			<span class="text-xs text-text-secondary font-mono">{data.health.timestamp}</span>
		</header>

		<!-- Page Content -->
		<main class="p-6">
			{@render children()}
		</main>
	</div>
</div>
