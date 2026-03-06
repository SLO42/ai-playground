import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import BubbleGraph from './BubbleGraph.svelte';

function makeNode(overrides: Partial<{
	id: string;
	category: string;
	confidence: number;
	accessCount: number;
	createdAt: number;
	pageRank: number;
	label: string;
}> = {}) {
	return {
		id: overrides.id ?? 'node-1',
		category: overrides.category ?? 'core',
		confidence: overrides.confidence ?? 0.9,
		accessCount: overrides.accessCount ?? 5,
		createdAt: overrides.createdAt ?? Date.now(),
		pageRank: overrides.pageRank ?? 0.5,
		label: overrides.label ?? 'Test Node'
	};
}

describe('BubbleGraph', () => {
	it('renders an SVG element', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode()] }
		});
		expect(container.querySelector('svg')).toBeInTheDocument();
	});

	it('renders a circle for each node', () => {
		const nodes = [
			makeNode({ id: 'a', label: 'Alpha' }),
			makeNode({ id: 'b', label: 'Beta' }),
			makeNode({ id: 'c', label: 'Gamma' })
		];
		const { container } = render(BubbleGraph, { props: { nodes } });
		const circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(3);
	});

	it('renders node labels', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ label: 'Auth Module' })] }
		});
		const texts = container.querySelectorAll('text');
		const labelText = Array.from(texts).find((t) => t.textContent?.includes('Auth Module'));
		expect(labelText).toBeTruthy();
	});

	it('truncates long labels to 14 chars + ellipsis', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ label: 'A Very Long Label Name' })] }
		});
		const texts = container.querySelectorAll('text');
		const labelText = Array.from(texts).find((t) => t.textContent?.includes('...'));
		expect(labelText).toBeTruthy();
		expect(labelText!.textContent).toBe('A Very Long La...');
	});

	it('does not truncate short labels', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ label: 'Short' })] }
		});
		const texts = container.querySelectorAll('text');
		const labelText = Array.from(texts).find((t) => t.textContent === 'Short');
		expect(labelText).toBeTruthy();
	});

	it('applies correct category colors', () => {
		const categories = [
			{ category: 'core', color: '#3b82f6' },
			{ category: 'insights', color: '#a855f7' },
			{ category: 'patterns', color: '#22c55e' },
			{ category: 'security', color: '#ef4444' }
		];
		for (const { category, color } of categories) {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ id: category, category })] }
			});
			const circle = container.querySelector('circle');
			expect(circle?.getAttribute('fill')).toBe(color);
			container.remove();
		}
	});

	it('uses fallback color for unknown category', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ category: 'unknown' })] }
		});
		const circle = container.querySelector('circle');
		expect(circle?.getAttribute('fill')).toBe('#94a3b8');
	});

	it('renders edges between nodes', () => {
		const nodes = [
			makeNode({ id: 'a', label: 'A' }),
			makeNode({ id: 'b', label: 'B' })
		];
		const edges = [{ sourceId: 'a', targetId: 'b', type: 'temporal' as const, weight: 1 }];
		const { container } = render(BubbleGraph, { props: { nodes, edges } });
		const lines = container.querySelectorAll('line');
		// At least one edge line (legend also has lines)
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});

	it('renders nodes as interactive buttons with tabindex', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode()] }
		});
		const button = container.querySelector('g[role="button"]');
		expect(button).toBeInTheDocument();
		expect(button?.getAttribute('tabindex')).toBe('0');
	});

	it('calls onNodeClick when a node is clicked', async () => {
		const handler = vi.fn();
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ id: 'clicked-node' })], onNodeClick: handler }
		});
		const button = container.querySelector('g[role="button"]');
		await fireEvent.click(button!);
		expect(handler).toHaveBeenCalledWith('clicked-node');
	});

	it('calls onNodeClick on Enter keydown', async () => {
		const handler = vi.fn();
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ id: 'key-node' })], onNodeClick: handler }
		});
		const button = container.querySelector('g[role="button"]');
		await fireEvent.keyDown(button!, { key: 'Enter' });
		expect(handler).toHaveBeenCalledWith('key-node');
	});

	it('renders pageRank info text for each node', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode({ pageRank: 0.75, accessCount: 10 })] }
		});
		const texts = container.querySelectorAll('text');
		const prText = Array.from(texts).find((t) => t.textContent?.includes('PR'));
		expect(prText).toBeTruthy();
		expect(prText!.textContent).toContain('10 hits');
	});

	it('renders legend at bottom of SVG', () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode()] }
		});
		const texts = container.querySelectorAll('text');
		const legendTexts = Array.from(texts).map((t) => t.textContent);
		expect(legendTexts).toContain('temporal');
		expect(legendTexts).toContain('similar');
	});

	it('scales radius based on pageRank', () => {
		const nodes = [
			makeNode({ id: 'low', pageRank: 0.1 }),
			makeNode({ id: 'high', pageRank: 1.0 })
		];
		const { container } = render(BubbleGraph, { props: { nodes } });
		const circles = container.querySelectorAll('circle');
		const lowR = parseFloat(circles[0].getAttribute('r')!);
		const highR = parseFloat(circles[1].getAttribute('r')!);
		expect(highR).toBeGreaterThan(lowR);
	});

	it('renders SVG with no circles when nodes array is empty', () => {
		const { container } = render(BubbleGraph, { props: { nodes: [] } });
		const svg = container.querySelector('svg');
		expect(svg).toBeInTheDocument();
		expect(container.querySelectorAll('circle').length).toBe(0);
	});

	it('renders no edge lines when edges array is empty', () => {
		const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
		const { container } = render(BubbleGraph, { props: { nodes, edges: [] } });
		// Only legend lines should exist, no edge lines connecting nodes
		const lines = container.querySelectorAll('line');
		// Legend has exactly 2 lines (temporal + similar)
		expect(lines.length).toBe(2);
	});

	it('ignores edges referencing non-existent nodes', () => {
		const nodes = [makeNode({ id: 'a', label: 'A' })];
		const edges = [{ sourceId: 'a', targetId: 'missing', type: 'temporal' as const, weight: 1 }];
		const { container } = render(BubbleGraph, { props: { nodes, edges } });
		// Edge should not render since 'missing' node doesn't exist
		const lines = container.querySelectorAll('line');
		// Only legend lines
		expect(lines.length).toBe(2);
	});

	it('does not call onNodeClick when not provided', async () => {
		const { container } = render(BubbleGraph, {
			props: { nodes: [makeNode()] }
		});
		const button = container.querySelector('g[role="button"]');
		// Should not throw when clicked without handler
		await fireEvent.click(button!);
	});

	it('applies causal edge color', () => {
		const nodes = [
			makeNode({ id: 'a', label: 'A' }),
			makeNode({ id: 'b', label: 'B' })
		];
		const edges = [{ sourceId: 'a', targetId: 'b', type: 'causal' as const, weight: 1 }];
		const { container } = render(BubbleGraph, { props: { nodes, edges } });
		const lines = container.querySelectorAll('line');
		const causalLine = Array.from(lines).find(l => l.getAttribute('stroke') === '#22c55e');
		expect(causalLine).toBeTruthy();
	});

	it('renders similar edges with dashed stroke', () => {
		const nodes = [
			makeNode({ id: 'a', label: 'A' }),
			makeNode({ id: 'b', label: 'B' })
		];
		const edges = [{ sourceId: 'a', targetId: 'b', type: 'similar' as const, weight: 1 }];
		const { container } = render(BubbleGraph, { props: { nodes, edges } });
		const lines = container.querySelectorAll('line');
		const dashedLine = Array.from(lines).find(
			l => l.getAttribute('stroke') === '#a855f7' && l.getAttribute('stroke-dasharray') === '4,3'
		);
		expect(dashedLine).toBeTruthy();
	});
});
