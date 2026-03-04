<script lang="ts">
	interface Props {
		name: string;
		category: string;
		description: string;
	}

	let { name, category, description }: Props = $props();

	const categoryColors: Record<string, string> = {
		core: 'text-accent-blue bg-accent-blue/10',
		consensus: 'text-accent-purple bg-accent-purple/10',
		github: 'text-accent-cyan bg-accent-cyan/10',
		sparc: 'text-accent-yellow bg-accent-yellow/10',
		swarm: 'text-accent-green bg-accent-green/10',
		specialized: 'text-accent-red bg-accent-red/10'
	};

	let colorClass = $derived(categoryColors[category] ?? 'text-text-secondary bg-bg-tertiary');
</script>

<div class="bg-bg-secondary border border-border rounded-lg p-3 hover:border-border/80 transition-colors">
	<div class="flex items-start justify-between gap-2">
		<h3 class="text-sm font-medium text-text-primary truncate">{name}</h3>
		<span class="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 {colorClass}">
			{category}
		</span>
	</div>
	<p class="text-xs text-text-secondary mt-1.5 line-clamp-2">{description}</p>
</div>
