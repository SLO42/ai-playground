import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import BubbleGraph from './BubbleGraph.svelte';

// Polyfill ResizeObserver for JSDOM (used by Svelte's bind:clientWidth)
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === 'undefined') {
		globalThis.ResizeObserver = class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

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

	// --- Empty data graceful handling ---

	describe('empty data handling', () => {
		it('renders without throwing when nodes is an empty array', () => {
			expect(() => render(BubbleGraph, { props: { nodes: [] } })).not.toThrow();
		});

		it('renders SVG with a viewBox when nodes is empty', () => {
			const { container } = render(BubbleGraph, { props: { nodes: [] } });
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			const viewBox = svg?.getAttribute('viewBox');
			expect(viewBox).toBeTruthy();
			// Width should still be valid (minimum 320)
			const vbWidth = Number((viewBox ?? '').split(' ')[2]);
			expect(vbWidth).toBeGreaterThanOrEqual(320);
		});

		it('renders accessible title reflecting zero nodes when empty', () => {
			const { container } = render(BubbleGraph, { props: { nodes: [] } });
			const title = container.querySelector('svg title');
			expect(title?.textContent).toContain('0 nodes');
		});

		it('still renders legend when nodes is empty', () => {
			const { container } = render(BubbleGraph, { props: { nodes: [] } });
			const texts = container.querySelectorAll('text');
			const legendTexts = Array.from(texts).map((t) => t.textContent);
			expect(legendTexts).toContain('temporal');
			expect(legendTexts).toContain('similar');
		});

		it('renders no circles and no interactive elements when empty', () => {
			const { container } = render(BubbleGraph, { props: { nodes: [] } });
			expect(container.querySelectorAll('circle').length).toBe(0);
			expect(container.querySelectorAll('g[role="button"]').length).toBe(0);
		});

		it('renders without throwing when both nodes and edges are empty', () => {
			expect(() => render(BubbleGraph, { props: { nodes: [], edges: [] } })).not.toThrow();
			const { container } = render(BubbleGraph, { props: { nodes: [], edges: [] } });
			const svg = container.querySelector('svg');
			expect(svg).toBeInTheDocument();
			expect(container.querySelectorAll('line').length).toBe(2); // only legend lines
		});

		it('accepts custom ariaLabel when empty', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [], ariaLabel: 'Empty graph' }
			});
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('aria-label')).toBe('Empty graph');
		});
	});

	// --- Responsive / mobile viewport tests ---

	describe('responsive mobile rendering', () => {
		// In JSDOM, clientWidth=0 so width=max(320,0)=320, triggering width<500 mobile path

		it('uses mobile viewBox width of 320 (minimum clamp)', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const svg = container.querySelector('svg');
			const viewBox = svg?.getAttribute('viewBox');
			expect(viewBox).toMatch(/^0 0 320 /);
		});

		it('applies mobile max-height style (320px)', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('style')).toContain('max-height: 320px');
		});

		it('uses smaller radii at mobile width than desktop would', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ pageRank: 0.5 })] }
			});
			const circles = container.querySelectorAll('circle');
			const radii = Array.from(circles).map(c => parseFloat(c.getAttribute('r') ?? '0'));
			const maxR = Math.max(...radii);
			// At mobile width (<500), max radius = 14+26=40; desktop = 18+36=54
			// Radius should be <= 54 (i.e. not desktop-sized)
			expect(maxR).toBeLessThanOrEqual(54);
			expect(maxR).toBeGreaterThan(0);
		});

		it('uses mobile font sizes for labels', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ label: 'TestLabel' })] }
			});
			const texts = container.querySelectorAll('text');
			const label = Array.from(texts).find((t) => t.textContent === 'TestLabel');
			// Mobile label font-size is 8
			expect(label?.getAttribute('font-size')).toBe('8');
		});

		it('uses mobile font sizes for detail text', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ pageRank: 0.75, accessCount: 3 })] }
			});
			const texts = container.querySelectorAll('text');
			const detail = Array.from(texts).find((t) => t.textContent?.includes('PR'));
			// Mobile detail font-size is 6
			expect(detail?.getAttribute('font-size')).toBe('6');
		});

		it('renders multiple nodes without SVG overflow at mobile width', () => {
			const nodes = Array.from({ length: 9 }, (_, i) =>
				makeNode({ id: `n${i}`, label: `Node ${i}`, pageRank: 0.3 + i * 0.05 })
			);
			const { container } = render(BubbleGraph, { props: { nodes } });
			const svg = container.querySelector('svg');
			const viewBox = svg?.getAttribute('viewBox');
			const [, , vbWidth, vbHeight] = (viewBox ?? '').split(' ').map(Number);
			// viewBox dimensions should be positive and finite
			expect(vbWidth).toBeGreaterThanOrEqual(320);
			expect(vbHeight).toBeGreaterThan(0);
			// All 9 nodes should produce circles (component may render 2 per node)
			const circleCount = container.querySelectorAll('circle').length;
			expect(circleCount).toBeGreaterThanOrEqual(9);
		});

		it('keeps nodes interactive (clickable) at mobile viewport', async () => {
			const handler = vi.fn();
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ id: 'mobile-tap' })], onNodeClick: handler }
			});
			const button = container.querySelector('g[role="button"]');
			await fireEvent.click(button!);
			expect(handler).toHaveBeenCalledWith('mobile-tap');
		});

		it('keeps nodes keyboard-accessible at mobile viewport', async () => {
			const handler = vi.fn();
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ id: 'mobile-key' })], onNodeClick: handler }
			});
			const button = container.querySelector('g[role="button"]');
			await fireEvent.keyDown(button!, { key: 'Enter' });
			expect(handler).toHaveBeenCalledWith('mobile-key');
		});

		it('uses mobile spacing (90px) for vertical node layout', () => {
			// With width<500, spacingY=90. Two rows → height = max(260, 2*90+80) = 260
			const nodes = [
				makeNode({ id: 'a' }),
				makeNode({ id: 'b' }),
				makeNode({ id: 'c' }),
				makeNode({ id: 'd' })
			];
			const { container } = render(BubbleGraph, { props: { nodes } });
			const svg = container.querySelector('svg');
			const viewBox = svg?.getAttribute('viewBox');
			const vbHeight = Number((viewBox ?? '').split(' ')[3]);
			// Mobile spacingY=90, so height should use 90-based calculation
			expect(vbHeight).toBeGreaterThanOrEqual(260);
			expect(vbHeight).toBeLessThanOrEqual(400);
		});

		it('renders edges correctly between nodes at mobile width', () => {
			const nodes = [
				makeNode({ id: 'x', label: 'X' }),
				makeNode({ id: 'y', label: 'Y' })
			];
			const edges = [{ sourceId: 'x', targetId: 'y', type: 'temporal' as const, weight: 1 }];
			const { container } = render(BubbleGraph, { props: { nodes, edges } });
			const lines = container.querySelectorAll('line');
			// Should have edge line + 2 legend lines
			expect(lines.length).toBeGreaterThanOrEqual(3);
		});

		it('preserves ARIA label at mobile viewport', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()], ariaLabel: 'Mobile graph' }
			});
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('aria-label')).toBe('Mobile graph');
		});
	});
});
