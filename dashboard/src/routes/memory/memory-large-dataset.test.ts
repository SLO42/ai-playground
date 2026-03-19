import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

vi.mock('$lib/components/BubbleGraph.svelte', () => {
	return {
		default: function BubbleGraphMock() {
			return { $$: { on_mount: [], on_destroy: [], before_update: [], after_update: [] } };
		}
	};
});

vi.mock('$lib/api-client.js', () => ({
	apiFetch: vi.fn()
}));

import MemoryPage from './+page.svelte';

const CATEGORIES = ['core', 'patterns', 'decisions', 'context', 'learned', 'system', 'user', 'debug'] as const;
const EDGE_TYPES = ['temporal', 'similar', 'causal'] as const;

function generateLargeDataset(nodeCount: number, edgesPerNode: number) {
	const nodes: Record<string, { id: string; category: string; confidence: number; accessCount: number; createdAt: number }> = {};
	const edges: Array<{ sourceId: string; targetId: string; type: 'temporal' | 'similar' | 'causal'; weight: number }> = [];
	const pageRanks: Record<string, number> = {};
	const now = Date.now();

	for (let i = 0; i < nodeCount; i++) {
		const id = `node-${i}`;
		nodes[id] = {
			id,
			category: CATEGORIES[i % CATEGORIES.length],
			confidence: 0.3 + Math.random() * 0.7,
			accessCount: Math.floor(Math.random() * 50),
			createdAt: now - Math.floor(Math.random() * 86400000 * 30)
		};
		pageRanks[id] = Math.random();
	}

	const nodeIds = Object.keys(nodes);
	for (let i = 0; i < nodeCount; i++) {
		for (let e = 0; e < edgesPerNode; e++) {
			const targetIdx = (i + 1 + e) % nodeCount;
			edges.push({
				sourceId: nodeIds[i],
				targetId: nodeIds[targetIdx],
				type: EDGE_TYPES[e % EDGE_TYPES.length],
				weight: 0.1 + Math.random() * 0.9
			});
		}
	}

	return { nodes, edges, pageRanks };
}

function generateLargeContext(entryCount: number) {
	const entries = [];
	for (let i = 0; i < entryCount; i++) {
		entries.push({
			id: `entry-${i}`,
			summary: `Memory entry ${i}`,
			content: `Content for entry ${i} with some detail text`,
			category: CATEGORIES[i % CATEGORIES.length],
			confidence: 0.3 + Math.random() * 0.7,
			pageRank: Math.random(),
			accessCount: Math.floor(Math.random() * 20)
		});
	}
	return { entries };
}

function makePageData(overrides: Record<string, unknown> = {}) {
	return {
		graph: null as ReturnType<typeof generateLargeDataset> | null,
		context: null as ReturnType<typeof generateLargeContext> | null,
		autoMemory: null as Array<{
			key: string;
			summary: string;
			namespace: string;
			content: string;
			type: string;
			createdAt: number;
			metadata: Record<string, unknown>;
		}> | null,
		memoryConfig: null as Record<string, unknown> | null,
		...overrides
	};
}

describe('Memory Page — Large Dataset Integration', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = vi.fn();
	});

	it('renders without crashing with ~10k graph nodes', () => {
		const graph = generateLargeDataset(10_000, 2);
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ graph }) }
		});

		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		expect(screen.getByText('Nodes')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		unmount();
	}, 15_000);

	it('renders edge count correctly for large dataset', () => {
		const graph = generateLargeDataset(10_000, 3);
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ graph }) }
		});

		// 10k nodes * 3 edges = 30k edges displayed in the Edges metric
		expect(screen.getByText('30000')).toBeInTheDocument();
		unmount();
	}, 15_000);

	it('completes initial render within a reasonable time for 10k nodes', () => {
		const graph = generateLargeDataset(10_000, 2);

		const start = performance.now();
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ graph }) }
		});
		const elapsed = performance.now() - start;

		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		// Render should complete well under 10 seconds even on CI
		expect(elapsed).toBeLessThan(10_000);
		unmount();
	}, 15_000);

	it('handles large context entry list without crashing', () => {
		const context = generateLargeContext(1_000);
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ context }) }
		});

		expect(screen.getByText('Context Summary')).toBeInTheDocument();
		expect(screen.getByText('Total Entries')).toBeInTheDocument();
		unmount();
	});

	it('handles combined large graph + large context', () => {
		const graph = generateLargeDataset(5_000, 2);
		const context = generateLargeContext(200);
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ graph, context }) }
		});

		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		expect(screen.getByText('Context Summary')).toBeInTheDocument();
		unmount();
	}, 15_000);

	it('handles large auto-memory list without crashing', () => {
		const autoMemory = Array.from({ length: 2_000 }, (_, i) => ({
			key: `auto-mem-${i}`,
			summary: `Auto memory entry ${i}`,
			namespace: CATEGORIES[i % CATEGORIES.length],
			content: `Auto memory content ${i}`,
			type: 'pattern',
			createdAt: Date.now() - i * 60000,
			metadata: {}
		}));

		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ autoMemory }) }
		});

		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		unmount();
	});

	it('does not crash with extremely dense edge graph (5 edges per node)', () => {
		const graph = generateLargeDataset(5_000, 5);
		const { unmount } = render(MemoryPage, {
			props: { data: makePageData({ graph }) }
		});

		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		// 5000 * 5 = 25000 edges
		expect(screen.getByText('25000')).toBeInTheDocument();
		unmount();
	});

	it('renders all metric cards with large dataset values', { timeout: 15_000 }, () => {
		const graph = generateLargeDataset(10_000, 2);
		const context = generateLargeContext(200);
		const { unmount } = render(MemoryPage, {
			props: {
				data: makePageData({
					graph,
					context,
					memoryConfig: { backend: 'agentdb', enableHNSW: true }
				})
			}
		});

		expect(screen.getByText('Backend')).toBeInTheDocument();
		expect(screen.getByText('agentdb')).toBeInTheDocument();
		expect(screen.getByText('Nodes')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		expect(screen.getByText('HNSW')).toBeInTheDocument();
		expect(screen.getByText('Enabled')).toBeInTheDocument();
		expect(screen.getByText('Confidence')).toBeInTheDocument();
		unmount();
	});
});
