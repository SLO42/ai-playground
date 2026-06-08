// server/workflows — public barrel (TASK 2.17; D-013; DATA-MODEL §4.11).
//
// Headless multi-step Claude Code pipelines: a `workflow` definition (validated step
// DAG) executed as a tracked `workflow_run`, each step a `session` linked to the run.
// Used by the release pipeline (3.4). Import the runner + repo from here.

export {
	createWorkflow,
	getWorkflow,
	getWorkflowRun,
	validateSteps,
	type WorkflowStep,
	type WorkflowTrigger,
	type CreateWorkflowInput,
	type WorkflowRow,
	type WorkflowRunRow,
	type StepStatus,
	type WorkflowRunStatus
} from './repo';

export { runWorkflow, type RunWorkflowDeps, type RunWorkflowResult } from './runner';
