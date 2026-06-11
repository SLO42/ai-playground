// server/release — public barrel (TASK 3.4; D-013; DATA-MODEL §4.11).
//
// The release pipeline: the canonical dry-run → test → changelog → version → tag →
// publish → verify chain (verify: TASK 14.7), run as a tracked `workflow_run` (reusing
// the 2.17 workflow runner), each stage a `session` linked to the run. Read
// `listReleaseRuns` for the Release tab.

export {
	RELEASE_STAGES,
	buildReleaseSteps,
	createReleaseWorkflow,
	runRelease,
	resolvePublishTarget,
	listReleaseRuns,
	getReleaseChangelogHtml,
	getReleaseChangelogMarkdown,
	type ReleaseStage,
	type BuildReleaseStepsInput,
	type CreateReleaseWorkflowInput,
	type RunReleaseDeps,
	type RunReleaseResult,
	type ReleaseRunSummary
} from './pipeline';
