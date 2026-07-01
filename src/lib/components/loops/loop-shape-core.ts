// LOOP SHAPE — the pure derivation for the loop-shape VISUAL on the per-loop detail page
// (/loops/[identifier]; operator directive 2026-06-29 "Loops = first-class · visuals"). It turns a
// loop's honest identity (its derived phase + a few live facts) and its persisted Design-Checklist
// state into an ordered strip of the SIX loop primitives (goal → trigger → action → check → state →
// handoff) plus the L1→L2→L3 maturity ladder position.
//
// HONEST BY CONSTRUCTION (F-008): a primitive is "satisfied" iff its governing readiness checklist item
// is EXPLICITLY checked (`=== true`) — an undeclared / unchecked loop shows the primitive as not-yet
// satisfied, NEVER fabricated as done. The per-primitive `detail` is a LIVE runtime fact (cadence, tick
// window, state label) or null — never invented. This is a plain .ts module — NO runes (F-009); types
// are imported type-only from the server read model (erased at build; the loop-card-core sibling pattern).

import type { LoopPhase } from '$lib/server/loops/read';
import type { ChecklistState } from './readiness-core';

/** The six loop primitives the shape strip renders, in loop order (handoff loops back to goal). */
export type PrimitiveKey = 'goal' | 'trigger' | 'action' | 'check' | 'state' | 'handoff';

/** The honest inputs the shape derives from — sourced from a running LoopView OR a declared manifest row. */
export interface ShapeSource {
	/** The loop's derived maturity phase (L1/L2/L3), or 'unknown' when the ladder does not apply. */
	phase: LoopPhase;
	/** Human cadence label (e.g. 'event-driven', 'cron …'), or null when unknown. */
	cadenceLabel: string | null;
	/** Short honest state label (e.g. 'driving', 'not currently running'), or null. */
	stateLabel: string | null;
	/** Re-ticks used this window (autonomous loops), or null when the loop has no tick window. */
	ticksUsed: number | null;
	/** The hard per-window re-tick cap, or null. */
	ticksMax: number | null;
}

/** One primitive node in the shape strip. */
export interface ShapePrimitive {
	key: PrimitiveKey;
	/** Node face label. */
	label: string;
	/** One-line meaning of this primitive. */
	blurb: string;
	/** The governing readiness checklist item id — the axis its satisfaction is read from. */
	checklistId: string;
	/** True iff the governing checklist item is EXPLICITLY checked (declared satisfied) — never assumed. */
	satisfied: boolean;
	/** A live runtime fact for this primitive (cadence / tick window / state), or null (honest). */
	detail: string | null;
}

/**
 * The six primitives + the checklist axis each maps to (LOOP-ENGINEERING.md). The mapping is 1:1 with the
 * six shape stages; the three cross-cutting guardrails (denylist / kill_switch / run_log) are surfaced by
 * the readiness panel, not the strip. Order is loop order.
 */
const PRIMITIVES: readonly { key: PrimitiveKey; label: string; blurb: string; checklistId: string }[] = [
	{ key: 'goal', label: 'Goal', blurb: 'One explicit goal + non-goals', checklistId: 'single_goal' },
	{ key: 'trigger', label: 'Trigger', blurb: 'Cadence, durable across restart', checklistId: 'cadence' },
	{ key: 'action', label: 'Action', blurb: 'Bounded attempt loop that escalates', checklistId: 'attempt_cap' },
	{ key: 'check', label: 'Check', blurb: 'Maker ≠ checker (a separate reviewer)', checklistId: 'maker_checker' },
	{ key: 'state', label: 'State', blurb: 'State read + pruned; outcomes written', checklistId: 'state' },
	{ key: 'handoff', label: 'Handoff', blurb: 'Explicit handoff / escalation triggers', checklistId: 'handoff' }
] as const;

/** A live runtime descriptor for a primitive, or null (never fabricated — F-008). */
function primitiveDetail(key: PrimitiveKey, source: ShapeSource): string | null {
	switch (key) {
		case 'trigger':
			return source.cadenceLabel && source.cadenceLabel.trim() ? source.cadenceLabel : null;
		case 'action':
			return source.ticksMax != null ? `${source.ticksUsed ?? 0}/${source.ticksMax} this window` : null;
		case 'state':
			return source.stateLabel && source.stateLabel.trim() ? source.stateLabel : null;
		default:
			return null;
	}
}

/**
 * Build the ordered primitive strip for a loop. SHADOW PATHS: a null/absent checklist ⇒ every primitive
 * unsatisfied (an undeclared loop has declared nothing — honest, not assumed-done); a non-boolean / absent
 * item value counts as UNCHECKED (only an explicit `true` satisfies).
 */
export function loopPrimitives(source: ShapeSource, checklist: ChecklistState | null | undefined): ShapePrimitive[] {
	const s = checklist ?? {};
	return PRIMITIVES.map((p) => ({
		key: p.key,
		label: p.label,
		blurb: p.blurb,
		checklistId: p.checklistId,
		satisfied: s[p.checklistId] === true,
		detail: primitiveDetail(p.key, source)
	}));
}

/** How many of the six primitives are satisfied (declared). */
export function shapeSatisfied(primitives: readonly ShapePrimitive[]): number {
	return primitives.reduce((n, p) => n + (p.satisfied ? 1 : 0), 0);
}

/** One rung of the L1→L2→L3 maturity ladder. */
export interface LadderRung {
	key: 'L1' | 'L2' | 'L3';
	label: string;
	title: string;
	/** True iff this rung IS the loop's current phase. */
	active: boolean;
	/** True iff the loop has reached at least this rung (current phase ≥ this rung). */
	reached: boolean;
}

/** The maturity-ladder view for the shape visual. */
export interface LadderView {
	/** False when the ladder does not apply to this loop (phase 'unknown' — orchestrator / memory-review). */
	applicable: boolean;
	/** The loop's current phase ('L1'|'L2'|'L3'|'unknown'). */
	current: LoopPhase;
	rungs: LadderRung[];
}

const RUNG_META: Record<'L1' | 'L2' | 'L3', { label: string; title: string; rank: number }> = {
	L1: { label: 'L1', title: 'L1 · report-only (proposes; the operator decides)', rank: 1 },
	L2: { label: 'L2', title: 'L2 · assisted (may act on a human-gated allowlist)', rank: 2 },
	L3: { label: 'L3', title: 'L3 · autonomous (auto-acts on an allowlist, capped)', rank: 3 }
};

/**
 * The L1→L2→L3 ladder position for a loop, derived purely from its phase. SHADOW PATH: phase 'unknown'
 * ⇒ applicable:false and every rung unreached (the ladder does not apply — honest, never a fabricated
 * rung), so the visual renders the ladder as not-applicable rather than implying an L1 default.
 */
export function loopLadder(phase: LoopPhase): LadderView {
	const applicable = phase === 'L1' || phase === 'L2' || phase === 'L3';
	const currentRank = applicable ? RUNG_META[phase].rank : 0;
	const rungs: LadderRung[] = (['L1', 'L2', 'L3'] as const).map((key) => ({
		key,
		label: RUNG_META[key].label,
		title: RUNG_META[key].title,
		active: applicable && phase === key,
		reached: applicable && RUNG_META[key].rank <= currentRank
	}));
	return { applicable, current: phase, rungs };
}
