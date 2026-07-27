// COST-GOVERNANCE-SPEC CG-2 — the GLOBAL rolling-24h TOKEN budget.
//
// dailySpawnCap (D-021) meters only the background CLAIM count and only the drain; it does NOT
// see interactive launches, ceremony/gauntlet runs, concierge Stage-2 turns, or benchmark runs,
// and its unit is a spawn count, not spend (200 trivial local spawns ≠ 200 deep opus spawns).
// This module adds a GLOBAL token ceiling enforced INSIDE the spend chokepoints (launchSession,
// the gauntlet runner, the concierge provider call) — never at the call sites (F-055 lesson: a
// cap enforced at callers is bypassed by the next new caller; enforced inside the primitive it is
// inherited by construction).
//
// Invariants (COST-GOVERNANCE-SPEC §1):
//   • MEASURE AT THE CHOKEPOINT: the counter reads agent_event completion rows (the one place
//     tokens converge), so every spend source is counted with no per-caller bookkeeping.
//   • UNIFORM CAP SEMANTICS: 0 / absent = UNCAPPED sentinel (mirrors normalizeCap, boot.ts); a
//     positive value arms the ceiling; the anchor is the DURABLE agent_event timestamp, so the
//     count survives a restart; at-cap PARKS work (background) or WARNS (operator), never a
//     silent drop; the gate check is cheap and precedes the spend.
//   • CONSENT AND CAP ARE SEPARATE (CLAUDE.md §6): the operator override is authority to proceed
//     PAST the cap, not a removal of it — and it is explicit (a flag threaded from the manual UI
//     path), never inferred.
//   • OBSERVABLE (§1 invariant 6): every refusal AND every override emits a named analytics event
//     carrying {spent, budget, source} so the how/why is queryable — never a silent stall.

import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { loadOrchestration } from '../config/load';
import { writeAgentEvent } from './events';

/** The rolling window the token budget meters over (24h) — the D-021 window, in spend terms. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The named refusal a spend chokepoint throws when a launch would cross the token budget and no
 * operator override is present. Carries the numbers so the caller (the orchestrator drain, the UI)
 * can PARK-not-crash and surface the honest reason. `instanceof` is the orchestrator's distinguisher
 * (park vs the generic spawn-failure that BURNS the task), so this MUST be a distinct error class.
 */
export class TokenBudgetExceededError extends Error {
	readonly name = 'TokenBudgetExceededError';
	/** Tokens already spent in the trailing window (the measured figure, never fabricated). */
	readonly spent: number;
	/** The armed budget the spend would have crossed. */
	readonly budget: number;
	/** Which spend source hit the ceiling (background / operator / gauntlet-auto / concierge …). */
	readonly source: string;
	/** WHICH ceiling was breached — the GLOBAL rolling budget (CG-2) or a per-PROJECT budget (CG-3). */
	readonly scope: 'global' | 'project';
	/** The project id when {@link scope} is 'project' (CG-3); absent for a global breach. */
	readonly projectId?: string;
	constructor(spent: number, budget: number, source: string, scope: 'global' | 'project' = 'global', projectId?: string) {
		// Honest for BOTH refusal causes: measured spend already at/over budget, AND the
		// concurrency guard (spent + in-flight reservations would cross it) where measured spent
		// is fractionally under budget — so we phrase "against budget", never a false "≥".
		super(
			`${scope} token budget reached: ${spent} tokens spent in the trailing 24h against budget ${budget} (source: ${source}${
				scope === 'project' && projectId ? `, project: ${projectId}` : ''
			}) — spawn refused/parked`
		);
		this.spent = spent;
		this.budget = budget;
		this.source = source;
		this.scope = scope;
		if (scope === 'project' && projectId) this.projectId = projectId;
	}
}

/**
 * The honest, SCOPE-AWARE 402 envelope a server action returns when an interactive spend refuses at a
 * token ceiling (COST-GOVERNANCE-SPEC CG-2/CG-3). The bug this closes (deferred finding CG2-2): the
 * launch/pmChat catch blocks hardcoded "daily token budget" even when the breach was PER-PROJECT
 * (`err.scope === 'project'`) — mislabeling the operator's recourse (a per-project cap is freed by
 * confirming past THIS project's budget, not the global daily one). We read `err.scope`/`err.projectId`
 * and render the correct label + which budget is the actual constraint, so the message is honest (F-008).
 *
 * `actionNoun` is the plain-language subject of the refused spend ('launch' | 'PM turn') so one helper
 * serves every interactive chokepoint with identical, scope-correct copy. The returned `budgetExceeded`
 * flag + `spent`/`budget` drive the existing confirm-to-overspend control; `scope`/`projectId` are
 * carried through so the UI can stay honest end-to-end.
 */
export interface BudgetRefusalEnvelope {
	/** Plain-language, scope-correct refusal message (rendered verbatim in the form-error alert). */
	readonly error: string;
	/** Gates the operator's confirm-to-overspend control (re-submits with overrideBudget=true). */
	readonly budgetExceeded: true;
	/** Measured spend in the trailing 24h window against the breached ceiling (never fabricated). */
	readonly spent: number;
	/** The armed budget the spend would have crossed. */
	readonly budget: number;
	/** WHICH ceiling breached — so the UI never mislabels the operator's recourse. */
	readonly scope: 'global' | 'project';
	/** The project id when {@link scope} is 'project' (CG-3); absent for a global breach. */
	readonly projectId?: string;
}

/**
 * Build the {@link BudgetRefusalEnvelope} for a refused interactive spend. A per-project breach names
 * "this project's token budget" (spent BY this project); a global breach names "the daily token budget"
 * (spent ACROSS all projects). Both offer the honest recourse (confirm to spend past it). Pure — no db,
 * no side effect — so it unit-tests directly for both scopes.
 */
export function budgetRefusalEnvelope(
	err: TokenBudgetExceededError,
	actionNoun: string
): BudgetRefusalEnvelope {
	const error =
		err.scope === 'project'
			? `This ${actionNoun} would exceed this project's token budget — ${err.spent} of ${err.budget} tokens have been spent by this project in the last 24h. Confirm to spend past it.`
			: `This ${actionNoun} would exceed the daily token budget — ${err.spent} of ${err.budget} tokens have been spent across all projects in the last 24h. Confirm to spend past it.`;
	return {
		error,
		budgetExceeded: true,
		spent: err.spent,
		budget: err.budget,
		scope: err.scope,
		...(err.projectId ? { projectId: err.projectId } : {})
	};
}

/**
 * Coerce a configured budget to the enforcement contract: a positive finite integer arms the cap;
 * 0 / undefined / negative / non-finite ⇒ 0 (UNCAPPED). Mirrors boot.ts normalizeCap so the wired
 * value and the enforced value agree, and the 0-sentinel is honoured identically everywhere.
 */
export function normalizeTokenBudget(raw: number | undefined | null): number {
	return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

// --- budget-safety verdict (SD-1 — the armed-and-uncapped VISIBILITY state) --------------------
//
// The 0-sentinel means UNCAPPED (honest opt-in). That is SAFE while nothing drives spend on its
// own, but an ARMED autonomous loop (a pm.autonomous=true — pm-repo.listAutonomousPms) spends
// real money unattended. An armed-AND-uncapped combination is exactly the runaway hole SD-1 closes:
// it must be VISIBLE, never silent (F-008 — autonomy-down/uncapped is surfaced, not console-only).
// This is the PURE verdict (no db, no config read) so it unit-tests directly for every shadow path;
// the caller (the /services loader) supplies the two resolved caps + the live armed-loop count.

/** The armed-vs-uncapped safety verdict rendered by the /services budget-safety banner. */
export interface BudgetSafety {
	/** The armed GLOBAL daily token budget, normalized (0 = uncapped). */
	dailyTokenBudget: number;
	/** The armed PER-PROJECT token budget, normalized (0 = uncapped). */
	perProjectTokenBudget: number;
	/** Count of autonomous loops currently ARMED (pm.autonomous=true) — real, never fabricated. */
	armedLoops: number;
	/** True iff the global daily ceiling is the 0 (uncapped) sentinel. */
	dailyUncapped: boolean;
	/** True iff the per-project ceiling is the 0 (uncapped) sentinel. */
	perProjectUncapped: boolean;
	/**
	 * The LOUD state: at least one autonomous loop is armed AND at least one token ceiling is
	 * uncapped (0). This is the runaway-spend hole SD-1 makes visible. false when no loop is
	 * armed (an uncapped ceiling is harmless with nothing driving spend) or when both ceilings
	 * are armed.
	 *
	 * SEVERITY IS NOT UNIFORM, and the UI must not flatten it (F-008 honesty cuts both ways — a
	 * warning that OVERSTATES is as dishonest as one that hides). Read `dailyUncapped` /
	 * `perProjectUncapped` to tell the two cases apart:
	 *   • BOTH uncapped        — genuinely unbounded: nothing caps total spend.
	 *   • daily armed, per-project uncapped — total spend IS still bounded by the daily ceiling;
	 *     the narrower risk is that ONE project consumes the whole global allowance.
	 *   • per-project armed, daily uncapped — each project is bounded, but the number of projects
	 *     spending in parallel is not.
	 * Only the first case may be described as having "no backstop".
	 */
	uncappedWhileArmed: boolean;
}

/**
 * Compute the {@link BudgetSafety} verdict from the two resolved caps + the live armed-loop count.
 * PURE (no db / no config read) so it is trivially testable. Both caps pass through
 * {@link normalizeTokenBudget} so a stray negative/NaN/fractional value collapses to the 0
 * (uncapped) sentinel identically to the enforcement path (no divergence between what is enforced
 * and what is reported). A non-positive / non-integer `armedLoops` (a shadow/degraded read) is
 * floored to 0 — honest "no armed loop observed", never a fabricated alarm.
 */
export function assessBudgetSafety(input: {
	dailyTokenBudget: number;
	perProjectTokenBudget: number;
	armedLoops: number;
}): BudgetSafety {
	const dailyTokenBudget = normalizeTokenBudget(input.dailyTokenBudget);
	const perProjectTokenBudget = normalizeTokenBudget(input.perProjectTokenBudget);
	const armedLoops =
		Number.isInteger(input.armedLoops) && input.armedLoops > 0 ? input.armedLoops : 0;
	const dailyUncapped = dailyTokenBudget <= 0;
	const perProjectUncapped = perProjectTokenBudget <= 0;
	return {
		dailyTokenBudget,
		perProjectTokenBudget,
		armedLoops,
		dailyUncapped,
		perProjectUncapped,
		uncappedWhileArmed: armedLoops > 0 && (dailyUncapped || perProjectUncapped)
	};
}

// --- the config read (cached per boot, mirroring the pricing singleton in events.ts) ---------
//
// Read once per boot (F-029 convention: a config change needs a restart, surfaced honestly by
// /settings). A read/parse failure degrades to UNCAPPED (0) with a named once-per-boot warning —
// a budget is a soft governance control, not a security boundary, so an unreadable config must NOT
// fail-closed and wedge every spawn (fail-closed is security-only — D-024/F-053). The un-bypassable
// enforcement still lives at the chokepoint; this only decides the armed value.

let budgetCache: number | null = null;
let budgetOverride: number | null = null;
let perProjectBudgetCache: number | null = null;
let perProjectBudgetOverride: number | null = null;

/** The default orchestration file, resolved the same way every other config family is. */
function orchestrationPath(): string {
	const dir = process.env.CONFIG_DIR?.trim() || 'config';
	return join(dir, 'orchestration.yaml');
}

/**
 * The armed daily token budget (0 = uncapped). Prefers a test-injected override; else lazy-loads
 * config/orchestration.yaml once per boot. FAIL-OPEN (0 = uncapped) on any read/parse failure, with
 * a named warning ONCE per boot — never a fabricated cap and never a fail-closed wedge.
 */
export function resolveDailyTokenBudget(): number {
	if (budgetOverride !== null) return budgetOverride;
	if (budgetCache !== null) return budgetCache;
	try {
		const orch = loadOrchestration(orchestrationPath());
		budgetCache = normalizeTokenBudget(orch.spend?.dailyTokenBudget);
	} catch (err) {
		console.warn(
			`[spend-budget] orchestration config unavailable (${(err as Error).message}) — token budget treated as UNCAPPED until fixed. This warning fires once per boot.`
		);
		budgetCache = 0;
	}
	return budgetCache;
}

/**
 * The armed PER-PROJECT token budget (0 = uncapped) — COST-GOVERNANCE-SPEC CG-3. Same read/degrade
 * contract as {@link resolveDailyTokenBudget}: prefers a test-injected override; else lazy-loads
 * config/orchestration.yaml `spend.perProjectTokenBudget` once per boot; FAIL-OPEN (0 = uncapped) on
 * any read/parse failure, with a named warning ONCE per boot. A per-project ceiling is a soft
 * governance control, not a security boundary (D-024/F-053), so an unreadable config never fail-closes
 * and wedges every project spawn. The un-bypassable enforcement still lives at the launchSession
 * chokepoint; this only decides the armed value.
 */
export function resolvePerProjectTokenBudget(): number {
	if (perProjectBudgetOverride !== null) return perProjectBudgetOverride;
	if (perProjectBudgetCache !== null) return perProjectBudgetCache;
	try {
		const orch = loadOrchestration(orchestrationPath());
		perProjectBudgetCache = normalizeTokenBudget(orch.spend?.perProjectTokenBudget);
	} catch (err) {
		console.warn(
			`[spend-budget] orchestration config unavailable (${(err as Error).message}) — per-project token budget treated as UNCAPPED until fixed. This warning fires once per boot.`
		);
		perProjectBudgetCache = 0;
	}
	return perProjectBudgetCache;
}

/**
 * TEST SEAM: inject a deterministic armed budget (or `null` to clear back to the config-file path).
 * Not exported from the barrel — for the spend-budget / launch integration tests only.
 */
export function __setBudgetForTest(budget: number | null): void {
	budgetOverride = budget;
	budgetCache = null;
}

/**
 * TEST SEAM: inject a deterministic armed PER-PROJECT budget (or `null` to clear back to the config-
 * file path). Not exported from the barrel — for the spend-budget / launch integration tests only.
 */
export function __setPerProjectBudgetForTest(budget: number | null): void {
	perProjectBudgetOverride = budget;
	perProjectBudgetCache = null;
}

// --- the counter (durable, restart-proof) ----------------------------------------------------

/**
 * Σ(tokens_in + tokens_out) over agent_event COMPLETION rows in the trailing `windowMs`. The anchor
 * is the durable `at` timestamp (schema default time::now()), so a fresh process reading the same
 * rows computes the same figure — restart-proof (COST-GOVERNANCE-SPEC §1 invariant 3). One aggregate
 * (GROUP ALL); the agent_event_by_type index narrows to completions. `?? 0` coalesces a row with a
 * NONE token leg so a partial completion never nulls the whole sum. Window boundary: `at >= $since`
 * excludes spend older than the window (an old row can never re-count). Returns a non-negative number
 * (0 when the window is empty — honest, not a fabricated value).
 */
export async function tokensSpentSince(db: Db, windowMs: number = SPEND_WINDOW_MS): Promise<number> {
	const since = new Date(Date.now() - windowMs).toISOString();
	const [rows] = await db.query<[Array<{ ti: number | null; to: number | null }>]>(
		`SELECT math::sum(tokens_in ?? 0) AS ti, math::sum(tokens_out ?? 0) AS to
		   FROM agent_event
		  WHERE type = 'completion' AND at >= <datetime>$since
		  GROUP ALL;`,
		{ since }
	);
	const row = Array.isArray(rows) ? rows[0] : undefined;
	const ti = typeof row?.ti === 'number' ? row.ti : 0;
	const to = typeof row?.to === 'number' ? row.to : 0;
	return ti + to;
}

/**
 * COST-GOVERNANCE-SPEC CG-3 — Σ(tokens_in + tokens_out) over agent_event COMPLETION rows THAT belong
 * to `project`, in the trailing `windowMs`. The project link is on the row DIRECTLY (events.ts writes
 * `project` on every launched session's completion — launch.ts:1150), so this is ONE aggregate keyed on
 * that column; no session→project join is needed (the spec's join is already denormalized onto the
 * row). Same durable `at` anchor as {@link tokensSpentSince} (restart-proof), same `?? 0` coalescing of
 * a NONE token leg, same inclusive window boundary (`at >= $since`). The project id passes the D-016
 * chokepoint (assertRecordId) and binds as a record link (`$project`), never string-interpolated.
 * Returns a non-negative number (0 when the project has no in-window spend — honest, not fabricated).
 */
export async function tokensSpentSinceForProject(
	db: Db,
	project: string,
	windowMs: number = SPEND_WINDOW_MS
): Promise<number> {
	const since = new Date(Date.now() - windowMs).toISOString();
	const [rows] = await db.query<[Array<{ ti: number | null; to: number | null }>]>(
		`SELECT math::sum(tokens_in ?? 0) AS ti, math::sum(tokens_out ?? 0) AS to
		   FROM agent_event
		  WHERE type = 'completion' AND project = $project AND at >= <datetime>$since
		  GROUP ALL;`,
		{ project: new StringRecordId(assertRecordId(project)), since }
	);
	const row = Array.isArray(rows) ? rows[0] : undefined;
	const ti = typeof row?.ti === 'number' ? row.ti : 0;
	const to = typeof row?.to === 'number' ? row.to : 0;
	return ti + to;
}

// --- enforcement -----------------------------------------------------------------------------

/** Where a spend is coming from, for the honest {source} on the emitted event + the park decision. */
export type SpendSource =
	| 'background'
	| 'operator'
	| 'gauntlet-auto'
	| 'gauntlet-operator'
	| 'concierge'
	| string;

export interface EnforceTokenBudgetOpts {
	/** The armed budget (0 = uncapped). Resolve via resolveDailyTokenBudget() at the chokepoint. */
	budget: number;
	/** The spend source label (drives the event {source} + the honest error message). */
	source: SpendSource;
	/**
	 * The provider this spend runs on (e.g. 'ollama'/'local' vs 'claude'). LOCAL/$0 providers are
	 * EXEMPT from the TOKEN budget gate: the always-on local brain (the concierge Stage-2 turn on
	 * Ollama) is genuinely free, so gating it on a token ceiling contradicts the local-first design
	 * (COST-GOVERNANCE-SPEC §1 invariant 5 — the $0 local floor is the FIRST cost control, not a
	 * capped resource). This ONLY skips the GATE; it does not itself record spend — metering happens
	 * elsewhere: a launched local session at the events.ts completion write, and the non-session
	 * concierge Stage-2 turn at wire.ts meterConciergeTurn (CG-2-1), which writes the one completion
	 * row for every concierge turn, so a LOCAL turn is counted as a genuine $0 and a CLOUD turn at its
	 * real cost (the former un-metered-concierge observability gap is now closed). A CLOUD provider (or an absent provider — the
	 * safe, gated default) falls through and stays gated. See {@link isLocalProvider}.
	 */
	provider?: string;
	/**
	 * Operator authority to proceed PAST the cap (the manual UI path threads this). When true and the
	 * budget is crossed, the spend WARNS + emits an override event + proceeds instead of refusing.
	 * Background/autonomous callers never set it, so they always refuse (park) at the ceiling.
	 */
	override?: boolean;
	/** Rolling window (defaults to SPEND_WINDOW_MS). */
	windowMs?: number;
	/**
	 * Project the spend is attributed to. Drives TWO things: the emitted event's `project` link, AND
	 * (CG-3) the per-project token ceiling — when set, enforceTokenBudget ALSO checks this project's
	 * in-window spend against the armed `spend.perProjectTokenBudget`. Omitted ⇒ NONE + global-only
	 * (the gauntlet/concierge chokepoints are project-less, so they are never per-project gated).
	 */
	project?: string;
}

export interface EnforceResult {
	/** Whether a cap was armed + checked (false when uncapped / could not measure). */
	enforced: boolean;
	/** Measured spend in the window (0 when uncapped / unmeasured). */
	spent: number;
	/** The armed budget echoed back (0 when uncapped). */
	budget: number;
	/** True when over budget AND an override let it proceed. */
	overrode: boolean;
	/**
	 * Release the in-process CONCURRENCY reservation this call took (see the concurrency-overshoot
	 * guard below). A no-op unless the call PROCEEDED under an armed budget and reserved a slot.
	 * A cooperative caller SHOULD call it once its spend has been metered (the concierge turn does,
	 * in a finally) for tight accounting; a caller that ignores it does NOT leak — the reservation
	 * auto-releases after {@link RESERVATION_TTL_MS}. Idempotent (a double-call cannot under-count).
	 */
	release: () => void;
}

/**
 * LOCAL/$0 provider exemption (COST-GOVERNANCE-SPEC §1 invariant 5). The always-on local brain runs
 * on Ollama, which is genuinely free — gating a $0 turn on a real-money TOKEN budget contradicts the
 * local-first design, so a local provider is never refused by the budget. The exemption only skips the
 * GATE, not metering: a launched local session is metered at the events.ts completion write, and the
 * non-session concierge Stage-2 turn is metered at wire.ts meterConciergeTurn (CG-2-1) as an honest $0
 * completion row (the local model prices 0/0). An ABSENT/unknown provider is NOT
 * treated as local (the safe, gated default — a caller must positively declare 'local'/'ollama').
 */
export function isLocalProvider(provider: string | undefined): boolean {
	if (!provider) return false;
	const p = provider.trim().toLowerCase();
	return p === 'ollama' || p === 'local';
}

// --- concurrency-overshoot guard (deferred finding cost-governance-1a #1) --------------------
//
// The gate is check-then-spawn: N CONCURRENT launches can all read under-budget in the window
// between the counter read and their spend landing as completion rows, so all N proceed and
// overshoot the ceiling by up to N sessions' tokens. Single-process (ORCHESTRATOR-SPEC ORH-5), so
// the fix is in-process (NOT a distributed reservation): SERIALIZE the read+decide window with a
// FIFO async mutex (the withMergeLock pattern), AND account for launches that PASSED the gate but
// whose spend is not yet metered, via an in-process reservation counter. Each in-flight launch
// reserves RESERVATION_TOKENS — 1, the honest floor (every real launch spends ≥1 token; never a
// fabricated estimate). So at the threshold (measured spend one below budget) the FIRST concurrent
// launch proceeds + reserves and every OTHER concurrent launch sees spent+reserved ≥ budget and
// parks — "at most 1 proceeds". Far below the ceiling the +1/launch reservation is immaterial, so
// normal concurrency is preserved. A reservation auto-releases after RESERVATION_TTL_MS (a safety
// net bounding a long session's wall-clock, so a caller that never calls release() cannot leak it);
// a cooperative caller MAY release() early once its spend is metered.

/** The honest lower-bound spend a not-yet-metered in-flight launch reserves (every launch spends ≥1). */
const RESERVATION_TOKENS = 1;
/** Safety-net auto-release for a reservation whose caller never releases (bounds a long session). */
const RESERVATION_TTL_MS = 30 * 60 * 1000;
/** In-process count of launches that passed the gate but whose spend has not yet landed as a row. */
let reservedInFlight = 0;
/**
 * CG-3 — the SAME in-flight reservations, bucketed by project id, so the per-project gate accounts
 * only for concurrent launches on THAT project (a global reservation from another project must not
 * falsely park an under-budget project). One physical reservation counts against BOTH the global
 * counter above AND its project's bucket here (takeReservation increments both, release decrements
 * both). A project-less launch (gauntlet/concierge) touches only the global counter.
 */
const reservedInFlightByProject = new Map<string, number>();
/** FIFO serialization chain for the read+decide window (never rejects — outcomes are absorbed). */
let budgetGateChain: Promise<void> = Promise.resolve();

/** Current in-flight reservation count for a project (0 when none) — the per-project projected-spend term. */
function projectReserved(project: string): number {
	return reservedInFlightByProject.get(project) ?? 0;
}

/** Run `fn` serialized behind every prior gate call (FIFO). The chain never rejects, so one call's
 *  throw/refusal cannot wedge the next; the caller still sees `fn`'s own resolution/rejection. */
function withBudgetGate<T>(fn: () => Promise<T>): Promise<T> {
	const run = budgetGateChain.then(fn, fn);
	budgetGateChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

/**
 * Take one in-flight reservation; returns an idempotent release (also auto-releases after the TTL).
 * The physical reservation counts against the GLOBAL counter AND, when a `project` is given, that
 * project's bucket (CG-3) — release decrements both. A project bucket is deleted at 0 so the Map does
 * not accumulate empty entries.
 */
function takeReservation(project?: string): () => void {
	reservedInFlight++;
	if (project) reservedInFlightByProject.set(project, projectReserved(project) + 1);
	let released = false;
	const drop = () => {
		if (released) return; // idempotent — a double release cannot under-count
		released = true;
		reservedInFlight = Math.max(0, reservedInFlight - 1);
		if (project) {
			const next = projectReserved(project) - 1;
			if (next > 0) reservedInFlightByProject.set(project, next);
			else reservedInFlightByProject.delete(project);
		}
	};
	const timer = setTimeout(drop, RESERVATION_TTL_MS);
	// Never hold the process open for a reservation timer (F-014 — no dangling handle).
	if (typeof (timer as { unref?: () => void }).unref === 'function') {
		(timer as { unref: () => void }).unref();
	}
	return () => {
		if (released) return;
		clearTimeout(timer);
		drop();
	};
}

/** No-op release for calls that reserved nothing (uncapped / local-exempt / fail-open / override). */
const NOOP_RELEASE = (): void => {};

/**
 * TEST SEAM: clear the in-process concurrency reservation counter (+ reset the FIFO chain) so a
 * suite starts hermetic. Not exported from the barrel — for the spend-budget tests only.
 */
export function __resetReservationsForTest(): void {
	reservedInFlight = 0;
	reservedInFlightByProject.clear();
	budgetGateChain = Promise.resolve();
}

/**
 * The ONE enforcement primitive every spend chokepoint calls (COST-GOVERNANCE-SPEC CG-2 + CG-3). The
 * read+decide window is SERIALIZED (FIFO) and accounts for in-flight reservations so concurrent
 * launches cannot all slip under a ceiling (the concurrency-overshoot guard above). TWO ceilings are
 * checked, independently — either can refuse:
 *   • the GLOBAL rolling-24h budget (CG-2): `opts.budget`, resolved by the caller (resolveDailyToken-
 *     Budget). Bounds TOTAL spend across every project + source.
 *   • the PER-PROJECT budget (CG-3): resolved HERE (resolvePerProjectTokenBudget) and engaged ONLY when
 *     `opts.project` is set — the counter sums tokens over THAT project's completion rows. Bounds any
 *     single project's slice so one project cannot eat the whole global budget. A project-less launch
 *     (gauntlet/concierge) is global-only. Resolving inside keeps the gate un-bypassable by construction
 *     (F-055): every existing chokepoint that already threads `project` inherits CG-3 with no caller edit.
 * Shadow paths, all built + tested:
 *   • LOCAL/$0 provider (isLocalProvider)      → EXEMPT from BOTH ceilings: return immediately, NO gate.
 *     The $0 local floor is the first cost control, not a capped resource.
 *   • BOTH ceilings ≤ 0 (uncapped / 0-sentinel) → return immediately, NO query/lock (cheap; the shipped
 *     default is uncapped so an untuned deploy pays zero overhead).
 *   • counter query THROWS (DB fault)          → FAIL-OPEN: allow + a named warning. A budget is a
 *     soft governance control, not a security boundary (D-024/F-053), and a DB fault on a spend path
 *     must never crash the server (F-014/F-048).
 *   • projected spend < every armed ceiling    → PROCEED, take a reservation (returned as release()),
 *     NO event (only breaches are events).
 *   • at/over an armed ceiling + override       → WARN + emit an override event + proceed.
 *   • at/over an armed ceiling + no override     → emit a refused event + THROW TokenBudgetExceededError
 *     (the caller parks-not-crashes). The error/event `scope` names WHICH ceiling breached ('global' |
 *     'project'); a project breach carries `projectId`.
 *
 * The event is written as an agent_event `type:'cancel'` with `detail.by='budget'` — the shape
 * events.ts already documents for a budget-initiated governance decision (a REFUSED spawn is a
 * cancelled spawn; an OVERRIDE records that the gate fired and the operator re-authorised). The
 * `detail.decision` field ('refused' | 'override') + `detail.scope` ('global' | 'project')
 * disambiguate, so a reader queries `type='cancel' AND detail.by='budget'`. Event writes are
 * best-effort (F-014): an event-write fault is logged and never masks the budget decision itself.
 */
export async function enforceTokenBudget(db: Db, opts: EnforceTokenBudgetOpts): Promise<EnforceResult> {
	// LOCAL/$0 exemption: a genuinely-free provider is never gated on the real-money token budget
	// (the GATE is skipped only; this does not itself meter). Checked BEFORE the lock so a $0 turn
	// pays zero serialization cost.
	if (isLocalProvider(opts.provider)) {
		return { enforced: false, spent: 0, budget: 0, overrode: false, release: NOOP_RELEASE };
	}
	const globalBudget = normalizeTokenBudget(opts.budget);
	// CG-3: the per-project ceiling engages ONLY when the launch carries a project id (a project-less
	// launch — gauntlet/concierge — is global-only). Resolved from config (0 = uncapped), so an
	// unconfigured deploy leaves it at the 0-sentinel and pays no per-project cost.
	const projectBudget = opts.project ? normalizeTokenBudget(resolvePerProjectTokenBudget()) : 0;
	// BOTH uncapped: nothing to enforce. No query, no lock, no event — the cheap common case.
	if (globalBudget <= 0 && projectBudget <= 0) {
		return { enforced: false, spent: 0, budget: 0, overrode: false, release: NOOP_RELEASE };
	}

	// SERIALIZE the read+decide+reserve window (concurrency-overshoot guard). The critical section is
	// just the counter read(s) + the budget decision + taking a reservation — short + bounded; the
	// actual spawn/turn happens AFTER this resolves, outside the lock.
	return withBudgetGate(async () => {
		// Measure each ARMED dimension (skip a query for an unarmed one). A counter fault on either
		// fails OPEN (a soft governance control must never wedge a legitimate spawn — D-024/F-053).
		let globalSpent = 0;
		let projectSpent = 0;
		try {
			if (globalBudget > 0) globalSpent = await tokensSpentSince(db, opts.windowMs ?? SPEND_WINDOW_MS);
			if (projectBudget > 0 && opts.project) {
				projectSpent = await tokensSpentSinceForProject(db, opts.project, opts.windowMs ?? SPEND_WINDOW_MS);
			}
		} catch (err) {
			console.warn(
				`[spend-budget] token counter query failed (${(err as Error).message}) — allowing spend (fail-open, budget not enforced this call).`
			);
			return { enforced: false, spent: 0, budget: 0, overrode: false, release: NOOP_RELEASE };
		}

		// Account for launches that already passed the gate but whose spend has not yet landed as a
		// completion row (each reserves the RESERVATION_TOKENS honest floor). At the threshold this is
		// what makes "at most 1 of N concurrent launches proceeds" — per ceiling, using that ceiling's
		// reservation term (global counter for the global ceiling; the project bucket for the project one).
		const globalProjected = globalSpent + reservedInFlight * RESERVATION_TOKENS;
		const projectProjected =
			projectSpent + (opts.project ? projectReserved(opts.project) : 0) * RESERVATION_TOKENS;
		const globalOver = globalBudget > 0 && globalProjected >= globalBudget;
		const projectOver = projectBudget > 0 && projectProjected >= projectBudget;

		if (!globalOver && !projectOver) {
			// Under EVERY armed ceiling — take ONE reservation (counted against the global counter and,
			// when set, this project's bucket). Report the binding dimension honestly: the GLOBAL figures
			// when the global ceiling is armed (back-compat with CG-2 callers), else the per-project ones.
			const [spent, budget] = globalBudget > 0 ? [globalSpent, globalBudget] : [projectSpent, projectBudget];
			return { enforced: true, spent, budget, overrode: false, release: takeReservation(opts.project) };
		}

		// At/over ≥1 ceiling. Report the BREACHED scope — the per-project ceiling takes precedence when it
		// is the one breached (it is the tighter, project-scoped bound); if both breached, report project.
		const scope: 'global' | 'project' = projectOver ? 'project' : 'global';
		const spent = scope === 'project' ? projectSpent : globalSpent;
		const budget = scope === 'project' ? projectBudget : globalBudget;
		const projectId = scope === 'project' ? opts.project : undefined;

		// Emit the named governance event (best-effort). It carries the MEASURED breached-scope figures
		// (+ projectId for a per-project breach, per CG-3), never `projected`.
		const emit = (decision: 'refused' | 'override') =>
			writeAgentEvent(db, {
				type: 'cancel',
				...(opts.project ? { project: opts.project } : {}),
				detail: {
					by: 'budget',
					decision,
					scope,
					...(projectId ? { projectId } : {}),
					reason:
						decision === 'refused'
							? `${scope} token budget reached — spawn refused + parked (spent ${spent}, budget ${budget}, source: ${opts.source}${projectId ? `, project: ${projectId}` : ''})`
							: `${scope} token budget reached — operator override, proceeding (spent ${spent}, budget ${budget}, source: ${opts.source}${projectId ? `, project: ${projectId}` : ''})`,
					spent,
					budget,
					source: opts.source
				}
			}).catch((evErr) =>
				console.warn(
					`[spend-budget] budget ${decision} event write failed (best-effort): ${(evErr as Error).message}`
				)
			);

		if (opts.override) {
			console.warn(
				`[spend-budget] ${scope} token budget reached (spent ${spent}, budget ${budget}, source: ${opts.source}) — proceeding on operator override.`
			);
			await emit('override');
			// Override proceeds regardless; no reservation needed (a concurrent NON-override launch
			// already parks on the measured spend, which is ≥ budget on the override path).
			return { enforced: true, spent, budget, overrode: true, release: NOOP_RELEASE };
		}

		await emit('refused');
		throw new TokenBudgetExceededError(spent, budget, opts.source, scope, projectId);
	});
}
