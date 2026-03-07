import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/** Stub fetch that routes by URL — analytics calls always resolve silently */
function routedFetch(routes: Record<string, () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>>) {
	return (url: string, _opts?: RequestInit) => {
		for (const [pattern, handler] of Object.entries(routes)) {
			if (url.includes(pattern)) return handler();
		}
		// Default: analytics and other fire-and-forget calls
		return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
	};
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Memory Page — Integration (API fetch → graph display)', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Default mock: always return a minimal Response-like object (needed for trackEvent)
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
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
		expect(screen.getByText('Context Summary')).toBeInTheDocument();
		expect(screen.getByText('Total Entries')).toBeInTheDocument();
	});

	// ── Undefined graph renders fallback without error ──────────────────

	it('renders fallback UI when graph is undefined (not just null)', () => {
		render(MemoryPage, {
			props: { data: makePageData({ graph: undefined }) }
		});

		// When all data is empty, page shows global empty state — should not crash
		expect(screen.getByText('No memories yet')).toBeInTheDocument();
	});

	it('renders all sections when graph is undefined but context and autoMemory have data', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					graph: undefined,
					context: makeContextData(),
					autoMemory: makeAutoMemoryData()
				})
			}
		});

		// Graph section shows the per-section empty fallback
		expect(screen.getByText('No graph data yet')).toBeInTheDocument();
		// Context still renders
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		expect(screen.getByText('Redis Caching')).toBeInTheDocument();
		// Auto-memory still renders
		expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
	});

	it('handles refresh from undefined graph to populated graph', async () => {
		// Start with context+autoMemory so the page is not in global empty state
		render(MemoryPage, {
			props: {
				data: makePageData({
					graph: undefined,
					context: makeContextData(),
					autoMemory: makeAutoMemoryData()
				})
			}
		});

		expect(screen.getByText('No graph data yet')).toBeInTheDocument();

		// Set up API responses for the refresh
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(makeGraphData())
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.queryByText('No graph data yet')).not.toBeInTheDocument();
		});
	});

	it('handles API returning null graph data on refresh gracefully', async () => {
		// Start with some context so we're not in global empty state
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContextData(),
					autoMemory: makeAutoMemoryData()
				})
			}
		});

		// API returns null graph (undefined can't be JSON-serialized)
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(null)
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			// Graph section shows empty fallback, page doesn't crash
			expect(screen.getByText('No graph data yet')).toBeInTheDocument();
			// Context is still visible
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
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

	// ── Client-side refresh fetches API and updates display ──────────────

	it('refreshes graph data via API and updates the displayed nodes', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Wait for $effect to set initialLoading = false, revealing the empty state
		await vi.waitFor(() => {
			expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		});

		// Set up API responses for the refresh call
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(makeGraphData())
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			expect(screen.getByText('Redis Caching')).toBeInTheDocument();
		});
	});

	it('shows graph fetch error when API returns error object', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: { entries: [] }, autoMemory: [] })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ error: 'Graph file corrupted' })
				})
			})
		);

		await vi.waitFor(() => {
			expect(screen.getByText('Refresh')).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('No context entries loaded')).toBeInTheDocument();
		});
	});

	it('renders auto-memory entries after API refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Wait for initial loading to finish
		await vi.waitFor(() => {
			expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
		});

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: { entries: [] }, autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(makeGraphData())
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
			expect(screen.getByText('patterns')).toBeInTheDocument();
		});
	});

	it('handles full lifecycle: empty → refresh → populated graph + context', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// 1. Wait for initial loading to clear, showing empty states
		await vi.waitFor(() => {
			expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
			expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
		});

		// 2. Set up refresh responses
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(makeGraphData())
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		// 3. After refresh — everything is populated
		await vi.waitFor(() => {
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			expect(screen.getByText('Redis Caching')).toBeInTheDocument();
			expect(screen.getByText('Database Connection Pool')).toBeInTheDocument();
			expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
		});
	});
});

// ─── Tests requiring fake timers (fetchWithRetry has exponential backoff) ────

describe('Memory Page — Integration (error handling with retries)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Default fetch: return a proper response for trackEvent fire-and-forget
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('handles network failure on graph refresh gracefully', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Wait for initial $effect
		await vi.advanceTimersByTimeAsync(0);

		// Now make all fetches reject
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network offline'));

		await fireEvent.click(screen.getByText('Refresh'));

		// Advance through all retry delays (500 + 1000 + 2000 + jitter)
		await vi.advanceTimersByTimeAsync(5000);

		await vi.waitFor(() => {
			expect(screen.getByText('Network offline')).toBeInTheDocument();
		});
	});

	it('error can be dismissed after failed refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		await vi.advanceTimersByTimeAsync(0);

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server down'));

		await fireEvent.click(screen.getByText('Refresh'));

		// Advance past all retries
		await vi.advanceTimersByTimeAsync(5000);

		await vi.waitFor(() => {
			expect(screen.getByText('Server down')).toBeInTheDocument();
		});

		const dismissBtn = screen.getByLabelText('Dismiss error');
		await fireEvent.click(dismissBtn);

		expect(screen.queryByText('Server down')).not.toBeInTheDocument();
	});

	it('shows loading state during refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		await vi.advanceTimersByTimeAsync(0);

		// Make fetch hang so loading state persists
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise(() => {}) // Never resolves
		);

		await fireEvent.click(screen.getByText('Refresh'));

		expect(screen.getByText('Refreshing...')).toBeInTheDocument();
	});
});
