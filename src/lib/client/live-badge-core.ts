/**
 * LiveBadge presentation core — pure (no Svelte runes), so it is unit-testable in
 * the node vitest env (mirrors toast-core / confirm-core). Maps a region's effective
 * liveness phase (the value `SseConnection.tableLiveness()` returns) to the badge's
 * { show, label, variant } so a degraded server-side LIVE subscription is SEEN by the
 * operator instead of silently presenting frozen rows as current (F-008).
 *
 * The phase is the 5-value union ConnectionState | LiveStatusPhase:
 *   live · reconnecting · disconnected · offline · unknown
 * The map is EXHAUSTIVE — a `never` assertion in the default branch makes adding a new
 * phase a COMPILE error here rather than a silent fall-through to a blank/"live" badge.
 */

import type { ConnectionState, LiveStatusPhase } from './sse.svelte';

/** The full set of phases `tableLiveness()` can return (socket health ∪ per-table health). */
export type LivenessPhase = ConnectionState | LiveStatusPhase;

/** Visual variant — drives the badge's token-backed color via a `data-variant` attribute. */
export type LiveBadgeVariant = 'live' | 'warn' | 'error' | 'neutral';

export interface LiveBadgeView {
	/**
	 * Whether the badge should render at all. The healthy 'live' phase is the silent
	 * default — we only surface a badge when the region is NOT cleanly live, so a
	 * working dashboard isn't littered with "live" chrome. Set true for every
	 * degraded/unknown phase (the honest signal, F-008).
	 */
	show: boolean;
	/** Human, screen-reader-spoken label (the badge has role=status; a11y). */
	label: string;
	/** Token-backed color variant. */
	variant: LiveBadgeVariant;
}

/**
 * Map a liveness phase to its badge view. EXHAUSTIVE over the 5-value union: the
 * default branch is a `never` guard, so a new phase added to the union fails the
 * build here (the LOW follow-up) — it can never silently fall through to a blank badge.
 */
export function liveBadgeView(phase: LivenessPhase): LiveBadgeView {
	switch (phase) {
		case 'live':
			// Cleanly live — no badge (silent healthy default).
			return { show: false, label: 'live', variant: 'live' };
		case 'reconnecting':
			// Server-side LIVE subscription (or the SSE socket) is re-establishing — NOT live now.
			return { show: true, label: 'live: reconnecting', variant: 'warn' };
		case 'disconnected':
			// The table's subscription gave up (bounded, F-042) — rows are frozen, say so.
			return { show: true, label: 'live: disconnected', variant: 'error' };
		case 'offline':
			// The SSE socket itself was stopped — the whole region is no longer live.
			return { show: true, label: 'live: offline', variant: 'error' };
		case 'unknown':
			// Pre-open: we haven't proven liveness yet, so we don't claim it (honest, F-008).
			return { show: true, label: 'live: unknown', variant: 'neutral' };
		default: {
			// Exhaustiveness guard — adding a phase to the union without a case is a COMPILE error.
			const _never: never = phase;
			return { show: true, label: `live: ${String(_never)}`, variant: 'neutral' };
		}
	}
}
