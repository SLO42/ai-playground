// PM-LC-2 — the one-click "start the project's life" lifecycle TICK (PM-LIFECYCLE-SPEC §PM-LC-2).
//
// The operator asked for ONE click that makes the PM review the project, propose the next work, and
// start the approved work. This module is that single entry point. It composes the EXISTING PM loop
// pieces — it builds NO new authority and promotes NOTHING itself:
//
//   1. getPm           (pm-repo.ts:449)  — no hired PM ⇒ { needsHire:true }. NEVER auto-hire.
//   2. bootstrapPm     (pm-repo.ts:618)  — idempotent (no-ops once memory exists). Re-run-safe.
//   3. generatePmProposals (pm-propose.ts) — the PM-LC-1 GENERATE step (injected seam, real launch in
//      prod / stub in tests). Creates BORN-'proposed' tasks through proposeTask's §4.1 chokepoint.
//   4. runValidationPanel (pm-panel.ts)  — over each freshly-proposed task. The panel is what closes
//      the loop per authority (it is the EXISTING authority gate — see below).
//
// PROMOTION IS THE PANEL'S JOB, NOT OURS (integrity LOCKED — verified at pm-panel.ts decidePanel):
//   • authority 'act'     → on unanimous approve the panel ITSELF calls setStatus(task,'ready')
//     (pm-panel.ts:604-605) → decision 'approved'. THAT setStatus is the orchestrator #onTrigger:257
//     auto-develop trigger (EXISTING behavior). We observe the 'approved' decision and COUNT it as
//     promoted. We do NOT call setStatus — a second move would illegally re-transition ready→ready.
//   • authority 'propose' → the panel creates a proposal_gate decision brief (pm-panel.ts:619-661) and
//     LEAVES the task 'proposed'; decision 'operator_gate'. We count it as leftForOperator.
//   • authority 'observe' → proposeTask REFUSES an observe-only PM (pm-proposals.ts:198) so step 3
//     creates ZERO proposed tasks; nothing reaches the panel; nothing is promoted. (We never even
//     reach the panel for observe — generation is empty by construction.)
// There is NO branch here that promotes a task. The ONLY promotion in the whole flow is the panel's
// pre-existing 'act'-authority setStatus. No new authority is introduced; D-039 operator gates,
// auto-hire, and hire-request approval are all untouched.
//
// F-008 honest: a healthy project (generator returns nothing) creates zero tasks and returns an honest
// "no actionable gaps" summary — never a fabricated task or count. Every count returned is a real read.
//
// SHADOW PATHS (built + tested): NIL/empty generation → zero proposals, honest summary; the generator
// throwing (env/timeout/contract) PROPAGATES named (the route records it honestly); a single proposal's
// panel run failing (verdict-contract) is collected as a NAMED per-proposal error without nuking the
// other proposals' results.
//
// Boundary discipline (D-016): this module composes existing repos (getPm/bootstrapPm/
// generatePmProposals/runValidationPanel); it opens NO new query surface and interpolates no id.

import type { Db } from '../db/client';
import type { EventBus } from '../events/bus';
import type { AgentRuntime, ModelSelection, SpawnBudgets } from '../runtime/index';
import { getPm, bootstrapPm, type PmAuthority } from './pm-repo';
import {
	generatePmProposals,
	makePmProposalAgent,
	type PmProposalGenerator,
	type GeneratePmProposalsResult,
	type ScreenedField
} from './pm-propose';
import {
	runValidationPanel,
	ValidatorContractError,
	PanelInputError,
	type PanelDecision,
	type PanelRunOpts
} from './pm-panel';
import { ProposalContractError } from './pm-proposals';
import { acquireLifecycleLock, releaseLifecycleLock } from './pm-lifecycle-lock';

// ── Deps + opts ────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the production tick needs to drive REAL sessions (the generator + the validation panel).
 * Mirrors the route's existing PanelDeps construction (getBus/getRuntime/DEFAULT_MODEL/DEFAULT_BUDGETS).
 * In unit tests the generator seam is injected directly via opts.generate (NO bus/runtime needed for
 * the generation half) — see startProjectLifecycle's opts.
 */
export interface LifecycleDeps {
	bus: EventBus;
	runtime: AgentRuntime;
	/** Recorded as a fallback route when config/workforce.yaml is unreadable (panel routing). */
	fallbackModel: ModelSelection;
	/** Spawn budgets for the panel validator sessions. */
	budgets: SpawnBudgets;
	/** The model the PM proposal-generation session runs under (opus-everywhere; cheap tier upstream). */
	proposalModel: ModelSelection;
	/** The agent slot id the read-only PM proposal session runs as. */
	proposalAgentId: string;
}

export interface StartLifecycleOpts {
	/** Config dir override forwarded to generatePmProposals + the panel (tests). */
	configDir?: string;
	/** Max candidate proposals this tick attempts (forwarded to generatePmProposals). */
	maxProposals?: number;
	/** Panel size (1 or 2 validators; default 2 — PM-SPEC §4.2). */
	validators?: 1 | 2;
	/**
	 * TEST/INJECTION SEAM: a stub proposal generator (NO spend). When provided it REPLACES the
	 * production makePmProposalAgent leg — exactly mirroring create/agent.ts's injected ProposalGenerator.
	 * Production callers omit this; the tick builds makePmProposalAgent from LifecycleDeps.
	 */
	generate?: PmProposalGenerator;
}

// ── Result ──────────────────────────────────────────────────────────────────────────────────────

/** Per-proposal panel outcome (real task id + the decision the panel mechanically reached). */
export interface LifecyclePanelResult {
	taskId: string;
	title: string;
	decision: PanelDecision;
	/** The task status AFTER the panel closed (e.g. 'ready' on an 'act' approve; 'proposed' otherwise). */
	status: string;
	/** The §8 decision brief id created for operator_gate / operator_challenge, else null. */
	briefId: string | null;
}

/** A proposal whose panel run FAILED (named) — collected, never silently dropped (F-008). */
export interface LifecyclePanelFailure {
	taskId: string;
	title: string;
	error: string;
}

export interface StartLifecycleResult {
	/** True ONLY when no PM is hired — the caller renders the hire CTA; NOTHING was run (no auto-hire). */
	needsHire?: boolean;
	/**
	 * True ONLY when a lifecycle tick was ALREADY running for this project (the per-project in-flight
	 * lock was held by a live tick). This is the BENIGN double-click/concurrent-submit guard: NOTHING
	 * was run this call (no second PM session, no double spend) — the caller surfaces "a tick is already
	 * running" rather than treating it as an error or starting a duplicate. (PM-LC-2 hardening.)
	 */
	alreadyRunning?: boolean;
	/** Whether bootstrapPm seeded founding memory THIS tick (false ⇒ already bootstrapped — idempotent). */
	bootstrapped: boolean;
	/** The PM authority this tick ran under (governs promotion — observe/propose/act). */
	authority: PmAuthority;
	/** How many tasks were BORN 'proposed' this tick (generatePmProposals.created). */
	generated: number;
	/** How many proposed tasks were put through the validation panel this tick. */
	validated: number;
	/** How many proposals the panel PROMOTED to 'ready' (panel 'act'-authority approve — EXISTING path). */
	promoted: number;
	/** How many proposals were LEFT for the operator (a proposal_gate / challenge brief — propose authority). */
	leftForOperator: number;
	/** The live transcript key — the PM proposal-generation session id (subscribe via ?session=). null when
	 *  no session was produced (e.g. observe authority generates nothing, or a stub seam in tests). */
	sessionId: string | null;
	/** Per-proposal panel results (real task ids + decisions) — the operator's audit of the tick. */
	panels: LifecyclePanelResult[];
	/** Per-proposal panel FAILURES, each named (a verdict-contract / missing-credential failure on ONE
	 *  proposal does not nuke the rest). [] when every panel ran clean. */
	panelFailures: LifecyclePanelFailure[];
	/** Honest human-readable one-line summary of the tick (F-008 — never a fabricated count). */
	summary: string;
	/** Candidates DROPPED before proposeTask (contract / screen / over-cap), each named (from generation). */
	dropped: Array<{ reason: string }>;
	/** D-026 writer-boundary redactions performed during generation (surfaced, non-fatal). */
	redactions: ScreenedField[];
}

// ── The one-click tick ───────────────────────────────────────────────────────────────────────────

/**
 * Run ONE PM lifecycle tick for a project (PM-LIFECYCLE-SPEC §PM-LC-2). Idempotent/interrupt-safe at
 * every step: bootstrapPm no-ops once seeded; proposeTask absorbs an already-open structural duplicate
 * so a re-run after a crash does not double-propose; the panel absorbs verdicts already recorded for a
 * proposal. Promotes NOTHING itself — promotion is the panel's pre-existing 'act'-authority setStatus.
 *
 * REAL-SPEND GUARD (PM-LC-2 hardening): the tick is serialized PER PROJECT by an in-flight lock. A
 * double-click / concurrent submit while a tick is already running for this project returns a BENIGN
 * { alreadyRunning:true } result — NO second PM session, NO double spend, and no same-project
 * double-propose (the lock serializes proposeTask too). A crashed holder's stale lock self-heals
 * (CA-H4 takeover), so a SIGKILL between acquire and release can never permanently wedge the project.
 *
 * @returns { needsHire:true } (and nothing else run) when the project has no hired PM — NEVER auto-hires.
 * @returns { alreadyRunning:true } (and nothing else run) when a tick is already in flight for this project.
 */
export async function startProjectLifecycle(
	db: Db,
	deps: LifecycleDeps,
	projectId: string,
	opts: StartLifecycleOpts = {}
): Promise<StartLifecycleResult> {
	// 0. CONCURRENCY/SPEND GUARD (PM-LC-2 hardening): acquire the per-project in-flight lock BEFORE any
	//    work. A second concurrent tick (double-click / parallel submit) finds the lock held by a live
	//    tick and gets a BENIGN already-running result — no second PM session, no double spend, and
	//    (because ticks for a project are now serialized) no same-project double-propose. A crashed
	//    holder's stale lock is taken over (CA-H4 — never wedge). The lock is released in `finally` on
	//    EVERY exit below (success, needsHire, or throw). Acquired FIRST so even the needsHire/observe
	//    short-circuits are serialized — a double-click never races getPm/bootstrapPm either.
	const lock = await acquireLifecycleLock(db, projectId);
	if (!lock.held) {
		return {
			alreadyRunning: true,
			bootstrapped: false,
			authority: 'observe',
			generated: 0,
			validated: 0,
			promoted: 0,
			leftForOperator: 0,
			sessionId: null,
			panels: [],
			panelFailures: [],
			summary:
				'A lifecycle tick is already running for this project — let it finish before starting another (no second PM session was spawned).',
			dropped: [],
			redactions: []
		};
	}

	try {
		return await runTick(db, deps, projectId, opts);
	} finally {
		// RELEASE on every exit (success/needsHire/throw). Holder-scoped + best-effort: a release failure
		// never masks the tick's result, and the STALE_LOCK_MS takeover is the backstop against a wedge.
		await releaseLifecycleLock(db, projectId, lock.nonce);
	}
}

/** The actual tick body, run UNDER the per-project lock held by startProjectLifecycle. */
async function runTick(
	db: Db,
	deps: LifecycleDeps,
	projectId: string,
	opts: StartLifecycleOpts
): Promise<StartLifecycleResult> {
	// 1. The PM must already be hired. No PM ⇒ the operator hires first (NEVER auto-hire). This is the
	//    short-circuit honest empty: nothing is generated, validated, or promoted.
	const pm = await getPm(db, projectId);
	if (!pm) {
		return {
			needsHire: true,
			bootstrapped: false,
			authority: 'observe',
			generated: 0,
			validated: 0,
			promoted: 0,
			leftForOperator: 0,
			sessionId: null,
			panels: [],
			panelFailures: [],
			summary: 'No PM is hired for this project — hire a PM first (the lifecycle never auto-hires).',
			dropped: [],
			redactions: []
		};
	}
	const authority = pm.authority;

	// 2. Idempotent bootstrap: seed founding pm_memory from LIVE project state IF not yet bootstrapped.
	//    bootstrapPm already no-ops (returns the existing rows) once any memory exists (pm-repo.ts:618).
	const boot = await bootstrapPm(db, projectId);

	// 3. GENERATE proposals (PM-LC-1). The injected stub (tests) or the production makePmProposalAgent
	//    leg (real, read-only, cheap-tier launchSession). The session id is captured via onSessionCreated
	//    so the operator can watch the PM think live. An 'observe' PM cannot propose — proposeTask refuses
	//    every candidate (pm-proposals.ts:198), so generation honestly yields zero created tasks.
	let sessionId: string | null = null;
	const generate: PmProposalGenerator =
		opts.generate ??
		makePmProposalAgent({
			db,
			bus: deps.bus,
			runtime: deps.runtime,
			agentId: deps.proposalAgentId,
			model: deps.proposalModel,
			onSessionCreated: (sid) => {
				sessionId = sid;
			}
		});

	const gen: GeneratePmProposalsResult = await generatePmProposals(db, generate, projectId, {
		...(opts.configDir ? { configDir: opts.configDir } : {}),
		...(opts.maxProposals != null ? { maxProposals: opts.maxProposals } : {})
	});

	// The freshly-BORN 'proposed' tasks this tick — 'created' outcomes only (a 'duplicate_open' absorb
	// re-points at an already-open proposal that already has/will have its own panel run; we do NOT
	// re-panel an absorbed duplicate, and capped/defer-suppressed produced no task).
	const freshProposed = gen.outcomes
		.filter((o) => o.outcome === 'created' && o.task)
		.map((o) => o.task!);

	// 4. Run the validation panel over each fresh proposal. The panel is the authority gate:
	//    'act' approve → it promotes (setStatus ready) → decision 'approved'; 'propose' → operator_gate
	//    brief, task stays proposed. We OBSERVE; we never promote. A single proposal's panel failure is
	//    collected NAMED (F-008) and does not abort the remaining proposals.
	const panelOpts: PanelRunOpts = {
		...(opts.validators ? { validators: opts.validators } : {}),
		...(opts.configDir ? { configDir: opts.configDir } : {})
	};
	const panels: LifecyclePanelResult[] = [];
	const panelFailures: LifecyclePanelFailure[] = [];
	for (const task of freshProposed) {
		try {
			const res = await runValidationPanel(
				{
					db,
					bus: deps.bus,
					runtime: deps.runtime,
					fallbackModel: deps.fallbackModel,
					budgets: deps.budgets
				},
				task.id,
				panelOpts
			);
			panels.push({
				taskId: task.id,
				title: task.title,
				decision: res.decision,
				status: res.task.status,
				briefId: res.brief?.id ?? null
			});
		} catch (err) {
			// EVERY ERROR HAS A NAME: a verdict-contract / missing-credential / panel-input failure on ONE
			// proposal is recorded against THAT proposal and the tick continues. A non-named error (DB
			// fault) re-throws so the tick fails honestly rather than masking a real fault as a failure row.
			if (
				err instanceof ValidatorContractError ||
				err instanceof PanelInputError ||
				err instanceof ProposalContractError
			) {
				panelFailures.push({ taskId: task.id, title: task.title, error: err.message });
				continue;
			}
			throw err;
		}
	}

	// 5. Tally — promotion is COUNTED from the panel's own decisions, never performed here.
	//    'approved' = the panel's 'act'-authority setStatus(ready) fired (the EXISTING auto-develop path).
	//    'operator_gate' / 'operator_challenge' = a brief awaits the operator (left for operator).
	const promoted = panels.filter((p) => p.decision === 'approved').length;
	const leftForOperator = panels.filter(
		(p) => p.decision === 'operator_gate' || p.decision === 'operator_challenge'
	).length;
	const pushedBack = panels.filter((p) => p.decision === 'pushback').length;

	const summary = buildSummary({
		authority,
		generated: gen.created,
		validated: panels.length,
		promoted,
		leftForOperator,
		pushedBack,
		panelFailures: panelFailures.length,
		genSummary: gen.summary
	});

	return {
		bootstrapped: boot.bootstrapped,
		authority,
		generated: gen.created,
		validated: panels.length,
		promoted,
		leftForOperator,
		sessionId,
		panels,
		panelFailures,
		summary,
		dropped: gen.dropped,
		redactions: gen.redactions
	};
}

/** Compose the honest one-line tick summary from REAL counts (F-008 — never a fabricated number). */
function buildSummary(x: {
	authority: PmAuthority;
	generated: number;
	validated: number;
	promoted: number;
	leftForOperator: number;
	pushedBack: number;
	panelFailures: number;
	genSummary: string;
}): string {
	if (x.generated === 0) {
		// Honest empty: nothing was proposed. observe says WHY (it never proposes); others echo the
		// generator's own honest summary (no gaps / nothing survived the contract).
		if (x.authority === 'observe') {
			return 'PM authority is "observe" — the PM reviewed the project but proposes nothing (raise authority to "propose" or "act" to act). No tasks generated.';
		}
		return `PM lifecycle tick: ${x.genSummary}`;
	}
	const parts = [`generated ${x.generated} proposal(s)`, `validated ${x.validated}`];
	if (x.promoted) parts.push(`promoted ${x.promoted} to ready (auto-develop)`);
	if (x.leftForOperator) parts.push(`${x.leftForOperator} awaiting your approval`);
	if (x.pushedBack) parts.push(`${x.pushedBack} returned to the PM (pushback)`);
	if (x.panelFailures) parts.push(`${x.panelFailures} panel run(s) failed (see reasons)`);
	const tail =
		x.authority === 'act'
			? ' (authority "act": approved proposals start automatically).'
			: x.authority === 'propose'
				? ' (authority "propose": approved proposals await your approval).'
				: '.';
	return `PM lifecycle tick: ${parts.join('; ')}${tail}`;
}
