<script lang="ts">
	import '../app.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import type { LayoutData } from './$types.js';

	let { data, children }: { data: LayoutData; children: any } = $props();

	let services = $derived([
		{ label: 'Gateway', status: (data.health.gateway ? 'online' : 'offline') as 'online' | 'offline', text: data.health.gateway ? 'Online' : 'Offline' },
		{ label: 'Ollama', status: (data.health.ollama ? 'online' : 'offline') as 'online' | 'offline', text: data.health.ollama ? 'Running' : 'Stopped' },
		{ label: 'Memory DB', status: ('online' as const), text: 'Connected' },
		{ label: 'Swarm', status: (data.health.swarm ? 'online' : 'warning') as 'online' | 'warning', text: data.health.swarm ? 'Active' : 'Idle' }
	]);
</script>

<svelte:head>
	<title>AI Playground Dashboard</title>
</svelte:head>

<div class="flex min-h-screen bg-bg-primary">
	<Sidebar />

	<div class="flex-1 ml-56 flex flex-col">
		<StatusBar {services} lastSync={data.health.timestamp} />

		<main class="flex-1 p-6">
			{@render children()}
		</main>
	</div>
</div>
