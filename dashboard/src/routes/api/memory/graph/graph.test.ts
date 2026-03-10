import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadJsonFile } = vi.hoisted(() => ({
	mockReadJsonFile: vi.fn()
}));

vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: mockReadJsonFile
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: { graphState: '/mock/path/graph-state.json' }
}));

import { GET } from './+server.js';

describe('/api/memory/graph GET', () => {
	beforeEach(() => {
		mockReadJsonFile.mockReset();
	});

	it('returns graph data when file exists and is valid', async () => {
		const graphData = {
			nodes: { a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: 1000 } },
			edges: [{ sourceId: 'a', targetId: 'b', type: 'temporal', weight: 1 }],
			pageRanks: { a: 0.6 }
		};
		mockReadJsonFile.mockResolvedValueOnce(graphData);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(graphData);
		expect(mockReadJsonFile).toHaveBeenCalledWith('/mock/path/graph-state.json');
	});

	it('returns null with 200 when graph file is missing', async () => {
		mockReadJsonFile.mockResolvedValueOnce(null);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toBeNull();
	});

	it('returns null when file contains malformed JSON (readJsonFile catches internally)', async () => {
		mockReadJsonFile.mockResolvedValueOnce(null);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toBeNull();
	});

	it('propagates error when readJsonFile throws unexpectedly', async () => {
		mockReadJsonFile.mockRejectedValueOnce(new Error('Disk I/O failure'));

		await expect(GET()).rejects.toThrow('Disk I/O failure');
	});

	it('returns empty graph structure when file has empty nodes/edges', async () => {
		const emptyGraph = { nodes: {}, edges: [], pageRanks: {} };
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
		mockReadJsonFile.mockResolvedValueOnce(malformed);

		const response = await GET();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual(malformed);
	});

	it('passes PATHS.graphState to readJsonFile', async () => {
		mockReadJsonFile.mockResolvedValueOnce(null);

		await GET();

		expect(mockReadJsonFile).toHaveBeenCalledTimes(1);
		expect(mockReadJsonFile).toHaveBeenCalledWith('/mock/path/graph-state.json');
	});
});
