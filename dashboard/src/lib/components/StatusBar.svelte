<script lang="ts">
	interface ServiceStatus {
		label: string;
		status: 'online' | 'offline' | 'warning';
		text: string;
	}

	interface Props {
		services?: ServiceStatus[];
		lastSync?: string;
	}

	let {
		services = [
			{ label: 'Gateway', status: 'online', text: 'Online' },
			{ label: 'Ollama', status: 'online', text: 'Running' },
			{ label: 'Memory DB', status: 'online', text: 'Connected' },
			{ label: 'Swarm', status: 'online', text: 'Active' }
		],
		lastSync = 'just now'
	}: Props = $props();

	const dotColors: Record<string, string> = {
		online: 'bg-accent-green',
		offline: 'bg-accent-red',
		warning: 'bg-accent-yellow'
	};
</script>

<header class="sticky top-0 z-40 h-12 bg-bg-secondary border-b border-border px-6 flex items-center justify-between">
	<div class="flex items-center gap-6">
		{#each services as svc}
			<div class="flex items-center gap-2">
				<span class="w-2 h-2 rounded-full {dotColors[svc.status]}"></span>
				<span class="text-xs text-text-secondary">
					{svc.label}: <span class="text-text-primary">{svc.text}</span>
				</span>
			</div>
		{/each}
	</div>
	<span class="text-xs text-text-secondary font-mono">Last sync: {lastSync}</span>
</header>
