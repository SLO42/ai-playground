// LG-3 motion-state — PURE, side-effect-free decision logic for the lifecycle graph's
// "alive" animation layer (LIFECYCLE-GRAPH-UX-SPEC, n8n-run feel). It owns NO truth and
// touches NO DOM / motion lib / Svelte — it just maps a node's HONEST status + the
// environment (reduced-motion, total node count) onto the visual motion-state the
// component renders. Keeping it pure means the running-vs-terminal honesty, the
// reduced-motion branch, and the bounded-motion cap are all unit-testable in the `node`
// test env (mirrors scene-graph.ts springFor/keyframesFor/statusFamily).
//
// INTEGRITY (the rails this module enforces, so the component can't drift):
//   • running-vs-terminal HONEST — a `running` SESSION (and only that) gets the cycling
//     glow; a done/failed/terminal node settles to a DISTINCT STATIC state and can never
//     read as 'active' (a failed node never animates). Truth in → motion out; no guessing.
//   • reduced-motion FULLY STATIC — prefers-reduced-motion ⇒ `animate:false` for every
//     state (running included): the running node keeps a static glow ring, never a moving
//     one. Asserted in the suite.
//   • BOUNDED (F-014) — past MAX_ANIMATED_NODES the per-node perimeter animation is
//     disabled wholesale (`animate:false`) so a huge graph never animates hundreds of
//     rings; the running node still shows its STATIC glow so it stays visually honest.
//
// The component reads `motionFor(node, env)` once per node and binds the returned class +
// `animate` flag; CSS owns the actual keyframes (token-driven), this owns the DECISION.

import type { LifecycleNode } from '$lib/server/observability';

/**
 * Past this many nodes, the perimeter glow ANIMATION is disabled wholesale (F-014 bounded —
 * never animate hundreds of rings). Running nodes still render their STATIC glow so the live
 * state stays honest; only the motion is dropped. Chosen to comfortably cover a real
 * lifecycle chain (Continue → a handful of parallel sessions → PM → tasks) while capping the
 * concurrent CSS animations a browser must drive. Exported so the test pins the threshold.
 */
export const MAX_ANIMATED_NODES = 60;

/** The visual motion-states a node can occupy. Mutually exclusive; drives the CSS class. */
export type NodeMotionState =
	| 'running' // a live session — cycling glow ring (when animation is allowed)
	| 'settled-done' // a terminal success — calm, distinct, STATIC
	| 'settled-failed' // a terminal failure — error family, distinct, STATIC (never 'active')
	| 'static'; // everything else (markers, pending, pm/task/continue) — no special motion

/** The resolved motion for a node: its state class + whether motion may actually play. */
export interface NodeMotion {
	/** The mutually-exclusive motion-state (binds `data-motion` on the node). */
	state: NodeMotionState;
	/** True ONLY for a running node when motion is allowed (not reduced, under the cap). */
	glow: boolean;
	/**
	 * True when the running glow should ANIMATE (cycle around the perimeter). False under
	 * reduced-motion or past the node cap — the glow is then a STATIC ring (still honest).
	 */
	animate: boolean;
}

/** The environment inputs the motion decision depends on (all honest, all from the host). */
export interface MotionEnv {
	/** prefers-reduced-motion — when true, NOTHING animates (static glow/state only). */
	reducedMotion: boolean;
	/** Total node count in the laid-out graph (for the F-014 bounded-motion cap). */
	nodeCount: number;
	/** Override the animation cap (tests / future tuning); defaults to MAX_ANIMATED_NODES. */
	maxAnimatedNodes?: number;
}

/** Terminal SUCCESS statuses (a calm settled state). Mirrors the projector's vocabulary. */
const DONE_STATUSES = new Set(['done', 'completed', 'complete']);
/** Terminal FAILURE/abort statuses (a distinct error settled state — never 'active'). */
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'stopped', 'aborted']);
/** The live "this session is working right now" status — the ONLY thing that glows. */
const RUNNING_STATUSES = new Set(['running', 'active', 'processing']);

/**
 * Classify a node into its motion-state from its HONEST kind + status. ONLY a `session`
 * node can be running/terminal-coloured here — a continue/pm/task marker is never 'running'
 * (it has no live agent), so it resolves to a neutral `static` even if its marker status
 * string happened to look terminal. This keeps the glow exclusively on real live work.
 *
 * Shadow paths (all four, all named):
 *   • happy   — a running session → 'running'; a done/failed session → 'settled-*'.
 *   • nil     — a null/undefined node → 'static' (no throw, no fabricated motion).
 *   • empty   — a node with an empty/whitespace status → 'static' (unknown ≠ active).
 *   • upstream — an unrecognized status string → 'static' (never guessed into 'running').
 */
export function motionStateOf(node: Pick<LifecycleNode, 'kind' | 'status'> | null | undefined): NodeMotionState {
	if (!node || node.kind !== 'session') return 'static';
	const s = (node.status ?? '').trim().toLowerCase();
	if (s === '') return 'static';
	if (RUNNING_STATUSES.has(s)) return 'running';
	if (DONE_STATUSES.has(s)) return 'settled-done';
	if (FAILED_STATUSES.has(s)) return 'settled-failed';
	return 'static';
}

/**
 * Resolve the full motion for a node given the environment. PURE + total.
 *
 *   running  + can-animate  → { glow:true,  animate:true  }  (cycling ring)
 *   running  + reduced       → { glow:true,  animate:false }  (STATIC glow — honest, a11y)
 *   running  + over-cap      → { glow:true,  animate:false }  (STATIC glow — bounded, F-014)
 *   done/failed/static       → { glow:false, animate:false }  (distinct static, never glows)
 *
 * A node is NEVER both 'settled-failed' and animated — the honesty invariant the suite pins.
 */
export function motionFor(
	node: Pick<LifecycleNode, 'kind' | 'status'> | null | undefined,
	env: MotionEnv
): NodeMotion {
	const state = motionStateOf(node);
	if (state !== 'running') {
		return { state, glow: false, animate: false };
	}
	const cap = env.maxAnimatedNodes ?? MAX_ANIMATED_NODES;
	const motionAllowed = !env.reducedMotion && env.nodeCount <= cap;
	// A running node ALWAYS shows its glow (honest live state); only the MOTION is gated.
	return { state, glow: true, animate: motionAllowed };
}
