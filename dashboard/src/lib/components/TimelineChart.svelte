<script lang="ts">
	interface TimelineItem {
		name: string;
		schedule: string;
		priority: number;
	}

	interface Props {
		items: TimelineItem[];
	}

	let { items }: Props = $props();

	const priorityColors: Record<number, string> = {
		1: '#ef4444',
		2: '#eab308',
		3: '#3b82f6',
		4: '#22c55e',
		5: '#94a3b8'
	};

	let sorted = $derived([...items].sort((a, b) => a.priority - b.priority));
</script>

<div class="space-y-1.5">
	{#each sorted as item}
		{@const color = priorityColors[item.priority] ?? '#94a3b8'}
		<div class="flex items-center gap-3 py-1.5">
			<div class="w-1 h-6 rounded-full" style="background-color: {color}"></div>
			<div class="flex-1 min-w-0">
				<p class="text-sm text-text-primary truncate">{item.name}</p>
				<p class="text-xs text-text-secondary font-mono">{item.schedule}</p>
			</div>
			<span class="text-xs font-mono text-text-secondary shrink-0">P{item.priority}</span>
		</div>
	{/each}
</div>
