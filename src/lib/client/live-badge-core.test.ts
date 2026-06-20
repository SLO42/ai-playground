import { describe, it, expect } from 'vitest';
import { liveBadgeView, type LivenessPhase, type LiveBadgeView } from './live-badge-core';

/**
 * The badge core is the F-008 honesty surface: every degraded liveness phase must
 * produce a VISIBLE, correctly-labelled badge, and only the clean 'live' phase may be
 * silent. These tests lock the status→label/variant map (the LOW exhaustive-render
 * follow-up) so a new phase can't quietly fall through to a blank/wrong badge.
 */

// The complete 5-value union, enumerated here so the suite fails if `tableLiveness`
// ever returns a phase we forgot to map (kept in sync with sse.svelte.ts).
const ALL_PHASES: LivenessPhase[] = [
	'live',
	'reconnecting',
	'disconnected',
	'offline',
	'unknown'
];

describe('liveBadgeView — exhaustive liveness → badge map', () => {
	it('maps every phase to a defined view (no fall-through)', () => {
		for (const phase of ALL_PHASES) {
			const view = liveBadgeView(phase);
			expect(view, `phase ${phase} must map to a view`).toBeDefined();
			expect(typeof view.label).toBe('string');
			expect(view.label.length).toBeGreaterThan(0);
		}
	});

	it('keeps the clean "live" phase silent (no badge clutter on a healthy region)', () => {
		const view = liveBadgeView('live');
		expect(view.show).toBe(false);
		expect(view.variant).toBe('live');
	});

	it('SHOWS a badge for every degraded/unknown phase (honest, F-008)', () => {
		for (const phase of ALL_PHASES.filter((p) => p !== 'live')) {
			expect(liveBadgeView(phase).show, `phase ${phase} must be visible`).toBe(true);
		}
	});

	it('labels reconnecting as a warn-variant "live: reconnecting"', () => {
		const view = liveBadgeView('reconnecting');
		expect(view).toEqual<LiveBadgeView>({
			show: true,
			label: 'live: reconnecting',
			variant: 'warn'
		});
	});

	it('labels disconnected as an error-variant "live: disconnected" (gave up)', () => {
		const view = liveBadgeView('disconnected');
		expect(view).toEqual<LiveBadgeView>({
			show: true,
			label: 'live: disconnected',
			variant: 'error'
		});
	});

	it('labels offline (socket stopped) as an error-variant "live: offline"', () => {
		const view = liveBadgeView('offline');
		expect(view).toEqual<LiveBadgeView>({
			show: true,
			label: 'live: offline',
			variant: 'error'
		});
	});

	it('labels unknown (pre-open) as a neutral-variant "live: unknown" — never claims live', () => {
		const view = liveBadgeView('unknown');
		expect(view).toEqual<LiveBadgeView>({
			show: true,
			label: 'live: unknown',
			variant: 'neutral'
		});
	});

	it('every visible label is prefixed "live:" so the signal is self-describing in a11y', () => {
		for (const phase of ALL_PHASES) {
			const view = liveBadgeView(phase);
			if (view.show) expect(view.label.startsWith('live:')).toBe(true);
		}
	});
});
