// WORKFORCE-SPEC §7 — TIER-AWARE HIRING (wave v2.3), STRICT policy (LOCKED operator
// decision 2026-06-16): a role runs at a tier ONLY when it has a PASSING gauntlet run at
// (prompt_sha × that tier's model_id). NO waivers, not even low-stakes roles.
//
// THE TWO EVIDENCE PLANES, NEVER MERGED (§7):
//   • the PROBE/GAUNTLET plane — interview_run rows for the version, grouped per model_id
//     (apples-to-apples recall / FP / pass-status / cost). REUSES track-record.ts's
//     InterviewPlaneCell fold wholesale (do NOT recompute divergently — task lock).
//   • the FIELD plane — per (role_version × model_id): priced agent_event cost + session
//     count (Σcost from PRICED rows only, null when none — F-008). panel_verdict outcomes
//     are per-VERSION (the table carries no model_id), so they ride on the grid header, not
//     a per-tier cell — reused verbatim from roleTrackRecord.panel.
//
// THE GRID (tierHiringGrid): one cell per (version × tier) — every cell null-honest, an
// uninterviewed tier renders '—' (never a fabricated 0%). No blended quality index, EVER.
//
// THE RECOMMENDATION (§7): emit 'tier X matches tier Y at a fraction of the cost' ONLY when
// BOTH tiers have a PASSING run at the SAME fixture_set_sha AND the cheaper tier is ≥ on
// recall AND ≤ on FP (equal-or-better on both surfaced columns). Otherwise return the raw
// grid with NO sentence (honest — never a fabricated 'matches').
//
// THE STRICT tier_change PROPOSAL (§7): proposeTierChange opens a review_proposal
// {kind:'tier_change'} via the EXISTING §5 createReviewProposal lifecycle (it does NOT fork
// it). THE STRICT GATE (resolveTierChangeGate): the proposal can be approved/swapped ONLY
// when a PASSING interview_run exists at (incumbent.prompt_sha × the target tier's model_id);
// when none exists the approve path REQUIRES running that interview first (the caller runs
// runGauntlet at the target tier and re-checks). The swap (swapTierChange) is operator-gated
// (D-039) — there is NO auto-swap, NO waiver, NO inherited cert across tiers.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { checkDeployability } from './deployability';
import { roleTrackRecord, type InterviewPlaneCell, type PanelPlane } from './track-record';
import {
	addRoleEvent,
	createReviewProposal,
	getReviewProposal,
	getRole,
	getRoleVersion,
	listReviewProposalsForRole,
	OPEN_PROPOSAL_STATUSES,
	setProposalStatus,
	type ReviewProposalRow,
	type RoleRow,
	type Tier,
	WorkforceInputError
} from './repo';

// ── Named errors (every error has a name; the message names what triggered it) ──────

/** A §7 STRICT governance gate violation — a tier swap requested without a passing
 *  interview at (incumbent.prompt_sha × target-tier model_id), a missing operator confirm,
 *  a proposal in the wrong status/kind. Fail loud, fail closed; the route maps it to a 400. */
export class TierGateError extends Error {
	override readonly name = 'TierGateError';
}

// ── The tier → model_id seam (D-003) — injected, fail-closed ─────────────────────────
//
// §7: the tier→model_id map lives in config/agent-pool.yaml (AgentPool.tiers, D-003), read
// via config/load.ts. This module must NOT couple to the config file (so it stays unit-
// testable against a throwaway DB). The resolution is therefore an INJECTED function; the
// route passes the config-backed resolver, tests pass a deterministic stub. Fail-closed: a
// tier the config does not know resolves to null and the cell renders '— (tier unmapped)'
// (never a fabricated model id — F-008).

/** Resolve a tier label → its {provider, model_id}, or null when the tier is unmapped. */
export type TierModelResolver = (tier: Tier) => { provider: string; model_id: string } | null;

/** The four tiers, cheapest → dearest (the §7 grid axis + the recommendation's cost order). */
export const TIER_ORDER: readonly Tier[] = ['local', 'haiku', 'sonnet', 'opus'];

/** Index of a tier in the cost ladder; -1 for an unknown tier (never treated as cheaper). */
function tierRank(tier: string): number {
	return TIER_ORDER.indexOf(tier as Tier);
}

// ── Grid cell ────────────────────────────────────────────────────────────────────────

/** The gauntlet (probe) evidence for one (version × tier) cell — null when the tier is
 *  unmapped OR uninterviewed at that model (honest empty, never a fabricated 0). This is the
 *  InterviewPlaneCell for the tier's resolved model_id, lifted verbatim from track-record.ts. */
export interface TierGauntletEvidence {
	modelId: string;
	/** All interview_run rows at this model (any status) — the source-row count. */
	runs: number;
	passed: number;
	failed: number;
	error: number;
	adjudicating: number;
	running: number;
	/** planted_found / planted_total of the LATEST terminal run; null when none / total 0. */
	recall: number | null;
	/** false_positives of the latest terminal run; null when no terminal run. */
	falsePositives: number | null;
	/** Σ cost_usd across PRICED runs only; null when none priced (F-008). */
	costUsd: number | null;
	/** True when every PASSING run at this model is stale (§3.7 honest flag). */
	stale: boolean;
	/** fixture_set_sha of the latest PASSING run — the recommendation's apples-to-apples key;
	 *  null when there is no passing run (so two cells can only be compared when both passed). */
	passedFixtureSetSha: string | null;
	lastRunAt: string | null;
}

/** The field evidence for one (version × tier) cell — per resolved model_id. Cost/sessions
 *  from REAL priced agent_event rows joined through session.role_version; null when none. */
export interface TierFieldEvidence {
	modelId: string;
	/** Sessions for this version at this model_id. */
	sessions: number;
	/** agent_event rows across those sessions (source-row count). */
	events: number;
	/** Σ cost_usd from PRICED rows only; null when none priced (F-008). */
	costUsd: number | null;
}

/** One (version × tier) grid cell — both planes null-honest, never merged into one index. */
export interface TierGridCell {
	tier: Tier;
	/** The tier's resolved model_id, or null when the tier is unmapped in config (F-008). */
	modelId: string | null;
	/** §7 STRICT: is the version deployable at this tier's model_id RIGHT NOW (a passing
	 *  (prompt_sha × model_id) interview exists)? false for every uninterviewed/unmapped tier. */
	deployable: boolean;
	/** Honest named reason when not deployable; null when deployable. */
	notDeployableReason: string | null;
	/** True iff this is the version's CURRENT operating tier (role.preferred_tier ||
	 *  role_version.default_tier) — the grid marks the incumbent tier. */
	current: boolean;
	gauntlet: TierGauntletEvidence | null;
	field: TierFieldEvidence | null;
}

/** A §7 recommendation — emitted ONLY under the strict both-passing / same-sha / cheaper-wins
 *  condition. When `emit` is false the surface shows the raw grid with NO sentence (F-008). */
export interface TierRecommendation {
	emit: boolean;
	/** The cheaper tier that matches (only set when emit). */
	cheaperTier: Tier | null;
	/** The dearer tier it matches (only set when emit). */
	dearerTier: Tier | null;
	/** The human sentence, ONLY when emit (e.g. 'sonnet matches opus on recall and FP at a
	 *  fraction of the cost'); null otherwise. */
	sentence: string | null;
	/** Why no recommendation, when emit=false (named — for the surface's honesty). */
	reason: string;
}

export interface TierHiringGrid {
	role: string;
	roleSlug: string;
	roleName: string;
	roleVersion: string;
	version: number;
	promptSha: string;
	/** role.preferred_tier ?? role_version.default_tier — the current operating tier. */
	currentTier: Tier;
	cells: TierGridCell[];
	/** Per-VERSION panel evidence (panel_verdict carries no model_id) — the grid header. */
	panel: PanelPlane;
	recommendation: TierRecommendation;
}

interface RawFieldRow {
	cost_usd?: number | null;
	mid?: string | null;
}

/**
 * Field cost rollup per model_id for ONE version: Σ priced agent_event.cost_usd grouped by
 * the producing session's model.model_id, plus the session/event counts. Bounded SELECTs,
 * fold in JS (rollup discipline). Costs come from PRICED rows ONLY (F-008) — a model with
 * sessions but no priced events yields costUsd:null, never a 0.
 */
async function fieldByModel(
	db: Db,
	versionId: string
): Promise<Map<string, TierFieldEvidence>> {
	const vid = new StringRecordId(assertRecordId(versionId));
	// Sessions for this version, with their resolved model_id (the field-plane axis).
	const [sessionRows] = await db.query<[Array<{ id: unknown; mid?: string | null }>]>(
		`SELECT id, model.model_id AS mid FROM session WHERE role_version = $vid LIMIT 2000;`,
		{ vid }
	);
	const sessions = sessionRows ?? [];
	const byModel = new Map<string, TierFieldEvidence>();
	const sessionModel = new Map<string, string>();
	for (const s of sessions) {
		const mid = typeof s.mid === 'string' && s.mid.length > 0 ? s.mid : null;
		if (!mid) continue; // a session with no resolved model_id can't be attributed to a tier.
		const sid = String(s.id);
		sessionModel.set(sid, mid);
		const cell = byModel.get(mid) ?? { modelId: mid, sessions: 0, events: 0, costUsd: null };
		cell.sessions++;
		byModel.set(mid, cell);
	}
	const sessionIds = [...sessionModel.keys()];
	if (sessionIds.length === 0) return byModel;
	// agent_event rows for those sessions, carrying each event's own model_id (defense in
	// depth: an event's recorded model is authoritative; fall back to its session's model).
	const [evRows] = await db.query<[Array<RawFieldRow & { session?: unknown }>]>(
		`SELECT session, cost_usd, model.model_id AS mid FROM agent_event
		   WHERE session IN $sids LIMIT 50000;`,
		{ sids: sessionIds.map((s) => new StringRecordId(assertRecordId(s))) }
	);
	for (const ev of evRows ?? []) {
		const evMid = typeof ev.mid === 'string' && ev.mid.length > 0 ? ev.mid : null;
		const sid = ev.session != null ? String(ev.session) : null;
		const mid = evMid ?? (sid ? (sessionModel.get(sid) ?? null) : null);
		if (!mid) continue;
		const cell = byModel.get(mid) ?? { modelId: mid, sessions: 0, events: 0, costUsd: null };
		cell.events++;
		if (typeof ev.cost_usd === 'number') cell.costUsd = (cell.costUsd ?? 0) + ev.cost_usd;
		byModel.set(mid, cell);
	}
	return byModel;
}

/** The fixture_set_sha of the LATEST PASSING run at a model — the recommendation's apples-to-
 *  apples key. null when no passing run exists. Bounded read (F-022: ORDER BY field projected). */
async function passedFixtureSetShaFor(
	db: Db,
	versionId: string,
	modelId: string
): Promise<string | null> {
	const vid = new StringRecordId(assertRecordId(versionId));
	const [rows] = await db.query<[Array<{ fixture_set_sha: string; started_at: unknown }>]>(
		`SELECT fixture_set_sha, started_at FROM interview_run
		  WHERE role_version = $vid AND status = 'passed' AND model_id = $mid
		  ORDER BY started_at DESC LIMIT 1;`,
		{ vid, mid: modelId }
	);
	const sha = rows?.[0]?.fixture_set_sha;
	return typeof sha === 'string' && sha.length > 0 ? sha : null;
}

/** Lift an InterviewPlaneCell (track-record fold) + the passing fixture_set_sha into the §7
 *  gauntlet-evidence shape. Pure (no IO). */
function gauntletEvidenceFrom(
	cell: InterviewPlaneCell,
	passedFixtureSetSha: string | null
): TierGauntletEvidence {
	return {
		modelId: cell.model_id,
		runs: cell.runs,
		passed: cell.passed,
		failed: cell.failed,
		error: cell.error,
		adjudicating: cell.adjudicating,
		running: cell.running,
		recall: cell.recall,
		falsePositives: cell.falsePositives,
		costUsd: cell.costUsd,
		stale: cell.stale,
		passedFixtureSetSha,
		lastRunAt: cell.lastRunAt
	};
}

/**
 * §7 — compute the tier-hiring grid for ONE role version: one cell per (version × tier),
 * both evidence planes null-honest, plus the strict recommendation. REUSES roleTrackRecord
 * (the interview/panel planes — do NOT recompute divergently) + checkDeployability (the §2.4
 * existential check the STRICT policy keys on) + the injected tier→model resolver (D-003).
 *
 * Throws WorkforceInputError when the version/role does not exist (a grid for a missing
 * artifact is a caller bug, not an empty state — mirrors roleTrackRecord/computeDriftSignals).
 */
export async function tierHiringGrid(
	db: Db,
	roleVersionId: string,
	resolveTierModel: TierModelResolver
): Promise<TierHiringGrid> {
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) throw new WorkforceInputError(`role_version not found: ${roleVersionId}`);
	const role = await getRole(db, version.role);
	if (!role) throw new WorkforceInputError(`role not found: ${version.role}`);

	// REUSE the track-record planes (interview per-model + panel per-version). The interview
	// plane is the SAME fold the role card uses — no divergent recompute (task lock).
	const track = await roleTrackRecord(db, version.id);
	const byModelInterview = new Map<string, InterviewPlaneCell>();
	for (const c of track.interviews) byModelInterview.set(c.model_id, c);
	const fieldByMid = await fieldByModel(db, version.id);

	const currentTier: Tier = role.preferred_tier ?? version.default_tier;

	const cells: TierGridCell[] = [];
	for (const tier of TIER_ORDER) {
		const resolved = resolveTierModel(tier);
		if (!resolved || !resolved.model_id?.trim()) {
			// Unmapped tier — honest empty cell, NEVER a fabricated model/score (F-008).
			cells.push({
				tier,
				modelId: null,
				deployable: false,
				notDeployableReason: `tier '${tier}' is not mapped to a model in config (D-003)`,
				current: tier === currentTier,
				gauntlet: null,
				field: null
			});
			continue;
		}
		const modelId = resolved.model_id;
		// §7 STRICT: deployability is the §2.4 existential check at THIS model_id. A tier with
		// no passing (prompt_sha × model_id) run is NOT deployable — no waiver, no inherited cert.
		const verdict = await checkDeployability(db, version.id, modelId);
		const interviewCell = byModelInterview.get(modelId) ?? null;
		const passedSha = interviewCell
			? await passedFixtureSetShaFor(db, version.id, modelId)
			: null;
		cells.push({
			tier,
			modelId,
			deployable: verdict.deployable,
			notDeployableReason: verdict.reason,
			current: tier === currentTier,
			gauntlet: interviewCell ? gauntletEvidenceFrom(interviewCell, passedSha) : null,
			field: fieldByMid.get(modelId) ?? null
		});
	}

	return {
		role: role.id,
		roleSlug: role.slug,
		roleName: role.name,
		roleVersion: version.id,
		version: version.version,
		promptSha: version.prompt_sha,
		currentTier,
		cells,
		panel: track.panel,
		recommendation: computeRecommendation(cells)
	};
}

/**
 * §7 RECOMMENDATION — STRICT and honest. Scan tier pairs cheapest→dearest; emit a match ONLY
 * when BOTH tiers have a PASSING run at the SAME fixture_set_sha AND the cheaper tier is
 * equal-or-better on BOTH surfaced columns (recall ≥, FP ≤). Otherwise NO sentence (F-008 —
 * never a fabricated 'matches'; mismatched fixture_set_sha, a worse-recall or worse-FP cheaper
 * tier, or any missing pass all return emit:false with the named reason).
 *
 * Pure (no IO) so it is unit-testable directly. Picks the CHEAPEST qualifying cheaper tier vs
 * the DEAREST dearer tier it beats — the biggest honest saving — and reports it.
 */
export function computeRecommendation(cells: TierGridCell[]): TierRecommendation {
	// Candidate tiers: those with a PASSING run (recall/FP measurable) and a fixture_set_sha.
	const passed = cells.filter(
		(c) =>
			c.gauntlet !== null &&
			c.gauntlet.passed > 0 &&
			c.gauntlet.passedFixtureSetSha !== null &&
			c.gauntlet.recall !== null &&
			c.gauntlet.falsePositives !== null
	);
	if (passed.length < 2) {
		return {
			emit: false,
			cheaperTier: null,
			dearerTier: null,
			sentence: null,
			reason: 'fewer than two tiers have a passing run with measurable recall/FP — no comparison'
		};
	}
	// Compare cheapest-first against each dearer tier; the first qualifying pair (biggest saving
	// against the dearest beatable tier) wins. Sort by cost rank ascending.
	const byRank = [...passed].sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
	let mismatchedSha = false;
	let cheaperWorse = false;
	for (let i = 0; i < byRank.length; i++) {
		const cheaper = byRank[i];
		// Compare against the DEAREST tier it can beat (scan dearer tiers high→low).
		for (let j = byRank.length - 1; j > i; j--) {
			const dearer = byRank[j];
			const cg = cheaper.gauntlet!;
			const dg = dearer.gauntlet!;
			if (cg.passedFixtureSetSha !== dg.passedFixtureSetSha) {
				mismatchedSha = true;
				continue;
			}
			const recallOk = (cg.recall ?? -1) >= (dg.recall ?? -1);
			const fpOk = (cg.falsePositives ?? Infinity) <= (dg.falsePositives ?? Infinity);
			if (recallOk && fpOk) {
				return {
					emit: true,
					cheaperTier: cheaper.tier,
					dearerTier: dearer.tier,
					sentence: `${cheaper.tier} matches ${dearer.tier} on recall and false positives at a fraction of the cost — both passed at the same fixture set`,
					reason: 'strict condition met: same fixture_set_sha, both passed, cheaper tier ≥ on recall and ≤ on FP'
				};
			}
			cheaperWorse = true;
		}
	}
	const reason = mismatchedSha
		? 'tiers passed at DIFFERENT fixture sets (fixture_set_sha mismatch) — not apples-to-apples, no claim (F-008)'
		: cheaperWorse
			? 'the cheaper tier is worse on recall or FP — no match (F-008)'
			: 'no qualifying tier pair';
	return { emit: false, cheaperTier: null, dearerTier: null, sentence: null, reason };
}

// ── STRICT tier_change PROPOSAL (§7 — reuses the §5 lifecycle, does NOT fork it) ──────

export interface ProposeTierChangeInput {
	/** The role version this proposal targets (the incumbent whose operating tier changes). */
	roleVersion: string;
	/** The tier the operator/PM wants the role to operate at. */
	targetTier: Tier;
	/** Optional PM id (NONE = operator-initiated, §5). */
	pm?: string;
	/** Optional free-form rationale — stored on the trigger (harness-authored provenance). */
	note?: string;
}

export interface ProposeTierChangeResult {
	proposal: ReviewProposalRow;
	/** false when an OPEN tier_change proposal already stood for this (role, incumbent) — the
	 *  existing one is returned (idempotent / §5 anti-spam, interrupt contract). */
	created: boolean;
}

/**
 * §7 — open a STRICT tier_change review_proposal via the EXISTING §5 createReviewProposal
 * (kind:'tier_change'). It cites the grid evidence in the trigger and records the target tier
 * in trigger.target_tier. It NEVER mutates the role, NEVER swaps, NEVER changes a tier — it
 * raises the proposal only; the strict gate + the swap are separate operator-gated acts.
 *
 * §5 ANTI-SPAM: one OPEN tier_change proposal per (role, incumbent) at a time — a second
 * proposeTierChange while one stands returns the existing row (created:false) rather than
 * duplicating (the open-check is the guarantee; the m0046 dedup_key fingerprint matches).
 */
export async function proposeTierChange(
	db: Db,
	input: ProposeTierChangeInput,
	resolveTierModel: TierModelResolver
): Promise<ProposeTierChangeResult> {
	if (!TIER_ORDER.includes(input.targetTier)) {
		throw new WorkforceInputError(
			`invalid target tier '${input.targetTier}' — must be one of ${TIER_ORDER.join(', ')}`
		);
	}
	const version = await getRoleVersion(db, input.roleVersion);
	if (!version) throw new WorkforceInputError(`role_version not found: ${input.roleVersion}`);
	const role = await getRole(db, version.role);
	if (!role) throw new WorkforceInputError(`role not found: ${version.role}`);

	const currentTier: Tier = role.preferred_tier ?? version.default_tier;
	if (input.targetTier === currentTier) {
		throw new WorkforceInputError(
			`role '${role.slug}' already operates at tier '${currentTier}' — no tier change to propose`
		);
	}

	// §5 anti-spam: collapse to an existing OPEN tier_change for this (role, incumbent).
	const existing = await listReviewProposalsForRole(db, role.id);
	const open = new Set(OPEN_PROPOSAL_STATUSES as readonly string[]);
	const standing = existing.find(
		(p) => p.kind === 'tier_change' && p.incumbent === version.id && open.has(p.status)
	);
	if (standing) return { proposal: standing, created: false };

	// Build the grid evidence the proposal cites (real rows; the trigger carries it verbatim).
	const grid = await tierHiringGrid(db, version.id, resolveTierModel);
	const targetCell = grid.cells.find((c) => c.tier === input.targetTier) ?? null;
	const trigger: Record<string, unknown> = {
		signal: 'tier_change',
		target_tier: input.targetTier,
		current_tier: currentTier,
		target_model_id: targetCell?.modelId ?? null,
		target_deployable: targetCell?.deployable ?? false,
		recommendation: grid.recommendation.emit
			? { cheaper: grid.recommendation.cheaperTier, dearer: grid.recommendation.dearerTier }
			: null,
		grid_evidence: grid.cells.map((c) => ({
			tier: c.tier,
			model_id: c.modelId,
			deployable: c.deployable,
			recall: c.gauntlet?.recall ?? null,
			false_positives: c.gauntlet?.falsePositives ?? null,
			gauntlet_cost_usd: c.gauntlet?.costUsd ?? null,
			field_cost_usd: c.field?.costUsd ?? null
		})),
		...(input.note ? { note: input.note } : {})
	};

	const proposal = await createReviewProposal(db, {
		role: role.id,
		kind: 'tier_change',
		incumbent: version.id,
		...(input.pm ? { pm: input.pm } : {}),
		trigger
	});
	await addRoleEvent(db, {
		role: role.id,
		role_version: version.id,
		op: 'created',
		detail: { proposal: proposal.id, kind: 'tier_change', target_tier: input.targetTier }
	});
	return { proposal, created: true };
}

// ── THE STRICT GATE ──────────────────────────────────────────────────────────────────

/** The strict-gate state for a tier_change proposal — what the surface renders + the
 *  approve path keys on. */
export interface TierChangeGate {
	proposal: string;
	targetTier: Tier;
	/** The target tier's resolved model_id, or null when the tier is unmapped (F-008). */
	targetModelId: string | null;
	/** §7 STRICT: does a PASSING interview_run exist at (incumbent.prompt_sha × targetModelId)?
	 *  When true the proposal may proceed to swap; when false it needs an interview FIRST. */
	passingRunExists: boolean;
	/** The certifying interview_run id when passingRunExists; null otherwise. */
	certifiedBy: string | null;
	/** What the proposal is waiting on: 'needs_interview' | 'ready_to_swap' | 'blocked'. */
	state: 'needs_interview' | 'ready_to_swap' | 'blocked';
	/** Honest one-line message ('needs a passing interview at <tier> first' / 'ready'). */
	message: string;
}

/**
 * §7 STRICT GATE — resolve whether a tier_change proposal may proceed to swap. The ONLY way
 * forward is a PASSING interview_run at (incumbent.prompt_sha × target-tier model_id); this
 * reuses checkDeployability (the §2.4 existential check) — never an inherited cert, never a
 * waiver. Returns the honest gate state the surface renders + the approve path keys on.
 *
 * Read-only (no writes). Throws WorkforceInputError when the proposal/version is missing or
 * the proposal is not a tier_change (a tier gate for a prompt_revision is a caller bug).
 */
export async function resolveTierChangeGate(
	db: Db,
	proposalId: string,
	resolveTierModel: TierModelResolver
): Promise<TierChangeGate> {
	const proposal = await getReviewProposal(db, proposalId);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${proposalId}`);
	if (proposal.kind !== 'tier_change') {
		throw new WorkforceInputError(
			`proposal ${proposal.id} is kind '${proposal.kind}', not 'tier_change' — no tier gate applies`
		);
	}
	const targetTier = readTargetTier(proposal);
	if (!targetTier) {
		throw new WorkforceInputError(
			`tier_change proposal ${proposal.id} carries no valid trigger.target_tier — cannot resolve the gate`
		);
	}
	if (!proposal.incumbent) {
		throw new WorkforceInputError(
			`tier_change proposal ${proposal.id} has no incumbent version to tier-change`
		);
	}
	const resolved = resolveTierModel(targetTier);
	if (!resolved || !resolved.model_id?.trim()) {
		return {
			proposal: proposal.id,
			targetTier,
			targetModelId: null,
			passingRunExists: false,
			certifiedBy: null,
			state: 'blocked',
			message: `tier '${targetTier}' is not mapped to a model in config (D-003) — cannot interview or swap`
		};
	}
	const modelId = resolved.model_id;
	// THE STRICT CHECK: a passing (incumbent.prompt_sha × target model_id) interview must exist.
	const verdict = await checkDeployability(db, proposal.incumbent, modelId);
	if (verdict.deployable) {
		return {
			proposal: proposal.id,
			targetTier,
			targetModelId: modelId,
			passingRunExists: true,
			certifiedBy: verdict.certifiedBy,
			state: 'ready_to_swap',
			message: `passing interview at ${targetTier} (${modelId}) exists — ready for the operator swap (D-039)`
		};
	}
	return {
		proposal: proposal.id,
		targetTier,
		targetModelId: modelId,
		passingRunExists: false,
		certifiedBy: null,
		state: 'needs_interview',
		message: `needs a passing interview at ${targetTier} (${modelId}) first — ${verdict.reason}`
	};
}

/** Read trigger.target_tier off a tier_change proposal; null when absent/invalid. */
function readTargetTier(proposal: ReviewProposalRow): Tier | null {
	const t = (proposal.trigger as Record<string, unknown> | undefined)?.target_tier;
	return typeof t === 'string' && (TIER_ORDER as readonly string[]).includes(t) ? (t as Tier) : null;
}

// ── THE SWAP (operator-gated, D-039 — reuses §5's swap discipline) ───────────────────

export interface SwapTierChangeInput {
	proposal: string;
	/** The operator's explicit D-039 confirm. REQUIRED true — fail-closed, NO auto-swap. */
	operatorConfirmed: boolean;
}

export interface SwapTierChangeResult {
	role: RoleRow;
	proposal: ReviewProposalRow;
	/** The tier the role now operates at (role.preferred_tier). */
	tier: Tier;
}

/**
 * §7 STRICT SWAP (operator-gated, D-039) — the SOLE tier-swap entry from a proposal. The
 * operator confirms; the role's operating tier (role.preferred_tier) is set to the target,
 * the proposal closes 'swapped' + decided_at, and a role_event{op:'tier_changed'} is appended.
 *
 * FAIL-CLOSED GOVERNANCE (the §7 red-team invariants — proven in tier-hiring.test.ts):
 *   • operatorConfirmed !== true                  → TierGateError (NO auto-swap, D-039).
 *   • proposal not a tier_change / missing         → TierGateError / WorkforceInputError.
 *   • NO passing interview at (incumbent.prompt_sha × target model_id) → TierGateError. THIS
 *     is the STRICT GATE: the swap is refused unless resolveTierChangeGate reports
 *     'ready_to_swap'. No waiver path exists; the cert is NEVER inherited across tiers.
 *
 * The pointer write (role.preferred_tier) + the role_event are ONE transaction (F-015). The
 * change is OPERATING-TIER only — it does NOT touch role.active_version (the incumbent version
 * is unchanged; only the tier it runs at moves), and resolveStaff/resolveRoute re-derive the
 * model fresh at spawn from the new preferred_tier (§6).
 *
 * INTERRUPT CONTRACT: an already-'swapped' proposal is absorbed (re-read + return) rather than
 * double-applied.
 */
export async function swapTierChange(
	db: Db,
	input: SwapTierChangeInput,
	resolveTierModel: TierModelResolver
): Promise<SwapTierChangeResult> {
	if (input.operatorConfirmed !== true) {
		throw new TierGateError(
			`swapTierChange requires an explicit operator D-039 confirm — there is NO auto-swap path; the operator IS the tier authority (§7/D-039)`
		);
	}
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (proposal.kind !== 'tier_change') {
		throw new TierGateError(
			`proposal ${proposal.id} is kind '${proposal.kind}', not 'tier_change' — swapTierChange refuses it`
		);
	}
	if (!proposal.incumbent) {
		throw new WorkforceInputError(`tier_change proposal ${proposal.id} has no incumbent version`);
	}
	const targetTier = readTargetTier(proposal);
	if (!targetTier) {
		throw new WorkforceInputError(
			`tier_change proposal ${proposal.id} carries no valid trigger.target_tier`
		);
	}

	// INTERRUPT CONTRACT: already swapped → absorb (idempotent).
	if (proposal.status === 'swapped') {
		const role = await getRole(db, proposal.role);
		if (!role) throw new WorkforceInputError(`role not found: ${proposal.role}`);
		return { role, proposal, tier: targetTier };
	}

	// THE STRICT GATE (§7): refuse the swap unless a PASSING (incumbent.prompt_sha × target
	// model_id) interview exists RIGHT NOW. resolveTierChangeGate is the single source of truth.
	const gate = await resolveTierChangeGate(db, proposal.id, resolveTierModel);
	if (gate.state !== 'ready_to_swap') {
		throw new TierGateError(
			`tier_change to '${targetTier}' is NOT swappable: ${gate.message} — a swap requires a passing interview at (incumbent.prompt_sha × the target tier's model_id) (§7 STRICT, no waiver)`
		);
	}

	// §7 requires the proposal to have reached the operator-decide stage. tier_change skips the
	// challenger-authoring + comparison of a prompt_revision; the legal terminal-decide statuses
	// are 'compared' (after a gate interview that drove it there) OR the operator-direct stages
	// 'proposed'/'validated'/'diff_review'/'interviewing'. The swap is the terminal act; we move
	// straight to 'swapped' from whatever open status it sits in, transition-checked by the
	// status machine — an illegal jump (e.g. already terminal-rejected) throws a named error.
	const role = await getRole(db, proposal.role);
	if (!role) throw new WorkforceInputError(`role not found: ${proposal.role}`);

	// The tier swap: set role.preferred_tier + role_event{op:'tier_changed'} in ONE transaction
	// (F-015 — assume it can die mid-apply; the transaction makes it atomic).
	const rid = new StringRecordId(assertRecordId(role.id));
	const vid = new StringRecordId(assertRecordId(proposal.incumbent));
	await db.query(
		`BEGIN;
		 UPDATE $rid SET preferred_tier = $tier, updated_at = time::now();
		 CREATE role_event CONTENT {
			role: $rid, role_version: $vid, op: 'tier_changed',
			detail: { from: $from, to: $tier, model_id: $model, certified_by: $cert,
			          proposal: $pstr, operator_confirmed: true }
		 };
		 COMMIT;`,
		{
			rid,
			vid,
			tier: targetTier,
			from: role.preferred_tier ?? null,
			model: gate.targetModelId,
			cert: gate.certifiedBy,
			pstr: proposal.id
		}
	);
	const moved = await closeProposalSwapped(db, proposal);
	const after = await getRole(db, role.id);
	if (!after) throw new WorkforceInputError(`role vanished mid tier-swap: ${role.id}`);
	return { role: after, proposal: moved, tier: targetTier };
}

/**
 * Close a tier_change proposal as 'swapped' regardless of which open status it sits in. The §5
 * status machine only allows compared→swapped; a tier_change reaches the swap from earlier
 * open stages (it has no challenger/comparison), so we walk it through the legal intermediate
 * hops (→ diff_review → interviewing → compared → swapped) — each transition-checked. Every hop
 * is idempotent-absorbing (setProposalStatus no-ops on the same status), so a crash mid-walk
 * re-runs clean (interrupt contract).
 */
async function closeProposalSwapped(
	db: Db,
	proposal: ReviewProposalRow
): Promise<ReviewProposalRow> {
	const path: Array<'diff_review' | 'interviewing' | 'compared' | 'swapped'> = [];
	switch (proposal.status) {
		case 'proposed':
		case 'validated':
			path.push('diff_review', 'interviewing', 'compared', 'swapped');
			break;
		case 'diff_review':
			path.push('interviewing', 'compared', 'swapped');
			break;
		case 'interviewing':
			path.push('compared', 'swapped');
			break;
		case 'compared':
			path.push('swapped');
			break;
		default:
			// Terminal or unknown — let setProposalStatus throw the named transition error.
			path.push('swapped');
	}
	let row = proposal;
	for (const to of path) row = await setProposalStatus(db, row.id, { to });
	return row;
}
