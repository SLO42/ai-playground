// MEMORY-SCENE-SPEC §4 — unit tests for the PURE scene-graph logic (the "pure bits" the
// wave asks for): the force-data mapping, the DbChange→animation-intent mapping, the
// reduced-motion branch, and the token-class node visual. No DOM / motion / d3 — pure.

import { describe, it, expect } from 'vitest';
import {
	toForceModel,
	linkId,
	animationIntent,
	springFor,
	keyframesFor,
	statusFamily,
	nodeVisual,
	type SceneChange
} from './scene-graph';
import type { SceneGraph } from '$lib/server/scene';

const graph: SceneGraph = {
	nodes: [
		{ id: 'entity:a', class: 'memory', subclass: 'entity', label: 'Alpha', status: 'active' },
		{ id: 'memory:m1', class: 'memory', subclass: 'memory', label: 'memory: note', status: 'active' },
		{ id: 'session:s1', class: 'job', subclass: 'session', label: 'session: build', status: 'running' },
		{ id: 'work_item:w1', class: 'job', subclass: 'work_item', label: 'work: review', status: 'pending' }
	],
	edges: [
		{ from: 'entity:a', to: 'memory:m1', kind: 'references' },
		{ from: 'work_item:w1', to: 'session:s1', kind: 'job_target' }
	]
};

describe('toForceModel (force-data mapping)', () => {
	it('happy path: maps nodes + valid edges to a force model with stable link ids', () => {
		const m = toForceModel(graph);
		expect(m.nodes).toHaveLength(4);
		expect(m.links).toHaveLength(2);
		expect(m.links[0]).toMatchObject({ source: 'entity:a', target: 'memory:m1', kind: 'references' });
		expect(m.links[0].id).toBe('entity:a→memory:m1:references');
		// node fields carried through
		expect(m.nodes.find((n) => n.id === 'session:s1')).toMatchObject({ class: 'job', status: 'running' });
	});

	it('nil shadow path: null/undefined graph → empty model, no throw', () => {
		expect(toForceModel(null)).toEqual({ nodes: [], links: [] });
		expect(toForceModel(undefined)).toEqual({ nodes: [], links: [] });
	});

	it('empty shadow path: empty graph → empty model (honest empty, F-008)', () => {
		expect(toForceModel({ nodes: [], edges: [] })).toEqual({ nodes: [], links: [] });
	});

	it('upstream-error shadow path: a dangling edge (endpoint not a node) is dropped, never a phantom link', () => {
		const dangling: SceneGraph = {
			nodes: [{ id: 'entity:a', class: 'memory', subclass: 'entity', label: 'A', status: 'active' }],
			edges: [{ from: 'entity:a', to: 'entity:GONE', kind: 'references' }]
		};
		expect(toForceModel(dangling).links).toHaveLength(0);
	});

	it('collapses duplicate parallel edges to one drawn link', () => {
		const dup: SceneGraph = {
			nodes: graph.nodes,
			edges: [
				{ from: 'entity:a', to: 'memory:m1', kind: 'references' },
				{ from: 'entity:a', to: 'memory:m1', kind: 'references' }
			]
		};
		expect(toForceModel(dup).links).toHaveLength(1);
	});

	it('linkId matches the edge-keying contract', () => {
		expect(linkId({ from: 'a:1', to: 'b:2', kind: 'references' })).toBe('a:1→b:2:references');
	});
});

describe('animationIntent (scene_event/DbChange → animation intent)', () => {
	const change = (action: SceneChange['action'], record: string, result?: unknown): SceneChange => ({
		action,
		record,
		result
	});

	it('entity/memory CREATE → spawn (node)', () => {
		expect(animationIntent('entity', change('CREATE', 'entity:new'))).toEqual({
			kind: 'spawn',
			target: 'entity:new',
			on: 'node'
		});
		expect(animationIntent('memory', change('CREATE', 'memory:new'))?.kind).toBe('spawn');
	});

	it('session/work_item CREATE → spawn (a job fires in)', () => {
		expect(animationIntent('session', change('CREATE', 'session:s2'))?.kind).toBe('spawn');
		expect(animationIntent('work_item', change('CREATE', 'work_item:w2'))?.kind).toBe('spawn');
	});

	it('job UPDATE → non-terminal status → pulse', () => {
		const i = animationIntent('session', change('UPDATE', 'session:s1', { status: 'running' }));
		expect(i).toEqual({ kind: 'pulse', target: 'session:s1', on: 'node' });
	});

	it('job UPDATE → terminal status → retire', () => {
		expect(animationIntent('session', change('UPDATE', 'session:s1', { status: 'done' }))?.kind).toBe('retire');
		expect(animationIntent('work_item', change('UPDATE', 'work_item:w1', { status: 'failed' }))?.kind).toBe('retire');
	});

	it('references CREATE → connect (edge), link id matches toForceModel', () => {
		const i = animationIntent('references', change('CREATE', 'references:r1', {
			in: 'entity:a',
			out: 'memory:m1',
			kind: 'references'
		}));
		expect(i).toEqual({ kind: 'connect', target: 'entity:a→memory:m1:references', on: 'edge' });
	});

	it('DELETE on a node topic → retire', () => {
		expect(animationIntent('session', change('DELETE', 'session:s1'))?.kind).toBe('retire');
	});

	it('nil/unknown shadow paths → null (no fabricated motion)', () => {
		expect(animationIntent('session', null)).toBeNull();
		expect(animationIntent('session', undefined)).toBeNull();
		expect(animationIntent('session', { action: 'CREATE', record: '' })).toBeNull();
		expect(animationIntent('unknown_topic', change('CREATE', 'x:1'))).toBeNull();
		// references CREATE with no row body → cannot address the link → null
		expect(animationIntent('references', change('CREATE', 'references:r2'))).toBeNull();
	});
});

describe('springFor + keyframesFor (reduced-motion branch)', () => {
	it('normal motion: spawn is the wobbly spring with a scale transform', () => {
		expect(springFor('spawn', false)).toEqual({ type: 'spring', stiffness: 200, damping: 10 });
		expect(keyframesFor('spawn', false)).toEqual({ scale: [0, 1], opacity: [0, 1] });
	});

	it('reduced motion: NO spring anywhere — every transition is duration-based', () => {
		for (const kind of ['spawn', 'pulse', 'connect', 'retire'] as const) {
			const t = springFor(kind, true);
			expect('type' in t && t.type === 'spring').toBe(false);
			expect('duration' in t).toBe(true);
		}
	});

	it('reduced motion: keyframes are opacity-only — no scale transform', () => {
		for (const kind of ['spawn', 'pulse', 'connect', 'retire'] as const) {
			expect(keyframesFor(kind, true).scale).toBeUndefined();
			expect(keyframesFor(kind, true).opacity).toBeDefined();
		}
	});

	it('reduced spawn/retire are instant (duration 0); pulse keeps a tiny perceptible fade', () => {
		expect(springFor('spawn', true)).toEqual({ duration: 0 });
		expect(springFor('retire', true)).toEqual({ duration: 0 });
		expect(springFor('pulse', true)).toMatchObject({ duration: 0.18 });
	});
});

describe('statusFamily + nodeVisual (token classes, no color literals)', () => {
	it('maps live statuses → design-system status families', () => {
		expect(statusFamily({ class: 'job', status: 'running' })).toBe('active');
		expect(statusFamily({ class: 'job', status: 'pending' })).toBe('pending');
		expect(statusFamily({ class: 'job', status: 'done' })).toBe('done');
		expect(statusFamily({ class: 'job', status: 'failed' })).toBe('failed');
		expect(statusFamily({ class: 'memory', status: 'archived' })).toBe('dim');
		expect(statusFamily({ class: 'memory', status: 'active' })).toBe('active');
	});

	it('nodeVisual returns token classes + a radius (jobs larger than memories)', () => {
		const job = nodeVisual({ id: 'session:s1', class: 'job', subclass: 'session', label: 's', status: 'running' });
		const mem = nodeVisual({ id: 'memory:m1', class: 'memory', subclass: 'memory', label: 'm', status: 'active' });
		expect(job).toMatchObject({ colorClass: 'job', statusClass: 'active' });
		expect(job.radius).toBeGreaterThan(mem.radius);
		// no inline color anywhere in the visual — only class names
		expect(JSON.stringify(job)).not.toMatch(/#[0-9a-f]{3,6}/i);
	});
});
