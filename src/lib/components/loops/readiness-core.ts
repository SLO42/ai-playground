// LOOPS READINESS — the pure Loop Design Checklist + its evaluator (LOOP-ENGINEERING.md:47-58).
//
// This is the SHARED, runes-free, server-free pure module (the loop-card-core.ts sibling): it is
// imported by BOTH the client (the readiness checklist UI) AND the server (the manifest CRUD + the
// arm gate). It therefore lives under components/loops/ — NOT $lib/server (which client code may not
// import) and NOT a `.svelte.ts` (NO runes here — F-009). Nothing here touches the DB or fabricates a
// value (F-008): readiness is computed purely from the persisted checklist state the operator ticked.
//
// The 9 items are the Loop Design Checklist (LOOP-ENGINEERING.md "Atelier's pre-arm gate"). A loop may
// NOT be promoted to autonomy (L3) until every item is checked — OR the operator records an explicit
// override (the operator is sovereign). The ids are STABLE storage keys (persisted in loop.checklist);
// never rename one without a migration.

/** One Design-Checklist item — a stable id (the storage key) + its operator-facing copy. */
export interface ChecklistItem {
	/** Stable storage key — persisted in the manifest `checklist` object. NEVER rename without a migration. */
	id: string;
	/** Short operator-facing label (the checkbox face). */
	label: string;
	/** One-line guidance on what "done" means for this item. */
	hint: string;
}

/**
 * The Loop Design Checklist — Atelier's pre-arm gate (LOOP-ENGINEERING.md:50-58). All 9 must be
 * checked before a loop arms for autonomy, unless the operator overrides. Order is the doc's order.
 */
export const READINESS_CHECKLIST: readonly ChecklistItem[] = [
	{
		id: 'single_goal',
		label: 'Single goal + non-goals',
		hint: 'One explicit goal, explicit non-goals, and the scope the loop watches.'
	},
	{
		id: 'cadence',
		label: 'Cadence + durability',
		hint: 'Cadence chosen, durable across restart, with defined off-hours behavior.'
	},
	{
		id: 'maker_checker',
		label: 'Maker ≠ checker',
		hint: 'The implementer cannot mark its own work done (a separate reviewer grades it).'
	},
	{
		id: 'attempt_cap',
		label: 'Attempt cap → escalate',
		hint: 'A bounded fix loop that escalates with full context — never retries forever.'
	},
	{
		id: 'state',
		label: 'State read + pruned',
		hint: 'State is read at the start of every run; resolved items pruned; outcomes written.'
	},
	{
		id: 'handoff',
		label: 'Handoff triggers',
		hint: 'Explicit handoff triggers (max attempts, risk paths, ambiguity).'
	},
	{
		id: 'denylist',
		label: 'Denylist paths enforced',
		hint: 'Publish / hire / secrets / root paths always escalate (D-037 · D-039 · D-018).'
	},
	{
		id: 'kill_switch',
		label: 'Kill switch + budget',
		hint: 'A working pause/disarm plus a token budget (re-tick cap + the daily spend cap).'
	},
	{
		id: 'run_log',
		label: 'Run log',
		hint: 'A history of what the loop did, when, and why.'
	}
] as const;

/** The persisted checklist state: item id → checked. Absent keys are treated as unchecked (F-008). */
export type ChecklistState = Record<string, boolean>;

/** The result of evaluating a loop's readiness against the Design Checklist. */
export interface ReadinessResult {
	/** True iff EVERY checklist item is checked (the loop has earned autonomy on this axis). */
	green: boolean;
	/** How many items are checked. */
	checked: number;
	/** Total items (== READINESS_CHECKLIST.length). */
	total: number;
	/** The still-unchecked items (the honest "what's missing" list surfaced when an arm is blocked). */
	missing: ChecklistItem[];
}

/**
 * Evaluate a loop's readiness from its persisted checklist state. SHADOW PATHS: null/undefined state ⇒
 * every item missing (an undeclared loop has earned nothing — green:false). A non-boolean / absent value
 * for an item counts as UNCHECKED (F-008 — only an explicit `true` counts as done; never assume readiness).
 */
export function evaluateReadiness(state: ChecklistState | null | undefined): ReadinessResult {
	const s = state ?? {};
	const missing = READINESS_CHECKLIST.filter((item) => s[item.id] !== true);
	const checked = READINESS_CHECKLIST.length - missing.length;
	return {
		green: missing.length === 0,
		checked,
		total: READINESS_CHECKLIST.length,
		missing
	};
}

/** The phase a loop may be promoted to (the maturity ladder). 'L3' is the autonomy rung the gate guards. */
export type DeclaredPhase = 'L1' | 'L2' | 'L3';

/** True for a phase that requires the readiness gate to be green (or overridden) — only L3 (autonomy). */
export function phaseRequiresReadiness(phase: DeclaredPhase): boolean {
	return phase === 'L3';
}
