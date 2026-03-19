<script lang="ts">
	import type { RankedGraphNode, GraphEdge } from '$lib/types/graph.js';

	interface Props {
		nodes: RankedGraphNode[];
		edges?: GraphEdge[];
		onNodeClick?: (nodeId: string) => void;
		ariaLabel?: string;
		isLoading?: boolean;
		isEmpty?: boolean;
		hasError?: boolean;
		errorMessage?: string;
		onRetry?: () => void;
	}

	let { nodes, edges = [], onNodeClick, ariaLabel, isLoading = false, isEmpty = false, hasError = false, errorMessage = 'Failed to load memory graph', onRetry }: Props = $props();

	let defaultAriaLabel = $derived(`Memory knowledge graph showing ${nodes.length} nodes and ${edges.length} connections, sized by PageRank relevance`);

	let maxRank = $derived(Math.max(...nodes.map((n) => n.pageRank), 0.001));

	// --- RAF-batched updates for resize, node data, and edge data ---
	let rawContainerWidth = $state(700);
	let containerWidth = $state(700);
	let rafId: number | null = null;

	// Batch node/edge data changes through RAF to avoid redundant recomputation
	// when multiple props update in the same frame (e.g. nodes + edges together)
	let batchedNodes = $state<RankedGraphNode[]>([]);
	let batchedEdges = $state<GraphEdge[]>([]);
	let dataRafId: number | null = null;

	$effect(() => {
		// Read reactive deps (nodes, edges) to track them
		const _n = nodes;
		const _e = edges;
		if (dataRafId != null) cancelAnimationFrame(dataRafId);
		dataRafId = requestAnimationFrame(() => {
			batchedNodes = _n;
			batchedEdges = _e;
			dataRafId = null;
		});
		return () => { if (dataRafId != null) cancelAnimationFrame(dataRafId); };
	});

	function onResize(el: HTMLDivElement) {
		const ro = new ResizeObserver((entries) => {
			const newWidth = entries[0]?.contentRect.width;
			if (newWidth != null && Math.abs(newWidth - rawContainerWidth) > 1) {
				rawContainerWidth = newWidth;
				if (rafId != null) cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(() => {
					containerWidth = rawContainerWidth;
					rafId = null;
				});
			}
		});
		ro.observe(el);
		return { destroy() { ro.disconnect(); if (rafId != null) cancelAnimationFrame(rafId); } };
	}

	const width = $derived(Math.max(320, containerWidth));

	// Minimum touch-target radius (22px = 44px diameter, Apple HIG minimum)
	const MIN_TOUCH_R = 22;

	const categoryColors: Record<string, string> = {
		core: '#3b82f6',
		insights: '#a855f7',
		patterns: '#22c55e',
		security: '#ef4444'
	};

	let edgeTypeColors: Record<string, string> = {
		temporal: '#475569',
		similar: '#a855f7',
		causal: '#22c55e'
	};

	// Pre-compute edge counts per node in a single pass (O(edges) instead of O(nodes * edges))
	let edgeCountMap = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const edge of batchedEdges) {
			counts.set(edge.sourceId, (counts.get(edge.sourceId) ?? 0) + 1);
			counts.set(edge.targetId, (counts.get(edge.targetId) ?? 0) + 1);
		}
		return counts;
	});

	interface ComputedNode {
		id: string;
		x: number;
		y: number;
		r: number;
		fill: string;
		label: string;
		fullLabel: string;
		detail: string;
		edgeSummary: string;
		category: string;
		index: number;
	}

	// Single-pass: batch all per-node computations into one derived (uses RAF-batched data)
	let computedNodes = $derived.by((): ComputedNode[] => {
		const uniqueNodes = batchedNodes.slice(); // plain array copy — avoids per-element proxy subscriptions in Svelte 5
		const total = uniqueNodes.length;
		if (total === 0) return [];
		const cols = Math.ceil(Math.sqrt(total));
		const isMobile = width < 500;
		const isNarrow = width < 400;
		const baseR = isMobile ? 14 : 18;
		const scaleR = isMobile ? 26 : 36;
		const spacingX = Math.max(80, (width - 100) / cols);
		const spacingY = isMobile ? 100 : 110;
		const truncLen = isNarrow ? 8 : isMobile ? 11 : 14;

		const result: ComputedNode[] = new Array(total);
		for (let i = 0; i < total; i++) {
			const node = uniqueNodes[i];
			const row = Math.floor(i / cols);
			const col = i % cols;
			const x = 50 + col * spacingX + (row % 2 ? spacingX * 0.4 : 0);
			const y = 60 + row * spacingY;
			const r = baseR + (node.pageRank / maxRank) * scaleR;
			const edgeCount = edgeCountMap.get(node.id) ?? 0;
			const truncLabel = node.label.length > truncLen ? node.label.slice(0, truncLen) + '...' : node.label;
			result[i] = {
				id: node.id,
				x,
				y,
				r,
				fill: categoryColors[node.category] ?? '#94a3b8',
				label: truncLabel,
				fullLabel: `${node.label}: PageRank ${(node.pageRank * 100).toFixed(1)}%, ${node.accessCount} hits, category ${node.category}. ${edgeCount === 0 ? 'No connections' : `${edgeCount} connection${edgeCount > 1 ? 's' : ''}`}. Node ${i + 1} of ${total}`,
				detail: `PR ${(node.pageRank * 100).toFixed(1)}% · ${node.accessCount} hits`,
				edgeSummary: edgeCount === 0 ? 'No connections' : `${edgeCount} connection${edgeCount > 1 ? 's' : ''}`,
				category: node.category,
				index: i
			};
		}
		return result;
	});

	// Viewport culling: only render nodes within the visible SVG area (with margin for labels)
	const CULL_MARGIN = 60;
	let visibleNodes = $derived.by((): ComputedNode[] => {
		if (computedNodes.length <= 50) return computedNodes; // skip culling for small sets
		return computedNodes.filter(
			(cn) => cn.x + cn.r + CULL_MARGIN >= 0 && cn.x - cn.r - CULL_MARGIN <= width
				&& cn.y + cn.r + CULL_MARGIN >= 0 && cn.y - cn.r - CULL_MARGIN <= height
		);
	});

	// Visible edge set: only render edges where both endpoints are visible
	let visibleNodeIds = $derived.by(() => {
		if (computedNodes.length <= 50) return null; // null = render all
		const ids = new Set<string>();
		for (const cn of visibleNodes) ids.add(cn.id);
		return ids;
	});

	let visibleEdges = $derived.by(() => {
		if (visibleNodeIds === null) return batchedEdges;
		return batchedEdges.filter(
			(e) => visibleNodeIds!.has(e.sourceId) && visibleNodeIds!.has(e.targetId)
		);
	});

	// Position lookup for edge rendering (reuses computedNodes positions)
	let positionMap = $derived.by(() => {
		const map = new Map<string, { x: number; y: number }>();
		for (const cn of computedNodes) {
			map.set(cn.id, { x: cn.x, y: cn.y });
		}
		return map;
	});

	let labelFontSize = $derived(width < 500 ? 8 : 9);
	let detailFontSize = $derived(width < 500 ? 6 : 7);

	let height = $derived(batchedNodes.length === 0 ? 260 : Math.max(260, Math.ceil(batchedNodes.length / Math.ceil(Math.sqrt(batchedNodes.length))) * (width < 500 ? 100 : 110) + 80));

	/** Keyboard navigation: arrow keys move focus between nodes, Space/Enter activates */
	function handleNodeKeydown(e: KeyboardEvent, index: number) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onNodeClick?.(batchedNodes[index]?.id);
			return;
		}

		const cols = Math.ceil(Math.sqrt(batchedNodes.length));
		let target = -1;

		if (e.key === 'ArrowRight') target = Math.min(index + 1, batchedNodes.length - 1);
		else if (e.key === 'ArrowLeft') target = Math.max(index - 1, 0);
		else if (e.key === 'ArrowDown') target = Math.min(index + cols, batchedNodes.length - 1);
		else if (e.key === 'ArrowUp') target = Math.max(index - cols, 0);
		else if (e.key === 'Home') target = 0;
		else if (e.key === 'End') target = batchedNodes.length - 1;

		if (target >= 0 && target !== index) {
			e.preventDefault();
			const container = (e.currentTarget as Element)?.closest('svg');
			const allNodes = container?.querySelectorAll<SVGGElement>('[data-graph-node]');
			allNodes?.[target]?.focus();
		}
	}

	const graphDescId = 'bubble-graph-desc';
</script>

<div use:onResize class="w-full overflow-x-auto bubble-graph-container">
{#if hasError}
	<div role="alert" aria-live="assertive" class="h-48 flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
		<svg class="w-8 h-8 text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
		</svg>
		<p>{errorMessage}</p>
		{#if onRetry}
			<button onclick={onRetry} class="px-3 py-1.5 rounded bg-bg-secondary hover:bg-bg-tertiary text-text-primary text-xs transition-colors">
				Retry
			</button>
		{/if}
	</div>
{:else if isLoading}
	<div role="status" aria-live="polite" aria-label="Loading memory graph" class="h-48 flex flex-col items-center justify-center gap-3">
		<svg class="w-6 h-6 animate-spin text-accent-cyan" fill="none" viewBox="0 0 24 24" aria-hidden="true">
			<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
			<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
		</svg>
		<p class="text-text-secondary text-sm">Loading graph…</p>
	</div>
{:else if isEmpty}
	<div role="status" aria-label="Memory graph empty" class="h-48 flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
		<svg class="w-8 h-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z" />
		</svg>
		<p>No memory data to display</p>
	</div>
{:else}
<svg
	viewBox="0 0 {width} {height}"
	class="w-full"
	style="max-height: {width < 360 ? '50vh' : width < 500 ? '60vh' : '420px'}; aspect-ratio: {width} / {height}"
	role="img"
	aria-label={ariaLabel ?? defaultAriaLabel}
	aria-describedby={graphDescId}
>
	<title>Memory knowledge graph with {batchedNodes.length} nodes connected by {batchedEdges.length} edges</title>
	<desc id={graphDescId}>
		Use arrow keys to navigate between nodes. Press Enter or Space to select a node.
		Nodes are sized by PageRank relevance. Categories: core (blue), insights (purple), patterns (green), security (red).
	</desc>

	<!-- Edges (viewport-culled for large datasets) -->
	{#each visibleEdges as edge}
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

	<!-- Nodes (viewport-culled, stable keys for efficient diffing) -->
	{#each visibleNodes as cn (cn.index)}
		<g
			data-graph-node={cn.index}
			role="button"
			tabindex="0"
			aria-label={cn.fullLabel}
			class="cursor-pointer graph-node"
			onclick={() => onNodeClick?.(cn.id)}
			onkeydown={(e) => handleNodeKeydown(e, cn.index)}
		>
			<!-- Invisible hit area ensures minimum 44px touch target -->
			{#if cn.r < MIN_TOUCH_R}
				<circle
					cx={cn.x}
					cy={cn.y}
					r={MIN_TOUCH_R}
					fill="transparent"
					aria-hidden="true"
				/>
			{/if}
			<circle
				cx={cn.x}
				cy={cn.y}
				r={cn.r}
				class="node-circle"
				style="--node-fill: {cn.fill}"
			/>
			<text
				x={cn.x}
				y={cn.y - 4}
				text-anchor="middle"
				dominant-baseline="middle"
				font-size={labelFontSize}
				class="pointer-events-none node-label"
				aria-hidden="true"
			>
				{cn.label}
			</text>
			<text
				x={cn.x}
				y={cn.y + 10}
				text-anchor="middle"
				font-size={detailFontSize}
				font-family="monospace"
				class="pointer-events-none node-detail"
				aria-hidden="true"
			>
				{cn.detail}
			</text>
		</g>
	{/each}

	<!-- Legend -->
	<g transform="translate(10, {height - 24})" role="list" aria-label="Edge type legend">
		<g role="listitem">
			<line x1="0" y1="0" x2="16" y2="0" stroke="#475569" stroke-width="0.8" opacity="0.6" />
			<text x="20" y="3" font-size="7" class="legend-text">temporal</text>
		</g>
		<g role="listitem">
			<line x1="70" y1="0" x2="86" y2="0" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6" />
			<text x="90" y="3" font-size="7" class="legend-text">similar</text>
		</g>
	</g>
</svg>
{/if}
</div>

<style>
	/* Scrollable container for very narrow viewports */
	.bubble-graph-container {
		min-height: 180px;
		-webkit-overflow-scrolling: touch;
	}

	/* Focus indicator for keyboard navigation */
	.graph-node:focus {
		outline: none;
	}
	.node-circle {
		fill: var(--node-fill);
		fill-opacity: 0.85;
	}
	.node-label {
		fill: var(--color-text-primary, #e2e8f0);
	}
	.node-detail {
		fill: var(--color-text-secondary, #94a3b8);
	}
	.legend-text {
		fill: var(--color-text-secondary, #94a3b8);
	}
	.graph-node:focus-visible .node-circle {
		filter: drop-shadow(0 0 4px #38bdf8);
	}

	/* Improve tap responsiveness on mobile */
	.graph-node {
		touch-action: manipulation;
	}

	/* High-contrast mode adjustments */
	@media (prefers-contrast: more) {
		.node-circle {
			fill-opacity: 1;
			stroke: var(--node-fill);
			stroke-width: 2.5;
		}
		.node-label {
			fill: var(--ds-text-primary, #ffffff);
			font-weight: bold;
		}
		.node-detail {
			fill: var(--ds-text-secondary, #cbd5e1);
		}
		.graph-node:focus-visible .node-circle {
			stroke: var(--ds-text-primary, #ffffff);
			stroke-width: 3;
		}
		.legend-text {
			fill: var(--ds-text-secondary, #94a3b8);
		}
	}

	/* Reduced motion: disable any future animations/transitions */
	@media (prefers-reduced-motion: reduce) {
		.graph-node {
			transition: none;
		}
	}
</style>
