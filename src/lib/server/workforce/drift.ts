// WORKFORCE-SPEC §5 — DRIFT DETECTION + AUTO-RAISE (operator decision 4, 2026-06-16).
//
// THE HALF THIS MODULE BUILDS: compute the ARMED drift signals per role_version over
// the track window, and — when an armed signal crosses its threshold with ≥ the claim
// floor of events — AUTO-CREATE a review_proposal{status:'proposed'} carrying the
// trigger + real cited evidence rows.
//
// THE LINE IT NEVER CROSSES (D-010 diff + D-039 swap authority):
//   • NEVER mutates the role or any role_version (no swap, no pointer write).
//   • NEVER authors a challenger prompt (the challenger is created LATER, on panel
//     validation — §5; this raises the TRIGGER only).
//   • NEVER deploys anything. The auto-raise output is a 'proposed' row the operator
//     reviews; prompt authoring, re-gauntlet, and the swap stay operator-gated.
// These are proven by drift.test.ts (the governance red-team).
//
// SIGNALS available NOW (v2.1 data plane):
//   • confidence-miscalibration (A1) — DERIVED from the existing A1 calibration
//     (panel_verdict.confidence × closed outcome): a role version whose HIGH-confidence
//     verdicts go bad (overridden_by_operator | revised) at/above the configured rate
//     is miscalibrated. The denominator is HIGH-confidence verdicts with a CLOSED
//     outcome in the window; null (honest, not a fake 0) below the claim floor.
//   • escaped_defect — an armed event signal (a positive-control failure). v2.1 has no
//     automatic escaped-defect ledger (that is §4.1, post-B2/v2.3); the signal fires
//     from an explicit triggering event the caller supplies (evidence = the real row).
//   • operator_feedback — an armed manual signal; fires from explicit operator-supplied
//     evidence. Both ride the SAME idempotent/bounded auto-raise path as miscalibration.
//   • refutation_rate, fixloop_rate — LITERALLY null (needs v2.2b's B2 + review_verdict).
//     No math, no placeholder (F-008) — surfaced '— (needs B2)'.
//
// IDEMPOTENT + BOUNDED (§5 anti-spam):
//   • Dedup on the m0046 dedup_key (role|kind|incumbent): one OPEN proposal per
//     (role, kind) at a time — a standing drift does NOT spawn duplicates.
//   • Cooldown after a REJECTION: a freshly rejected/withdrawn (role, kind) is not
//     re-raised until the cooldown elapses (don't nag the operator every tick).
//   • A duplicate CREATE racing the open-check still collides on the UNIQUE dedup_key
//     (D-008) and is absorbed — never a duplicate row, even under concurrency.
//
// WIRING (no unbounded loop): evaluateDriftAndAutoRaise is a bounded, on-demand pass
// (one bounded SELECT per role over the window) invoked from the EXISTING PM periodic
// cadence tick (pm-triggers.ts), gated by the same D-004 mode + budget posture.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { WorkforceConfig } from '../config/load';
import {
	createReviewProposal,
	getRoleVersion,
	listReviewProposalsForRole,
	OPEN_PROPOSAL_STATUSES,
	REJECTED_PROPOSAL_STATUSES,
	WorkforceInputError,
	type ReviewProposalKind,
	type ReviewProposalRow
} from './repo';

// ── Signal taxonomy ────────────────────────────────────────────────────────────────

/** The drift signal names §5 arms in v2.1 (rate signals stay null — see below). */
export type DriftSignalName =
	| 'confidence_miscalibration'
	| 'escaped_defect'
	| 'operator_feedback';

/** §5: the proposal KIND each signal raises. Miscalibration → a prompt revision (the
 *  role is mis-judging); escaped_defect → a prompt revision (it missed a real defect);
 *  operator_feedback → a prompt revision by default (the operator can re-kind on the
 *  decision brief). Tier/retire/staffing remain operator-initiated in v2.1. */
const SIGNAL_KIND: Record<DriftSignalName, ReviewProposalKind> = {
	confidence_miscalibration: 'prompt_revision',
	escaped_defect: 'prompt_revision',
	operator_feedback: 'prompt_revision'
};

/** One computed/observed signal for a role version over the window. Every metric is
 *  honest: `armed` reflects config; `fired` is only true when armed AND over threshold
 *  AND at/above the claim floor; below the floor → fired:false + reason (never a fake). */
export interface DriftSignal {
	signal: DriftSignalName;
	/** config: is this signal armed at all? */
	armed: boolean;
	/** The measured value (miscalibration rate ∈ [0,1]); null when not measurable
	 *  (below floor / no closed events / event-style signal with no metric). */
	value: number | null;
	/** The threshold the value is compared against; null when the signal has no rate
	 *  bound (event-style signals) or the rate bound is disarmed. */
	threshold: number | null;
	/** The number of source events backing `value` (the claim-floor denominator). */
	events: number;
	/** True iff this signal should raise a proposal this evaluation. */
	fired: boolean;
	/** Honest one-line reason (why fired / why not — below floor, disarmed, no data). */
	reason: string;
	/** Real cited evidence row ids (F-008) — NEVER fabricated. */
	evidence: string[];
}

/** The post-B2 RATE signals — LITERALLY null until v2.2b lands review_verdict (§2.5).
 *  Typed `null` so no code can "compute" them early; the surface renders '— (needs B2)'. */
export interface PreB2DriftSignals {
	refutation_rate: null;
	fixloop_rate: null;
}

export interface DriftReport {
	roleVersion: string;
	role: string;
	/** The window the signals were computed over (days + the cutoff ISO instant). */
	windowDays: number;
	since: string;
	minEventsForClaim: number;
	signals: DriftSignal[];
	preB2: PreB2DriftSignals;
}

// ── confidence-miscalibration (A1) — the windowed calibration metric ────────────────

/** Outcomes that count a (high-confidence) verdict as WRONG for miscalibration. A
 *  verdict the operator overrode or that had to be revised was a bad confident call.
 *  'upheld' is right; 'withdrawn' is neither (the artifact went away) — excluded from
 *  both numerator AND denominator so a withdrawal never inflates the rate. */
const WRONG_OUTCOMES = new Set(['overridden_by_operator', 'revised']);
const CLOSED_FOR_CALIBRATION = new Set(['overridden_by_operator', 'revised', 'upheld']);

interface RawCalVerdict {
	id: string;
	confidence?: string | null;
	outcome?: string | null;
}

/**
 * Compute the high-confidence-wrong miscalibration metric for ONE version over the
 * window. Bounded SELECT (≤2000 verdict rows); fold in JS (rollup.ts discipline).
 * Denominator = HIGH-confidence verdicts with a CLOSED-for-calibration outcome in the
 * window; numerator = those whose outcome is WRONG. Returns { rate, events, evidence }
 * with rate=null when there are no qualifying verdicts (honest — never a 0/0 → 0).
 */
async function computeMiscalibration(
	db: Db,
	roleVersionId: string,
	since: Date
): Promise<{ rate: number | null; events: number; wrongIds: string[] }> {
	const vid = new StringRecordId(assertRecordId(roleVersionId));
	// F-022: the ORDER BY / filter fields appear in the projection. We window on `at`.
	const [rows] = await db.query<[RawCalVerdict[]]>(
		`SELECT id, confidence, outcome, at FROM panel_verdict
		   WHERE role_version = $vid AND confidence = 'high' AND at > $since
		  ORDER BY at DESC LIMIT 2000;`,
		{ vid, since }
	);
	const closed = (rows ?? []).filter(
		(r) => typeof r.outcome === 'string' && CLOSED_FOR_CALIBRATION.has(r.outcome)
	);
	if (closed.length === 0) return { rate: null, events: 0, wrongIds: [] };
	const wrong = closed.filter((r) => WRONG_OUTCOMES.has(String(r.outcome)));
	return {
		rate: wrong.length / closed.length,
		events: closed.length,
		// Cap the cited evidence so the trigger payload stays bounded (real ids only).
		wrongIds: wrong.slice(0, 25).map((r) => String(r.id))
	};
}

// ── An externally-observed event signal (escaped_defect / operator_feedback) ────────
//
// v2.1 has no automatic ledger for these (§4.1 escaped-defect attribution is v2.3,
// post-B2). They are ARMED so the auto-raise MECHANISM handles them uniformly, but they
// fire only from an EXPLICIT triggering event the caller supplies — with the REAL
// evidence row ids. No event supplied = honestly not fired (never invented).

/** One externally-observed armed event for a role version (an escape the panel caught,
 *  or operator feedback). evidence = the REAL rows that prove it (F-008). */
export interface ObservedDriftEvent {
	roleVersion: string;
	signal: 'escaped_defect' | 'operator_feedback';
	/** Real cited row ids (the failing panel_verdict / the operator_feedback row…). */
	evidence: string[];
	/** Optional free-form note the caller already screened (D-026) — stored verbatim. */
	note?: string;
}

// ── computeDriftSignals — the read-only report (no writes) ──────────────────────────

export interface ComputeDriftOptions {
	/** Externally-observed armed events for THIS version (escaped_defect/operator_feedback). */
	observed?: ObservedDriftEvent[];
	/** Clock seam (tests). */
	now?: () => Date;
}

/**
 * Compute the §5 drift report for one role version — READ ONLY (no row writes). This is
 * the surface feed (role card 'drift' lens) AND the input to the auto-raise pass.
 * Throws WorkforceInputError when the version does not exist (a drift report for a
 * missing version is a caller bug, not an empty state — mirrors roleTrackRecord).
 */
export async function computeDriftSignals(
	db: Db,
	roleVersionId: string,
	cfg: WorkforceConfig,
	opts: ComputeDriftOptions = {}
): Promise<DriftReport> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);

	const now = (opts.now ?? (() => new Date()))();
	const windowDays = cfg.workforce.track_window_days;
	const minEvents = cfg.workforce.min_events_for_claim;
	const since = new Date(now.getTime() - windowDays * 86_400_000);

	const signals: DriftSignal[] = [];

	// ── confidence-miscalibration (A1) ───────────────────────────────────────────────
	{
		const armed =
			cfg.drift.confidence_miscalibration && cfg.drift.confidence_miscalibration_rate !== null;
		const threshold = cfg.drift.confidence_miscalibration_rate;
		const m = await computeMiscalibration(db, version.id, since);
		let fired = false;
		let reason: string;
		if (!cfg.drift.confidence_miscalibration) {
			reason = 'signal disarmed (drift.confidence_miscalibration: false)';
		} else if (threshold === null) {
			reason = 'rate bound unarmed (drift.confidence_miscalibration_rate: null) — surface only';
		} else if (m.rate === null) {
			reason = 'no high-confidence verdicts with a closed outcome in the window';
		} else if (m.events < minEvents) {
			reason = `below claim floor (${m.events} < min_events_for_claim ${minEvents}) — surfaced, not raised`;
		} else if (m.rate >= threshold) {
			fired = true;
			reason = `high-confidence-wrong rate ${m.rate.toFixed(3)} ≥ ${threshold} over ${m.events} closed verdicts`;
		} else {
			reason = `high-confidence-wrong rate ${m.rate.toFixed(3)} < ${threshold} over ${m.events} closed verdicts`;
		}
		signals.push({
			signal: 'confidence_miscalibration',
			armed,
			value: m.rate,
			threshold,
			events: m.events,
			fired,
			reason,
			evidence: m.wrongIds
		});
	}

	// ── escaped_defect / operator_feedback (externally observed armed events) ─────────
	for (const name of ['escaped_defect', 'operator_feedback'] as const) {
		const armed = cfg.drift[name];
		const obs = (opts.observed ?? []).filter(
			(o) => o.signal === name && o.roleVersion === version.id && o.evidence.length > 0
		);
		const evidence = [...new Set(obs.flatMap((o) => o.evidence))].slice(0, 25);
		let fired = false;
		let reason: string;
		if (!armed) {
			reason = `signal disarmed (drift.${name}: false)`;
		} else if (evidence.length === 0) {
			reason = 'no observed event in the window';
		} else {
			fired = true;
			reason = `${evidence.length} observed ${name} event(s) — armed`;
		}
		signals.push({
			signal: name,
			armed,
			value: null, // event-style: a count, not a rate — events carries it
			threshold: null,
			events: evidence.length,
			fired,
			reason,
			evidence
		});
	}

	return {
		roleVersion: version.id,
		role: version.role,
		windowDays,
		since: since.toISOString(),
		minEventsForClaim: minEvents,
		signals,
		// §2.5: literally null until v2.2b's B2 — no math (F-008).
		preB2: { refutation_rate: null, fixloop_rate: null }
	};
}

// ── auto-raise — idempotent + bounded ───────────────────────────────────────────────

/** The disposition of one signal's auto-raise attempt (for the surface + tests). */
export type RaiseDisposition =
	| 'raised' // a new 'proposed' row was created
	| 'not_fired' // the signal did not cross threshold / no event
	| 'open_exists' // an open proposal already stands for (role, kind) — idempotent
	| 'cooldown' // a recent rejection holds the slot (don't nag)
	| 'collision'; // a concurrent create hit the UNIQUE dedup_key — absorbed

export interface RaiseResult {
	signal: DriftSignalName;
	kind: ReviewProposalKind;
	disposition: RaiseDisposition;
	/** The proposal row when disposition='raised' (else the existing/blocking row, if any). */
	proposal?: ReviewProposalRow;
	reason: string;
}

export interface AutoRaiseOptions extends ComputeDriftOptions {
	/** Cooldown after a rejection before the same (role, kind) may re-raise (ms).
	 *  Default = the track window (a rejected concern is not re-litigated within the
	 *  same window it was measured over — a conservative, window-derived default). */
	rejectionCooldownMs?: number;
}

/**
 * Evaluate drift for ONE role version and auto-raise proposals for fired signals —
 * IDEMPOTENT + BOUNDED (§5), deduped on the m0046 dedup_key fingerprint
 * (role|kind|incumbent). For each fired signal:
 *   1. If an OPEN proposal already stands at the fingerprint → 'open_exists' (no dup).
 *   2. Else if the most-recent rejection at the fingerprint is within the cooldown →
 *      'cooldown' (a standing-but-rejected concern is not re-litigated every tick).
 *   3. Else CREATE a review_proposal{status:'proposed', trigger, evidence}.
 * The dedup is a RUNTIME open-check + cooldown, NOT a DB UNIQUE constraint: a hard
 * UNIQUE on (role|kind|incumbent) would forbid the legitimate post-cooldown re-raise
 * (the fingerprint repeats across the version's lifetime by design). The defensive
 * 'collision' branch absorbs a true concurrent double-insert IF a future migration ever
 * adds the index — today it cannot fire, and the open-check is the guarantee.
 * NEVER mutates the version/role, NEVER swaps, NEVER authors a prompt.
 */
export async function autoRaiseForVersion(
	db: Db,
	roleVersionId: string,
	cfg: WorkforceConfig,
	opts: AutoRaiseOptions = {}
): Promise<{ report: DriftReport; raises: RaiseResult[] }> {
	const report = await computeDriftSignals(db, roleVersionId, cfg, opts);
	const version = await getRoleVersion(db, roleVersionId);
	// computeDriftSignals already threw if missing; re-fetch is cheap + keeps the type tight.
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);

	const now = (opts.now ?? (() => new Date()))();
	const cooldownMs = opts.rejectionCooldownMs ?? cfg.workforce.track_window_days * 86_400_000;

	// ONE bounded read of the role's proposals; partition in JS (no per-signal query).
	const existing = await listReviewProposalsForRole(db, version.role);
	const open = new Set(OPEN_PROPOSAL_STATUSES);
	const rejected = new Set(REJECTED_PROPOSAL_STATUSES);

	const raises: RaiseResult[] = [];
	for (const sig of report.signals) {
		const kind = SIGNAL_KIND[sig.signal];
		if (!sig.fired) {
			raises.push({ signal: sig.signal, kind, disposition: 'not_fired', reason: sig.reason });
			continue;
		}
		// Match the m0046 dedup_key fingerprint: role|kind|incumbent (this version).
		const fingerprint = dedupFingerprint(version.role, kind, version.id);
		const sameSlot = existing.filter(
			(p) => dedupFingerprint(p.role, p.kind, p.incumbent) === fingerprint
		);
		const openRow = sameSlot.find((p) => open.has(p.status));
		if (openRow) {
			raises.push({
				signal: sig.signal,
				kind,
				disposition: 'open_exists',
				proposal: openRow,
				reason: `an open ${kind} proposal already stands for this version (${openRow.id})`
			});
			continue;
		}
		const cooled = mostRecentRejection(sameSlot, rejected);
		if (cooled && withinCooldown(cooled, now, cooldownMs)) {
			raises.push({
				signal: sig.signal,
				kind,
				disposition: 'cooldown',
				proposal: cooled,
				reason: `recently ${cooled.status} (${cooled.decided_at ?? cooled.created_at}) — within cooldown`
			});
			continue;
		}
		// Fire: open a 'proposed' row with the real trigger + evidence.
		const trigger = buildTrigger(sig, cfg, report);
		try {
			const proposal = await createReviewProposal(db, {
				role: version.role,
				kind,
				incumbent: version.id,
				trigger
			});
			raises.push({
				signal: sig.signal,
				kind,
				disposition: 'raised',
				proposal,
				reason: sig.reason
			});
		} catch (err) {
			// A concurrent tick raced us to the same (role|kind|incumbent) dedup_key — the
			// UNIQUE index rejected the second insert. That is the idempotency guarantee
			// working (never a duplicate row); absorb it as 'collision', not a failure.
			if (isUniqueViolation(err)) {
				raises.push({
					signal: sig.signal,
					kind,
					disposition: 'collision',
					reason: `dedup_key collision (role|${kind}|incumbent already proposed) — absorbed`
				});
			} else {
				throw err;
			}
		}
	}
	return { report, raises };
}

/** PM-SPEC §4.1 provenance object copied onto the proposal's `trigger` (the operator
 *  reads this verbatim). Carries the signal name, the REAL evidence ids (F-008), and a
 *  config snapshot so a later threshold change is auditable against what fired. */
function buildTrigger(
	sig: DriftSignal,
	cfg: WorkforceConfig,
	report: DriftReport
): Record<string, unknown> {
	return {
		signal: sig.signal,
		evidence: sig.evidence,
		value: sig.value,
		threshold: sig.threshold,
		events: sig.events,
		reason: sig.reason,
		window_days: report.windowDays,
		since: report.since,
		config_snapshot: {
			confidence_miscalibration: cfg.drift.confidence_miscalibration,
			confidence_miscalibration_rate: cfg.drift.confidence_miscalibration_rate,
			escaped_defect: cfg.drift.escaped_defect,
			operator_feedback: cfg.drift.operator_feedback,
			track_window_days: cfg.workforce.track_window_days,
			min_events_for_claim: cfg.workforce.min_events_for_claim
		}
	};
}

/** The m0046 dedup_key fingerprint, computed in JS to match the DDL VALUE exactly:
 *  `<string>role + '|' + kind + '|' + (incumbent || '')`. The single dedup identity
 *  the open-check + cooldown key on (§5 anti-spam). */
function dedupFingerprint(role: string, kind: string, incumbent: string | null): string {
	return `${role}|${kind}|${incumbent ?? ''}`;
}

function mostRecentRejection(
	rows: ReviewProposalRow[],
	rejected: Set<string>
): ReviewProposalRow | null {
	let best: ReviewProposalRow | null = null;
	for (const p of rows) {
		if (!rejected.has(p.status)) continue;
		if (!best || rejectionInstant(p) > rejectionInstant(best)) best = p;
	}
	return best;
}

function rejectionInstant(p: ReviewProposalRow): number {
	const t = p.decided_at ?? p.created_at;
	const ms = t ? Date.parse(t) : NaN;
	return Number.isNaN(ms) ? 0 : ms;
}

function withinCooldown(p: ReviewProposalRow, now: Date, cooldownMs: number): boolean {
	const at = rejectionInstant(p);
	if (at === 0) return false; // no parseable instant → don't block (fail open on cooldown only)
	return now.getTime() - at < cooldownMs;
}

/** Recognize the SurrealDB UNIQUE-index violation the dedup_key throws on a duplicate
 *  open. Message-shape match (SurrealDB has no typed error here); conservative — an
 *  unrecognized error re-throws (never silently swallowed, F-022). */
function isUniqueViolation(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /already (contains|exists)|index .* unique|duplicate/i.test(msg);
}

// ── evaluateDriftAndAutoRaise — the bounded fleet pass (the wiring entry point) ──────

export interface EvaluateDriftOptions {
	/** Externally-observed armed events keyed for the relevant versions. */
	observed?: ObservedDriftEvent[];
	rejectionCooldownMs?: number;
	now?: () => Date;
	/** Cap the role versions evaluated in one pass (bounded — never the whole table). */
	maxVersions?: number;
}

export interface EvaluateDriftResult {
	/** Role versions evaluated this pass. */
	evaluated: number;
	/** Proposals actually raised this pass. */
	raised: number;
	/** Per-version raise outcomes (for the surface / diagnostics). */
	details: Array<{ roleVersion: string; raises: RaiseResult[] }>;
}

/**
 * The BOUNDED fleet drift pass (the §5 wiring entry point — invoked from the PM periodic
 * cadence, NOT an unbounded loop). Evaluates the ACTIVE (incumbent) version of every
 * active role — that is the version actually producing verdicts, so it is the only one
 * a drift signal is honest about — and auto-raises for fired signals. Returns counts +
 * details. NEVER swaps/mutates/authors (every raise is a 'proposed' row).
 *
 * Bounded by construction: one role list (≤500) → one incumbent per role → one proposal
 * read + at most |signals| creates each. `maxVersions` hard-caps the pass.
 */
export async function evaluateDriftAndAutoRaise(
	db: Db,
	cfg: WorkforceConfig,
	opts: EvaluateDriftOptions = {}
): Promise<EvaluateDriftResult> {
	const maxVersions = Math.min(Math.max(opts.maxVersions ?? 100, 1), 500);
	// Bounded: the active incumbents only (the versions producing live verdicts). A role
	// with NONE active_version is not deployable → not producing drift → skipped honestly.
	const [roles] = await db.query<[Array<{ active_version: unknown }>]>(
		// F-022: the ORDER BY field (slug) MUST appear in the projection.
		`SELECT slug, active_version FROM role WHERE status = 'active' AND active_version != NONE
		  ORDER BY slug ASC LIMIT ${maxVersions};`
	);
	const details: EvaluateDriftResult['details'] = [];
	let raised = 0;
	let evaluated = 0;
	for (const r of roles ?? []) {
		const versionId = r.active_version != null ? String(r.active_version) : null;
		if (!versionId) continue;
		evaluated++;
		const { raises } = await autoRaiseForVersion(db, versionId, cfg, {
			...(opts.observed !== undefined ? { observed: opts.observed } : {}),
			...(opts.rejectionCooldownMs !== undefined
				? { rejectionCooldownMs: opts.rejectionCooldownMs }
				: {}),
			...(opts.now !== undefined ? { now: opts.now } : {})
		});
		raised += raises.filter((x) => x.disposition === 'raised').length;
		details.push({ roleVersion: versionId, raises });
	}
	return { evaluated, raised, details };
}
