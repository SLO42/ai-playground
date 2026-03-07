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

		// When all data is empty, page shows section-level empty states — should not crash
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
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
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		// Context still renders
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		expect(screen.getByText('Redis Caching')).toBeInTheDocument();
		// Auto-memory still renders
		expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
	});

	it('handles refresh from undefined graph — graph populates via client-side fetch', async () => {
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

		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();

		// Set up API responses for both context and graph refresh
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
			// Graph empty state should be gone after refresh populates liveGraph
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
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

		// API returns null for graph
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
			// Page doesn't crash, context is still visible
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		});
	});

	// ── Server load errors banner ───────────────────────────────────────

	it('shows server load errors banner when data has loadErrors', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					loadErrors: ['Graph file not found', 'Context timeout']
				})
			}
		});

		expect(screen.getByText('Some data failed to load:')).toBeInTheDocument();
		expect(screen.getByText('Graph file not found')).toBeInTheDocument();
		expect(screen.getByText('Context timeout')).toBeInTheDocument();
	});

	// ── Client-side refresh error shows error banner ────────────────────

	it('shows error banner when client-side refresh fails', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Make fetch reject to trigger client-side error
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Context fetch failed'));

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('Context fetch failed')).toBeInTheDocument();
		});
	});

	// ── Client-side refresh fetches API and updates display ──────────────

	it('refreshes both context and graph data via API on refresh click', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// Wait for empty state to appear
		await vi.waitFor(() => {
			expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		});

		// Set up API responses for both endpoints
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
			// Graph empty state should be gone after client-side refresh
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

	it('handles full lifecycle: empty → refresh → populated graph + context + auto-memory', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

		// 1. Wait for initial loading to clear, showing empty states
		await vi.waitFor(() => {
			expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
			expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
		});

		// 2. Set up refresh responses for both context and graph
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

// ─── Missing graph data — fallback UI without errors ─────────────────────────

describe('Memory Page — Integration (missing graph data renders fallback)', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
	});

	it('renders graph empty state when graph property is entirely absent from page data', () => {
		// Simulate server returning data without the `graph` key at all
		const dataWithoutGraph = {
			context: null,
			autoMemory: null,
			memoryConfig: null,
			loadErrors: null
		};

		render(MemoryPage, { props: { data: dataWithoutGraph as any } });

		// Page should not throw — graph section shows empty state
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		// Other sections show their own empty states
		expect(screen.getByText('No memory context available. Context populates as the system processes entries.')).toBeInTheDocument();
		// Should NOT show loading
		expect(screen.queryByText('Loading memory graph...')).not.toBeInTheDocument();
	});

	it('renders graph empty state alongside populated context when graph property is absent', () => {
		const dataWithoutGraph = {
			context: makeContextData(),
			autoMemory: makeAutoMemoryData(),
			memoryConfig: { backend: 'agentdb', enableHNSW: true },
			loadErrors: null
		};

		render(MemoryPage, { props: { data: dataWithoutGraph as any } });

		// Graph section shows empty fallback
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		// Other sections still render correctly
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
		expect(screen.getByText('agentdb')).toBeInTheDocument();
	});

	it('does not throw when graph is undefined and context has data', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					graph: undefined,
					context: makeContextData()
				})
			}
		});

		// Graph section shows empty state without crashing
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		// Metric cards should still render
		expect(screen.getByText('Nodes')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		// Context renders correctly alongside missing graph
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
	});

	it('recovers from absent graph after API refresh returns valid data', async () => {
		// Start with graph absent but context populated
		const dataWithoutGraph = {
			context: makeContextData(),
			autoMemory: makeAutoMemoryData(),
			memoryConfig: null,
			loadErrors: null
		};

		render(MemoryPage, { props: { data: dataWithoutGraph as any } });

		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();

		// API returns valid data for both context and graph on refresh
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
			// Graph empty state gone, data populated
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		});
	});

	it('shows graph fallback when API refresh returns empty object for graph', async () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContextData(),
					autoMemory: makeAutoMemoryData()
				})
			}
		});

		// API returns empty object (no nodes/edges keys) for graph
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({})
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			// Page should not crash — context still visible
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		});
	});
});

// ─── Client-side graph refresh + feature flag tests ──────────────────────────

describe('Memory Page — Client-side graph refresh', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) as any;
	});

	it('fetches both /api/memory/context and /api/memory/graph on refresh', async () => {
		render(MemoryPage, { props: { data: makePageData() } });

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
			// Both context and graph data should appear after refresh
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			expect(screen.getByText('JWT with refresh tokens')).toBeInTheDocument();
			// Graph empty state should be gone
			expect(screen.queryByText('No graph data. Memory graph populates as the system processes entries.')).not.toBeInTheDocument();
		});

		// Verify both endpoints were called
		const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
		expect(calls.some(url => url.includes('/api/memory/context'))).toBe(true);
		expect(calls.some(url => url.includes('/api/memory/graph'))).toBe(true);
	});

	it('updates liveGraph with new data from graph API', async () => {
		// Start with server-loaded graph data
		render(MemoryPage, {
			props: {
				data: makePageData({
					graph: makeGraphData(),
					context: makeContextData()
				})
			}
		});

		// Verify initial graph metrics
		expect(screen.getByText('Nodes')).toBeInTheDocument();

		// Refresh with new graph data (different node count)
		const newGraph = makeGraphData();
		newGraph.nodes['new-node'] = { id: 'new-node', category: 'test', confidence: 0.5, accessCount: 1, createdAt: Date.now() };

		const newContext = makeContextData();
		newContext.entries.push({ id: 'new-node', summary: 'New Node Entry', content: 'Test', category: 'test', confidence: 0.5, pageRank: 0.1, accessCount: 1 });

		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: newContext, autoMemory: [] })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve(newGraph)
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			expect(screen.getByText('New Node Entry')).toBeInTheDocument();
		});
	});

	it('handles graph API failure gracefully while context succeeds', async () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContextData(),
					autoMemory: makeAutoMemoryData()
				})
			}
		});

		// Context succeeds, graph fails
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			routedFetch({
				'/api/memory/context': () => Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ context: makeContextData(), autoMemory: makeAutoMemoryData() })
				}),
				'/api/memory/graph': () => Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.resolve({ error: 'Internal server error' })
				})
			})
		);

		await fireEvent.click(screen.getByText('Refresh'));

		await vi.waitFor(() => {
			// Context should still be visible (no error thrown)
			expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
			// No client-side error banner should appear (graph failure is silent)
			expect(screen.queryByText('Internal server error')).not.toBeInTheDocument();
		});
	});

	it('shows disabled message when memoryGraphEnabled is false', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({ memoryGraphEnabled: false })
			}
		});

		expect(screen.getByText('Memory graph is disabled. Enable it in settings to visualize relationships.')).toBeInTheDocument();
	});

	it('shows normal graph empty state when memoryGraphEnabled is not set', () => {
		render(MemoryPage, {
			props: {
				data: makePageData()
			}
		});

		// Should show the default empty state, not the disabled message
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
		expect(screen.queryByText('Memory graph is disabled. Enable it in settings to visualize relationships.')).not.toBeInTheDocument();
	});

	it('shows graph section (not disabled message) when memoryGraphEnabled is true and graph data exists', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					graph: makeGraphData(),
					context: makeContextData(),
					memoryGraphEnabled: true
				})
			}
		});

		// Should not show disabled message
		expect(screen.queryByText('Memory graph is disabled. Enable it in settings to visualize relationships.')).not.toBeInTheDocument();
		// Context entries should render
		expect(screen.getByText('JWT Authentication')).toBeInTheDocument();
		// Memory Graph heading should be present
		expect(screen.getByText('Memory Graph')).toBeInTheDocument();
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
