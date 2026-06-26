import { describe, it, expect } from 'vitest';
import { layoutGraph, nodePath, nodeKindLabel, truncate, NODE_W, MARGIN, COL_GAP, COL_HEADER_H } from './layout';
import type { LifecycleEdge, LifecycleNode } from '$lib/server/observability';

// LG-3 layout VERIFY — the PURE layout fn. Deterministic geometry from the LG-2 read model;
// all four shadow paths (happy / nil / empty / malformed) + the causal-depth columns +
// edge routing + stable ordering.

function node(id: string, kind: LifecycleNode['kind'], extra: Partial<LifecycleNode> = {}): LifecycleNode {
	return { id, kind, label: id, status: 'x', ...extra };
}
function edge(from: string, to: string, kind: LifecycleEdge['kind'] = 'spawned', inferred = false): LifecycleEdge {
	return { from, to, kind, inferred };
}

describe('layoutGraph', () => {
	it('empty graph → empty layout with a minimal canvas (honest empty)', () => {
		const out = layoutGraph([], []);
		expect(out.nodes).toEqual([]);
		expect(out.edges).toEqual([]);
		expect(out.columns).toEqual([]);
		expect(out.width).toBe(MARGIN * 2);
		expect(out.height).toBe(MARGIN * 2);
	});

	it('nil nodes/edges → empty layout (does not throw — shadow path)', () => {
		expect(() => layoutGraph(null, null)).not.toThrow();
		expect(() => layoutGraph(undefined, undefined)).not.toThrow();
		const out = layoutGraph(null, undefined);
		expect(out.nodes).toEqual([]);
	});

	it('places a single root at column 0', () => {
		const out = layoutGraph([node('continue:1', 'continue')], []);
		expect(out.nodes).toHaveLength(1);
		expect(out.nodes[0].col).toBe(0);
		expect(out.nodes[0].row).toBe(0);
		expect(out.nodes[0].x).toBe(MARGIN + NODE_W / 2);
		// Cards sit BELOW the column-header band (y offset by COL_HEADER_H).
		expect(out.nodes[0].y).toBeGreaterThan(MARGIN + COL_HEADER_H);
	});

	it('emits a per-column band (header label + count) per rank', () => {
		const nodes = [
			node('continue:1', 'continue'),
			node('session:1', 'session'),
			node('session:2', 'session')
		];
		const edges = [edge('continue:1', 'session:1'), edge('continue:1', 'session:2')];
		const out = layoutGraph(nodes, edges);
		expect(out.columns).toHaveLength(2);
		expect(out.columns[0]).toMatchObject({ col: 0, count: 1, label: 'Continue' });
		expect(out.columns[1]).toMatchObject({ col: 1, count: 2, label: 'Agent sessions' });
		// Column center x aligns with the cards in that column.
		expect(out.columns[1].centerX).toBe(out.nodes.find((n) => n.id === 'session:1')!.x);
	});

	it('assigns causal-depth columns: Continue→session→pm→task is 4 columns', () => {
		const nodes = [
			node('continue:1', 'continue'),
			node('session:1', 'session'),
			node('pm_tick:1', 'pm'),
			node('task:1', 'task')
		];
		const edges = [
			edge('continue:1', 'session:1', 'spawned'),
			edge('session:1', 'pm_tick:1', 'reported-to', true),
			edge('pm_tick:1', 'task:1', 'proposed')
		];
		const out = layoutGraph(nodes, edges);
		const col = (id: string) => out.nodes.find((n) => n.id === id)!.col;
		expect(col('continue:1')).toBe(0);
		expect(col('session:1')).toBe(1);
		expect(col('pm_tick:1')).toBe(2);
		expect(col('task:1')).toBe(3);
		// edges routed between real anchors
		expect(out.edges).toHaveLength(3);
		expect(out.edges[0].path).toMatch(/^M [\d.]+ [\d.]+ C/);
	});

	it('stacks sibling sessions in the same column on successive rows (stable order)', () => {
		const nodes = [
			node('continue:1', 'continue'),
			node('session:1', 'session'),
			node('session:2', 'session')
		];
		const edges = [edge('continue:1', 'session:1'), edge('continue:1', 'session:2')];
		const out = layoutGraph(nodes, edges);
		const s1 = out.nodes.find((n) => n.id === 'session:1')!;
		const s2 = out.nodes.find((n) => n.id === 'session:2')!;
		expect(s1.col).toBe(1);
		expect(s2.col).toBe(1);
		expect(s1.row).toBe(0);
		expect(s2.row).toBe(1);
		expect(s2.y).toBeGreaterThan(s1.y);
	});

	it('drops an edge whose endpoint is not a node (defensive — never throws)', () => {
		const out = layoutGraph([node('a', 'task')], [edge('a', 'ghost')]);
		expect(out.edges).toHaveLength(0);
		expect(out.nodes).toHaveLength(1);
	});

	it('terminates on a cyclic edge set (cycle guard)', () => {
		const nodes = [node('a', 'task'), node('b', 'task')];
		const edges = [edge('a', 'b'), edge('b', 'a')];
		expect(() => layoutGraph(nodes, edges)).not.toThrow();
		const out = layoutGraph(nodes, edges);
		expect(out.nodes).toHaveLength(2);
	});

	it('canvas width grows with column depth', () => {
		const narrow = layoutGraph([node('a', 'continue')], []);
		const wide = layoutGraph(
			[node('a', 'continue'), node('b', 'session')],
			[edge('a', 'b')]
		);
		expect(wide.width).toBe(narrow.width + NODE_W + COL_GAP);
	});

	it('is deterministic — same input yields identical output', () => {
		const nodes = [node('continue:1', 'continue'), node('session:1', 'session')];
		const edges = [edge('continue:1', 'session:1')];
		expect(layoutGraph(nodes, edges)).toEqual(layoutGraph(nodes, edges));
	});

	it('preserves node attributes (role/toolCount/skills) through layout', () => {
		const n = node('session:1', 'session', {
			role: 'role:dev',
			hire: 'role_version:1',
			toolCount: 7,
			skills: ['svelte5-patterns']
		});
		const out = layoutGraph([n], []);
		expect(out.nodes[0].role).toBe('role:dev');
		expect(out.nodes[0].toolCount).toBe(7);
		expect(out.nodes[0].skills).toEqual(['svelte5-patterns']);
	});
});

describe('nodePath', () => {
	// Continue → session → pm → task chain (the canonical lifecycle).
	const nodes = [
		node('continue:1', 'continue', { label: 'Continue' }),
		node('session:1', 'session', { label: 'session: build X' }),
		node('pm_tick:1', 'pm', { label: 'PM tick' }),
		node('task:1', 'task', { label: 'next task' })
	];
	const edges = [
		edge('continue:1', 'session:1', 'spawned'),
		edge('session:1', 'pm_tick:1', 'reported-to', true),
		edge('pm_tick:1', 'task:1', 'proposed')
	];

	it('returns parents (causes) and children (effects) for a mid-chain node', () => {
		const p = nodePath('session:1', nodes, edges);
		expect(p.parents).toEqual([
			{ id: 'continue:1', label: 'Continue', kind: 'spawned', inferred: false }
		]);
		expect(p.children).toEqual([
			{ id: 'pm_tick:1', label: 'PM tick', kind: 'reported-to', inferred: true }
		]);
	});

	it('a root node has no parents; a leaf has no children', () => {
		expect(nodePath('continue:1', nodes, edges).parents).toEqual([]);
		expect(nodePath('task:1', nodes, edges).children).toEqual([]);
	});

	it('carries the inferred flag through verbatim (F-008 honest)', () => {
		expect(nodePath('pm_tick:1', nodes, edges).parents[0].inferred).toBe(true);
	});

	it('drops a path step whose neighbour is not a node (defensive — never fabricates)', () => {
		const p = nodePath('a', [node('a', 'task')], [edge('a', 'ghost'), edge('ghost', 'a')]);
		expect(p.parents).toEqual([]);
		expect(p.children).toEqual([]);
	});

	it('nil / empty / unknown-focus → empty path (all shadow paths, never throws)', () => {
		expect(nodePath(null, nodes, edges)).toEqual({ parents: [], children: [] });
		expect(nodePath('session:1', null, null)).toEqual({ parents: [], children: [] });
		expect(nodePath('nope:1', nodes, edges)).toEqual({ parents: [], children: [] });
		expect(() => nodePath('session:1', undefined, undefined)).not.toThrow();
	});

	it('dedups a neighbour reached by the same edge kind + sorts by label', () => {
		const ns = [
			node('p:1', 'task', { label: 'beta' }),
			node('p:2', 'task', { label: 'alpha' }),
			node('c:1', 'task', { label: 'child' })
		];
		const es = [
			edge('p:1', 'c:1', 'follow-up'),
			edge('p:2', 'c:1', 'follow-up'),
			edge('p:1', 'c:1', 'follow-up') // duplicate — collapsed
		];
		const p = nodePath('c:1', ns, es);
		expect(p.parents.map((x) => x.label)).toEqual(['alpha', 'beta']); // label-sorted, deduped
	});
});

describe('nodeKindLabel', () => {
	it('names each node kind', () => {
		expect(nodeKindLabel('continue')).toBe('Continue');
		expect(nodeKindLabel('session')).toBe('Agent session');
		expect(nodeKindLabel('pm')).toBe('Project manager');
		expect(nodeKindLabel('task')).toBe('Task');
	});
});

describe('truncate', () => {
	it('leaves a short string unchanged', () => {
		expect(truncate('hello', 40)).toBe('hello');
	});
	it('ellipsises a long string to the bound (full title kept by the caller)', () => {
		const long = 'a'.repeat(60);
		const out = truncate(long, 40);
		expect(out.length).toBe(40);
		expect(out.endsWith('…')).toBe(true);
	});
	it('handles the empty string (shadow path)', () => {
		expect(truncate('', 40)).toBe('');
	});
});
