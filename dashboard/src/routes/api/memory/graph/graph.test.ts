import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadJsonFile, mockCacheGet, mockCacheSet, mockCacheGetTtl, mockInvalidate, mockWriteFile, mockMkdir } = vi.hoisted(() => ({
	mockReadJsonFile: vi.fn(),
	mockCacheGet: vi.fn(),
	mockCacheSet: vi.fn(),
	mockCacheGetTtl: vi.fn().mockReturnValue(30),
	mockInvalidate: vi.fn(),
	mockWriteFile: vi.fn().mockResolvedValue(undefined),
	mockMkdir: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: mockReadJsonFile
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: { graphState: '/mock/path/graph-state.json' }
}));

vi.mock('$lib/server/cache.js', () => ({
	graphCache: { get: mockCacheGet, set: mockCacheSet, getRemainingTtl: mockCacheGetTtl },
	invalidateMemoryCaches: mockInvalidate
}));

vi.mock('fs/promises', () => ({
	writeFile: mockWriteFile,
	mkdir: mockMkdir
}));

import { GET, POST, PUT } from './+server.js';

function makeRequest(body: unknown): Request {
	return new Request('http://localhost/api/memory/graph', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('/api/memory/graph GET', () => {
	beforeEach(() => {
		mockReadJsonFile.mockReset();
		mockCacheGet.mockReset();
		mockCacheSet.mockReset();
	});

	it('returns graph data when file exists and is valid', async () => {
		const graphData = {
			nodes: { a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: 1000 } },
			edges: [{ sourceId: 'a', targetId: 'b', type: 'temporal', weight: 1 }],
			pageRanks: { a: 0.6 }
		};
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(graphData);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(graphData);
		expect(mockReadJsonFile).toHaveBeenCalledWith('/mock/path/graph-state.json');
	});

	it('returns cached data without reading file', async () => {
		const cached = { nodes: { x: { id: 'x' } }, edges: [], pageRanks: {} };
		mockCacheGet.mockReturnValueOnce(cached);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(cached);
		expect(mockReadJsonFile).not.toHaveBeenCalled();
	});

	it('caches graph data after successful file read', async () => {
		const graphData = { nodes: { a: { id: 'a' } }, edges: [], pageRanks: {} };
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(graphData);

		await GET();

		expect(mockCacheSet).toHaveBeenCalledWith('graph-state', graphData);
	});

	it('returns null with 200 when graph file is missing', async () => {
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(null);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toBeNull();
	});

	it('does not cache null when file is missing', async () => {
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(null);

		await GET();

		expect(mockCacheSet).not.toHaveBeenCalled();
	});

	it('returns null when file contains malformed JSON (readJsonFile catches internally)', async () => {
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(null);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toBeNull();
	});

	it('propagates error when readJsonFile throws unexpectedly', async () => {
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockRejectedValueOnce(new Error('Disk I/O failure'));

		await expect(GET()).rejects.toThrow('Disk I/O failure');
	});

	it('returns empty graph structure when file has empty nodes/edges', async () => {
		const emptyGraph = { nodes: {}, edges: [], pageRanks: {} };
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(emptyGraph);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.nodes).toEqual({});
		expect(body.edges).toEqual([]);
		expect(body.pageRanks).toEqual({});
	});

	it('returns data as-is when graph has unexpected shape (no server-side validation)', async () => {
		const malformed = { unexpected: 'data', nodes: 'not-an-object' };
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(malformed);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(malformed);
	});

	it('passes PATHS.graphState to readJsonFile', async () => {
		mockCacheGet.mockReturnValueOnce(undefined);
		mockReadJsonFile.mockResolvedValueOnce(null);

		await GET();

		expect(mockReadJsonFile).toHaveBeenCalledTimes(1);
		expect(mockReadJsonFile).toHaveBeenCalledWith('/mock/path/graph-state.json');
	});
});
