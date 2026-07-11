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
import type { Db } from '../db/client';
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
	constructor(spent: number, budget: number, source: string) {
		// Honest for BOTH refusal causes: measured spend already at/over budget, AND the
		// concurrency guard (spent + in-flight reservations would cross it) where measured spent
		// is fractionally under budget — so we phrase "against budget", never a false "≥".
		super(
			`token budget reached: ${spent} tokens spent in the trailing 24h against budget ${budget} (source: ${source}) — spawn refused/parked`
		);
		this.spent = spent;
		this.budget = budget;
		this.source = source;
	}
}

/**
 * Coerce a configured budget to the enforcement contract: a positive finite integer arms the cap;
 * 0 / undefined / negative / non-finite ⇒ 0 (UNCAPPED). Mirrors boot.ts normalizeCap so the wired
 * value and the enforced value agree, and the 0-sentinel is honoured identically everywhere.
 */
export function normalizeTokenBudget(raw: number | undefined | null): number {
	return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
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
 * TEST SEAM: inject a deterministic armed budget (or `null` to clear back to the config-file path).
 * Not exported from the barrel — for the spend-budget / launch integration tests only.
 */
export function __setBudgetForTest(budget: number | null): void {
	budgetOverride = budget;
	budgetCache = null;
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
	 * capped resource). Tokens are STILL metered at the events.ts completion write for observability;
	 * this only skips the GATE. A CLOUD provider (or an absent provider — the safe, gated default)
	 * falls through and stays gated. See {@link isLocalProvider}.
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
	/** Project the spend is attributed to (for the emitted event) — omitted ⇒ NONE. */
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
 * local-first design, so a local provider is never refused by the budget. Tokens are still metered at
 * the events.ts write for observability; only the GATE is skipped. An ABSENT/unknown provider is NOT
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
/** FIFO serialization chain for the read+decide window (never rejects — outcomes are absorbed). */
let budgetGateChain: Promise<void> = Promise.resolve();

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

/** Take one in-flight reservation; returns an idempotent release (also auto-releases after the TTL). */
function takeReservation(): () => void {
	reservedInFlight++;
	let released = false;
	const drop = () => {
		if (released) return; // idempotent — a double release cannot under-count
		released = true;
		reservedInFlight = Math.max(0, reservedInFlight - 1);
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
	budgetGateChain = Promise.resolve();
}

/**
 * The ONE enforcement primitive every spend chokepoint calls (COST-GOVERNANCE-SPEC CG-2). The
 * read+decide window is SERIALIZED (FIFO) and accounts for in-flight reservations so concurrent
 * launches cannot all slip under the ceiling (the concurrency-overshoot guard above). Shadow
 * paths, all built + tested:
 *   • LOCAL/$0 provider (isLocalProvider)      → EXEMPT: return immediately, NO gate (still metered
 *     at events.ts). The $0 local floor is the first cost control, not a capped resource.
 *   • budget ≤ 0 (uncapped / 0-sentinel)      → return immediately, NO query/lock (cheap; the shipped
 *     default is uncapped so an untuned deploy pays zero overhead).
 *   • counter query THROWS (DB fault)          → FAIL-OPEN: allow + a named warning. A budget is a
 *     soft governance control, not a security boundary (D-024/F-053), and a DB fault on a spend path
 *     must never crash the server (F-014/F-048).
 *   • spent + in-flight reservations < budget  → PROCEED, take a reservation (returned as release()),
 *     NO event (only breaches are events).
 *   • at/over budget + override                → WARN + emit a `token-budget-override` event + proceed.
 *   • at/over budget (or reservation-crossed) + no override → emit a `token-budget-refused` event +
 *     THROW TokenBudgetExceededError (the caller parks-not-crashes).
 *
 * The event is written as an agent_event `type:'cancel'` with `detail.by='budget'` — the shape
 * events.ts already documents for a budget-initiated governance decision (a REFUSED spawn is a
 * cancelled spawn; an OVERRIDE records that the gate fired and the operator re-authorised). The
 * `detail.decision` field ('refused' | 'override') disambiguates, so a reader queries
 * `type='cancel' AND detail.by='budget'`. Event writes are best-effort (F-014): an event-write fault
 * is logged and never masks the budget decision itself.
 */
export async function enforceTokenBudget(db: Db, opts: EnforceTokenBudgetOpts): Promise<EnforceResult> {
	// LOCAL/$0 exemption: a genuinely-free provider is never gated on the real-money token budget
	// (still metered at events.ts). Checked BEFORE the lock so a $0 turn pays zero serialization cost.
	if (isLocalProvider(opts.provider)) {
		return { enforced: false, spent: 0, budget: 0, overrode: false, release: NOOP_RELEASE };
	}
	const budget = normalizeTokenBudget(opts.budget);
	// 0-sentinel: uncapped. No query, no lock, no event — the cheap common case (shipped default).
	if (budget <= 0) return { enforced: false, spent: 0, budget: 0, overrode: false, release: NOOP_RELEASE };

	// SERIALIZE the read+decide+reserve window (concurrency-overshoot guard). The critical section is
	// just the counter read + the budget decision + taking a reservation — short + bounded; the actual
	// spawn/turn happens AFTER this resolves, outside the lock.
	return withBudgetGate(async () => {
		let spent: number;
		try {
			spent = await tokensSpentSince(db, opts.windowMs ?? SPEND_WINDOW_MS);
		} catch (err) {
			// Fail-open (not a security boundary): a counter fault must never wedge a legitimate spawn.
			console.warn(
				`[spend-budget] token counter query failed (${(err as Error).message}) — allowing spend (fail-open, budget not enforced this call).`
			);
			return { enforced: false, spent: 0, budget, overrode: false, release: NOOP_RELEASE };
		}

		// Account for launches that already passed the gate but whose spend has not yet landed as a
		// completion row (each reserves the RESERVATION_TOKENS honest floor). At the threshold this is
		// what makes "at most 1 of N concurrent launches proceeds".
		const projected = spent + reservedInFlight * RESERVATION_TOKENS;
		if (projected < budget) {
			// PROCEED under budget — take a reservation the caller releases once its spend is metered
			// (or the TTL auto-releases). The measured `spent` is reported honestly (never `projected`).
			return { enforced: true, spent, budget, overrode: false, release: takeReservation() };
		}

		// At/over budget (measured, or would-be with concurrent in-flight launches). Emit the named
		// governance event (best-effort), then refuse-or-override. The event carries the MEASURED spent.
		const emit = (decision: 'refused' | 'override') =>
			writeAgentEvent(db, {
				type: 'cancel',
				...(opts.project ? { project: opts.project } : {}),
				detail: {
					by: 'budget',
					decision,
					reason:
						decision === 'refused'
							? `token budget reached — spawn refused + parked (spent ${spent}, budget ${budget}, in-flight ${reservedInFlight}, source: ${opts.source})`
							: `token budget reached — operator override, proceeding (spent ${spent}, budget ${budget}, source: ${opts.source})`,
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
				`[spend-budget] token budget reached (spent ${spent}, budget ${budget}, source: ${opts.source}) — proceeding on operator override.`
			);
			await emit('override');
			// Override proceeds regardless; no reservation needed (a concurrent NON-override launch
			// already parks on the measured spend, which is ≥ budget on the override path).
			return { enforced: true, spent, budget, overrode: true, release: NOOP_RELEASE };
		}

		await emit('refused');
		throw new TokenBudgetExceededError(spent, budget, opts.source);
	});
}
