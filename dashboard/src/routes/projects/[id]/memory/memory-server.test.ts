import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('$lib/server/file-reader.js', () => ({
	readJsonFile: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		rankedContext: '.playground/ranked-context.json',
		autoMemoryStore: '.playground/auto-memory.json',
		graphState: '.playground/ui-graph-state.json'
	}
}));

import { readJsonFile } from '$lib/server/file-reader.js';

const mockReadJsonFile = vi.mocked(readJsonFile);

function makeGraphState(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		updatedAt: Date.now(),
		nodeCount: 0,
		nodes: {},
		edges: [],
		pageRanks: {},
		...overrides
	};
}

function makeParentData(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'test-project',
		project: { name: 'test-project' },
		...overrides
	};
}

async function callLoad(parentOverrides: Record<string, unknown> = {}) {
	// Dynamic import so mocks are applied first
	const { load } = await import('./+page.server.js');
	return load({
		parent: () => Promise.resolve(makeParentData(parentOverrides))
	} as any);
}

describe('projects/[id]/memory +page.server load', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it('returns graph as null when no graph file exists', async () => {
		mockReadJsonFile.mockResolvedValue(null);
		const result = await callLoad();

		expect(result).toHaveProperty('graph');
		expect(result.graph).toBeNull();
	});

	it('returns graph with expected shape when graph data exists', async () => {
		const graph = makeGraphState({
			nodeCount: 2,
			nodes: {
				a: { id: 'a', category: 'core', confidence: 0.9, accessCount: 2, createdAt: Date.now() },
				b: { id: 'b', category: 'patterns', confidence: 0.7, accessCount: 1, createdAt: Date.now() }
			},
			edges: [{ sourceId: 'a', targetId: 'b', type: 'temporal', weight: 1 }],
			pageRanks: { a: 0.6, b: 0.4 }
		});

		mockReadJsonFile.mockImplementation(async (path: string) => {
			if (path.includes('graph')) return graph;
			return null;
		});

		const result = await callLoad();

		expect(result.graph).toBeDefined();
		expect(result.graph).not.toBeNull();
		expect(result.graph).toHaveProperty('nodes');
		expect(result.graph).toHaveProperty('edges');
		expect(result.graph).toHaveProperty('pageRanks');
		expect(result.graph).toHaveProperty('version');
		expect(result.graph).toHaveProperty('updatedAt');
		expect(result.graph).toHaveProperty('nodeCount');

		// Validate node shape
		const nodes = result.graph!.nodes as Record<string, any>;
		expect(Object.keys(nodes)).toHaveLength(2);
		expect(nodes.a).toMatchObject({ id: 'a', category: 'core', confidence: 0.9 });

		// Validate edges shape
		const edges = result.graph!.edges as any[];
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ sourceId: 'a', targetId: 'b', type: 'temporal', weight: 1 });

		// Validate pageRanks
		expect(result.graph!.pageRanks).toEqual({ a: 0.6, b: 0.4 });
	});

	it('returns graph alongside other expected return keys', async () => {
		mockReadJsonFile.mockResolvedValue(null);
		const result = await callLoad();

		expect(result).toHaveProperty('projectId');
		expect(result).toHaveProperty('projectName');
		expect(result).toHaveProperty('loadError');
		expect(result).toHaveProperty('graph');
		expect(result).toHaveProperty('summary');
		expect(result).toHaveProperty('namespaceBreakdown');
		expect(result).toHaveProperty('categoryBreakdown');
		expect(result).toHaveProperty('entries');
		expect(result).toHaveProperty('context');
	});

	it('sets graph to null when readJsonFile throws', async () => {
		mockReadJsonFile.mockRejectedValue(new Error('File read error'));
		const result = await callLoad();

		expect(result.graph).toBeNull();
		expect(result.loadError).toBe('File read error');
	});

	it('returns graph with empty nodes and edges', async () => {
		const emptyGraph = makeGraphState({ nodes: {}, edges: [], pageRanks: {} });

		mockReadJsonFile.mockImplementation(async (path: string) => {
			if (path.includes('graph')) return emptyGraph;
			return null;
		});

		const result = await callLoad();

		expect(result.graph).toBeDefined();
		expect(result.graph).not.toBeNull();
		expect(Object.keys(result.graph!.nodes as Record<string, any>)).toHaveLength(0);
		expect((result.graph!.edges as any[]) ?? []).toHaveLength(0);
	});
});
