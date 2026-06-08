// server/orchestrator — public barrel (TASK 2.2; ARCHITECTURE §2.2; D-004/D-021).
//
// The event-mode orchestrator + its TWO distinct concurrency mechanisms:
//   • Semaphore        — interactive in-process spawn cap (ARCHITECTURE §2.2a)
//   • work_item queue  — background atomic claim queue (DATA-MODEL §4.12, D-021)
// The orchestrator subscribes to the `events` bus ONLY (never its own live query,
// §2.11). Import the orchestrator from here.

export {
	Orchestrator,
	type OrchestratorOptions,
	type OrchMode,
	type StubRoute,
	type DrainSummary
} from './orchestrator';

export { Semaphore, type Permit } from './semaphore';

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
	writeHandoff,
	recoverHandoffs,
	DAY_MS,
	type EnqueueInput,
	type ClaimedItem,
	type WorkStatus,
	type GcResult,
	type HandoffRow
} from './workqueue';

export {
	maybeEnqueueReview,
	countChangedFiles,
	DEFAULT_REVIEW_THRESHOLD,
	type ReviewDecision,
	type ReviewDecisionInput,
	type ReviewDecisionOptions,
	type CountChangedOptions
} from './review';
