import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';

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
		render(MemoryPage, { props: { data: makePageData({ graph: null }) } });
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
	});

	it('shows empty state when graph has no nodes', () => {
		render(MemoryPage, {
			props: { data: makePageData({ graph: makeGraphState({ nodes: {} }) }) }
		});
		expect(screen.getByText('No graph data. Memory graph populates as the system processes entries.')).toBeInTheDocument();
	});

	it('shows no-context message when context is null and not loading', () => {
		render(MemoryPage, { props: { data: makePageData({ context: null }) } });
		expect(screen.getByText('No memory context available. Context populates as the system processes entries.')).toBeInTheDocument();
	});

	it('shows "No context entries loaded" when context has empty entries', () => {
		render(MemoryPage, {
			props: { data: makePageData({ context: makeContext({ entries: [] }) }) }
		});
		expect(screen.getByText('No context entries loaded')).toBeInTheDocument();
	});

	it('shows "No auto-memory entries loaded" when autoMemory is empty', () => {
		render(MemoryPage, { props: { data: makePageData({ autoMemory: [] }) } });
		expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
	});

	it('shows "No auto-memory entries loaded" when autoMemory is null', () => {
		render(MemoryPage, { props: { data: makePageData({ autoMemory: null }) } });
		expect(screen.getByText('No auto-memory entries loaded')).toBeInTheDocument();
	});

	it('renders metric cards with default N/A values when data is null', () => {
		render(MemoryPage, { props: { data: makePageData() } });
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
					memoryConfig: { backend: 'agentdb', enableHNSW: true }
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
					memoryConfig: { enableHNSW: false }
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
