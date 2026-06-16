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
import {
	authorChallenger,
	loadProposalCards,
	proposalDiff,
	regauntletChallenger,
	rejectProposal,
	resolveRegauntletTarget,
	ResolutionGateError,
	swapFromProposal,
	WorkforceInputError,
	type GauntletOutcome,
	type ProposalCard
} from '$lib/server/workforce';
import { getRuntime } from '$lib/server/harness';
import { loadWorkforce } from '$lib/server/config';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface ProposalsPageData {
	connected: boolean;
	proposals: ProposalCard[];
	/** Honest live-spend availability (F-008): the re-gauntlet needs a real credential. */
	runtimeAvailable: boolean;
	runtimeReason: string | null;
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<ProposalsPageData> => {
	// Live off the ONE SSE stream (D-035): a proposal status flip (author/regauntlet/swap/
	// reject) writes review_proposal/role_version/role/role_event rows — all watched on /agents.
	depends('app:workforce');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, proposals: [], runtimeAvailable: false, runtimeReason: 'database not connected' };
	}
	try {
		const [proposals, runtime] = await Promise.all([loadProposalCards(db), getRuntime(db)]);
		return {
			connected: true,
			proposals,
			runtimeAvailable: runtime.available,
			runtimeReason: runtime.available ? null : runtime.reason
		};
	} catch (err) {
		return {
			connected: false,
			proposals: [],
			runtimeAvailable: false,
			runtimeReason: null,
			error: (err as Error).message
		};
	}
};

function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}

/** Map a GauntletOutcome (ran | queued) into the named action result the UI renders. */
function outcomeResult(outcome: GauntletOutcome): Record<string, unknown> {
	if (outcome.kind === 'queued') return { queued: true, reason: outcome.reason };
	const run = outcome.run;
	return {
		ran: true,
		run: run.id,
		status: run.status,
		...(run.error_reason ? { errorReason: run.error_reason } : {}),
		plantedFound: run.planted_found,
		plantedTotal: run.planted_total,
		falsePositives: run.false_positives,
		...(run.cost_usd !== null ? { costUsd: run.cost_usd } : {})
	};
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
			if (err instanceof ResolutionGateError || err instanceof WorkforceInputError) {
				return fail(400, { proposals: { proposal, error: err.message } });
			}
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
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
					...outcomeResult(res.outcome)
				}
			};
		} catch (err) {
			if (err instanceof ResolutionGateError || err instanceof WorkforceInputError) {
				return fail(400, { proposals: { proposal, error: err.message } });
			}
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
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
			if (err instanceof ResolutionGateError || err instanceof WorkforceInputError) {
				return fail(400, { proposals: { proposal, error: err.message } });
			}
			return fail(500, { proposals: { proposal, error: (err as Error).message } });
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
	}
};
