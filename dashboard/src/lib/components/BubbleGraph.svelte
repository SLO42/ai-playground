<script lang="ts">
	import type { GraphNode } from '$lib/types/graph.js';

	interface Props {
		nodes: (GraphNode & { pageRank: number; label: string })[];
		onNodeClick?: (nodeId: string) => void;
	}

	let { nodes, onNodeClick }: Props = $props();

	let maxRank = $derived(Math.max(...nodes.map((n) => n.pageRank), 0.001));

	function getRadius(pageRank: number): number {
		return 16 + (pageRank / maxRank) * 40;
	}

	function getColor(category: string): string {
		const colors: Record<string, string> = {
			core: '#3b82f6',
			insights: '#a855f7',
			patterns: '#22c55e',
			security: '#ef4444'
		};
		return colors[category] ?? '#94a3b8';
	}

	// Simple force-directed layout approximation
	function getPosition(index: number, total: number): { x: number; y: number } {
		const cols = Math.ceil(Math.sqrt(total));
		const row = Math.floor(index / cols);
		const col = index % cols;
		const spacing = 100;
		return {
			x: 80 + col * spacing + (row % 2 ? 40 : 0),
			y: 60 + row * spacing
		};
	}

	const width = 600;
	let height = $derived(Math.max(300, Math.ceil(nodes.length / Math.ceil(Math.sqrt(nodes.length))) * 100 + 80));
</script>

<svg viewBox="0 0 {width} {height}" class="w-full" style="max-height: 400px">
	{#each nodes as node, i}
		{@const pos = getPosition(i, nodes.length)}
		{@const r = getRadius(node.pageRank)}
		<g
			role="button"
			tabindex="0"
			class="cursor-pointer"
			onclick={() => onNodeClick?.(node.id)}
			onkeydown={(e) => e.key === 'Enter' && onNodeClick?.(node.id)}
		>
			<circle
				cx={pos.x}
				cy={pos.y}
				r={r}
				fill={getColor(node.category)}
				opacity="0.25"
				stroke={getColor(node.category)}
				stroke-width="1.5"
			/>
			<text
				x={pos.x}
				y={pos.y}
				text-anchor="middle"
				dominant-baseline="middle"
				fill="#e2e8f0"
				font-size="9"
				class="pointer-events-none"
			>
				{node.label.length > 12 ? node.label.slice(0, 12) + '...' : node.label}
			</text>
			<text
				x={pos.x}
				y={pos.y + 14}
				text-anchor="middle"
				fill="#94a3b8"
				font-size="8"
				font-family="monospace"
				class="pointer-events-none"
			>
				{(node.pageRank * 100).toFixed(1)}%
			</text>
		</g>
	{/each}
</svg>
