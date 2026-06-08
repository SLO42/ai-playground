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
