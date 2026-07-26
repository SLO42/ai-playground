// COMPLETION-LEDGER Wave A (findings 3 + 4) — THE DRAIN LEDGER: the orchestrator's
// "faces of failure" chokepoint.
//
// THE GAP THIS CLOSES. Two whole classes of real decision left NO durable trace:
//
//   (3) DRAIN FAULTS. Every fault on the orchestrator drain path was swallowed into
//       `console.warn`/`console.error` — and in one case (`catch {}` around the whole
//       post-task block, orchestrator.ts) into NOTHING AT ALL. A route resolve throw, a
//       launchSession failure, a post-task commit/test explosion, a merge-back fault, a
//       terminal-transition error: the work_item flipped to `failed` and the operator was
//       left with a red row and zero explanation. Nothing in the UI could answer "what
//       actually broke, and where?".
//
//   (4) QUEUE HOLDS. `enqueue` / park / gate-block were NON-EVENTS. A task deduped against
//       an active twin, a drain that stopped on the D-021 daily cap, the CG-2 token budget,
//       a saturated interactive semaphore, or a per-project in-flight cap all just `break`
//       out of the loop silently. The operator could not answer "why is this task sitting
//       there?" from the UI at all.
//
// THE FIX. ONE chokepoint (this module), TWO named writers, ONE existing table:
//
//   • {@link recordDrainFault} — a NAMED failure: WHICH stage broke (claim vs route/spawn vs
//     post-task vs commit vs heartbeat vs merge-back vs …), the task/session/work_item it
//     broke on, the error CLASS, and the first lines of the real error text (screened, D-026).
//     Rides `agent_event.type = 'error'` — the honest existing failure type.
//   • {@link recordQueueHold} — a first-class queue lifecycle moment (enqueued / deduped /
//     parked / gate-blocked) carrying the REASON (new work · active twin · daily cap · token
//     budget · concurrency · per-project cap · capability denied). Rides the NEW
//     `agent_event.type = 'queue'` (m0084 widens the ASSERT — the m0081 precedent; no new
//     table, no second writer, F-055).
//
// Both go through {@link writeAgentEvent}, the ONE analytics chokepoint (D-016 param binding,
// §6.1 omit-don't-null, CG-1 metering) — never a raw CREATE.
//
// HARD RULE (F-014/F-048). A DB fault on the drain path must NEVER crash the server, so BOTH
// writers are best-effort: they absorb a write failure and return `false`. But (the F-020
// sweep rule) a best-effort catch must NOT hide a DEVELOPER error, so the absorb is not
// uniform: a programmer fault (TypeError / ReferenceError / SyntaxError — our own bug) is
// logged LOUDLY and distinctly at console.error with a DEVELOPER-ERROR banner, while an
// operational DB fault (conflict, connection, UNIQUE) is a quiet console.warn no-op-retry.
// A happy-path test (drain-events.test.ts) proves the write actually LANDS, so the catch can
// never mask a silently-broken writer.
//
// NOISE DISCIPLINE. Two of the four phases are REPEATING conditions, not one-off decisions:
//   • `parked`  — a saturated semaphore re-parks on every single trigger;
//   • `deduped` — an armed PM re-enqueues the same task every cadence tick forever, and each
//                 one collapses onto the same active twin. (LIVE-VERIFIED: the first load of
//                 /atelier/queue against the real dev DB showed 20 identical dedup rows for ONE
//                 task inside 8 minutes, burying everything else.)
// An unthrottled event for either is a storm, which is the OPPOSITE of visibility. Both are
// therefore collapsed per (phase, reason, project, task) inside a bounded in-process window
// (default 60s), and the row that does emit carries `suppressed` — the honest count folded into
// it — so the operator reads "not re-queued (×19 more in the last minute)" instead of 20 rows
// or, worse, one row that hides how often it is happening.
//
// `enqueued` and `gate_blocked` are genuinely DISCRETE and are never throttled: an enqueue only
// succeeds when there is NO active twin (i.e. real new work), and a gate-block happens once per
// claim. Suppressing either would lose a real, non-repeating decision.
//
// SHADOW PATHS (all four, per data flow):
//   • nil input      — an absent taskId/projectId/error is OMITTED, never stringified into
//                      "undefined" (F-013 spirit); a nil `error` becomes the honest
//                      '(no error message)' marker, never a blank.
//   • empty input    — an empty-string id/message is treated exactly as absent.
//   • upstream error — the analytics write itself throwing is absorbed (see above).
//   • happy path     — a real row lands and is queryable by the read model.

import type { Db } from '../db/client';
import { writeAgentEvent } from '../analytics/events';
import { screen } from '../memory/screen';

// ── Stage vocabulary (drain faults) ─────────────────────────────────────────────────────
//
// 'drain failed' is NOT an acceptable name. Every fault names the STEP that broke. These are
// the real swallow sites in orchestrator.ts — one stage per site, no catch-all bucket.

export const DRAIN_STAGES = [
	/** #onTrigger: the bus task→ready trigger's enqueue/drain threw. */
	'trigger',
	/** bootDrain: one ready task's enqueue threw during the one-shot boot drain. */
	'boot_enqueue',
	/** drain(): claimNext / a gate reader threw while trying to claim work. */
	'claim',
	/** #runItem: the route resolve or launchSession spawn threw (the run itself failed). */
	'route_spawn',
	/** #runItem: the D-036 cc-config catalog freshen threw (spawn proceeds on last-good). */
	'catalog_freshen',
	/** #runItem: the ready→in_progress task transition was refused/threw. */
	'task_transition',
	/** #runItem: the post-task loop (commit + project test + follow-up) threw. */
	'post_task',
	/** post-task reported a mid-run divergence — the terminal task write did NOT land. */
	'post_task_divergence',
	/** #runItem: the GAME-VERIFY step threw (task stays done — a fix signal, not a hard fail). */
	'game_verify',
	/** #runItem: WI-3 merge-back / worktree teardown threw (committed work stays on its branch). */
	'merge_back',
	/** The finally's terminal task transition (→ failed / → done) threw — the heartbeat link. */
	'heartbeat',
	/** complete(): marking the work_item terminal threw (the lease write). */
	'complete',
	/** release(): returning a parked work_item to pending threw. */
	'release',
	/** The memory_review writer fork threw. */
	'memory_review_fork',
	/** The hire_request (HR draft) fork threw. */
	'hire_request_fork',
	/** The backstop maintenance gc tick threw. */
	'maintenance_gc'
] as const;

export type DrainStage = (typeof DRAIN_STAGES)[number];

/** Plain-language stage names for the UI (cross-cutting check 3 — human-readable, no jargon ids). */
export const DRAIN_STAGE_LABELS: Record<DrainStage, string> = {
	trigger: 'queueing a newly-ready task',
	boot_enqueue: 'queueing ready tasks at boot',
	claim: 'claiming the next work item',
	route_spawn: 'routing and spawning the agent',
	catalog_freshen: 'refreshing the capability catalog',
	task_transition: 'moving the task to in-progress',
	post_task: 'committing and testing after the run',
	post_task_divergence: 'writing the task result after the run',
	game_verify: 'verifying the build by running the game',
	merge_back: 'merging the session branch back',
	heartbeat: 'writing the final task status',
	complete: 'closing out the work item',
	release: 'returning the work item to the queue',
	memory_review_fork: 'running the memory review fork',
	hire_request_fork: 'drafting the hire request',
	maintenance_gc: 'the queue maintenance sweep'
};

// ── Queue-hold vocabulary (why work is not running) ──────────────────────────────────────

export const QUEUE_PHASES = [
	/** A NEW work_item row was created for a task. */
	'enqueued',
	/** The enqueue collapsed onto an ACTIVE twin — no new row (the F-048/F-026 dedup). */
	'deduped',
	/** The drain STOPPED claiming and left work pending (a resource/budget ceiling). */
	'parked',
	/** The work was claimed but a policy gate refused the spawn (config, not a ceiling). */
	'gate_blocked'
] as const;
export type QueuePhase = (typeof QUEUE_PHASES)[number];

// Every reason below has a REAL emit site in orchestrator.ts. Reasons with no emit site are
// deliberately ABSENT rather than declared-and-dead: the drain path has NO dependency-unmet
// and NO operator-gate check (verified — those live in the PM/promotion layer, not here), so
// inventing `dependency_unmet` / `operator_gate` entries would be a fabricated vocabulary the
// UI could render but the engine could never produce (F-008).
export const QUEUE_REASONS = [
	/** enqueued — a genuinely new unit of work entered the queue. */
	'new_work',
	/** deduped — an active (pending or processing) twin already holds this unit. */
	'active_twin',
	/** parked — the D-021 rolling daily CLAIM cap is reached. */
	'daily_cap',
	/** parked — the CG-2 rolling 24h TOKEN budget is reached (real spend, not a count). */
	'token_budget',
	/** parked — every interactive semaphore permit is in use (concurrency.maxAgents). */
	'concurrency',
	/** parked — one or more projects are at their per-project in-flight cap (concurrency.perProject). */
	'per_project',
	/** gate_blocked — the D-036 capability validation fail-closed on this spawn. */
	'capability_denied'
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

/** Plain-language hold reasons for the UI — what a human needs to read to act. */
export const QUEUE_REASON_LABELS: Record<QueueReason, string> = {
	new_work: 'new work queued',
	active_twin: 'already queued — an identical item is pending or running',
	daily_cap: 'daily spawn cap reached — work is waiting for the 24h window to roll forward',
	token_budget: 'token budget reached — work is waiting for spend to free up',
	concurrency: 'all agent slots are busy — work is waiting for one to finish',
	per_project: 'this project is at its concurrent-session limit — work is waiting for a slot',
	capability_denied: 'refused: the task asked for a capability that is not in the synced catalog'
};

/** The `detail.kind` discriminators the read model filters on. */
export const DRAIN_FAULT_KIND = 'drain_fault';
export const QUEUE_HOLD_KIND = 'queue_hold';

// ── Screening (D-026) ────────────────────────────────────────────────────────────────────

/** How many leading lines of a real error we persist. Enough to name the cause, not a dump. */
const ERROR_LINES = 3;
/** Hard character bound on the screened error text (an event row is not a log file). */
const ERROR_MAX_CHARS = 600;

/**
 * D-026 boundary screen for a raw error message before it is persisted into `detail.error`.
 * A drain error message routinely embeds absolute worktree paths (→ home-path PII) and, on a
 * config/spawn fault, can embed a token — so it is NEVER stored raw.
 *
 * `screen()` fails CLOSED (any scan error ⇒ quarantined ⇒ empty text), so a quarantined or
 * empty result degrades to an HONEST marker rather than a blank field or the raw text (F-008).
 * Shadow paths: nil/non-string ⇒ '(no error message)'; empty ⇒ '(no error message)';
 * quarantined ⇒ '(error text withheld — it contained a secret)'.
 */
export function screenErrorText(raw: unknown): string {
	const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
	if (!text.trim()) return '(no error message)';
	const res = screen(text);
	if (res.status === 'quarantined') return '(error text withheld — it contained a secret)';
	const clipped = res.text.split(/\r?\n/).slice(0, ERROR_LINES).join(' · ').trim();
	if (!clipped) return '(no error message)';
	return clipped.length > ERROR_MAX_CHARS ? `${clipped.slice(0, ERROR_MAX_CHARS - 1)}…` : clipped;
}

/**
 * The error's CLASS name — the machine-groupable half of "why" (the screened message is the
 * human half). A non-Error throw reports its typeof, never a fabricated class.
 */
export function errorClassOf(err: unknown): string {
	if (err instanceof Error) return err.constructor?.name || 'Error';
	return `non-error:${typeof err}`;
}

/**
 * A DEVELOPER error (our own bug) vs an OPERATIONAL one (the DB said no). Drives whether the
 * best-effort absorb logs quietly or LOUDLY — the F-020-sweep rule that a best-effort catch
 * must never hide a programmer fault.
 */
function isDeveloperError(err: unknown): boolean {
	return err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError;
}

/** Normalize an optional id/text: absent, nil, or blank ⇒ undefined (never the string 'undefined'). */
function opt(v: string | undefined | null): string | undefined {
	if (typeof v !== 'string') return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

/**
 * Absorb a ledger-write failure (F-014/F-048): the ledger is OBSERVABILITY — it must never be
 * able to take down the thing it observes. Returns false so the caller can tell (tests assert
 * on it) without ever having to catch. A developer error is surfaced loudly and distinctly so
 * it cannot hide behind the operational best-effort path.
 */
function absorb(what: string, err: unknown): false {
	if (isDeveloperError(err)) {
		console.error(
			`[drain-ledger] DEVELOPER ERROR writing ${what} — this is a BUG in the ledger writer, not a DB fault: ` +
				`${errorClassOf(err)}: ${(err as Error).message}`
		);
	} else {
		console.warn(
			`[drain-ledger] could not record ${what} (drain unaffected; a later event re-records the state): ` +
				`${errorClassOf(err)}: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	return false;
}

// ── Writer 1: a NAMED drain fault ────────────────────────────────────────────────────────

export interface DrainFaultInput {
	/** WHICH step of the drain broke. Never a catch-all. */
	stage: DrainStage;
	/** The thrown value. Screened + class-extracted here; never persisted raw. */
	error: unknown;
	/** The task the drain was working on (`task:…`), when known. */
	taskId?: string;
	/** The project (`project:…`), when known — links the row to the project surfaces. */
	projectId?: string;
	/** The session (`session:…`), when the fault happened after a spawn. */
	sessionId?: string;
	/** The `work_item:…` the drain had claimed, when known — the queue-side join key. */
	workItemId?: string;
	/** The work_type of the claimed item (task_run / memory_review / hire_request / review). */
	workType?: string;
	/**
	 * TRUE when the drain ABSORBED this fault and carried on (best-effort site), FALSE when it
	 * changed the outcome (the item was marked failed / the task burned). The operator needs to
	 * know whether they are looking at a survived hiccup or a real stop.
	 */
	absorbed: boolean;
	/** Any further structured context (counts, paths already screened upstream, flags). */
	context?: Record<string, unknown>;
}

/**
 * Record ONE named drain fault as a durable, queryable `agent_event` (`type:'error'`).
 *
 * The row answers all three parts of "every error has a name": WHAT triggered it (`stage` +
 * `stageLabel`), WHAT caught it (`absorbed` — the drain carried on, or it changed the verdict),
 * and WHAT the reader sees (`reason`, a plain-language sentence rendered verbatim by the UI).
 *
 * BEST-EFFORT by contract (F-014/F-048): never throws, returns whether the row landed.
 */
export async function recordDrainFault(db: Db, input: DrainFaultInput): Promise<boolean> {
	try {
		const stageLabel = DRAIN_STAGE_LABELS[input.stage] ?? input.stage;
		const errorText = screenErrorText(input.error);
		const errorClass = errorClassOf(input.error);
		const taskId = opt(input.taskId);
		const on = taskId ? ` on task ${taskId}` : input.workItemId ? ` on ${input.workItemId}` : '';
		const tail = input.absorbed
			? 'the drain continued'
			: 'the drain stopped this item (it was marked failed)';
		await writeAgentEvent(db, {
			type: 'error',
			session: opt(input.sessionId),
			project: opt(input.projectId),
			detail: {
				kind: DRAIN_FAULT_KIND,
				by: 'orchestrator',
				stage: input.stage,
				stageLabel,
				errorClass,
				absorbed: input.absorbed,
				// The `reason` field is what activityLabel() and every generic feed renders, so it
				// must READ as a sentence on its own — never a bare id.
				reason: `Drain failed while ${stageLabel}${on}: ${errorText} (${errorClass}; ${tail}).`,
				error: errorText,
				taskId,
				workItemId: opt(input.workItemId),
				workType: opt(input.workType),
				...(input.context ?? {})
			}
		});
		return true;
	} catch (err) {
		return absorb(`drain fault (${input.stage})`, err);
	}
}

// ── Writer 2: a first-class queue hold ───────────────────────────────────────────────────

/** The throttle window: repeats of a REPEATING phase for the same unit collapse into one row. */
export const PARK_THROTTLE_MS = 60_000;
/** Bound on the throttle map so a long-lived process can never grow it without limit (F-014). */
const THROTTLE_MAX_KEYS = 256;

/**
 * The phases that REPEAT under a healthy engine and are therefore throttled (see NOISE DISCIPLINE
 * above). `enqueued` / `gate_blocked` are deliberately absent — each is a one-off decision.
 */
const THROTTLED_PHASES: ReadonlySet<QueuePhase> = new Set<QueuePhase>(['parked', 'deduped']);

interface ThrottleEntry {
	/** Epoch ms of the last EMITTED park for this key. */
	lastEmit: number;
	/** Parks observed since that emit (reported as `suppressed` on the next one). */
	suppressed: number;
}

const parkThrottle = new Map<string, ThrottleEntry>();

/**
 * The throttle bucket for one repeating hold. Keyed by (phase, reason, project, task) so a park
 * on one ceiling never suppresses a park on another, and a re-queue storm for ONE task never
 * hides a different task's first dedup. A park carries no task, so its task component is empty —
 * which is correct: parks are a global/per-project condition, not a per-task one.
 */
function throttleKey(
	phase: QueuePhase,
	reason: QueueReason,
	projectId?: string,
	taskId?: string
): string {
	return `${phase}|${reason}|${opt(projectId) ?? ''}|${opt(taskId) ?? ''}`;
}

/**
 * TEST SEAM: clear the process-local hold throttle so an emission test is not shadowed by a
 * prior test's park/dedup inside the same window. Not used by production code.
 */
export function __resetParkThrottle(): void {
	parkThrottle.clear();
}

/**
 * Prune the throttle map when it grows past its bound — drop entries whose window has long
 * since rolled (they would emit immediately anyway, so dropping them changes no behavior).
 * Keeps the map O(active reasons × active projects), never O(all projects ever).
 */
function pruneThrottle(now: number): void {
	if (parkThrottle.size <= THROTTLE_MAX_KEYS) return;
	for (const [k, v] of parkThrottle) {
		if (now - v.lastEmit > PARK_THROTTLE_MS * 10) parkThrottle.delete(k);
	}
	// Still over bound (pathological churn): drop the oldest half by insertion order.
	if (parkThrottle.size > THROTTLE_MAX_KEYS) {
		const drop = parkThrottle.size - THROTTLE_MAX_KEYS;
		let n = 0;
		for (const k of parkThrottle.keys()) {
			parkThrottle.delete(k);
			if (++n >= drop) break;
		}
	}
}

export interface QueueHoldInput {
	phase: QueuePhase;
	reason: QueueReason;
	/** The task this hold concerns (`task:…`), when known. */
	taskId?: string;
	/** The project (`project:…`), when known. */
	projectId?: string;
	/** The `work_item:…` id, when known. */
	workItemId?: string;
	/** The work_type of the held/queued item. */
	workType?: string;
	/**
	 * Pending+unclaimed queue depth observed at the moment of the hold. THE number that makes a
	 * park actionable ("parked with 12 items waiting" vs "parked with an empty queue"). Omit when
	 * the caller genuinely does not know it — never pass a guess (F-008).
	 */
	pendingDepth?: number;
	/** Any further structured context (cap/budget values, capped project ids, …). */
	context?: Record<string, unknown>;
}

/**
 * Record ONE first-class queue lifecycle moment (`agent_event.type = 'queue'`) — the answer to
 * "why is this task not running?".
 *
 * THROTTLING: the REPEATING phases (`parked`, `deduped` — see NOISE DISCIPLINE at the top) are
 * collapsed per (phase, reason, project, task) inside {@link PARK_THROTTLE_MS}, and the emitted
 * row carries `suppressed` — the honest count folded into it. Returns `false` when the hold was
 * throttled (no row written) so a caller/test can tell a throttle from a write failure via
 * {@link parkSuppressedCount}. `enqueued` / `gate_blocked` are one-off decisions, never throttled.
 *
 * BEST-EFFORT by contract (F-014/F-048): never throws, returns whether the row landed.
 */
export async function recordQueueHold(db: Db, input: QueueHoldInput): Promise<boolean> {
	try {
		const now = Date.now();
		let suppressed = 0;
		if (THROTTLED_PHASES.has(input.phase)) {
			const key = throttleKey(input.phase, input.reason, input.projectId, input.taskId);
			const entry = parkThrottle.get(key);
			if (entry && now - entry.lastEmit < PARK_THROTTLE_MS) {
				entry.suppressed += 1;
				return false; // inside the window — folded into the next emitted row
			}
			suppressed = entry?.suppressed ?? 0;
			parkThrottle.set(key, { lastEmit: now, suppressed: 0 });
			pruneThrottle(now);
		}

		const reasonLabel = QUEUE_REASON_LABELS[input.reason] ?? input.reason;
		const taskId = opt(input.taskId);
		const subject = taskId ? `Task ${taskId}` : 'Work';
		const depth =
			typeof input.pendingDepth === 'number' && Number.isFinite(input.pendingDepth)
				? input.pendingDepth
				: undefined;
		const depthPhrase = depth === undefined ? '' : ` ${depth} item${depth === 1 ? '' : 's'} waiting.`;
		const repeatPhrase =
			suppressed > 0
				? ` (${suppressed} identical hold${suppressed === 1 ? '' : 's'} in the last minute folded in)`
				: '';

		await writeAgentEvent(db, {
			type: 'queue',
			project: opt(input.projectId),
			detail: {
				kind: QUEUE_HOLD_KIND,
				by: 'orchestrator',
				phase: input.phase,
				reason: input.reason,
				reasonLabel,
				suppressed,
				// A sentence, not an id — this is what the generic feeds (activityLabel) render.
				// NOTE: `detail.reason` is the machine reason code AND the feed label in the shared
				// contract, so we keep the code in `reason` and put the sentence in `summary` — the
				// field activityLabel prefers — so both readers get the right thing.
				summary: `${subject} ${input.phase === 'enqueued' ? 'queued' : input.phase === 'deduped' ? 'not re-queued' : input.phase === 'gate_blocked' ? 'blocked' : 'parked'}: ${reasonLabel}.${depthPhrase}${repeatPhrase}`,
				taskId,
				workItemId: opt(input.workItemId),
				workType: opt(input.workType),
				pendingDepth: depth,
				...(input.context ?? {})
			}
		});
		return true;
	} catch (err) {
		return absorb(`queue hold (${input.phase}/${input.reason})`, err);
	}
}

/**
 * How many holds for this bucket are currently FOLDED into the next emitted row. Diagnostics and
 * tests only — the number is also persisted as `detail.suppressed` the moment a row does emit.
 */
export function parkSuppressedCount(
	reason: QueueReason,
	projectId?: string,
	phase: QueuePhase = 'parked',
	taskId?: string
): number {
	return parkThrottle.get(throttleKey(phase, reason, projectId, taskId))?.suppressed ?? 0;
}

/**
 * Classify a spawn-path throw that is a POLICY REFUSAL rather than a fault. A D-036 capability
 * validation failure is not a transient error — the task CANNOT run until the catalog or the
 * bundle changes — so it is recorded as a `gate_blocked` HOLD (actionable) instead of being
 * buried in the generic route/spawn fault bucket. Returns null for everything else, which the
 * caller then records as a normal named fault.
 *
 * Matched by CLASS NAME, not by message text: the runtime's CapabilityValidationError /
 * SterileCompositionError (runtime/capabilities.ts) are the fail-closed D-036 boundary. Name
 * matching (rather than an import + instanceof) keeps the orchestrator free of a runtime-internal
 * import and survives an error crossing a module boundary.
 */
export function holdReasonForSpawnError(err: unknown): QueueReason | null {
	const cls = errorClassOf(err);
	if (cls === 'CapabilityValidationError' || cls === 'SterileCompositionError') {
		return 'capability_denied';
	}
	return null;
}
