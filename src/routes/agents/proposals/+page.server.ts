// WORKFORCE-SPEC §5 — the OPERATOR-GATED PROPOSAL RESOLUTION surface (the §8 'Surfaces'
// proposal queue). Lists open review_proposals with the drift evidence, the prompt-core
// DIFF (D-010), the re-gauntlet comparison, and the approve/author / re-gauntlet / swap /
// reject controls — every spending or pointer-moving act operator-gated (D-010/D-039),
// honest empties, live via the existing app:workforce SSE re-invalidation (D-035).
//
// This route is the operator-clickable DRIVER for the resolution.ts MECHANISM — it does NOT
// fork it. Real spend (the re-gauntlet) wires the live Claude Code runtime only on the
// credentialed path (getRuntime → honest 'credential not configured' otherwise, F-008); the
// re-gauntlet target (tier × model_id) is RESOLVED from the incumbent's certifying run
// (resolveRegauntletTarget — never a guessed model). NO auto-swap path exists: the swap goes
// through swapFromProposal which fail-closes on a missing operator confirm AND on a challenger
// that has not earned its own passing gauntlet (§2.4).

import { tryGetDb } from '$lib/server/db/runtime-init';
import { IdentifierError } from '$lib/server/db/validate';
import {
	authorChallenger,
	loadProposalCards,
	proposalDiff,
	ProposalComparisonCollisionError,
	proposeTierChange,
	reconcileProposalFromRun,
	regauntletChallenger,
	rejectProposal,
	resolveRegauntletTarget,
	resolveTierChangeGate,
	ResolutionGateError,
	swapFromProposal,
	swapTierChange,
	TierGateError,
	tierHiringGrid,
	WorkforceInputError,
	type GauntletOutcome,
	type ProposalCard,
	type Tier,
	type TierChangeGate,
	type TierHiringGrid,
	type TierModelResolver
} from '$lib/server/workforce';
import { getRuntime } from '$lib/server/harness';
import { loadAgentPool, loadWorkforce, type AgentPool } from '$lib/server/config';
import { fail, type Actions } from '@sveltejs/kit';
import { isScoredStatus } from '$lib/shared/interview-status';
import type { PageServerLoad } from './$types';

export interface ProposalsPageData {
	connected: boolean;
	proposals: ProposalCard[];
	/** §7 — the tier-hiring grid for each OPEN proposal's incumbent version (null-honest),
	 *  keyed by proposal id; plus, for tier_change proposals, the STRICT gate state. */
	tierGrids: Record<string, TierHiringGrid>;
	tierGates: Record<string, TierChangeGate>;
	/** Honest live-spend availability (F-008): the re-gauntlet needs a real credential. */
	runtimeAvailable: boolean;
	runtimeReason: string | null;
	error?: string;
}

/** Resolve a tier name → {provider, model_id} from agent-pool.yaml (D-003: the tier→model
 *  map lives in config, never hard-coded). Fail-closed: an unknown tier or unreadable config
 *  yields null so the §7 grid/gate render an honest '— (tier unmapped)' rather than a guessed
 *  model. Reads the pool ONCE per request (the caller passes the memoized fn). */
function makeTierResolver(): TierModelResolver {
	let pool: AgentPool | null = null;
	let loaded = false;
	return (tier: Tier) => {
		if (!loaded) {
			loaded = true;
			try {
				pool = loadAgentPool(`${configDir()}/agent-pool.yaml`);
			} catch {
				pool = null;
			}
		}
		const spec = pool?.tiers[tier];
		return spec ? { provider: spec.provider, model_id: spec.model } : null;
	};
}

export const load: PageServerLoad = async ({ depends }): Promise<ProposalsPageData> => {
	// Live off the ONE SSE stream (D-035): a proposal status flip (author/regauntlet/swap/
	// reject) writes review_proposal/role_version/role/role_event rows — all watched on /agents.
	depends('app:workforce');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			proposals: [],
			tierGrids: {},
			tierGates: {},
			runtimeAvailable: false,
			runtimeReason: 'database not connected'
		};
	}
	try {
		const [proposals, runtime] = await Promise.all([loadProposalCards(db), getRuntime(db)]);
		// §7 — per-proposal tier grid (over the incumbent version) + the strict gate for
		// tier_change proposals. Reuses the SAME tier→model resolver (D-003); null-honest on a
		// missing incumbent / unmapped tier — a grid failure for one proposal never sinks the page.
		const resolve = makeTierResolver();
		const tierGrids: Record<string, TierHiringGrid> = {};
		const tierGates: Record<string, TierChangeGate> = {};
		for (const p of proposals) {
			if (!p.incumbent) continue;
			try {
				tierGrids[p.proposal] = await tierHiringGrid(db, p.incumbent, resolve);
			} catch {
				/* a single broken grid is omitted — the surface renders the proposal without it. */
			}
			if (p.kind === 'tier_change') {
				try {
					tierGates[p.proposal] = await resolveTierChangeGate(db, p.proposal, resolve);
				} catch {
					/* a malformed tier_change (no target_tier) omits the gate; surface stays honest. */
				}
			}
		}
		return {
			connected: true,
			proposals,
			tierGrids,
			tierGates,
			runtimeAvailable: runtime.available,
			runtimeReason: runtime.available ? null : runtime.reason
		};
	} catch (err) {
		return {
			connected: false,
			proposals: [],
			tierGrids: {},
			tierGates: {},
			runtimeAvailable: false,
			runtimeReason: null,
			error: (err as Error).message
		};
	}
};

function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}

/** Map a GauntletOutcome (ran | queued) into the named action result the UI renders.
 *  Score keys are gated at the PAYLOAD through the shared terminality rule — see the twin in
 *  `routes/agents/ceremony/+page.server.ts` for the column provenance. Today this page's
 *  markup renders only `status`; emitting an uninitialised `0 FP` anyway is a loaded gun
 *  pointed at whoever adds the next line to the template. */
function outcomeResult(outcome: GauntletOutcome): Record<string, unknown> {
	if (outcome.kind === 'queued') return { queued: true, reason: outcome.reason };
	const run = outcome.run;
	const scored = isScoredStatus(run.status);
	return {
		ran: true,
		run: run.id,
		status: run.status,
		...(run.error_reason ? { errorReason: run.error_reason } : {}),
		...(scored
			? {
					plantedFound: run.planted_found,
					plantedTotal: run.planted_total,
					falsePositives: run.false_positives
				}
			: {}),
		...(run.status === 'adjudicating'
			? { progressFound: run.planted_found, progressTotal: run.planted_total }
			: {}),
		...(run.cost_usd !== null ? { costUsd: run.cost_usd } : {})
	};
}

/**
 * The HTTP status for a CALLER-FACING refusal, or `null` when the throw is a genuine server
 * fault (→ 500). One ladder, shared by every action's catch, because the alternative — each
 * catch listing the classes it happens to know — is what let a whole error class fall through.
 *
 * THE DEFECT THIS CLOSES. Every action's catch listed ResolutionGateError | WorkforceInputError
 * and nothing else, so the D-016 `IdentifierError` that `link()` throws on a malformed record id
 * — the FIRST refusal a hostile or fat-fingered id meets — landed in the 500 branch. The handlers
 * claim every refusal is returned NAMED; a 500 says "this server broke", which is the opposite
 * claim about the same event. (The validator itself is doing its job: the id never reaches
 * SurrealQL. Only the reporting was wrong.)
 */
function refusalStatus(err: unknown): number | null {
	// A second writer already recorded a different comparison — a genuine CONFLICT, not bad input.
	if (err instanceof ProposalComparisonCollisionError) return 409;
	if (err instanceof IdentifierError) return 400;
	if (err instanceof ResolutionGateError || err instanceof WorkforceInputError) return 400;
	return null;
}

export const actions: Actions = {
	// ① PREVIEW the D-010 diff for a draft challenger (read-only; the operator inspects the
	// real incumbent-vs-draft delta BEFORE authoring). No write, no gate.
	previewDiff: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		const draft = String(form.get('promptCore') ?? '');
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		try {
			const diff = await proposalDiff(db, proposal, draft);
			return { proposals: { ok: true, proposal, previewDiff: { lines: diff.lines, added: diff.added, removed: diff.removed, unchanged: diff.unchanged } } };
		} catch (err) {
			if (err instanceof WorkforceInputError) return fail(400, { proposals: { proposal, error: err.message } });
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// ① AUTHOR the challenger (D-010 diff+confirm). The operator approved the prompt-core diff;
	// this records the challenger as a NEW pm_proposal role_version + moves the proposal to
	// 'interviewing'. The confirm checkbox IS the D-010 approval — fail-closed without it.
	author: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		const promptCore = String(form.get('promptCore') ?? '');
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				proposals: { proposal, error: 'confirm the prompt-core diff to author the challenger (the §5 D-010 ceremony is operator-gated; until then the draft is fenced as DATA)' }
			});
		}
		if (!promptCore.trim()) {
			return fail(400, { proposals: { proposal, error: 'the challenger prompt-core text is empty' } });
		}
		try {
			const res = await authorChallenger(db, { proposal, promptCore, operatorConfirmed: true });
			return {
				proposals: {
					ok: true,
					proposal,
					authored: true,
					created: res.created,
					challengerVersion: res.challenger.version,
					...(res.screened.length ? { screened: res.screened } : {})
				}
			};
		} catch (err) {
			return fail(refusalStatus(err) ?? 500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// ② RE-GAUNTLET the challenger (REAL SPEND, operator-gated). Resolves the incumbent's
	// certified (tier × model_id) — apples-to-apples — wires the live runtime (honest reason
	// when no credential), runs the gauntlet, records the comparison, moves to 'compared'. The
	// confirm tick IS the budget decision (trigger='operator'); §3.7 has no auto-spend here.
	regauntlet: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				proposals: { proposal, error: 'confirm the spend — this runs a REAL gauntlet for the challenger at the incumbent’s certified tier/model (the click IS the budget decision, §3.7)' }
			});
		}

		const target = await resolveRegauntletTarget(db, proposal);
		if (!target.ok) {
			return fail(400, { proposals: { proposal, error: target.reason } });
		}

		const runtime = await getRuntime(db);
		if (!runtime.available) {
			return fail(503, { proposals: { proposal, error: runtime.reason } });
		}
		let config;
		try {
			config = loadWorkforce(`${configDir()}/workforce.yaml`);
		} catch (err) {
			return fail(500, { proposals: { proposal, error: `workforce config unreadable: ${(err as Error).message}` } });
		}

		try {
			const res = await regauntletChallenger(
				{ db, runtime: runtime.runtime, config },
				{
					proposal,
					tier: target.target.tier,
					provider: target.target.provider,
					modelId: target.target.modelId,
					trigger: 'operator'
				}
			);
			return {
				proposals: {
					ok: true,
					proposal,
					regauntlet: true,
					comparable: res.comparison?.comparable ?? null,
					// Named on the surface, not swallowed: a non-terminal challenger run records NO
					// comparison and leaves the proposal in 'interviewing' (resolution.ts). Without
					// this the operator saw "Re-gauntlet adjudicating." and no explanation for why
					// the swap stage never appeared.
					incomparableReason: res.comparison?.incomparableReason ?? null,
					...outcomeResult(res.outcome)
				}
			};
		} catch (err) {
			return fail(refusalStatus(err) ?? 500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// ②b RECONCILE (NO SPEND). The free counterpart to ②: consume the verdict of the run this
	// proposal is ALREADY waiting on, instead of paying for a second gauntlet to re-derive it.
	//
	// WHY THERE IS NO CONFIRM TICK HERE, unlike ② and ③. A confirm gate exists to authorise a
	// consequence — real money (②) or a pointer move on a live role (③). This action spends
	// nothing and moves no role: it records a comparison from a run the operator ALREADY paid for
	// and adjudicated, and lands the proposal on 'compared', which is precisely where the D-039
	// swap ceremony asks for their confirm. Gating the free, reversible step the same way as the
	// expensive irreversible one trains the tick to mean nothing.
	//
	// Fail-closed by delegation: every refusal (wrong status, no challenger, no run, run still
	// non-terminal) is decided inside reconcileProposalFromRun and returned NAMED — this handler
	// invents no permission of its own.
	reconcile: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		try {
			const res = await reconcileProposalFromRun(db, { proposal });
			if (res.outcome !== 'reconciled') {
				// Not an ERROR the operator caused — a state. Named, at 400 so the surface shows it
				// beside the card rather than swallowing it into a silent no-op.
				return fail(400, { proposals: { proposal, error: res.reason ?? res.outcome } });
			}
			return {
				proposals: {
					ok: true,
					proposal,
					reconciled: true,
					run: res.run,
					comparable: res.comparison?.comparable ?? null,
					incomparableReason: res.comparison?.incomparableReason ?? null
				}
			};
		} catch (err) {
			return fail(refusalStatus(err) ?? 500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// ③ SWAP (operator-gated, D-039 — the FINAL touch). The challenger becomes the role's active
	// version. swapFromProposal fail-closes on a missing confirm AND on a challenger that has not
	// earned its own passing gauntlet at (prompt_sha × model_id) — there is NO auto-swap path.
	swap: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		const modelId = String(form.get('modelId') ?? '').trim();
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		if (!modelId) return fail(400, { proposals: { proposal, error: 'missing model_id (the challenger’s certified model)' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				proposals: { proposal, error: 'confirm the swap — the challenger becomes the role’s active version (D-039; there is no auto-swap)' }
			});
		}
		try {
			const res = await swapFromProposal(db, { proposal, modelId, operatorConfirmed: true });
			return {
				proposals: {
					ok: true,
					proposal,
					swapped: true,
					activeVersion: res.role?.active_version ?? null,
					challengerVersion: res.challenger.version
				}
			};
		} catch (err) {
			return fail(refusalStatus(err) ?? 500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// REJECT / WITHDRAW — close the proposal terminally with a reason (SCREENED, D-026) +
	// feed the V2.3-02a cooldown (the terminal row's decided_at is the cooldown anchor).
	reject: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		const reason = String(form.get('reason') ?? '').trim() || undefined;
		const as = form.get('as') === 'withdrawn' ? 'withdrawn' : 'operator';
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		try {
			const res = await rejectProposal(db, { proposal, ...(reason ? { reason } : {}), as });
			return {
				proposals: {
					ok: true,
					proposal,
					rejected: true,
					status: res.proposal.status,
					...(res.screened.length ? { screened: res.screened } : {})
				}
			};
		} catch (err) {
			if (err instanceof WorkforceInputError) return fail(400, { proposals: { proposal, error: err.message } });
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// §7 — PROPOSE a tier change for a proposal's incumbent version. Opens a STRICT
	// tier_change review_proposal (kind:'tier_change') via the EXISTING §5 lifecycle; it cites
	// the grid evidence and does NOT mutate the role/swap. Anti-spam: idempotent per (role,
	// incumbent). The targetTier comes from the grid affordance on the page.
	proposeTier: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const roleVersion = String(form.get('roleVersion') ?? '').trim();
		const targetTier = String(form.get('targetTier') ?? '').trim() as Tier;
		const note = String(form.get('note') ?? '').trim() || undefined;
		if (!roleVersion) return fail(400, { proposals: { error: 'missing role version id' } });
		if (!['local', 'haiku', 'sonnet', 'opus'].includes(targetTier)) {
			return fail(400, { proposals: { error: `invalid target tier '${targetTier}'` } });
		}
		try {
			const res = await proposeTierChange(
				db,
				{ roleVersion, targetTier, ...(note ? { note } : {}) },
				makeTierResolver()
			);
			return {
				proposals: {
					ok: true,
					proposal: res.proposal.id,
					proposedTier: true,
					created: res.created,
					targetTier
				}
			};
		} catch (err) {
			if (err instanceof WorkforceInputError) return fail(400, { proposals: { error: err.message } });
			return fail(500, { proposals: { error: (err as Error).message } });
		}
	},

	// §7 STRICT GATE — run the interview at the TARGET tier (REAL SPEND, operator-gated). The
	// strict gate refuses the swap until a passing (incumbent.prompt_sha × target model_id)
	// interview exists; this action runs that interview. The confirm tick IS the budget decision
	// (trigger='operator'). On a pass, the gate flips to ready_to_swap on the next load.
	tierInterview: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				proposals: { proposal, error: 'confirm the spend — this runs a REAL gauntlet at the target tier to satisfy the §7 strict gate (the click IS the budget decision)' }
			});
		}
		let gate;
		try {
			gate = await resolveTierChangeGate(db, proposal, makeTierResolver());
		} catch (err) {
			return fail(400, { proposals: { proposal, error: (err as Error).message } });
		}
		if (gate.state === 'ready_to_swap') {
			return { proposals: { ok: true, proposal, tierInterview: true, alreadyReady: true } };
		}
		if (gate.state === 'blocked' || !gate.targetModelId) {
			return fail(400, { proposals: { proposal, error: gate.message } });
		}
		const p = await getProposalIncumbent(db, proposal);
		if (!p) return fail(400, { proposals: { proposal, error: 'proposal has no incumbent version to interview' } });

		const runtime = await getRuntime(db);
		if (!runtime.available) return fail(503, { proposals: { proposal, error: runtime.reason } });
		let config;
		try {
			config = loadWorkforce(`${configDir()}/workforce.yaml`);
		} catch (err) {
			return fail(500, { proposals: { proposal, error: `workforce config unreadable: ${(err as Error).message}` } });
		}
		const pool = makeTierResolver();
		const model = pool(gate.targetTier);
		if (!model) return fail(400, { proposals: { proposal, error: `tier '${gate.targetTier}' is not mapped to a model (D-003)` } });
		try {
			const { runGauntlet } = await import('$lib/server/workforce');
			const outcome = await runGauntlet(
				{ db, runtime: runtime.runtime, config },
				{
					roleVersionId: p,
					tier: gate.targetTier,
					provider: model.provider,
					modelId: model.model_id,
					trigger: 'operator'
				}
			);
			return {
				proposals: {
					ok: true,
					proposal,
					tierInterview: true,
					...outcomeResult(outcome)
				}
			};
		} catch (err) {
			if (err instanceof WorkforceInputError) return fail(400, { proposals: { proposal, error: err.message } });
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
		}
	},

	// §7 SWAP (operator-gated, D-039 — the tier swap). Sets role.preferred_tier to the target.
	// swapTierChange fail-closes on a missing confirm AND on a target tier lacking a passing
	// (incumbent.prompt_sha × target model_id) interview — NO auto-swap, NO waiver.
	tierSwap: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { proposals: { error: 'database not connected' } });
		const form = await request.formData();
		const proposal = String(form.get('proposal') ?? '').trim();
		if (!proposal) return fail(400, { proposals: { error: 'missing proposal id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				proposals: { proposal, error: 'confirm the tier swap — the role’s operating tier changes (D-039; there is no auto-swap)' }
			});
		}
		try {
			const res = await swapTierChange(db, { proposal, operatorConfirmed: true }, makeTierResolver());
			return {
				proposals: {
					ok: true,
					proposal,
					tierSwapped: true,
					tier: res.tier
				}
			};
		} catch (err) {
			if (err instanceof TierGateError || err instanceof WorkforceInputError) {
				return fail(400, { proposals: { proposal, error: err.message } });
			}
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
		}
	}
};

/** Bounded read of a proposal's incumbent version id (for the §7 tier interview). */
async function getProposalIncumbent(
	db: NonNullable<ReturnType<typeof tryGetDb>>,
	proposalId: string
): Promise<string | null> {
	const { getReviewProposal } = await import('$lib/server/workforce');
	const p = await getReviewProposal(db, proposalId);
	return p?.incumbent ?? null;
}
