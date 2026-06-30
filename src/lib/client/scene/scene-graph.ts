// MEMORY-SCENE-SPEC §4 — the PURE logic for the living-brain animated graph.
//
// What this is (and is NOT):
//   • This module is the framework-agnostic, side-effect-free core the MemoryScene
//     component renders. It does NOT touch the DOM, motion.dev, d3-force, or Svelte —
//     it just MAPS the derived truth (the MS-2 aggregator's SceneGraph) and the live
//     feed (MS-1 scene_event / a DbChange) into the shapes the component animates.
//     Keeping it pure means the force-data mapping, the change→animation-intent
//     mapping, and the reduced-motion branch are all unit-testable in node (the test
//     env is `node` — no DOM), which is exactly the "pure bits" the wave asks for.
//   • It is NOT a source of truth (F-008). The aggregator (src/lib/server/scene) is the
//     node/edge TRUTH; this module never fabricates a node — it only re-shapes what the
//     loader already derived live. A change-intent that references an unknown node is
//     dropped (the truth refresh, via loader re-invalidation, is what actually adds it).
//
// Layers (MEMORY-SCENE-SPEC §4 "springs LAYERED on the force positions"):
//   1. toForceModel()      — SceneGraph → {nodes, links} d3-force consumes for layout.
//   2. animationIntent()   — a DbChange (off the SSE feed) → an AnimationIntent the
//                            component plays with motion.dev (spawn pop / job pulse /
//                            connection draw / node exit).
//   3. springFor()         — the reduced-motion-aware motion.dev transition for an intent
//                            (wobbly spring normally; instant/opacity-only when reduced).
//   4. nodeVisual()        — a node's design-system color family + radius (TOKENS only).

import type { SceneGraph, SceneNode, SceneEdge, SceneNodeClass, SceneEvent } from '$lib/server/scene';

// ── 1. Force model ──────────────────────────────────────────────────────────────────

/** A node fed to the d3-force simulation. x/y/vx/vy are mutated by the sim in place. */
export interface ForceNode {
	id: string;
	class: SceneNodeClass;
	subclass: SceneNode['subclass'];
	label: string;
	status: string;
	/** S3 — a concept node's screened summary (surfaced in the inspect panel). Absent otherwise. */
	summary?: string;
	/** Owning project record-id when the source row carried one (for the per-atelier lens). */
	project?: string;
	/** Agent slot that ran a job (session nodes; m0069) — surfaced in the inspect panel. */
	agent?: string;
	/** Linked task record-id (session nodes) — surfaced in the inspect panel. */
	task?: string;
	/** Last-known activity time, ISO — drives the time scrubber + the inspect panel. */
	at?: string;
	/** Simulation-owned position/velocity (seeded; d3-force fills these). */
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	/** Pin flag: when dragged, the node is fixed (fx/fy) until released. */
	fx?: number | null;
	fy?: number | null;
}

/** A link fed to d3-force. `source`/`target` are node ids (d3 swaps them for node refs). */
export interface ForceLink {
	id: string;
	source: string;
	target: string;
	kind: string;
}

export interface ForceModel {
	nodes: ForceNode[];
	links: ForceLink[];
}

/**
 * Map the derived SceneGraph → the d3-force model (MEMORY-SCENE-SPEC §4 layout layer).
 * PURE + total. Shadow paths, all four, all named:
 *   • happy — real nodes/edges → a force model with one link per valid edge.
 *   • nil   — `graph` null/undefined (loader degraded) → empty model (no throw).
 *   • empty — `{nodes:[],edges:[]}` (honest-empty DB) → empty model → the UI shows the
 *             "no active memory / jobs yet" state, never a faked graph (F-008).
 *   • upstream error — a malformed edge (endpoint not in the node set) is DROPPED, never
 *             rendered as a dangling link (the aggregator already filters, this is belt+braces).
 * A stable link `id` (`from→to:kind`) lets the component key edges for enter/exit animation.
 */
export function toForceModel(graph: SceneGraph | null | undefined): ForceModel {
	if (!graph || !Array.isArray(graph.nodes)) return { nodes: [], links: [] };

	const nodes: ForceNode[] = graph.nodes.map((n) => ({
		id: n.id,
		class: n.class,
		subclass: n.subclass,
		label: n.label,
		status: n.status,
		...(n.summary ? { summary: n.summary } : {}),
		...(n.project ? { project: n.project } : {}),
		...(n.agent ? { agent: n.agent } : {}),
		...(n.task ? { task: n.task } : {}),
		...(n.at ? { at: n.at } : {})
	}));

	const ids = new Set(nodes.map((n) => n.id));
	const links: ForceLink[] = [];
	const seen = new Set<string>();
	for (const e of graph.edges ?? []) {
		// Drop a dangling edge (endpoint not in the rendered node set) — never a phantom link.
		if (!ids.has(e.from) || !ids.has(e.to)) continue;
		const id = linkId(e);
		if (seen.has(id)) continue; // collapse duplicate parallel edges to one drawn link
		seen.add(id);
		links.push({ id, source: e.from, target: e.to, kind: e.kind });
	}
	return { nodes, links };
}

/** Stable, content-free id for an edge (keys the enter/exit animation). */
export function linkId(e: Pick<SceneEdge, 'from' | 'to' | 'kind'>): string {
	return `${e.from}→${e.to}:${e.kind}`;
}

// ── 2. Animation intent (the live feed → what to play) ────────────────────────────────

/** The motion the component should play in response to a live change. */
export type AnimationKind = 'spawn' | 'pulse' | 'connect' | 'retire';

/** A resolved animation to play, addressed to a node id or an edge link id. */
export interface AnimationIntent {
	kind: AnimationKind;
	/** The node id (spawn/pulse/retire) or the link id (connect) this animation targets. */
	target: string;
	/** 'node' | 'edge' — which DOM family the component should resolve `target` against. */
	on: 'node' | 'edge';
}

/** The subset of a DbChange this mapping needs (matches events/db-source DbChange). */
export interface SceneChange {
	action: 'CREATE' | 'UPDATE' | 'DELETE';
	/** The changed record id string (e.g. 'session:abc' or an edge record id). */
	record: string;
	/** Row contents for CREATE/UPDATE; null/absent for DELETE. */
	result?: unknown;
}

/** Terminal session/work_item statuses → the node is exiting (mirrors the projector). */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'completed', 'stopped']);

/** Source tables whose nodes participate in the v1 scene (MEMORY + USAGE/JOBS). */
const NODE_TOPICS = new Set(['entity', 'memory', 'session', 'work_item']);

/**
 * Map ONE live DbChange (topic + change) → the animation to play, or null for "nothing to
 * animate" (DERIVED ONLY, F-008 — never invent motion for a change we did not classify).
 * PURE. Mirrors the MS-1 projector's emission map so the animation timeline matches the feed:
 *   entity|memory CREATE                → spawn   (a node pops in)
 *   session|work_item CREATE            → spawn   (a job node fires in)
 *   session|work_item UPDATE→non-terminal → pulse (the job is active — glow it)
 *   session|work_item UPDATE→terminal   → retire  (the job ended — fade it out)
 *   references CREATE                   → connect (a new edge draws in)
 * The component decides whether the target currently exists in the DOM; an intent for a node
 * that just appeared via the truth refresh is the SPAWN that introduces it.
 *
 * Shadow paths: nil change → null; DELETE → retire (the row is gone, fade before removal);
 * an unknown topic → null (no fabricated motion).
 */
export function animationIntent(topic: string, change: SceneChange | null | undefined): AnimationIntent | null {
	if (!change || typeof change.record !== 'string' || !change.record) return null;

	// A hard DELETE always retires the node (or no-ops for an edge topic — edges fade with
	// their endpoints). The row is gone; the component fades it before DOM removal.
	if (change.action === 'DELETE') {
		return NODE_TOPICS.has(topic) ? { kind: 'retire', target: change.record, on: 'node' } : null;
	}

	if (topic === 'references') {
		// A new RELATION edge draws in. The link id is derived from the row's in/out + kind so
		// it matches toForceModel's linkId; if the row body is absent we cannot address the
		// specific link, so we no-op (the truth refresh still draws it statically).
		if (change.action !== 'CREATE') return null;
		const row = asRow(change.result);
		const from = row && refStr(row.in);
		const to = row && refStr(row.out);
		const kind = row && typeof row.kind === 'string' ? row.kind : 'references';
		if (!from || !to) return null;
		return { kind: 'connect', target: linkId({ from, to, kind }), on: 'edge' };
	}

	if (!NODE_TOPICS.has(topic)) return null;

	if (change.action === 'CREATE') {
		return { kind: 'spawn', target: change.record, on: 'node' };
	}

	// UPDATE on a job node: terminal → retire, otherwise an activity pulse.
	if (topic === 'session' || topic === 'work_item') {
		const row = asRow(change.result);
		const status = row && typeof row.status === 'string' ? row.status : undefined;
		if (status && TERMINAL_STATUSES.has(status)) {
			return { kind: 'retire', target: change.record, on: 'node' };
		}
		return { kind: 'pulse', target: change.record, on: 'node' };
	}

	// UPDATE on a memory/entity node: a content change pulses it (it's alive), never re-spawns.
	return { kind: 'pulse', target: change.record, on: 'node' };
}

function asRow(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}
function refStr(v: unknown): string | undefined {
	if (v == null) return undefined;
	const s = String(v);
	return s.includes(':') ? s : undefined;
}

// ── 3. Reduced-motion-aware spring config (motion.dev transition) ─────────────────────

/** A motion.dev transition object (the second/third arg shape of `animate`). */
export type MotionTransition =
	| { type: 'spring'; stiffness: number; damping: number; mass?: number }
	| { duration: number; ease?: string };

/**
 * The motion.dev transition for an animation kind, honoring prefers-reduced-motion
 * (MEMORY-SCENE-SPEC §4 a11y; motion-framer perf §3). Normally a lively spring (the
 * "wobbly" preset for spawn pops, gentler for pulse/connect). When reduced: NO spring —
 * an instant/opacity-only tween (duration 0 for spawn/retire so it's effectively
 * instant; a tiny fade for pulse so a status change is still perceptible without motion).
 * PURE — the component just hands the result to `animate(el, keyframes, transition)`.
 */
export function springFor(kind: AnimationKind, reducedMotion: boolean): MotionTransition {
	if (reducedMotion) {
		// Opacity-only / instant — no transform spring, no bounce (a11y).
		return kind === 'pulse' ? { duration: 0.18, ease: 'linear' } : { duration: 0 };
	}
	switch (kind) {
		case 'spawn':
			// Wobbly pop (skill §7 preset: stiffness 200 / damping 10) — a lively entrance.
			return { type: 'spring', stiffness: 200, damping: 10 };
		case 'connect':
			// Gentle draw-in for an edge (skill §7 gentle: stiffness 100 / damping 20).
			return { type: 'spring', stiffness: 120, damping: 18 };
		case 'pulse':
			// Quick transform/opacity pulse — duration-based, no lingering bounce.
			return { duration: 0.42, ease: 'easeOut' };
		case 'retire':
			// Shrink+fade out before DOM removal (skill stiff-ish, quick settle).
			return { type: 'spring', stiffness: 260, damping: 26 };
	}
}

/** Keyframes for each animation kind (transform/opacity ONLY for 60fps; perf §1). */
export interface MotionKeyframes {
	scale?: number[];
	opacity?: number[];
}

/**
 * Transform/opacity-only keyframes for an animation kind, reduced-motion-aware. Reduced
 * motion drops every scale keyframe (no transform), leaving opacity-only (or nothing for a
 * pulse, which stays a CSS glow). PURE.
 */
export function keyframesFor(kind: AnimationKind, reducedMotion: boolean): MotionKeyframes {
	if (reducedMotion) {
		switch (kind) {
			case 'spawn':
				return { opacity: [0, 1] };
			case 'retire':
				return { opacity: [1, 0] };
			case 'connect':
				return { opacity: [0, 1] };
			case 'pulse':
				return { opacity: [1, 0.6, 1] };
		}
	}
	switch (kind) {
		case 'spawn':
			return { scale: [0, 1], opacity: [0, 1] };
		case 'retire':
			return { scale: [1, 0], opacity: [1, 0] };
		case 'connect':
			return { opacity: [0, 1] };
		case 'pulse':
			return { scale: [1, 1.35, 1], opacity: [1, 0.85, 1] };
	}
}

// ── 4. Node visual mapping (design-system TOKENS only) ────────────────────────────────

/** A node's visual family — a CSS class (token-driven) + a radius. NO hard-coded colors. */
export interface NodeVisual {
	/** data-class / data-status drive the token color in CSS — never an inline color here. */
	colorClass: SceneNodeClass;
	statusClass: string;
	/** Bubble radius in px — memory nodes a touch smaller than jobs (visual hierarchy). */
	radius: number;
}

/** Normalize a live status into one of the design-system status families (token classes). */
export function statusFamily(node: Pick<ForceNode, 'class' | 'status'>): string {
	const s = (node.status ?? '').toLowerCase();
	if (s === 'archived' || s === 'superseded') return 'dim';
	if (TERMINAL_STATUSES.has(s)) return s === 'failed' || s === 'cancelled' ? 'failed' : 'done';
	if (s === 'running' || s === 'processing' || s === 'active') return 'active';
	if (s === 'pending' || s === 'queued') return 'pending';
	// project 'paused' / agent 'idle' — a quiet, non-active state (no pulse, dimmed ring).
	if (s === 'idle' || s === 'paused') return 'idle';
	return 'active';
}

/**
 * Map a node → its visual (token color class + radius). PURE; no color literals. The class drives
 * the color FAMILY + icon (memory / job / project / agent); status drives the within-class state
 * (the pulse ring) via statusClass. Project/agent get a slightly larger radius (structural anchors).
 */
export function nodeVisual(node: ForceNode): NodeVisual {
	const radius =
		node.class === 'project'
			? 12
			: node.class === 'concept'
				? 11 // S3 concepts are structural semantic anchors (project-sized)
				: node.class === 'agent'
					? 10
					: node.class === 'job'
						? 9
						: node.class === 'skill'
							? 8
							: node.class === 'causal'
								? 8
								: node.class === 'correction'
									? 7
									: node.subclass === 'entity'
										? 8
										: 6;
	return { colorClass: node.class, statusClass: statusFamily(node), radius };
}

// ── 5. Activity-feed formatting (the §5 "what's happening now" panel) ─────────────────

/** A human-readable description of one scene_event for the activity feed. PURE. */
export interface SceneEventLine {
	/** A short, human verb phrase ("job fired", "memory added", "connection formed"). */
	verb: string;
	/** The node-class family the event belongs to (drives the feed dot color — TOKENS). */
	colorClass: SceneNodeClass;
	/** The short, content-free subject ('session: build', the ref tail) — never raw content. */
	subject: string;
	/** Optional trailing detail off the SCREENED meta (a status/kind), or undefined. */
	detail?: string;
}

/** The v1 scene_event kind → its human verb. Unknown kinds fall back to a safe generic. */
const KIND_VERB: Record<string, string> = {
	node_spawned: 'node spawned',
	job_fired: 'job fired',
	job_done: 'job done',
	connection_formed: 'connection formed',
	node_retired: 'node retired',
	memory_added: 'memory added',
	hire_staffed: 'hire staffed'
};

/** The kind → which node-class color family the feed dot uses (memory vs job). */
function kindColorClass(kind: string): SceneNodeClass {
	// job_* events are the USAGE/JOBS family; everything else (memory/node/connection) is memory.
	return kind === 'job_fired' || kind === 'job_done' ? 'job' : 'memory';
}

/** The short tail of a record-id ref ('session:abc' → 'abc'), or the whole ref if untagged. */
function refTail(ref: string): string {
	const i = ref.indexOf(':');
	return i >= 0 ? ref.slice(i + 1) : ref;
}

/**
 * Format ONE scene_event → a human-readable feed line (MEMORY-SCENE-SPEC §5). PURE + total:
 * never throws, never surfaces raw row content (meta was D-026-screened at write time; we read
 * only a couple of label fields). An unknown kind degrades to a generic verb (honest — we show
 * the real kind string, never fabricate). Shadow paths: nil → null (skipped by the caller);
 * absent meta → no detail. The subject prefers the screened label/kind meta, else the ref tail.
 */
export function describeSceneEvent(event: SceneEvent | null | undefined): SceneEventLine | null {
	if (!event || typeof event.kind !== 'string') return null;
	const verb = KIND_VERB[event.kind] ?? event.kind.replace(/_/g, ' ');
	const meta = event.meta && typeof event.meta === 'object' ? event.meta : undefined;
	// Subject: a screened label/kind/work_type meta field if present, else the ref tail. These
	// meta fields are the ones the projector surfaces (already screened) — never raw content.
	const labelMeta =
		metaStr(meta, 'label') ?? metaStr(meta, 'kind') ?? metaStr(meta, 'work_type');
	const subject = labelMeta ?? (typeof event.ref === 'string' ? refTail(event.ref) : '—');
	// Detail: a status off the screened meta (e.g. 'done', 'failed') — the only extra label.
	const detail = metaStr(meta, 'status');
	return {
		verb,
		colorClass: kindColorClass(event.kind),
		subject: subject || '—',
		...(detail ? { detail } : {})
	};
}

/** Read a string-valued meta field, or undefined (numbers/objects are not feed subjects). */
function metaStr(meta: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!meta) return undefined;
	const v = meta[key];
	return typeof v === 'string' && v.length ? v : undefined;
}
