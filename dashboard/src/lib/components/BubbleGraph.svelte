<script lang="ts">
	import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

	interface Props {
		nodes: RankedGraphNode[];
		edges?: GraphEdge[];
		onNodeClick?: (nodeId: string) => void;
	}

	let { nodes, edges = [], onNodeClick }: Props = $props();

	let maxRank = $derived(Math.max(...nodes.map((n) => n.pageRank), 0.001));

	function getRadius(pageRank: number): number {
		return 18 + (pageRank / maxRank) * 36;
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

	// Force-directed layout with better spacing
	function getPosition(index: number, total: number): { x: number; y: number } {
		const cols = Math.ceil(Math.sqrt(total));
		const row = Math.floor(index / cols);
		const col = index % cols;
		const spacingX = 120;
		const spacingY = 110;
		return {
			x: 80 + col * spacingX + (row % 2 ? 50 : 0),
			y: 60 + row * spacingY
		};
	}

	const width = 700;
	let height = $derived(Math.max(300, Math.ceil(nodes.length / Math.ceil(Math.sqrt(nodes.length))) * 110 + 80));

	// Build position lookup for edges
	let positionMap = $derived.by(() => {
		const map = new Map<string, { x: number; y: number }>();
		nodes.forEach((node, i) => {
			map.set(node.id, getPosition(i, nodes.length));
		});
		return map;
	});

	let edgeTypeColors: Record<string, string> = {
		temporal: '#475569',
		similar: '#a855f7',
		causal: '#22c55e'
	};
</script>

<svg viewBox="0 0 {width} {height}" class="w-full" style="max-height: 420px" role="img" aria-label="Memory knowledge graph showing {nodes.length} nodes and {edges.length} connections, sized by PageRank relevance">
	<title>Memory knowledge graph with {nodes.length} nodes connected by {edges.length} edges</title>
	<!-- Edges -->
	{#each edges as edge}
		{@const from = positionMap.get(edge.sourceId)}
		{@const to = positionMap.get(edge.targetId)}
		{#if from && to}
			<line
				x1={from.x}
				y1={from.y}
				x2={to.x}
				y2={to.y}
				stroke={edgeTypeColors[edge.type] ?? '#475569'}
				stroke-width={edge.type === 'similar' ? 1.5 : 0.8}
				stroke-dasharray={edge.type === 'similar' ? '4,3' : 'none'}
				opacity="0.4"
			/>
		{/if}
	{/each}

	<!-- Nodes -->
	{#each nodes as node, i}
		{@const pos = getPosition(i, nodes.length)}
		{@const r = getRadius(node.pageRank)}
		<g
			role="button"
			tabindex="0"
			aria-label="{node.label}: PageRank {(node.pageRank * 100).toFixed(1)}%, {node.accessCount} hits, category {node.category}"
			class="cursor-pointer"
			onclick={() => onNodeClick?.(node.id)}
			onkeydown={(e) => e.key === 'Enter' && onNodeClick?.(node.id)}
		>
			<circle
				cx={pos.x}
				cy={pos.y}
				r={r}
				fill={getColor(node.category)}
				opacity="0.2"
				stroke={getColor(node.category)}
				stroke-width="1.5"
			/>
			<text
				x={pos.x}
				y={pos.y - 4}
				text-anchor="middle"
				dominant-baseline="middle"
				fill="#e2e8f0"
				font-size="9"
				class="pointer-events-none"
			>
				{node.label.length > 14 ? node.label.slice(0, 14) + '...' : node.label}
			</text>
			<text
				x={pos.x}
				y={pos.y + 10}
				text-anchor="middle"
				fill="#94a3b8"
				font-size="7"
				font-family="monospace"
				class="pointer-events-none"
			>
				PR {(node.pageRank * 100).toFixed(1)}% · {node.accessCount} hits
			</text>
		</g>
	{/each}

	<!-- Legend -->
	<g transform="translate(10, {height - 24})">
		<line x1="0" y1="0" x2="16" y2="0" stroke="#475569" stroke-width="0.8" opacity="0.6" />
		<text x="20" y="3" fill="#64748b" font-size="7">temporal</text>
		<line x1="70" y1="0" x2="86" y2="0" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6" />
		<text x="90" y="3" fill="#64748b" font-size="7">similar</text>
	</g>
</svg>
