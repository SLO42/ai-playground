<script lang="ts">
	import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

	interface Props {
		nodes: RankedGraphNode[];
		edges?: GraphEdge[];
		onNodeClick?: (nodeId: string) => void;
		ariaLabel?: string;
	}

	let { nodes, edges = [], onNodeClick, ariaLabel }: Props = $props();

	let defaultAriaLabel = $derived(`Memory knowledge graph showing ${nodes.length} nodes and ${edges.length} connections, sized by PageRank relevance`);

	let maxRank = $derived(Math.max(...nodes.map((n) => n.pageRank), 0.001));

	function getRadius(pageRank: number): number {
		const base = width < 500 ? 14 : 18;
		const scale = width < 500 ? 26 : 36;
		return base + (pageRank / maxRank) * scale;
	}

	let labelFontSize = $derived(width < 500 ? 8 : 9);
	let detailFontSize = $derived(width < 500 ? 6 : 7);

	function getColor(category: string): string {
		const colors: Record<string, string> = {
			core: '#3b82f6',
			insights: '#a855f7',
			patterns: '#22c55e',
			security: '#ef4444'
		};
		return colors[category] ?? '#94a3b8';
	}

	/** High-contrast color variants for prefers-contrast: more */
	function getHighContrastColor(category: string): string {
		const colors: Record<string, string> = {
			core: '#60a5fa',
			insights: '#c084fc',
			patterns: '#4ade80',
			security: '#f87171'
		};
		return colors[category] ?? '#cbd5e1';
	}

	// Responsive container width via bind:clientWidth
	let containerWidth = $state(700);
	const width = $derived(Math.max(320, containerWidth));

	// Force-directed layout with responsive spacing
	function getPosition(index: number, total: number): { x: number; y: number } {
		const cols = Math.ceil(Math.sqrt(total));
		const row = Math.floor(index / cols);
		const col = index % cols;
		// Scale spacing based on available width
		const spacingX = Math.max(80, (width - 100) / cols);
		const spacingY = width < 500 ? 90 : 110;
		return {
			x: 50 + col * spacingX + (row % 2 ? spacingX * 0.4 : 0),
			y: 60 + row * spacingY
		};
	}

	let height = $derived(Math.max(260, Math.ceil(nodes.length / Math.ceil(Math.sqrt(nodes.length))) * (width < 500 ? 90 : 110) + 80));

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

	/** Keyboard navigation: arrow keys move focus between nodes, Space/Enter activates */
	function handleNodeKeydown(e: KeyboardEvent, index: number) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onNodeClick?.(nodes[index].id);
			return;
		}

		const cols = Math.ceil(Math.sqrt(nodes.length));
		let target = -1;

		if (e.key === 'ArrowRight') target = Math.min(index + 1, nodes.length - 1);
		else if (e.key === 'ArrowLeft') target = Math.max(index - 1, 0);
		else if (e.key === 'ArrowDown') target = Math.min(index + cols, nodes.length - 1);
		else if (e.key === 'ArrowUp') target = Math.max(index - cols, 0);
		else if (e.key === 'Home') target = 0;
		else if (e.key === 'End') target = nodes.length - 1;

		if (target >= 0 && target !== index) {
			e.preventDefault();
			const container = (e.currentTarget as Element)?.closest('svg');
			const allNodes = container?.querySelectorAll<SVGGElement>('[data-graph-node]');
			allNodes?.[target]?.focus();
		}
	}

	/** Build a screen-reader summary of edges for a given node */
	function getNodeEdgeSummary(nodeId: string): string {
		const connected = edges.filter(e => e.sourceId === nodeId || e.targetId === nodeId);
		if (connected.length === 0) return 'No connections';
		return `${connected.length} connection${connected.length > 1 ? 's' : ''}`;
	}

	const graphDescId = 'bubble-graph-desc';
</script>

<div bind:clientWidth={containerWidth} class="w-full bubble-graph-container">
<svg
	viewBox="0 0 {width} {height}"
	class="w-full"
	style="max-height: {width < 500 ? '320px' : '420px'}"
	role="img"
	aria-label={ariaLabel ?? defaultAriaLabel}
	aria-describedby={graphDescId}
>
	<title>Memory knowledge graph with {nodes.length} nodes connected by {edges.length} edges</title>
	<desc id={graphDescId}>
		Use arrow keys to navigate between nodes. Press Enter or Space to select a node.
		Nodes are sized by PageRank relevance. Categories: core (blue), insights (purple), patterns (green), security (red).
	</desc>

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
				aria-hidden="true"
			/>
		{/if}
	{/each}

	<!-- Nodes -->
	{#each nodes as node, i}
		{@const pos = getPosition(i, nodes.length)}
		{@const r = getRadius(node.pageRank)}
		<g
			data-graph-node={i}
			role="button"
			tabindex="0"
			aria-label="{node.label}: PageRank {(node.pageRank * 100).toFixed(1)}%, {node.accessCount} hits, category {node.category}. {getNodeEdgeSummary(node.id)}. Node {i + 1} of {nodes.length}"
			class="cursor-pointer graph-node"
			onclick={() => onNodeClick?.(node.id)}
			onkeydown={(e) => handleNodeKeydown(e, i)}
		>
			<!-- Focus ring (visible on keyboard focus) -->
			<circle
				cx={pos.x}
				cy={pos.y}
				r={r + 3}
				fill="none"
				stroke="transparent"
				stroke-width="2"
				class="focus-ring"
			/>
			<circle
				cx={pos.x}
				cy={pos.y}
				r={r}
				fill={getColor(node.category)}
				opacity="0.2"
				stroke={getColor(node.category)}
				stroke-width="1.5"
				class="node-circle"
			/>
			<text
				x={pos.x}
				y={pos.y - 4}
				text-anchor="middle"
				dominant-baseline="middle"
				fill="#e2e8f0"
				font-size={labelFontSize}
				class="pointer-events-none node-label"
				aria-hidden="true"
			>
				{node.label.length > 14 ? node.label.slice(0, 14) + '...' : node.label}
			</text>
			<text
				x={pos.x}
				y={pos.y + 10}
				text-anchor="middle"
				fill="#94a3b8"
				font-size={detailFontSize}
				font-family="monospace"
				class="pointer-events-none node-detail"
				aria-hidden="true"
			>
				PR {(node.pageRank * 100).toFixed(1)}% · {node.accessCount} hits
			</text>
		</g>
	{/each}

	<!-- Legend -->
	<g transform="translate(10, {height - 24})" role="list" aria-label="Edge type legend">
		<g role="listitem">
			<line x1="0" y1="0" x2="16" y2="0" stroke="#475569" stroke-width="0.8" opacity="0.6" />
			<text x="20" y="3" fill="#64748b" font-size="7" class="legend-text">temporal</text>
		</g>
		<g role="listitem">
			<line x1="70" y1="0" x2="86" y2="0" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6" />
			<text x="90" y="3" fill="#64748b" font-size="7" class="legend-text">similar</text>
		</g>
	</g>
</svg>
</div>

<style>
	/* Focus indicator for keyboard navigation */
	.graph-node:focus {
		outline: none;
	}
	.graph-node:focus .focus-ring {
		stroke: #38bdf8;
		stroke-width: 2;
	}
	.graph-node:focus-visible .focus-ring {
		stroke: #38bdf8;
		stroke-width: 2.5;
		stroke-dasharray: 4 2;
	}

	/* High-contrast mode adjustments */
	@media (prefers-contrast: more) {
		.graph-node :global(.node-circle) {
			opacity: 0.4;
			stroke-width: 2.5;
		}
		.graph-node :global(.node-label) {
			fill: #ffffff;
			font-weight: bold;
		}
		.graph-node :global(.node-detail) {
			fill: #cbd5e1;
		}
		.graph-node:focus .focus-ring {
			stroke: #ffffff;
			stroke-width: 3;
		}
		:global(.legend-text) {
			fill: #94a3b8;
		}
	}

	/* Reduced motion: disable any future animations/transitions */
	@media (prefers-reduced-motion: reduce) {
		.graph-node {
			transition: none;
		}
	}
</style>
