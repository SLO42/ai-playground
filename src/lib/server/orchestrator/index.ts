// server/orchestrator — public barrel (TASK 2.2; ARCHITECTURE §2.2; D-004/D-021).
//
// The event-mode orchestrator + its TWO distinct concurrency mechanisms:
//   • Semaphore        — interactive in-process spawn cap (ARCHITECTURE §2.2a)
//   • work_item queue  — background atomic claim queue (DATA-MODEL §4.12, D-021)
// The orchestrator subscribes to the `events` bus ONLY (never its own live query,
// §2.11). Import the orchestrator from here.

export {
	Orchestrator,
	setActiveOrchestrator,
	activeOrchestrator,
	type OrchestratorOptions,
	type OrchMode,
	type StubRoute,
	type RouteResolver,
	type DrainSummary
} from './orchestrator';

export { Semaphore, type Permit } from './semaphore';

// TASK 8.1 — the live boot seam: build + start the orchestrator from hooks.server.ts
// (event-driven, idle-cheap, bus-only — D-004/§2.11). Honest skip when no credential (F-008).
export { startOrchestrator, type OrchestratorBootResult } from './boot';

// TASK 13.2 — the boot-time reaper: marks session/workflow_run rows wedged 'running' by a
// previous boot as 'failed' ("reaped: server restarted mid-run" — F-008 honest), so a hard
// server death never leaves phantom running agents. Wired from hooks.server.ts at boot.
export { reapStaleRuns, processBootTime, REAPED_NOTE, type ReapResult } from './reaper';

export {
	runPostTask,
	splitCommand,
	execFileRunner,
	type CommandRunner,
	type CommandResult,
	type PostTaskInput,
	type PostTaskOptions,
	type PostTaskResult,
	type CommitOutcome,
	type TestOutcome
} from './post-task';

export {
	enqueue,
	claimNext,
	complete,
	countByStatus,
	pendingDepth,
	spawnsSince,
	gcStale,
	DAY_MS,
	type EnqueueInput,
	type ClaimedItem,
	type WorkStatus,
	type GcResult
} from './workqueue';

// GAME-VERIFY (docs/GAME-VERIFY-SPEC.md) — the runner + the orchestrator step that gates/serializes/
// persists/feeds-back a built mod's live game verification. INFRASTRUCTURE (ROUNDS is only a config).
export {
	runGameVerify,
	type GameVerifyConfig,
	type GameVerifyContext,
	type GameVerifyDeps,
	type GameVerifyVerdict,
	type GameVerifyOutcome
} from './game-verify';
export {
	runGameVerifyStep,
	gameVerifyInFlightCount,
	type GameVerifyRunner,
	type GameVerifyStepInput,
	type GameVerifyStepDeps,
	type GameVerifyStepResult
} from './game-verify-step';
// GV-4 — the read-side: surface the persisted verdict in the project command-center (operator visibility).
export {
	listGameVerifyVerdicts,
	type GameVerifyVerdictRow,
	type GameVerifyVerdictOutcome
} from './game-verify-read';

export {
	maybeEnqueueReview,
	countChangedFiles,
	DEFAULT_REVIEW_THRESHOLD,
	type ReviewDecision,
	type ReviewDecisionInput,
	type ReviewDecisionOptions,
	type CountChangedOptions
} from './review';

// TASK 4.2 — resource-profile detection (optional perf knob): detect CPU/RAM at boot →
// default concurrency caps. Pure recommender; operator config always wins (ARCHITECTURE §388).
export {
	detectHostSnapshot,
	detectResourceProfile,
	recommendCaps,
	classifyTier,
	resolveBootCaps,
	RESOURCE_TUNING,
	type HostSnapshot,
	type ConcurrencyCaps,
	type ResourceTier,
	type ResourceProfile
} from './resource-profile';
