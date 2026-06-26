import { describe, it, expect } from 'vitest';
import {
	motionStateOf,
	motionFor,
	MAX_ANIMATED_NODES,
	type MotionEnv
} from './motion-state';
import type { LifecycleNode } from '$lib/server/observability';

// LG-3 motion-state VERIFY — the PURE "alive" animation decision (n8n-run feel).
// Pins the three integrity rails the component depends on:
//   • running-vs-terminal HONEST (a failed node never animates / reads active),
//   • reduced-motion FULLY STATIC (running glow stops moving),
//   • BOUNDED (F-014: past the cap the perimeter motion is dropped).

function node(kind: LifecycleNode['kind'], status: string): Pick<LifecycleNode, 'kind' | 'status'> {
	return { kind, status };
}
const env = (over: Partial<MotionEnv> = {}): MotionEnv => ({
	reducedMotion: false,
	nodeCount: 5,
	...over
});

describe('motionStateOf', () => {
	it('a running session → running', () => {
		expect(motionStateOf(node('session', 'running'))).toBe('running');
		expect(motionStateOf(node('session', 'active'))).toBe('running');
		expect(motionStateOf(node('session', 'PROCESSING'))).toBe('running'); // case-insensitive
	});

	it('a terminal-success session → settled-done (distinct, static family)', () => {
		expect(motionStateOf(node('session', 'done'))).toBe('settled-done');
		expect(motionStateOf(node('session', 'completed'))).toBe('settled-done');
	});

	it('a terminal-failure session → settled-failed (distinct error state)', () => {
		expect(motionStateOf(node('session', 'failed'))).toBe('settled-failed');
		expect(motionStateOf(node('session', 'error'))).toBe('settled-failed');
		expect(motionStateOf(node('session', 'cancelled'))).toBe('settled-failed');
		expect(motionStateOf(node('session', 'stopped'))).toBe('settled-failed');
	});

	it('non-session kinds never glow — continue/pm/task are static even if status looks live', () => {
		expect(motionStateOf(node('continue', 'running'))).toBe('static');
		expect(motionStateOf(node('pm', 'tick'))).toBe('static');
		expect(motionStateOf(node('task', 'running'))).toBe('static');
	});

	// ── Shadow paths (all four, all named) ──────────────────────────────────────────────
	it('nil node → static (no throw, no fabricated motion)', () => {
		expect(() => motionStateOf(null)).not.toThrow();
		expect(motionStateOf(null)).toBe('static');
		expect(motionStateOf(undefined)).toBe('static');
	});
	it('empty/whitespace status → static (unknown is not active)', () => {
		expect(motionStateOf(node('session', ''))).toBe('static');
		expect(motionStateOf(node('session', '   '))).toBe('static');
	});
	it('an unrecognized status → static (never guessed into running)', () => {
		expect(motionStateOf(node('session', 'queued'))).toBe('static');
		expect(motionStateOf(node('session', 'frobnicating'))).toBe('static');
	});
});

describe('motionFor', () => {
	it('running + normal env → glow ON and animating (the cycling ring)', () => {
		const m = motionFor(node('session', 'running'), env());
		expect(m).toEqual({ state: 'running', glow: true, animate: true });
	});

	it('reduced-motion → running glow is STATIC (glow on, animate OFF) — fully static a11y', () => {
		const m = motionFor(node('session', 'running'), env({ reducedMotion: true }));
		expect(m.state).toBe('running');
		expect(m.glow).toBe(true); // still honest: the node IS running
		expect(m.animate).toBe(false); // but NOTHING moves
	});

	it('BOUNDED (F-014): past the node cap, the perimeter motion is dropped (static glow)', () => {
		const m = motionFor(node('session', 'running'), env({ nodeCount: MAX_ANIMATED_NODES + 1 }));
		expect(m.glow).toBe(true);
		expect(m.animate).toBe(false);
	});
	it('at exactly the cap, motion is still allowed (boundary inclusive)', () => {
		const m = motionFor(node('session', 'running'), env({ nodeCount: MAX_ANIMATED_NODES }));
		expect(m.animate).toBe(true);
	});
	it('a custom cap override is honored', () => {
		const m = motionFor(node('session', 'running'), env({ nodeCount: 3, maxAnimatedNodes: 2 }));
		expect(m.animate).toBe(false);
	});

	it('HONESTY: a failed node never animates and never reads as active', () => {
		const m = motionFor(node('session', 'failed'), env());
		expect(m.state).toBe('settled-failed');
		expect(m.glow).toBe(false);
		expect(m.animate).toBe(false);
	});
	it('a done node settles static (no glow, no motion) and is distinct from failed', () => {
		const done = motionFor(node('session', 'done'), env());
		const failed = motionFor(node('session', 'failed'), env());
		expect(done.glow).toBe(false);
		expect(done.animate).toBe(false);
		expect(done.state).not.toBe(failed.state); // visually distinct settled states
	});

	it('nil node → static, no glow, no animation (shadow path)', () => {
		expect(motionFor(null, env())).toEqual({ state: 'static', glow: false, animate: false });
	});
});
