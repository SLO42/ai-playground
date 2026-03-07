import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('$lib/components/BubbleGraph.svelte', () => ({
	default: function BubbleGraphMock() {
		return { $$: { on_mount: [], on_destroy: [], before_update: [], after_update: [] } };
	}
}));

vi.mock('$lib/api-client.js', () => ({
	apiFetch: vi.fn()
}));

import MemoryPage from './+page.svelte';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeGraphData() {
	return {
		version: 1,
		updatedAt: Date.now(),
		nodeCount: 3,
		nodes: {
			'auth-jwt': { id: 'auth-jwt', category: 'core', confidence: 0.95, accessCount: 12, createdAt: Date.now() - 600000 },
			'cache-redis': { id: 'cache-redis', category: 'patterns', confidence: 0.8, accessCount: 5, createdAt: Date.now() - 300000 },
			'db-pool': { id: 'db-pool', category: 'infra', confidence: 0.7, accessCount: 3, createdAt: Date.now() - 100000 }
		},
		edges: [
			{ sourceId: 'auth-jwt', targetId: 'cache-redis', type: 'temporal' as const, weight: 0.9 },
			{ sourceId: 'cache-redis', targetId: 'db-pool', type: 'similar' as const, weight: 0.6 },
			{ sourceId: 'auth-jwt', targetId: 'db-pool', type: 'causal' as const, weight: 0.4 }
		],
		pageRanks: { 'auth-jwt': 0.55, 'cache-redis': 0.30, 'db-pool': 0.15 }
	};
}

function makeContextData() {
	return {
		entries: [
			{ id: 'auth-jwt', summary: 'JWT Authentication', content: 'Use refresh tokens with short-lived access', category: 'core', confidence: 0.95, pageRank: 0.55, accessCount: 12 },
			{ id: 'cache-redis', summary: 'Redis Caching', content: 'Cache invalidation patterns', category: 'patterns', confidence: 0.8, pageRank: 0.30, accessCount: 5 },
			{ id: 'db-pool', summary: 'Database Connection Pool', content: 'PgBouncer config', category: 'infra', confidence: 0.7, pageRank: 0.15, accessCount: 3 }
		]
	};
}

function makeAutoMemoryData() {
	return [
		{
			id: 'am-1',
			key: 'pattern-auth-jwt',
			summary: 'JWT with refresh tokens',
			namespace: 'patterns',
			content: 'Always use refresh tokens with short TTL',
			type: 'pattern',
			createdAt: Date.now() - 60000,
			metadata: {}
		}
	];
}

function makePageData(overrides: Record<string, unknown> = {}) {
	return {
		graph: null as ReturnType<typeof makeGraphData> | null,
		context: null as ReturnType<typeof makeContextData> | null,
		autoMemory: null as ReturnType<typeof makeAutoMemoryData> | null,
		memoryConfig: null as Record<string, unknown> | null,
		loadErrors: null as string[] | null,
		...overrides
	};
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Memory Page — Integration (API fetch → graph display)', () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.restoreAllMocks();
		// Default mock returns a minimal Response-like object (needed for trackEvent's fire-and-forget fetch)
		mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
		globalThis.fetch = mockFetch as any;
	});

	// ── Initial server data renders graph correctly ──────────────────────

	it('renders graph nodes and edges from server-loaded data', () => {
		const graph = makeGraphData();
		const context = makeContextData();

		render(MemoryPage, {
			props: {
				data: makePageData({ graph, context, memoryConfig: { backend: 'agentdb', enableHNSW: true } })
			}
		});

		// Metric cards should reflect the graph structure
		expect(screen.getByText('Nodes')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		expect(screen.getByText('agentdb')).toBeInTheDocument();
		expect(screen.getByText('Enabled')).toBeInTheDocument();

		// Context entries should appear in the top contexts list
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		expect(screen.getByText('Redis Caching')).toBeInTheDocument();
		expect(screen.getByText('Database Connection Pool')).toBeInTheDocument();
	});

	it('computes correct confidence from context entries', () => {
		const context = makeContextData();

		render(MemoryPage, {
			props: { data: makePageData({ context }) }
		});

		// Average confidence = (0.95 + 0.8 + 0.7) / 3 ≈ 0.8167 => 81.7%
		expect(screen.getByText('81.7%')).toBeInTheDocument();
	});

	// ── Client-side refresh fetches API and updates display ──────────────

	it('refreshes graph data via API and updates the displayed nodes', async () => {
		// Start with empty data
		render(MemoryPage, { props: { data: makePageData() } });

		// Verify empty state first
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();

		// Mock the API responses for refresh
		const freshGraph = makeGraphData();
		const freshContext = makeContextData();

		mockFetch.mockImplementation((url: string) => {
			if (url.includes('/api/memory/context')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: freshContext, autoMemory: makeAutoMemoryData() })
				});
			}
			if (url.includes('/api/memory/graph')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(freshGraph)
				});
			}
			// Analytics endpoint (fire-and-forget)
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});

		// Click refresh
		const btn = screen.getByText('Refresh');
		await fireEvent.click(btn);

		// Wait for async updates
		await vi.waitFor(() => {
			// Graph should now be populated — empty state should be gone
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
		});

		// Context entries should be visible after refresh
		await vi.waitFor(() => {
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			expect(screen.getByText('Redis Caching')).toBeInTheDocument();
		});
	});

	it('shows graph fetch error when API returns error response', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		mockFetch.mockImplementation((url: string) => {
			if (url.includes('/api/memory/context')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: { entries: [] }, autoMemory: [] })
				});
			}
			if (url.includes('/api/memory/graph')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ error: 'Graph file corrupted' })
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			// The graph error should not crash the page — other sections should still render
			expect(screen.getByText('No context entries loaded')).toBeInTheDocument();
		});
	});

	it('handles network failure on graph refresh gracefully', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Both API calls fail
		mockFetch.mockRejectedValue(new Error('Network offline'));

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('Network offline')).toBeInTheDocument();
		});
	});

	// ── Server data with loadErrors shows error banner ───────────────────

	it('shows error banner when server data has loadErrors', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					loadErrors: ['Graph file not found', 'Context timeout']
				})
			}
		});

		expect(screen.getByText('Failed to load: Graph file not found; Context timeout')).toBeInTheDocument();
	});

	// ── Auto-memory entries render after refresh ─────────────────────────

	it('renders auto-memory entries after API refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Initially no entries
		expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();

		mockFetch.mockImplementation((url: string) => {
			if (url.includes('/api/memory/context')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: { entries: [] }, autoMemory: makeAutoMemoryData() })
				});
			}
			if (url.includes('/api/memory/graph')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(makeGraphData())
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
			expect(screen.getByText('patterns')).toBeInTheDocument();
		});
	});

	// ── Full pipeline: empty → refresh → populated → dismiss error ──────

	it('handles full lifecycle: empty → refresh → populated graph + context', async () => {
		const { unmount } = render(MemoryPage, { props: { data: makePageData() } });

		// 1. Starts empty
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();

		// 2. Refresh with full data
		const graph = makeGraphData();
		const context = makeContextData();

		mockFetch.mockImplementation((url: string) => {
			if (url.includes('/api/memory/context')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context, autoMemory: makeAutoMemoryData() })
				});
			}
			if (url.includes('/api/memory/graph')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(graph)
				});
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});

		await fireEvent.click(screen.getByText('Refresh'));

		// 3. After refresh — graph and context are populated
		await vi.waitFor(() => {
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			expect(screen.getByText('Redis Caching')).toBeInTheDocument();
			expect(screen.getByText('Database Connection Pool')).toBeInTheDocument();
		});

		// 4. Auto-memory should also be populated
		await vi.waitFor(() => {
			expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
		});

		unmount();
	});

	// ── Metric cards update with refreshed data ─────────────────────────

	it('metric cards reflect graph structure after server-loaded data', () => {
		const graph = makeGraphData();
		const context = makeContextData();

		render(MemoryPage, {
			props: {
				data: makePageData({
					graph,
					context,
					memoryConfig: { backend: 'hybrid', enableHNSW: false }
				})
			}
		});

		expect(screen.getByText('hybrid')).toBeInTheDocument();
		expect(screen.getByText('Disabled')).toBeInTheDocument();
		// Context summary should show total entries
		expect(screen.getByText('Context Summary')).toBeInTheDocument();
		expect(screen.getByText('Total Entries')).toBeInTheDocument();
	});

	// ── Error dismissal clears the error state ──────────────────────────

	it('error can be dismissed after failed refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		mockFetch.mockRejectedValue(new Error('Server down'));

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('Server down')).toBeInTheDocument();
		});

		const dismissBtn = screen.getByLabelText('Dismiss error');
		await fireEvent.click(dismissBtn);

		expect(screen.queryByText('Server down')).not.toBeInTheDocument();
	});

	// ── Refresh shows loading state then resolves ───────────────────────

	it('shows loading state during refresh then resolves', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Make fetch hang initially
		let resolveContext!: (value: unknown) => void;
		let resolveGraph!: (value: unknown) => void;

		mockFetch.mockImplementation((url: string) => {
			if (url.includes('/api/memory/context')) {
				return new Promise(resolve => { resolveContext = resolve; });
			}
			if (url.includes('/api/memory/graph')) {
				return new Promise(resolve => { resolveGraph = resolve; });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		});

		await fireEvent.click(screen.getByText('Refresh'));

		// Should be in loading state
		expect(screen.getByText('Refreshing...')).toBeInTheDocument();

		// Resolve both API calls
		resolveContext({ ok: true, json: () => Promise.resolve({ context: makeContextData(), autoMemory: [] }) });
		resolveGraph({ ok: true, json: () => Promise.resolve(makeGraphData()) });

		await vi.waitFor(() => {
			// Loading should be done — Refresh button should be back
			expect(screen.getByText('Refresh')).toBeInTheDocument();
			expect(screen.queryByText('Refreshing...')).not.toBeInTheDocument();
		});
	});
});
