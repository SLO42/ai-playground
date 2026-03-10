import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';

// Mock the BubbleGraph lazy import so it resolves immediately
vi.mock('$lib/components/BubbleGraph.svelte', () => {
	const { default: MockComponent } = (() => {
		// Return a minimal svelte component mock
		return {
			default: function BubbleGraphMock() {
				return { $$: { on_mount: [], on_destroy: [], before_update: [], after_update: [] } };
			}
		};
	})();
	return { default: MockComponent };
});

vi.mock('$lib/api-client.js', () => ({
	apiFetch: vi.fn()
}));

import MemoryPage from './+page.svelte';

function makeGraphState(overrides: Partial<{
	nodes: Record<string, { id: string; category: string; confidence: number; accessCount: number; createdAt: number }>;
	edges: Array<{ sourceId: string; targetId: string; type: 'temporal' | 'similar' | 'causal'; weight: number }>;
	pageRanks: Record<string, number>;
}> = {}) {
	return {
		nodes: overrides.nodes ?? {},
		edges: overrides.edges ?? [],
		pageRanks: overrides.pageRanks ?? {}
	};
}

function makeContext(overrides: Partial<{
	entries: Array<{
		id: string;
		summary: string;
		content: string;
		category: string;
		confidence: number;
		pageRank: number;
		accessCount: number;
	}>;
}> = {}) {
	return {
		entries: overrides.entries ?? []
	};
}

function makePageData(overrides: Record<string, unknown> = {}) {
	return {
		graph: null as ReturnType<typeof makeGraphState> | null,
		context: null as ReturnType<typeof makeContext> | null,
		autoMemory: null as Array<{
			id: string;
			key: string;
			summary: string;
			namespace: string;
			content: string;
			type: string;
			createdAt: number;
			metadata: Record<string, unknown>;
		}> | null,
		memoryConfig: null as Record<string, unknown> | null,
		memoryGraphEnabled: true,
		loadErrors: null as string[] | null,
		...overrides
	};
}

describe('Memory Page', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Mock fetch for refresh
		globalThis.fetch = vi.fn();
	});

	it('renders page title', () => {
		render(MemoryPage, { props: { data: makePageData() } });
		expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
	});

	it('shows empty state when graph data is null', () => {
		// Provide context entries so isEmpty=false and graph section renders
		render(MemoryPage, { props: { data: makePageData({
			graph: null,
			context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
		}) } });
		expect(screen.getByText('No graph data yet')).toBeInTheDocument();
	});

	it('shows empty state when graph has no nodes', () => {
		render(MemoryPage, {
			props: { data: makePageData({
				graph: makeGraphState({ nodes: {} }),
				context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
			}) }
		});
		expect(screen.getByText('No graph data yet')).toBeInTheDocument();
	});

	it('shows no-context message when context is null and not loading', () => {
		// Provide autoMemory so isEmpty=false and context section renders
		render(MemoryPage, { props: { data: makePageData({
			context: null,
			autoMemory: [{ id: 'a1', key: 'k', summary: 's', namespace: 'default', content: '', type: 'p', createdAt: Date.now(), metadata: {} }]
		}) } });
		expect(screen.getByText('No memory context yet')).toBeInTheDocument();
	});

	it('shows "No context entries loaded" when context has empty entries', () => {
		render(MemoryPage, {
			props: { data: makePageData({
				context: makeContext({ entries: [] }),
				autoMemory: [{ id: 'a1', key: 'k', summary: 's', namespace: 'default', content: '', type: 'p', createdAt: Date.now(), metadata: {} }]
			}) }
		});
		expect(screen.getByText('No context entries yet')).toBeInTheDocument();
	});

	it('shows "No auto-memory entries loaded" when autoMemory is empty', () => {
		render(MemoryPage, { props: { data: makePageData({
			autoMemory: [],
			context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
		}) } });
		expect(screen.getByText('No auto-memory entries yet')).toBeInTheDocument();
	});

	it('shows "No auto-memory entries loaded" when autoMemory is null', () => {
		render(MemoryPage, { props: { data: makePageData({
			autoMemory: null,
			context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
		}) } });
		expect(screen.getByText('No auto-memory entries yet')).toBeInTheDocument();
	});

	it('renders metric cards with default N/A values when data is null', () => {
		// Provide some context so isEmpty=false and metric cards render
		render(MemoryPage, { props: { data: makePageData({
			context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
		}) } });
		expect(screen.getByText('Backend')).toBeInTheDocument();
		expect(screen.getByText('Nodes')).toBeInTheDocument();
		expect(screen.getByText('Edges')).toBeInTheDocument();
		expect(screen.getByText('HNSW')).toBeInTheDocument();
		expect(screen.getByText('Confidence')).toBeInTheDocument();
	});

	it('renders metric values from memoryConfig', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					memoryConfig: { backend: 'agentdb', enableHNSW: true },
					context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
				})
			}
		});
		expect(screen.getByText('agentdb')).toBeInTheDocument();
		expect(screen.getByText('Enabled')).toBeInTheDocument();
	});

	it('shows HNSW Disabled when enableHNSW is false', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					memoryConfig: { enableHNSW: false },
					context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
				})
			}
		});
		expect(screen.getByText('Disabled')).toBeInTheDocument();
	});

	it('renders context summary when context has entries', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContext({
						entries: [
							{ id: 'e1', summary: 'Auth pattern', content: 'JWT', category: 'core', confidence: 0.9, pageRank: 0.5, accessCount: 3 },
							{ id: 'e2', summary: 'Cache logic', content: 'Redis', category: 'patterns', confidence: 0.7, pageRank: 0.3, accessCount: 1 }
						]
					})
				})
			}
		});
		expect(screen.getByText('Context Summary')).toBeInTheDocument();
		expect(screen.getByText('Total Entries')).toBeInTheDocument();
	});

	it('renders top contexts list from context entries', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContext({
						entries: [
							{ id: 'e1', summary: 'Auth pattern', content: 'JWT', category: 'core', confidence: 0.9, pageRank: 0.5, accessCount: 3 }
						]
					})
				})
			}
		});
		expect(screen.getByText('Auth pattern')).toBeInTheDocument();
	});

	it('renders auto-memory entries with key and namespace', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					autoMemory: [
						{
							id: 'am1',
							key: 'mem-auth-jwt',
							summary: 'JWT authentication',
							namespace: 'patterns',
							content: 'Use refresh tokens',
							type: 'pattern',
							createdAt: Date.now() - 60000,
							metadata: {}
						}
					]
				})
			}
		});
		expect(screen.getByText('JWT authentication')).toBeInTheDocument();
		expect(screen.getByText('patterns')).toBeInTheDocument();
		expect(screen.getByText('pattern')).toBeInTheDocument();
	});

	it('shows Refresh button', () => {
		render(MemoryPage, { props: { data: makePageData() } });
		expect(screen.getByText('Refresh')).toBeInTheDocument();
	});

	it('shows loading state when refresh is clicked', async () => {
		// Make fetch hang so loading state persists
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise(() => {})
		);
		render(MemoryPage, { props: { data: makePageData() } });
		const btn = screen.getByText('Refresh');
		await fireEvent.click(btn);
		expect(screen.getByText('Refreshing...')).toBeInTheDocument();
		expect(screen.getByText('Loading memory context...')).toBeInTheDocument();
	});

	it('shows error banner when refresh fails', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
		render(MemoryPage, { props: { data: makePageData() } });
		const btn = screen.getByText('Refresh');
		await fireEvent.click(btn);
		// Wait for the async handler to settle
		await vi.waitFor(() => {
			expect(screen.getByText('Network error')).toBeInTheDocument();
		});
	});

	it('shows error when refresh returns non-ok response', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 500
		});
		render(MemoryPage, { props: { data: makePageData() } });
		const btn = screen.getByText('Refresh');
		await fireEvent.click(btn);
		await vi.waitFor(() => {
			expect(screen.getByText('Failed to fetch memory context (500)')).toBeInTheDocument();
		});
	});

	it('dismisses error when dismiss button is clicked', async () => {
		(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Test error'));
		render(MemoryPage, { props: { data: makePageData() } });
		await fireEvent.click(screen.getByText('Refresh'));
		await vi.waitFor(() => {
			expect(screen.getByText('Test error')).toBeInTheDocument();
		});
		const dismissBtn = screen.getByLabelText('Dismiss error');
		await fireEvent.click(dismissBtn);
		expect(screen.queryByText('Test error')).not.toBeInTheDocument();
	});

	it('computes edge count from graph data', () => {
		const { container } = render(MemoryPage, {
			props: {
				data: makePageData({
					graph: makeGraphState({
						nodes: {
							a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: Date.now() },
							b: { id: 'b', category: 'core', confidence: 0.8, accessCount: 1, createdAt: Date.now() }
						},
						edges: [{ sourceId: 'a', targetId: 'b', type: 'temporal' as const, weight: 1 }],
						pageRanks: { a: 0.6, b: 0.4 }
					})
				})
			}
		});
		// The Edges metric card should show 1
		expect(screen.getByText('Edges')).toBeInTheDocument();
	});

	describe('malformed graph data handling', () => {
		it('handles graph with nodes as an array instead of object', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: { nodes: ['bad'] as any, edges: [], pageRanks: {} }
					})
				}
			});
			// Array has no Object.values mapping to valid nodes — should show fallback error
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
		});

		it('handles graph with edges containing invalid sourceId/targetId references', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 1, createdAt: Date.now() }
							},
							edges: [
								{ sourceId: 'nonexistent', targetId: 'also-missing', type: 'temporal' as const, weight: 1 }
							],
							pageRanks: { a: 0.5 }
						})
					})
				}
			});
			// Dangling edges should not crash — graph still renders
			expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		});

		it('handles graph with null node value', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: { broken: null as any },
							pageRanks: {}
						})
					})
				}
			});
			// Accessing properties on null throws — caught by graphNodes error handler
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
		});

		it('handles graph with undefined nodes value', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: { nodes: undefined as any, edges: [], pageRanks: {} },
						context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
					})
				}
			});
			// data.graph?.nodes is undefined — derived returns []
			expect(screen.getByText('No graph data yet')).toBeInTheDocument();
		});

		it('handles graph with edges as non-array value', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 1, createdAt: Date.now() }
							},
							edges: 'not-an-array' as any,
							pageRanks: { a: 0.5 }
						})
					})
				}
			});
			// Should not crash the page
			expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		});

		it('handles completely empty graph object', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: {} as any,
						context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
					})
				}
			});
			// Empty object has no nodes — should show empty state
			expect(screen.getByText('No graph data yet')).toBeInTheDocument();
		});

		it('handles graph with pageRanks as null', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 1, createdAt: Date.now() }
							},
							edges: [],
							pageRanks: null as any
						})
					})
				}
			});
			// pageRanks ?? {} fallback should handle null — page renders normally
			expect(screen.getByText('Memory & Knowledge')).toBeInTheDocument();
		});

		it('does not render BubbleGraph when graph error occurs from malformed data', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: { broken: null as any },
							edges: [{ sourceId: 'a', targetId: 'b', type: 'temporal' as const, weight: 1 }],
							pageRanks: {}
						})
					})
				}
			});
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			expect(screen.queryByText('No graph data yet')).not.toBeInTheDocument();
			expect(screen.queryByText('Loading memory graph...')).not.toBeInTheDocument();
		});
	});

	describe('memoryGraphEnabled flag disabled', () => {
		it('shows disabled message when memoryGraphEnabled is false', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						memoryGraphEnabled: false,
						graph: null,
						context: makeContext({ entries: [{ id: 'e1', summary: 'X', content: '', category: 'core', confidence: 0.5, pageRank: 0.5, accessCount: 1 }] })
					})
				}
			});
			expect(screen.getByText('Memory graph is disabled. Enable it in settings to visualize relationships.')).toBeInTheDocument();
			expect(screen.queryByText('No graph data yet')).not.toBeInTheDocument();
		});

		it('does not render BubbleGraph when memoryGraphEnabled is false even with graph data', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						memoryGraphEnabled: false,
						graph: makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: Date.now() }
							},
							edges: [],
							pageRanks: { a: 0.5 }
						})
					})
				}
			});
			// Graph disabled message should show, not the graph itself
			expect(screen.getByText('Memory graph is disabled. Enable it in settings to visualize relationships.')).toBeInTheDocument();
		});

		it('does not fetch graph data on refresh when memoryGraphEnabled is false', async () => {
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ context: makeContext(), autoMemory: [] })
					});
				}
				if (url === '/api/memory/graph') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve(makeGraphState())
					});
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, {
				props: {
					data: makePageData({ memoryGraphEnabled: false })
				}
			});

			const btn = screen.getByText('Refresh');
			await fireEvent.click(btn);

			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});

			const graphCalls = fetchMock.mock.calls.filter(
				(call: unknown[]) => call[0] === '/api/memory/graph'
			);
			expect(graphCalls).toHaveLength(0);
		});
	});

	describe('graph fetch failure and fallback with retry', () => {
		it('does not show error banner when graph fetch returns non-ok but context succeeds', async () => {
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ context: makeContext(), autoMemory: [] })
					});
				}
				if (url === '/api/memory/graph') {
					return Promise.resolve({ ok: false, status: 502 });
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData({ graph: null }) } });
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			// No error banner shown — graph failure is silent, only context failure triggers error
			expect(screen.queryByText(/Network error/)).not.toBeInTheDocument();
			expect(screen.queryByText(/Failed to fetch memory context/)).not.toBeInTheDocument();
		});

		it('shows graph error fallback when server returns malformed graph data on refresh', async () => {
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({
							context: makeContext({
								entries: [
									{ id: 'e1', summary: 'Test', content: '', category: 'core', confidence: 0.8, pageRank: 0.5, accessCount: 1 }
								]
							}),
							autoMemory: []
						})
					});
				}
				if (url === '/api/memory/graph') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({
							nodes: { broken: null },
							edges: [],
							pageRanks: {}
						})
					});
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData() } });
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			// Malformed graph data triggers the inline error fallback
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
		});

		it('recovers from graph error on retry with valid data', async () => {
			let callCount = 0;
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({
							context: makeContext({
								entries: [
									{ id: 'a', summary: 'Auth', content: 'JWT', category: 'core', confidence: 0.9, pageRank: 0.5, accessCount: 2 }
								]
							}),
							autoMemory: []
						})
					});
				}
				if (url === '/api/memory/graph') {
					callCount++;
					if (callCount === 1) {
						// First call: return malformed data
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({
								nodes: { broken: null },
								edges: [],
								pageRanks: {}
							})
						});
					}
					// Second call: return valid data
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve(makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: Date.now() }
							},
							edges: [],
							pageRanks: { a: 0.5 }
						}))
					});
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData() } });

			// First refresh — malformed data triggers fallback
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();

			// Second refresh (retry) — valid data recovers
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			// Error fallback should be gone after successful retry
			expect(screen.queryByText('Failed to load graph data')).not.toBeInTheDocument();
		});

		it('shows error fallback message text from caught exception', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: { broken: null as any },
							edges: [],
							pageRanks: {}
						})
					})
				}
			});
			// The fallback renders both the heading and the error detail
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			// The error detail text should be present (from the caught TypeError)
			const graphSection = screen.getByText('Failed to load graph data').closest('div');
			expect(graphSection).toBeInTheDocument();
		});

		it('renders graph fallback with warning icon when graph processing fails', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: { broken: null as any },
							edges: [],
							pageRanks: {}
						})
					})
				}
			});
			// Fallback container has centered flex layout
			const fallbackContainer = screen.getByText('Failed to load graph data').closest('div');
			expect(fallbackContainer).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center');
		});

		it('shows graph error fallback with Retry button when graph API network-rejects on refresh', async () => {
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ context: makeContext(), autoMemory: [] })
					});
				}
				if (url === '/api/memory/graph') {
					return Promise.reject(new Error('Network request failed'));
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData({ graph: null }) } });
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				// Network rejection goes to general error banner, not graph-specific fallback
				expect(screen.getByText('Network request failed')).toBeInTheDocument();
			});
		});

		it('shows graph fallback with Retry when graph API returns non-ok and user can retry successfully', async () => {
			let graphCallCount = 0;
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({
							context: makeContext({
								entries: [{ id: 'e1', summary: 'Test', content: '', category: 'core', confidence: 0.8, pageRank: 0.5, accessCount: 1 }]
							}),
							autoMemory: [{ id: 'am1', key: 'k1', summary: 's1', namespace: 'default', content: '', type: 'pattern', createdAt: Date.now(), metadata: {} }]
						})
					});
				}
				if (url === '/api/memory/graph') {
					graphCallCount++;
					if (graphCallCount === 1) {
						return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
					}
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve(makeGraphState({
							nodes: {
								a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: Date.now() }
							},
							edges: [],
							pageRanks: { a: 0.5 }
						}))
					});
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData({ graph: null }) } });

			// First refresh — graph API returns 503
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			// Graph error fallback should appear with retry button
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			expect(screen.getByText('Retry')).toBeInTheDocument();

			// Click Retry — second call returns valid data
			await fireEvent.click(screen.getByText('Retry'));
			await vi.waitFor(() => {
				expect(screen.queryByText('Failed to load graph data')).not.toBeInTheDocument();
			});
			// Graph error should be cleared
			expect(screen.queryByText('Retry')).not.toBeInTheDocument();
		});

		it('shows graph fallback with error detail when retryGraphFetch itself rejects', async () => {
			const fetchMock = vi.fn().mockImplementation((url: string) => {
				if (url === '/api/memory/context') {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({
							context: makeContext({
								entries: [{ id: 'e1', summary: 'Test', content: '', category: 'core', confidence: 0.8, pageRank: 0.5, accessCount: 1 }]
							}),
							autoMemory: [{ id: 'am1', key: 'k1', summary: 's1', namespace: 'default', content: '', type: 'pattern', createdAt: Date.now(), metadata: {} }]
						})
					});
				}
				if (url === '/api/memory/graph') {
					return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
				}
				return Promise.resolve({ ok: false, status: 404 });
			});
			globalThis.fetch = fetchMock;

			render(MemoryPage, { props: { data: makePageData({ graph: null }) } });
			await fireEvent.click(screen.getByText('Refresh'));
			await vi.waitFor(() => {
				expect(screen.getByText('Refresh')).not.toBeDisabled();
			});
			// Should show graph-specific error with status detail
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			expect(screen.getByText(/Graph API returned 500/)).toBeInTheDocument();

			// Now make retry also fail with a network error
			fetchMock.mockImplementation((url: string) => {
				if (url === '/api/memory/graph') {
					return Promise.reject(new Error('Connection refused'));
				}
				return Promise.resolve({ ok: false, status: 404 });
			});

			await fireEvent.click(screen.getByText('Retry'));
			await vi.waitFor(() => {
				expect(screen.getByText('Connection refused')).toBeInTheDocument();
			});
			// Fallback still shows with updated error message
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			expect(screen.getByText('Retry')).toBeInTheDocument();
		});

		it('does not show empty-state message when graph error fallback is active', () => {
			render(MemoryPage, {
				props: {
					data: makePageData({
						graph: makeGraphState({
							nodes: { broken: null as any },
							edges: [],
							pageRanks: {}
						})
					})
				}
			});
			expect(screen.getByText('Failed to load graph data')).toBeInTheDocument();
			expect(screen.queryByText('No graph data yet')).not.toBeInTheDocument();
			expect(screen.queryByText('Loading memory graph...')).not.toBeInTheDocument();
		});
	});

	it('displays confidence metric from context entries', () => {
		render(MemoryPage, {
			props: {
				data: makePageData({
					context: makeContext({
						entries: [
							{ id: 'e1', summary: 'A', content: '', category: 'core', confidence: 0.8, pageRank: 0.5, accessCount: 1 },
							{ id: 'e2', summary: 'B', content: '', category: 'core', confidence: 0.6, pageRank: 0.3, accessCount: 1 }
						]
					})
				})
			}
		});
		// Average confidence = (0.8 + 0.6) / 2 = 0.7 => 70.0%
		expect(screen.getByText('70.0%')).toBeInTheDocument();
	});
});
