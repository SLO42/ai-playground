<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';

	interface Props {
		name: string;
		command: string;
		status: 'online' | 'offline' | 'pending';
		autoStart: boolean;
	}

	let { name, command, status, autoStart }: Props = $props();
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	<div class="flex justify-between items-center mb-2">
		<h3 class="text-sm font-medium text-text-primary">{name}</h3>
		<StatusBadge {status} label={status} />
	</div>
	<p class="text-xs font-mono text-text-secondary truncate">{command}</p>
	<div class="flex justify-between mt-2 text-xs text-text-secondary">
		<span>Auto-start</span>
		<span class="font-mono text-text-primary">{autoStart ? 'Yes' : 'No'}</span>
	</div>
</div>
