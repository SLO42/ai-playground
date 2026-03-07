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
});
