// WORKFORCE-SPEC §5 — the OPERATOR-GATED RESOLUTION half of the performance-review
// loop, on top of V2.3-02a's auto-raised proposals (drift.ts). V2.3-02a opens a
// review_proposal{status:'proposed', trigger, evidence}; THIS module is everything that
// happens AFTER, every step operator-gated (D-010 diff + D-039 swap authority):
//
//   ① AUTHOR CHALLENGER (D-010 diff ceremony) — the operator reviews the incumbent-vs-
//      challenger prompt-core DIFF and, on approval, the challenger prompt_core becomes a
//      NEW role_version (createRoleVersion — fresh prompt_sha, source='pm_proposal',
//      proposal=<this>). The proposal moves proposed/validated → diff_review → interviewing
//      and is stamped with the challenger. SECURITY BEFORE SPEND (§5): the diff is approved
//      BEFORE the gauntlet executes the candidate text.
//   ② RE-GAUNTLET — the challenger runs the EXISTING gauntlet runner (runGauntlet, NOT a
//      fork) at the INCUMBENT'S certified (tier × model_id) — apples-to-apples; the
//      comparison (challenger vs incumbent: recall / FP / cost delta) is recorded into
//      review_proposal.comparison; the proposal moves → 'compared'.
//   ③ SWAP (operator-gated, D-039) — the operator confirms the swap; the challenger
//      becomes the role's active/launch version (swapActiveVersion — ONE pointer write +
//      role_event{op:'swap', operator_confirmed:true}); the proposal closes status='swapped'
//      + decided_at. A REJECT closes 'rejected_by_operator' + feeds the V2.3-02a cooldown.
//
// THE GOVERNANCE INVARIANTS (proven by resolution.test.ts — the red-team):
//   • NO code path swaps a role version without (a) an explicit operator D-039 confirm AND
//     (b) a PASSING challenger gauntlet run AT the incumbent's certified (prompt_sha ×
//     model_id). swapFromProposal is the SOLE swap entry from a proposal; it fail-closes on
//     a missing confirm, a non-'compared' proposal, OR a challenger whose own deployability
//     does not positively prove a pass (§2.4 — the challenger EARNS its own cert; it never
//     inherits the incumbent's).
//   • THE DIFF SHOWN MATCHES THE ACTUAL prompt_core delta (no forgery): proposalDiff reads
//     the REAL incumbent.prompt_core and the operator-supplied challenger text and computes
//     the line delta over THEM — there is no separate stored "diff" the swap trusts. The
//     challenger row's prompt_core IS the text the operator approved (content-immutable,
//     §2.1), and the re-gauntlet certifies THAT prompt_sha.
//   • D-026: every operator/agent-supplied text (the challenger prompt_core, the reject
//     reason) is SCREENED at the boundary before it is stored or shown.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { screen } from '../memory/screen';
import { checkDeployability } from './deployability';
import {
	addRoleEvent,
	createRoleVersion,
	getReviewProposal,
	getRole,
	getRoleVersion,
	listOpenProposals,
	setProposalStatus,
	swapActiveVersion,
	WorkforceInputError,
	type ReviewProposalRow,
	type RoleVersionRow,
	type Tier
} from './repo';
import { runGauntlet, type GauntletDeps, type GauntletOutcome } from './gauntlet';

// ── Named errors (every error has a name; the message names what triggered it) ──────

/** A §5 governance gate violation — a missing operator confirm, a proposal in the wrong
 *  status for the requested act, a challenger that has not earned its own cert. Fail loud,
 *  fail closed; the route maps it to a 400 (operator-facing), never a silent proceed. */
export class ResolutionGateError extends Error {
	override readonly name = 'ResolutionGateError';
}

// ── The prompt-core DIFF (D-010 ceremony substrate — §5 touch ①) ────────────────────

export interface DiffLine {
	/** 'context' (unchanged), 'add' (challenger only), 'del' (incumbent only). */
	op: 'context' | 'add' | 'del';
	text: string;
}

export interface ProposalDiff {
	proposal: string;
	role: string;
	roleSlug: string;
	/** The incumbent version the challenger would replace; null = no incumbent (a fresh
	 *  role with no active version — the diff is then "all-add"). */
	incumbent: string | null;
	incumbentVersion: number | null;
	/** The incumbent's prompt_core (the diff's LEFT side); '' when no incumbent. */
	incumbentPromptCore: string;
	/** The challenger prompt_core the operator is authoring (the diff's RIGHT side). When
	 *  the challenger has already been authored (post-diff_review) this is its STORED text;
	 *  pre-authoring it is the draft the operator supplies to authorChallenger. */
	challengerPromptCore: string | null;
	/** The challenger version row id once authored; null while still being drafted. */
	challenger: string | null;
	/** The line-level delta over (incumbent, challenger). Empty until a challenger text
	 *  exists to diff against. */
	lines: DiffLine[];
	/** Honest summary counts for the brief (added / removed / unchanged lines). */
	added: number;
	removed: number;
	unchanged: number;
}

/**
 * A minimal, deterministic line-level diff (LCS over lines) — enough for the operator to
 * see exactly what the challenger changes vs the incumbent. NOT a git-grade diff; it is the
 * honest delta the D-010 ceremony shows. Pure (no IO) so it is unit-testable and the surface
 * and the swap both compute it from the SAME real text (no separate forgeable "diff" blob).
 */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.length === 0 ? [] : before.split('\n');
	const b = after.length === 0 ? [] : after.split('\n');
	// LCS table (bounded — prompt cores are small; cap defensively at 2000 lines each).
	const A = a.slice(0, 2000);
	const B = b.slice(0, 2000);
	const n = A.length;
	const m = B.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (A[i] === B[j]) {
			out.push({ op: 'context', text: A[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			out.push({ op: 'del', text: A[i] });
			i++;
		} else {
			out.push({ op: 'add', text: B[j] });
			j++;
		}
	}
	while (i < n) out.push({ op: 'del', text: A[i++] });
	while (j < m) out.push({ op: 'add', text: B[j++] });
	return out;
}

/**
 * §5 touch ① substrate: the read-only diff data for the operator's D-010 prompt-core review.
 * Reads the REAL incumbent.prompt_core (the diff's left side). When the challenger has not
 * been authored yet, pass `draftChallenger` to preview the delta; once authored, the stored
 * challenger.prompt_core is used (the text the re-gauntlet will certify) — so the diff the
 * operator confirms and the text that gets certified are the SAME bytes (no forgery).
 *
 * Throws WorkforceInputError when the proposal/role/version do not exist (a diff for a
 * missing artifact is a caller bug, not an empty state).
 */
export async function proposalDiff(
	db: Db,
	proposalId: string,
	draftChallenger?: string
): Promise<ProposalDiff> {
	const proposal = await getReviewProposal(db, proposalId);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${proposalId}`);
	const role = await getRole(db, proposal.role);
	if (!role) throw new WorkforceInputError(`role not found: ${proposal.role}`);

	let incumbentPromptCore = '';
	let incumbentVersion: number | null = null;
	if (proposal.incumbent) {
		const inc = await getRoleVersion(db, proposal.incumbent);
		if (inc) {
			incumbentPromptCore = inc.prompt_core;
			incumbentVersion = inc.version;
		}
	}

	// Prefer the STORED challenger text (post-authoring) over a draft preview — the stored
	// text is the certified one; a draft only previews before authoring.
	let challengerPromptCore: string | null = null;
	if (proposal.challenger) {
		const chal = await getRoleVersion(db, proposal.challenger);
		if (chal) challengerPromptCore = chal.prompt_core;
	} else if (draftChallenger !== undefined) {
		challengerPromptCore = draftChallenger;
	}

	const lines = challengerPromptCore !== null ? diffLines(incumbentPromptCore, challengerPromptCore) : [];
	let added = 0;
	let removed = 0;
	let unchanged = 0;
	for (const l of lines) {
		if (l.op === 'add') added++;
		else if (l.op === 'del') removed++;
		else unchanged++;
	}
	return {
		proposal: proposal.id,
		role: role.id,
		roleSlug: role.slug,
		incumbent: proposal.incumbent,
		incumbentVersion,
		incumbentPromptCore,
		challengerPromptCore,
		challenger: proposal.challenger,
		lines,
		added,
		removed,
		unchanged
	};
}

// ── Step ① — AUTHOR/APPROVE the challenger (D-010 diff ceremony) ────────────────────

export interface AuthorChallengerInput {
	proposal: string;
	/** The operator-approved challenger prompt_core (the diff's right side). REQUIRED,
	 *  non-empty — SCREENED (D-026) before it is stored. */
	promptCore: string;
	/** The challenger's default tier; defaults to the incumbent's default_tier so the
	 *  re-gauntlet runs apples-to-apples at the incumbent's tier. */
	defaultTier?: Tier;
	/** Optional capability bundle override; defaults to the incumbent's capabilities (a
	 *  prompt revision keeps the same toolkit unless the operator changes it). */
	capabilities?: Record<string, unknown>;
	/** The operator's explicit D-010 confirm of the diff. REQUIRED true — fail-closed. */
	operatorConfirmed: boolean;
}

export interface AuthorChallengerResult {
	challenger: RoleVersionRow;
	proposal: ReviewProposalRow;
	/** false when the challenger already existed (idempotent absorb — interrupt contract). */
	created: boolean;
	/** D-026: redaction reasons applied to the stored prompt_core (empty when clean). */
	screened: string[];
}

/**
 * §5 touch ① WRITE-PATH: the operator approved the D-010 diff → author the challenger as a
 * NEW role_version (createRoleVersion: fresh prompt_sha computed mechanically — D-035;
 * source='pm_proposal'; proposal=<this>; lifecycle 'draft' — UNCERTIFIED, it must EARN its
 * own gauntlet pass). The proposal moves to 'interviewing' (the diff is approved; the
 * re-gauntlet is the next step) and is stamped with the challenger.
 *
 * FAIL-CLOSED GATES (named):
 *   • operatorConfirmed !== true            → ResolutionGateError (the diff ceremony has
 *     not happened — draft text stays fenced as DATA, §5/D-026).
 *   • proposal not found / not a prompt_revision / already has a challenger / wrong status
 *                                            → WorkforceInputError / ResolutionGateError.
 *   • empty prompt_core                      → WorkforceInputError (createRoleVersion guard).
 *
 * D-026: the prompt_core is SCREENED before storage; a quarantine-class hit (prompt
 * injection / credential) is REFUSED (the challenger text would carry a live attack), a
 * redaction-class hit is stored screened with the reasons surfaced.
 *
 * INTERRUPT CONTRACT: if the proposal already carries a challenger (a prior run authored it
 * then crashed before the status flip), this re-reads + returns it (created:false) and
 * re-asserts the status — never a second challenger version.
 */
export async function authorChallenger(
	db: Db,
	input: AuthorChallengerInput
): Promise<AuthorChallengerResult> {
	if (input.operatorConfirmed !== true) {
		throw new ResolutionGateError(
			`authorChallenger requires an explicit operator confirm — the §5 D-010 prompt-core diff is operator-gated (until approved, the draft is fenced as DATA, D-026)`
		);
	}
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (proposal.kind !== 'prompt_revision') {
		throw new ResolutionGateError(
			`proposal ${proposal.id} is kind '${proposal.kind}', not 'prompt_revision' — only a prompt revision authors a challenger prompt_core (§5)`
		);
	}

	// INTERRUPT CONTRACT: a challenger already authored (prior partial run) is absorbed.
	if (proposal.challenger) {
		const existing = await getRoleVersion(db, proposal.challenger);
		if (!existing) {
			throw new WorkforceInputError(
				`proposal ${proposal.id} references challenger ${proposal.challenger} which does not exist — data corruption`
			);
		}
		// Ensure the status reflects the authored challenger (idempotent re-assert).
		const moved =
			proposal.status === 'interviewing'
				? proposal
				: await setProposalStatus(db, proposal.id, { to: 'interviewing', challenger: existing.id });
		return { challenger: existing, proposal: moved, created: false, screened: [] };
	}

	// D-026 — screen the operator-supplied prompt_core. A quarantine-class hit is refused.
	const screened = screen(input.promptCore ?? '');
	if (screened.status === 'quarantined') {
		throw new WorkforceInputError(
			`challenger prompt_core failed the D-026 screen (${screened.reasons.join(', ')}) — refusing to store a challenger carrying a quarantine-class payload (§5/D-026)`
		);
	}
	const promptCore = screened.text;
	if (!promptCore.trim()) {
		throw new WorkforceInputError(
			`challenger prompt_core is empty after screening — the methodology text IS the product row (§2.1)`
		);
	}

	// Default tier + capabilities from the incumbent so the re-gauntlet runs apples-to-apples.
	let defaultTier: Tier = input.defaultTier ?? 'sonnet';
	let capabilities = input.capabilities;
	if (proposal.incumbent) {
		const inc = await getRoleVersion(db, proposal.incumbent);
		if (inc) {
			if (input.defaultTier === undefined) defaultTier = inc.default_tier;
			if (input.capabilities === undefined) capabilities = inc.capabilities;
		}
	}

	// The §5 legal moves into 'interviewing': from diff_review (PM path, post-diff approval)
	// OR from proposed/validated (operator-authored path skips the panel — the operator IS
	// the author, §5). We drive the status to 'diff_review' first when needed, then
	// 'interviewing' — every hop transition-checked by setProposalStatus.
	if (proposal.status !== 'diff_review' && proposal.status !== 'interviewing') {
		// proposed | validated → diff_review (open the diff). Illegal from any other status
		// (e.g. compared/swapped) → ProposalStatusError, fail closed.
		await setProposalStatus(db, proposal.id, { to: 'diff_review' });
	}

	const challenger = await createRoleVersion(db, {
		role: proposal.role,
		prompt_core: promptCore,
		...(capabilities !== undefined ? { capabilities } : {}),
		default_tier: defaultTier,
		source: 'pm_proposal',
		proposal: proposal.id
	});

	const moved = await setProposalStatus(db, proposal.id, {
		to: 'interviewing',
		challenger: challenger.id
	});

	await addRoleEvent(db, {
		role: proposal.role,
		role_version: challenger.id,
		op: 'created',
		detail: {
			challenger_of: proposal.incumbent ?? null,
			proposal: proposal.id,
			source: 'pm_proposal',
			operator_confirmed: true,
			screened: screened.reasons
		}
	});

	return { challenger, proposal: moved, created: true, screened: screened.reasons };
}

// ── Resolve the re-gauntlet target = the incumbent's certified (tier × model_id) ─────

export interface RegauntletTarget {
	tier: Tier;
	provider: string;
	modelId: string;
	/** The incumbent's certifying run this target was read from (provenance). */
	certifiedBy: string;
}

/**
 * §5: the re-gauntlet runs at the INCUMBENT'S certified (tier × model_id) so the comparison
 * is apples-to-apples. Resolve it from the incumbent's most-recent PASSING run whose prompt_sha
 * matches the incumbent's current text (the certification axis, §2.4). Returns null with a named
 * reason when there is no incumbent or no certifying run (the route surfaces it — never a guessed
 * model to spend on, F-008).
 */
export async function resolveRegauntletTarget(
	db: Db,
	proposalId: string
): Promise<{ ok: true; target: RegauntletTarget } | { ok: false; reason: string }> {
	const proposal = await getReviewProposal(db, proposalId);
	if (!proposal) return { ok: false, reason: `review_proposal not found: ${proposalId}` };
	if (!proposal.incumbent) {
		return {
			ok: false,
			reason: 'proposal has no incumbent — no certified (tier × model_id) to re-gauntlet at (§5)'
		};
	}
	const inc = await getRoleVersion(db, proposal.incumbent);
	if (!inc) return { ok: false, reason: `incumbent ${proposal.incumbent} not found` };
	const vid = new StringRecordId(assertRecordId(inc.id));
	const [rows] = await db.query<[Array<{ tier: string; provider: string; model_id: string; id: unknown }>]>(
		// `started_at` MUST appear in the projection to be an ORDER BY idiom (SurrealDB 2.x —
		// "Missing order idiom" parse error otherwise; F-020). It is not otherwise read here.
		`SELECT id, tier, provider, model_id, started_at FROM interview_run
		  WHERE role_version = $vid AND status = 'passed' AND prompt_sha = $sha
		  ORDER BY started_at DESC LIMIT 1;`,
		{ vid, sha: inc.prompt_sha }
	);
	const r = rows?.[0];
	if (!r) {
		return {
			ok: false,
			reason: `incumbent v${inc.version} has no passing interview at its current prompt_sha — cannot resolve a certified (tier × model_id) to re-gauntlet the challenger at (§5)`
		};
	}
	return {
		ok: true,
		target: {
			tier: r.tier as Tier,
			provider: r.provider,
			modelId: r.model_id,
			certifiedBy: String(r.id)
		}
	};
}

// ── Step ② — RE-GAUNTLET the challenger + record the comparison (§5) ─────────────────

export interface RegauntletInput {
	proposal: string;
	/** The (tier, provider, model_id) to interview the challenger at. §5: this MUST be the
	 *  incumbent's certified (tier × model_id) for an apples-to-apples comparison; the caller
	 *  (route) resolves it from the incumbent's certifying run. */
	tier: Tier;
	provider: string;
	modelId: string;
	/** Operator spend authority (§3.7): 'operator' bypasses the budget gate (the click IS the
	 *  decision); 'auto' must pass checkInterviewBudget or queues. The re-gauntlet's real cost
	 *  is the proposal's cost (§7); default 'operator'. */
	trigger?: 'operator' | 'auto';
}

/** The §5 comparison object stored on review_proposal.comparison. Every field honest. */
export interface ProposalComparison {
	/** §5: comparable:true ONLY when both runs share fixture_set_sha AND model_id. */
	comparable: boolean;
	/** Why not comparable, when comparable:false (named). */
	incomparableReason: string | null;
	challenger: {
		run: string;
		status: string;
		modelId: string;
		recall: number | null;
		falsePositives: number;
		costUsd: number | null;
		fixtureSetSha: string | null;
	};
	/** The incumbent's certifying run, when one exists at the same (tier × model_id). null
	 *  asymmetry stated (§5): incumbent has a field record, challenger has gauntlet only. */
	incumbent: {
		run: string;
		modelId: string;
		recall: number | null;
		falsePositives: number;
		costUsd: number | null;
		fixtureSetSha: string | null;
	} | null;
	/** challenger − incumbent on the surfaced columns; null when not comparable. */
	delta: { recall: number | null; falsePositives: number | null; costUsd: number | null } | null;
	at: string;
}

export interface RegauntletResult {
	outcome: GauntletOutcome;
	proposal: ReviewProposalRow;
	comparison: ProposalComparison | null;
}

interface IncumbentRunRow {
	id: unknown;
	model_id: string;
	planted_total: number;
	planted_found: number;
	false_positives: number;
	cost_usd: number | null;
	fixture_set_sha: string;
	started_at: unknown;
}

function recallOf(found: number, total: number): number | null {
	return total > 0 ? found / total : null;
}

/**
 * §5 touch ② WRITE-PATH: run the challenger through the EXISTING gauntlet (runGauntlet — NOT
 * a fork) at the incumbent's certified (tier × model_id), then record the comparison
 * (challenger vs incumbent: recall / FP / cost delta) into review_proposal.comparison and
 * move the proposal → 'compared'.
 *
 * The proposal MUST be in 'interviewing' (the challenger authored, the diff approved) — a
 * re-gauntlet on a proposal that has not passed the diff ceremony is refused (fail closed).
 * The challenger EARNS its own pass; nothing here certifies it on the incumbent's cert — the
 * runner writes a real interview_run that the §2.4 resolver reads at swap time.
 *
 * COMPARISON HONESTY (§5): comparable:true ONLY when the challenger run and the incumbent's
 * certifying run share BOTH fixture_set_sha AND model_id; otherwise comparable:false + the
 * named reason, and delta is null (the asymmetry is stated, never a projected number).
 *
 * A queued outcome (budget-unarmed under trigger:'auto') records NO comparison and leaves the
 * proposal in 'interviewing' (honest — the run did not happen); the operator path uses
 * trigger:'operator' (the click IS the budget decision).
 */
export async function regauntletChallenger(
	deps: GauntletDeps,
	input: RegauntletInput
): Promise<RegauntletResult> {
	const { db } = deps;
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (!proposal.challenger) {
		throw new ResolutionGateError(
			`proposal ${proposal.id} has no challenger — author the challenger (approve the D-010 diff) before the re-gauntlet (§5)`
		);
	}
	if (proposal.status !== 'interviewing') {
		throw new ResolutionGateError(
			`proposal ${proposal.id} is status '${proposal.status}', not 'interviewing' — the re-gauntlet runs only after the diff is approved + the challenger authored (§5)`
		);
	}

	const outcome = await runGauntlet(deps, {
		roleVersionId: proposal.challenger,
		tier: input.tier,
		provider: input.provider,
		modelId: input.modelId,
		trigger: input.trigger ?? 'operator'
	});

	// A queued outcome (auto + unarmed budget) did not run — record nothing, stay 'interviewing'.
	if (outcome.kind === 'queued') {
		return { outcome, proposal, comparison: null };
	}

	const run = outcome.run;
	// The incumbent's certifying run at THIS (model_id) for the comparison baseline — the
	// latest passing run at the same model_id, prompt_sha matching the incumbent's text.
	let incumbentRun: IncumbentRunRow | null = null;
	if (proposal.incumbent) {
		const inc = await getRoleVersion(db, proposal.incumbent);
		if (inc) {
			const vid = new StringRecordId(assertRecordId(inc.id));
			const [rows] = await db.query<[IncumbentRunRow[]]>(
				`SELECT id, model_id, planted_total, planted_found, false_positives, cost_usd,
				        fixture_set_sha, started_at
				   FROM interview_run
				  WHERE role_version = $vid AND status = 'passed' AND model_id = $model
				        AND prompt_sha = $sha
				  ORDER BY started_at DESC LIMIT 1;`,
				{ vid, model: input.modelId, sha: inc.prompt_sha }
			);
			incumbentRun = rows?.[0] ?? null;
		}
	}

	const comparison = buildComparison(run, incumbentRun);
	const moved = await setProposalStatus(db, proposal.id, {
		to: 'compared',
		comparison: comparison as unknown as Record<string, unknown>
	});
	return { outcome, proposal: moved, comparison };
}

/** Compose the §5 comparison object from the challenger's run + the incumbent's baseline. */
function buildComparison(
	run: {
		id: string;
		status: string;
		model_id: string;
		planted_found: number;
		planted_total: number;
		false_positives: number;
		cost_usd: number | null;
		fixture_set_sha: string;
	},
	incumbentRun: IncumbentRunRow | null
): ProposalComparison {
	const chalRecall = recallOf(run.planted_found, run.planted_total);
	const challenger = {
		run: run.id,
		status: run.status,
		modelId: run.model_id,
		recall: chalRecall,
		falsePositives: run.false_positives,
		costUsd: run.cost_usd,
		fixtureSetSha: run.fixture_set_sha || null
	};
	if (!incumbentRun) {
		return {
			comparable: false,
			incomparableReason:
				'no incumbent certifying run at this (tier × model_id) — challenger has gauntlet evidence only (§5 asymmetry)',
			challenger,
			incumbent: null,
			delta: null,
			at: new Date().toISOString()
		};
	}
	const incRecall = recallOf(incumbentRun.planted_found, incumbentRun.planted_total);
	const incumbent = {
		run: String(incumbentRun.id),
		modelId: incumbentRun.model_id,
		recall: incRecall,
		falsePositives: incumbentRun.false_positives,
		costUsd: typeof incumbentRun.cost_usd === 'number' ? incumbentRun.cost_usd : null,
		fixtureSetSha: incumbentRun.fixture_set_sha || null
	};
	// §5: comparable ONLY when both share fixture_set_sha AND model_id.
	const comparable =
		!!challenger.fixtureSetSha &&
		challenger.fixtureSetSha === incumbent.fixtureSetSha &&
		challenger.modelId === incumbent.modelId;
	if (!comparable) {
		const why = !challenger.fixtureSetSha
			? 'challenger run has no fixture_set_sha'
			: challenger.fixtureSetSha !== incumbent.fixtureSetSha
				? 'fixture pool differs between the runs (different fixture_set_sha)'
				: 'model_id differs between the runs';
		return {
			comparable: false,
			incomparableReason: `${why} — recall/FP/cost are not apples-to-apples (§5)`,
			challenger,
			incumbent,
			delta: null,
			at: new Date().toISOString()
		};
	}
	return {
		comparable: true,
		incomparableReason: null,
		challenger,
		incumbent,
		delta: {
			recall: chalRecall !== null && incRecall !== null ? chalRecall - incRecall : null,
			falsePositives: challenger.falsePositives - incumbent.falsePositives,
			costUsd:
				challenger.costUsd !== null && incumbent.costUsd !== null
					? challenger.costUsd - incumbent.costUsd
					: null
		},
		at: new Date().toISOString()
	};
}

// ── Step ③ — SWAP (operator-gated, D-039) / REJECT ──────────────────────────────────

export interface SwapFromProposalInput {
	proposal: string;
	/** The challenger's resolved model_id — the swap re-checks the challenger's §2.4
	 *  deployability at THIS model before pointing incumbency at it (fail closed). MUST be
	 *  the model the challenger's gauntlet passed at. */
	modelId: string;
	/** The operator's explicit D-039 swap confirm. REQUIRED true — fail-closed, no auto-swap. */
	operatorConfirmed: boolean;
}

export interface SwapFromProposalResult {
	/** The role after the pointer write (active_version now the challenger). */
	role: Awaited<ReturnType<typeof getRole>>;
	proposal: ReviewProposalRow;
	/** The challenger that took incumbency. */
	challenger: RoleVersionRow;
}

/**
 * §5 touch ② / D-039 WRITE-PATH — the SOLE swap-from-proposal entry. The operator confirms;
 * the challenger becomes the role's active version (swapActiveVersion: ONE pointer write +
 * role_event{op:'swap', operator_confirmed:true}) and the proposal closes 'swapped' +
 * decided_at.
 *
 * FAIL-CLOSED GOVERNANCE (the red-team invariants — proven in resolution.test.ts):
 *   • operatorConfirmed !== true   → ResolutionGateError (NO auto-swap path exists, D-039).
 *   • proposal not 'compared'      → ResolutionGateError (a swap before the re-gauntlet ran +
 *     comparison recorded is refused — the heavy diff + the gauntlet must have happened, §5).
 *   • challenger missing            → WorkforceInputError.
 *   • challenger NOT deployable at $modelId (§2.4: no passing interview at prompt_sha ×
 *     model_id) → ResolutionGateError. THIS is the "earns its own cert" guard: the challenger
 *     is never activated on the incumbent's cert. swapActiveVersion ALSO re-asserts lifecycle
 *     'passed' (defense in depth). Together: no swap without a passing challenger gauntlet AND
 *     an operator D-039 confirm.
 *
 * INTERRUPT CONTRACT: if the proposal is already 'swapped' (a prior run swapped then crashed
 * before responding), re-read + return the current role/challenger (idempotent absorb) rather
 * than erroring or double-swapping.
 */
export async function swapFromProposal(
	db: Db,
	input: SwapFromProposalInput
): Promise<SwapFromProposalResult> {
	if (input.operatorConfirmed !== true) {
		throw new ResolutionGateError(
			`swapFromProposal requires an explicit operator D-039 confirm — there is NO auto-swap path; the operator IS the swap authority (§5/D-039)`
		);
	}
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	if (!proposal.challenger) {
		throw new WorkforceInputError(`proposal ${proposal.id} has no challenger to swap in`);
	}
	const challenger = await getRoleVersion(db, proposal.challenger);
	if (!challenger) {
		throw new WorkforceInputError(`challenger ${proposal.challenger} not found — data corruption`);
	}

	// INTERRUPT CONTRACT: already swapped → absorb (idempotent).
	if (proposal.status === 'swapped') {
		const role = await getRole(db, proposal.role);
		return { role, proposal, challenger };
	}

	if (proposal.status !== 'compared') {
		throw new ResolutionGateError(
			`proposal ${proposal.id} is status '${proposal.status}', not 'compared' — the swap is the FINAL step; the re-gauntlet must have run + the comparison recorded first (§5: no swap without a passing challenger gauntlet)`
		);
	}

	// THE "earns its own cert" GUARD (§5 red-team): the challenger must positively prove a
	// passing interview at THIS (prompt_sha × model_id) — never inheriting the incumbent's.
	const verdict = await checkDeployability(db, challenger.id, input.modelId);
	if (!verdict.deployable) {
		throw new ResolutionGateError(
			`challenger v${challenger.version} is NOT deployable at ${input.modelId}: ${verdict.reason} — a swap requires the challenger's OWN passing gauntlet (§2.4/§5); it never inherits the incumbent's cert`
		);
	}

	// The swap: swapActiveVersion re-asserts lifecycle 'passed' + cross-role identity (defense
	// in depth) and writes the pointer + role_event{op:'swap', operator_confirmed:true} atomically.
	const role = await swapActiveVersion(db, proposal.role, challenger.id);
	const moved = await setProposalStatus(db, proposal.id, { to: 'swapped' });
	return { role, proposal: moved, challenger };
}

export interface RejectProposalInput {
	proposal: string;
	/** Operator-supplied reason — SCREENED (D-026) before storage; surfaced + feeds cooldown. */
	reason?: string;
	/** Which terminal rejection: 'operator' (post-anything operator reject) or 'withdrawn'
	 *  (the PM/operator pulls the proposal). Default 'operator'. */
	as?: 'operator' | 'withdrawn';
}

export interface RejectProposalResult {
	proposal: ReviewProposalRow;
	/** D-026 redaction reasons applied to the stored reason (empty when clean/absent). */
	screened: string[];
}

/**
 * §5 — REJECT/WITHDRAW a proposal: closes it terminally ('rejected_by_operator' by default,
 * or 'withdrawn') with the operator's reason (SCREENED, D-026), stamps decided_at, and feeds
 * the V2.3-02a cooldown (drift.ts re-reads the rejection instant via decided_at and holds the
 * (role,kind) slot for the cooldown window — no extra write needed; the terminal row IS the
 * cooldown anchor). Records a role_event for the audit feed.
 *
 * Legal from any pre-terminal status (the operator may reject at the panel, the diff, or after
 * the comparison). A terminal proposal absorbs idempotently (interrupt contract).
 */
export async function rejectProposal(
	db: Db,
	input: RejectProposalInput
): Promise<RejectProposalResult> {
	const proposal = await getReviewProposal(db, input.proposal);
	if (!proposal) throw new WorkforceInputError(`review_proposal not found: ${input.proposal}`);
	const to: ProposalTerminalReject = input.as === 'withdrawn' ? 'withdrawn' : 'rejected_by_operator';

	// D-026 — screen the operator reason before it is stored/surfaced.
	let reasons: string[] = [];
	let storedReason: string | undefined;
	if (input.reason && input.reason.trim()) {
		const s = screen(input.reason);
		reasons = s.reasons;
		storedReason = s.status === 'quarantined' ? '[reason redacted — D-026 quarantine]' : s.text;
	}

	// INTERRUPT CONTRACT: already terminal → absorb (return current row).
	if (
		proposal.status === 'swapped' ||
		proposal.status === 'rejected_by_operator' ||
		proposal.status === 'rejected_by_panel' ||
		proposal.status === 'withdrawn'
	) {
		return { proposal, screened: reasons };
	}

	const moved = await setProposalStatus(db, proposal.id, { to });
	if (storedReason !== undefined) {
		// Store the screened reason on the trigger object (harness-authored provenance), so the
		// operator's "why" rides alongside the original drift signal and is on record. The id
		// passes the SAME D-016 chokepoint repo.ts uses (assertRecordId via StringRecordId).
		await db.query(`UPDATE $rid SET trigger.reject_reason = $reason;`, {
			rid: new StringRecordId(assertRecordId(proposal.id)),
			reason: storedReason
		});
	}
	// The terminal proposal row (status + decided_at) IS the audit + the V2.3-02a cooldown
	// anchor (drift.ts re-reads decided_at). No role_event op exists for a proposal rejection
	// (the role_event enum is role/version lifecycle ops, not proposal-status ops) — fabricating
	// one ('archived') would lie about the audit class, so the proposal row stands alone (F-008).
	return { proposal: moved, screened: reasons };
}

type ProposalTerminalReject = 'rejected_by_operator' | 'withdrawn';

// ── Surface aggregator — the /agents proposal cards (read-only, null-honest) ─────────

/** The next operator action a proposal is waiting on (the surface renders the matching
 *  control; honest at every stage). */
export type ProposalNextAction =
	| 'review_diff' // proposed/validated: open the D-010 diff + author the challenger
	| 'regauntlet' // diff_review/interviewing(no comparison): run the challenger gauntlet
	| 'decide_swap' // compared: the one-click D-039 swap (or reject)
	| 'closed'; // terminal

/** One open proposal distilled for the surface: the drift evidence (trigger), the diff
 *  summary, the re-gauntlet comparison, and the next-action gate — all honest. */
export interface ProposalCard {
	proposal: string;
	role: string;
	roleSlug: string;
	roleName: string;
	kind: string;
	status: string;
	incumbent: string | null;
	incumbentVersion: number | null;
	challenger: string | null;
	challengerVersion: number | null;
	/** The §4.1 drift provenance (trigger) verbatim — the operator reads it. */
	trigger: Record<string, unknown>;
	/** Diff summary (added/removed/unchanged); null until a challenger text exists. */
	diff: { added: number; removed: number; unchanged: number; lines: DiffLine[] } | null;
	/** The recorded re-gauntlet comparison (§5); null until 'compared'. */
	comparison: Record<string, unknown> | null;
	nextAction: ProposalNextAction;
	createdAt: string | null;
}

function nextActionFor(status: string): ProposalNextAction {
	switch (status) {
		case 'proposed':
		case 'validated':
			return 'review_diff';
		case 'diff_review':
		case 'interviewing':
			return 'regauntlet';
		case 'compared':
			return 'decide_swap';
		default:
			return 'closed';
	}
}

/**
 * Build the surface card for one open proposal: drift evidence + diff + comparison + the
 * next-action gate. Read-only (no writes); reuses proposalDiff (the same real-text diff the
 * ceremony uses — no forgery). The challenger's prompt_core is NEVER returned raw to the
 * surface beyond the diff lines (which are already the operator-authored, screened text).
 */
export async function buildProposalCard(db: Db, proposal: ReviewProposalRow): Promise<ProposalCard> {
	const role = await getRole(db, proposal.role);
	const incumbentVersion = proposal.incumbent
		? ((await getRoleVersion(db, proposal.incumbent))?.version ?? null)
		: null;
	const challengerVersion = proposal.challenger
		? ((await getRoleVersion(db, proposal.challenger))?.version ?? null)
		: null;
	let diff: ProposalCard['diff'] = null;
	if (proposal.challenger) {
		const d = await proposalDiff(db, proposal.id);
		diff = { added: d.added, removed: d.removed, unchanged: d.unchanged, lines: d.lines };
	}
	return {
		proposal: proposal.id,
		role: proposal.role,
		roleSlug: role?.slug ?? proposal.role,
		roleName: role?.name ?? proposal.role,
		kind: proposal.kind,
		status: proposal.status,
		incumbent: proposal.incumbent,
		incumbentVersion,
		challenger: proposal.challenger,
		challengerVersion,
		trigger: proposal.trigger,
		diff,
		comparison: proposal.comparison,
		nextAction: nextActionFor(proposal.status),
		createdAt: proposal.created_at
	};
}

/** §8 — the open-proposals surface feed (the RightTray decisions inbox / /agents/proposals).
 *  Bounded; null-honest; reuses listOpenProposals + buildProposalCard. */
export async function loadProposalCards(db: Db): Promise<ProposalCard[]> {
	const open = await listOpenProposals(db);
	return Promise.all(open.map((p) => buildProposalCard(db, p)));
}
