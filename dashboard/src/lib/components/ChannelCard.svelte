<script lang="ts">
	import StatusBadge from './StatusBadge.svelte';

	interface Props {
		name: string;
		enabled: boolean;
		activation: string;
		commandPrefix: string;
		userMode: string;
		userCount: number;
	}

	let { name, enabled, activation, commandPrefix, userMode, userCount }: Props = $props();
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-4">
	<div class="flex justify-between items-center mb-3">
		<h3 class="text-sm font-medium text-text-primary capitalize">{name}</h3>
		<StatusBadge status={enabled ? 'online' : 'offline'} label={enabled ? 'Active' : 'Disabled'} />
	</div>
	<div class="space-y-1.5 text-xs text-text-secondary">
		<div class="flex justify-between">
			<span>Activation</span>
			<span class="font-mono text-text-primary">{activation}</span>
		</div>
		<div class="flex justify-between">
			<span>Prefix</span>
			<span class="font-mono text-text-primary">{commandPrefix}</span>
		</div>
		<div class="flex justify-between">
			<span>Access</span>
			<span class="font-mono text-text-primary">{userMode}</span>
		</div>
		<div class="flex justify-between">
			<span>Users</span>
			<span class="font-mono text-text-primary">{userCount}</span>
		</div>
	</div>
</div>
