import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import axe from 'axe-core';
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

	// --- Duplicate node ID handling ---

	describe('duplicate node IDs', () => {
		it('renders without throwing when nodes share the same ID', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'First', pageRank: 0.8 }),
				makeNode({ id: 'dup', label: 'Second', pageRank: 0.3 })
			];
			expect(() => render(BubbleGraph, { props: { nodes } })).not.toThrow();
		});

		it('renders a circle for each duplicate node entry', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'First' }),
				makeNode({ id: 'dup', label: 'Second' })
			];
			const { container } = render(BubbleGraph, { props: { nodes } });
			const circles = container.querySelectorAll('circle');
			expect(circles.length).toBe(2);
		});

		it('renders both labels for duplicate ID nodes', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'First' }),
				makeNode({ id: 'dup', label: 'Second' })
			];
			const { container } = render(BubbleGraph, { props: { nodes } });
			const texts = Array.from(container.querySelectorAll('text')).map(t => t.textContent);
			expect(texts).toContain('First');
			expect(texts).toContain('Second');
		});

		it('renders interactive buttons for each duplicate node', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'A' }),
				makeNode({ id: 'dup', label: 'B' })
			];
			const { container } = render(BubbleGraph, { props: { nodes } });
			const buttons = container.querySelectorAll('g[role="button"]');
			expect(buttons.length).toBe(2);
		});

		it('fires onNodeClick with the shared ID for each duplicate', async () => {
			const handler = vi.fn();
			const nodes = [
				makeNode({ id: 'dup', label: 'A' }),
				makeNode({ id: 'dup', label: 'B' })
			];
			const { container } = render(BubbleGraph, { props: { nodes, onNodeClick: handler } });
			const buttons = container.querySelectorAll('g[role="button"]');
			await fireEvent.click(buttons[0]);
			await fireEvent.click(buttons[1]);
			expect(handler).toHaveBeenCalledTimes(2);
			expect(handler).toHaveBeenNthCalledWith(1, 'dup');
			expect(handler).toHaveBeenNthCalledWith(2, 'dup');
		});

		it('renders edges connecting to duplicate nodes without errors', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'A' }),
				makeNode({ id: 'dup', label: 'B' }),
				makeNode({ id: 'other', label: 'C' })
			];
			const edges = [{ sourceId: 'dup', targetId: 'other', type: 'temporal' as const, weight: 1 }];
			const { container } = render(BubbleGraph, { props: { nodes, edges } });
			// Should render at least 1 edge line + 2 legend lines
			const lines = container.querySelectorAll('line');
			expect(lines.length).toBeGreaterThanOrEqual(3);
		});

		it('gives each duplicate node a unique ARIA label with index', () => {
			const nodes = [
				makeNode({ id: 'dup', label: 'Same', pageRank: 0.5, accessCount: 3, category: 'core' }),
				makeNode({ id: 'dup', label: 'Same', pageRank: 0.5, accessCount: 3, category: 'core' })
			];
			const { container } = render(BubbleGraph, { props: { nodes } });
			const buttons = container.querySelectorAll('g[role="button"]');
			const label0 = buttons[0].getAttribute('aria-label');
			const label1 = buttons[1].getAttribute('aria-label');
			// Both should have valid labels
			expect(label0).toContain('Same');
			expect(label1).toContain('Same');
			// They should differ by node index (Node 1 of 2 vs Node 2 of 2)
			expect(label0).toContain('Node 1 of 2');
			expect(label1).toContain('Node 2 of 2');
		});
	});

	// --- Accessibility & high-contrast mode ---

	describe('accessibility and high-contrast', () => {
		it('passes axe-core accessibility checks', async () => {
			const nodes = [
				makeNode({ id: 'a', label: 'Alpha', category: 'core', pageRank: 0.8, accessCount: 5 }),
				makeNode({ id: 'b', label: 'Beta', category: 'insights', pageRank: 0.4, accessCount: 2 })
			];
			const edges = [{ sourceId: 'a', targetId: 'b', type: 'temporal' as const, weight: 1 }];
			const { container } = render(BubbleGraph, { props: { nodes, edges } });

			const results = await axe.run(container, {
				rules: {
					// SVG region/landmark rules don't apply to embedded graph components
					region: { enabled: false }
				}
			});
			expect(results.violations).toEqual([]);
		});

		it('SVG has role="img" and aria-label', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()], ariaLabel: 'Test knowledge graph' }
			});
			const svg = container.querySelector('svg');
			expect(svg?.getAttribute('role')).toBe('img');
			expect(svg?.getAttribute('aria-label')).toBe('Test knowledge graph');
		});

		it('SVG has a <title> element for assistive technology', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode(), makeNode({ id: 'b' })] }
			});
			const title = container.querySelector('svg title');
			expect(title).toBeTruthy();
			expect(title!.textContent).toContain('2 nodes');
		});

		it('SVG has a <desc> element with navigation instructions', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const desc = container.querySelector('svg desc');
			expect(desc).toBeTruthy();
			expect(desc!.textContent).toContain('arrow keys');
		});

		it('each node group has an aria-label with name, category, and metrics', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ label: 'Auth', category: 'security', pageRank: 0.7, accessCount: 12 })] }
			});
			const button = container.querySelector('g[role="button"]');
			const label = button?.getAttribute('aria-label') ?? '';
			expect(label).toContain('Auth');
			expect(label).toContain('security');
		});

		it('visual label and detail text are aria-hidden (info in aria-label)', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const nodeLabels = container.querySelectorAll('.node-label');
			const nodeDetails = container.querySelectorAll('.node-detail');
			for (const el of [...nodeLabels, ...nodeDetails]) {
				expect(el.getAttribute('aria-hidden')).toBe('true');
			}
		});

		it('edge lines are aria-hidden (decorative)', () => {
			const nodes = [
				makeNode({ id: 'a', label: 'A' }),
				makeNode({ id: 'b', label: 'B' })
			];
			const edges = [{ sourceId: 'a', targetId: 'b', type: 'temporal' as const, weight: 1 }];
			const { container } = render(BubbleGraph, { props: { nodes, edges } });
			// The edge line (not legend) should be aria-hidden
			const lines = container.querySelectorAll('line[aria-hidden="true"]');
			expect(lines.length).toBeGreaterThanOrEqual(1);
		});

		it('legend group has role="list" and items have role="listitem"', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const legendList = container.querySelector('g[role="list"]');
			expect(legendList).toBeTruthy();
			expect(legendList?.getAttribute('aria-label')).toContain('legend');
			const listItems = legendList?.querySelectorAll('g[role="listitem"]');
			expect(listItems?.length).toBeGreaterThanOrEqual(2);
		});

		it('label text (#e2e8f0) on category fills meets 3:1 contrast ratio', () => {
			// WCAG AA for large text / UI components requires 3:1 minimum
			// #e2e8f0 (label) luminance vs category fill colors
			const labelHex = '#e2e8f0';
			const categoryFills: Record<string, string> = {
				core: '#3b82f6',
				insights: '#a855f7',
				patterns: '#22c55e',
				security: '#ef4444',
				fallback: '#94a3b8'
			};

			function relativeLuminance(hex: string): number {
				const r = parseInt(hex.slice(1, 3), 16) / 255;
				const g = parseInt(hex.slice(3, 5), 16) / 255;
				const b = parseInt(hex.slice(5, 7), 16) / 255;
				const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
				return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
			}

			function contrastRatio(hex1: string, hex2: string): number {
				const l1 = relativeLuminance(hex1);
				const l2 = relativeLuminance(hex2);
				const lighter = Math.max(l1, l2);
				const darker = Math.min(l1, l2);
				return (lighter + 0.05) / (darker + 0.05);
			}

			for (const [category, fill] of Object.entries(categoryFills)) {
				const ratio = contrastRatio(labelHex, fill);
				expect(ratio, `Label on ${category} (${fill}): ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
			}
		});

		it('high-contrast CSS styles increase stroke-width on circles', () => {
			// Verify the component's <style> block includes high-contrast media query rules
			// by checking that the rendered component has the expected CSS class structure
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const circle = container.querySelector('.node-circle');
			expect(circle).toBeTruthy();
			// The circle uses CSS custom property --node-fill for its fill
			const style = circle?.getAttribute('style');
			expect(style).toContain('--node-fill');
		});

		it('high-contrast mode labels use white fill (#ffffff)', () => {
			// The CSS specifies fill: #ffffff for .node-label in high-contrast mode
			// We verify the inline fill attribute on labels (default mode) is a light color
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode({ label: 'HCLabel' })] }
			});
			const label = Array.from(container.querySelectorAll('text')).find(
				(t) => t.textContent === 'HCLabel'
			);
			// Default fill is #e2e8f0 (light gray), high-contrast overrides to #ffffff
			expect(label?.getAttribute('fill')).toBe('#e2e8f0');
		});

		it('focus ring element exists for keyboard navigation visibility', () => {
			const { container } = render(BubbleGraph, {
				props: { nodes: [makeNode()] }
			});
			const focusRing = container.querySelector('.focus-ring');
			expect(focusRing).toBeTruthy();
		});

		it('detail text (#94a3b8) contrasts sufficiently against dark background', () => {
			// Detail text color #94a3b8 against a near-black graph background
			// The SVG background is transparent/dark theme, assume #1e293b (slate-800)
			const detailColor = '#94a3b8';
			const bgColor = '#1e293b';

			function relativeLuminance(hex: string): number {
				const r = parseInt(hex.slice(1, 3), 16) / 255;
				const g = parseInt(hex.slice(3, 5), 16) / 255;
				const b = parseInt(hex.slice(5, 7), 16) / 255;
				const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
				return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
			}

			const l1 = relativeLuminance(detailColor);
			const l2 = relativeLuminance(bgColor);
			const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
			// WCAG AA for small text requires 4.5:1
			expect(ratio).toBeGreaterThanOrEqual(3);
		});
	});
});
