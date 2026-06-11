// server/projects — public barrel (TASK 1.2; ARCHITECTURE §2, depends on: db).
//
// DB-backed CRUD for the project plan hierarchy (project + embedded Project-Plan-v3
// + release/phase/feature/sprint). The scanner module owns upsert-from-detection;
// this module owns explicit create/read/update/delete + plan editing.

export {
	// project
	createProject,
	getProject,
	listProjects,
	updateProject,
	updateProjectPlan,
	deleteProject,
	// release
	createRelease,
	getRelease,
	listReleases,
	updateRelease,
	deleteRelease,
	// phase
	createPhase,
	getPhase,
	listPhases,
	updatePhase,
	deletePhase,
	// feature
	createFeature,
	getFeature,
	listFeatures,
	updateFeature,
	deleteFeature,
	// sprint
	createSprint,
	getSprint,
	listSprints,
	updateSprint,
	deleteSprint,
	// types
	type ProjectRow,
	type ProjectPlan,
	type ReleaseRow,
	type PhaseRow,
	type FeatureRow,
	type SprintRow,
	type CreateProjectInput,
	type UpdateProjectInput,
	type CreateReleaseInput,
	type UpdateReleaseInput,
	type CreatePhaseInput,
	type UpdatePhaseInput,
	type CreateFeatureInput,
	type UpdateFeatureInput,
	type CreateSprintInput,
	type UpdateSprintInput
} from './repo';

export {
	// PM memory
	addPmMemory,
	listPmMemory,
	pmMemoryStats,
	// decisions
	addDecision,
	listDecisions,
	// sprint lifecycle
	completeSprint,
	// bootstrap
	bootstrapPm,
	// PM identity (TASK 16.1 / PM-SPEC §1)
	getPm,
	createPm,
	updatePmCharter,
	PM_AUTHORITIES,
	// taxonomy + types
	PM_MEMORY_KINDS,
	type PmMemoryKind,
	type PmMemoryRow,
	type AddPmMemoryInput,
	type PmMemoryStats,
	type DecisionRow,
	type AddDecisionInput,
	type PmBootstrapResult,
	type PmRow,
	type PmAuthority,
	type CreatePmInput
} from './pm-repo';

// TASK 16.1 — the hire flow (Six Forcing Questions) + the PM session seams.
export {
	hirePm,
	hireInterviewFor,
	HIRE_QUESTIONS,
	type HireQuestion,
	type HireQuestionId,
	type HireInterviewQuestion,
	type HireAnswer,
	type HirePmInput,
	type HirePmResult
} from './pm-hire';

export {
	assemblePmContext,
	resolvePmRoute,
	type PmContextBundle,
	type PmContextItem,
	type PmRoute
} from './pm-session';

// TASK 16.2 — the PM trigger engine (PM-SPEC §3).
export {
	PmTriggerEngine,
	pmTriggerAllowed,
	reviewAllowedByAuthority,
	parseCron,
	cronMatches,
	parseDurationMs,
	periodicDue,
	activePmTriggerEngine,
	setActivePmTriggerEngine,
	type PmTriggerEngineOptions,
	type PmTriggerKind,
	type PmGithubArrival,
	type CronSpec
} from './pm-triggers';
export { listPmsWithCadence, type PmReviewProvenance } from './pm-repo';
