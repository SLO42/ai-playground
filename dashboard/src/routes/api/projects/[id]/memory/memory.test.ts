import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadJsonFile, mockScanAllProjects, mockCacheGet, mockCacheSet, mockCacheGetTtl } = vi.hoisted(() => ({
	mockReadJsonFile: vi.fn(),
	mockScanAllProjects: vi.fn(),
	mockCacheGet: vi.fn(),
	mockCacheSet: vi.fn(),
	mockCacheGetTtl: vi.fn().mockReturnValue(30)
}));

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: mockReadJsonFile
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		playgroundRegistry: '/mock/registry',
		root: '/mock/root',
		rankedContext: '/mock/ranked-context.json',
		autoMemoryStore: '/mock/auto-memory.json',
		graphState: '/mock/graph-state.json'
	}
}));

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: mockScanAllProjects
}));

vi.mock('$lib/server/cache.js', () => ({
	projectMemoryCache: {
		get: mockCacheGet,
		set: mockCacheSet,
		getRemainingTtl: mockCacheGetTtl
	}
}));

import { GET } from './+server.js';

function makeEvent(projectId: string, searchParams: Record<string, string> = {}) {
	const url = new URL(`http://localhost/api/projects/${projectId}/memory`);
	for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
	return { params: { id: projectId }, url } as unknown as Parameters<typeof GET>[0];
}

describe('/api/projects/[id]/memory GET', () => {
	beforeEach(() => {
		mockReadJsonFile.mockReset();
		mockScanAllProjects.mockReset();
		mockCacheGet.mockReset();
		mockCacheSet.mockReset();
		mockCacheGetTtl.mockReturnValue(30);
		mockScanAllProjects.mockResolvedValue([
			{ id: 'test-project', name: 'test-project', path: '/mock/projects/test' }
		]);
	});

	it('does not throw when graph is null (no graph file)', async () => {
		mockCacheGet.mockReturnValue(undefined);
		mockReadJsonFile
			.mockResolvedValueOnce(null)  // rankedContext
			.mockResolvedValueOnce(null)  // autoMemoryStore
			.mockResolvedValueOnce(null); // graphState

		const response = await GET(makeEvent('test-project'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.graph).toBeNull();
	});

	it('does not throw when graph is null and a time range is set', async () => {
		mockCacheGet.mockReturnValue(undefined);
		mockReadJsonFile
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null);

		const response = await GET(makeEvent('test-project', { range: '1h' }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.graph).toBeNull();
	});

	it('does not throw when graph is undefined and range is 24h', async () => {
		mockCacheGet.mockReturnValue(undefined);
		mockReadJsonFile
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(undefined);

		const response = await GET(makeEvent('test-project', { range: '24h' }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.graph).toBeNull();
	});

	it('filters graph nodes by cutoff when graph exists and range is set', async () => {
		const now = Date.now();
		const graphData = {
			nodes: {
				recent: { id: 'recent', category: 'core', confidence: 1, accessCount: 0, createdAt: now },
				old: { id: 'old', category: 'core', confidence: 1, accessCount: 0, createdAt: 1000 }
			},
			edges: [
				{ source: 'recent', target: 'old', type: 'temporal', weight: 1 }
			],
			pageRanks: { recent: 0.5, old: 0.3 },
			updatedAt: now
		};

		mockCacheGet.mockReturnValue(undefined);
		mockReadJsonFile
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(graphData);

		const response = await GET(makeEvent('test-project', { range: '1h' }));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.graph).not.toBeNull();
		expect(body.graph.nodes).toHaveProperty('recent');
		expect(body.graph.nodes).not.toHaveProperty('old');
		expect(body.graph.pageRanks.recent).toBe(0.5);
		expect(body.graph.pageRanks).not.toHaveProperty('old');
	});

	it('returns full graph when no range is set', async () => {
		const graphData = {
			nodes: {
				a: { id: 'a', category: 'core', confidence: 1, accessCount: 0, createdAt: 1000 }
			},
			edges: [],
			pageRanks: { a: 0.5 },
			updatedAt: 2000
		};

		mockCacheGet.mockReturnValue(undefined);
		mockReadJsonFile
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(graphData);

		const response = await GET(makeEvent('test-project'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.graph).toEqual(graphData);
	});

	it('returns cached response when available', async () => {
		const cached = { projectId: 'test-project', graph: null };
		mockCacheGet.mockReturnValue(cached);

		const response = await GET(makeEvent('test-project'));
		const body = await response.json();

		expect(body).toEqual(cached);
		expect(mockReadJsonFile).not.toHaveBeenCalled();
	});

	describe('caching behavior', () => {
		it('populates cache on first request and serves from cache on second', async () => {
			// First request: cache miss — should read files and store result
			mockCacheGet.mockReturnValue(undefined);
			mockReadJsonFile
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(null);

			const first = await GET(makeEvent('test-project'));
			expect(first.status).toBe(200);
			expect(mockCacheSet).toHaveBeenCalledTimes(1);
			const storedValue = mockCacheSet.mock.calls[0][1];

			// Second request: cache hit — should skip file reads entirely
			mockReadJsonFile.mockClear();
			mockScanAllProjects.mockClear();
			mockCacheGet.mockReturnValue(storedValue);

			const second = await GET(makeEvent('test-project'));
			const secondBody = await second.json();

			expect(mockReadJsonFile).not.toHaveBeenCalled();
			expect(mockScanAllProjects).not.toHaveBeenCalled();
			expect(secondBody).toEqual(storedValue);
		});

		it('includes Cache-Control header with remaining TTL on cache hit', async () => {
			const cached = { projectId: 'test-project', graph: null };
			mockCacheGet.mockReturnValue(cached);
			mockCacheGetTtl.mockReturnValue(17);

			const response = await GET(makeEvent('test-project'));
			const cc = response.headers.get('Cache-Control');

			expect(cc).toBe('max-age=17, stale-while-revalidate=10');
		});

		it('uses separate cache keys per range parameter', async () => {
			mockCacheGet.mockReturnValue(undefined);
			mockReadJsonFile
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(null);

			await GET(makeEvent('test-project', { range: '1h' }));
			const firstKey = mockCacheSet.mock.calls[0][0];

			mockReadJsonFile
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(null);

			await GET(makeEvent('test-project', { range: '24h' }));
			const secondKey = mockCacheSet.mock.calls[1][0];

			expect(firstKey).toBe('project-memory:test-project:1h');
			expect(secondKey).toBe('project-memory:test-project:24h');
			expect(firstKey).not.toBe(secondKey);
		});

		it('uses "all" suffix in cache key when no range is specified', async () => {
			mockCacheGet.mockReturnValue(undefined);
			mockReadJsonFile
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(null);

			await GET(makeEvent('test-project'));
			const key = mockCacheSet.mock.calls[0][0];

			expect(key).toBe('project-memory:test-project:all');
		});

		it('sets Cache-Control max-age=30 on fresh (non-cached) response', async () => {
			mockCacheGet.mockReturnValue(undefined);
			mockReadJsonFile
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(null);

			const response = await GET(makeEvent('test-project'));
			const cc = response.headers.get('Cache-Control');

			expect(cc).toBe('max-age=30, stale-while-revalidate=10');
		});
	});
});
