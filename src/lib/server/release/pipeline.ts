// TASK 3.4 — the release pipeline (workflows + runtime; D-013; DATA-MODEL §4.11; dep 2.17).
//
// A release is the canonical 6-step pipeline:
//   dry-run → test → changelog → version → tag → publish
// driven as a tracked `workflow_run` (reusing the 2.17 DAG runner) — each step is one
// `launchSession` with `workflowRunId` set (the §4.11 "each executing step is a session"
// contract), so every step's transcript + analytics + live SSE flow through the SAME
// session/message/agent_event tables. The steps form a strict linear chain (each depends
// on the previous), so a failure anywhere SHORT-CIRCUITS every later step and fails the
// run — exactly the "abort the release on the first red gate" semantics we want.
//
// This module is a THIN builder over the 2.17 primitives — it does NOT reimplement the
// runner. It:
//   1. buildReleaseSteps()  — the canonical ordered WorkflowStep[] for a target version.
//   2. createReleaseWorkflow() — persist that step list as a `workflow` (validateSteps +
//      the DAG guard run inside createWorkflow before persist, §4.11).
//   3. runRelease()        — create the workflow then runWorkflow() it; returns the
//      tracked run result (runId + per-step status + per-step session ids).
//   4. listReleaseRuns()   — read-side for the Release tab: the workflow_run rows of a
//      project's release workflows, newest first, with their step_state.
//
// NO LIVE CREDENTIALS THIS WAVE: runWorkflow drives launchSession → the 1.4 AgentRuntime,
// which the test injects as a MOCKED/SANDBOXED backend (scripted stream, no Anthropic
// network, no real `git tag` / `npm publish`). The pipeline LOGIC is identical for the
// real backend — only the injected runtime differs. The real credentialed end-to-end
// release transcript (real publish + tag) is the deferred live capstone.
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated token
// is the validated project record id (StringRecordId at the db/validate.ts chokepoint).
// Optionals are OMITTED, not nulled (§6.1).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import type { AgentRuntime, ModelSelection } from '../runtime/index';
import {
	createWorkflow,
	runWorkflow,
	type WorkflowStep,
	type WorkflowRow,
	type RunWorkflowResult
} from '../workflows/index';

/** The canonical release stages, in pipeline order. Each is one workflow step. */
export const RELEASE_STAGES = [
	'dry-run',
	'test',
	'changelog',
	'version',
	'tag',
	'publish'
] as const;

export type ReleaseStage = (typeof RELEASE_STAGES)[number];

/** The agent slot id a release step runs as (a release-runner agent; D-013 step.agent). */
const RELEASE_AGENT = 'release-runner';

/**
 * The prompt each stage seeds its headless session with. Concrete, single-purpose
 * instructions — the runtime turns each into a real Claude Code run in the project cwd.
 * `{version}` is substituted with the target version. These are PROMPTS (data the model
 * receives), never executed locally by this module — the model performs the work.
 */
const STAGE_PROMPT: Record<ReleaseStage, string> = {
	'dry-run':
		'Release dry-run for {version}: verify the working tree is clean, the build passes, and there are no uncommitted changes. Report blockers; do NOT modify anything.',
	test: 'Run the full test suite for the {version} release. Fail the step (non-zero) if any test fails.',
	changelog:
		'Generate the CHANGELOG entry for {version} from the commits since the last release tag. Write it to CHANGELOG.md.',
	version:
		'Bump the project version to {version} in the manifest (package.json or equivalent) and commit the version bump.',
	tag: 'Create the annotated git tag for {version} on the version-bump commit.',
	publish:
		'Publish the {version} release (npm publish / push the tag to the remote). This is the only step with external side effects.'
};

export interface BuildReleaseStepsInput {
	/** Target version, e.g. "v0.4". Substituted into each stage prompt. */
	version: string;
	/** Working dir the release runs in (the project root). */
	cwd: string;
	/** Model each step runs as. */
	model: ModelSelection;
	/** Optional agent slot override (default `release-runner`). */
	agent?: string;
}

/**
 * Build the canonical release step list: a strict linear chain in RELEASE_STAGES order.
 * Each step depends_on the previous one (so a red step aborts everything downstream) and
 * is NON-parallel (a release is inherently sequential). The returned WorkflowStep[] is
 * exactly what createWorkflow/validateSteps expect.
 */
export function buildReleaseSteps(input: BuildReleaseStepsInput): WorkflowStep[] {
	const agent = input.agent ?? RELEASE_AGENT;
	return RELEASE_STAGES.map((stage, i) => ({
		id: stage,
		prompt: STAGE_PROMPT[stage].replaceAll('{version}', input.version),
		agent,
		model: input.model,
		cwd: input.cwd,
		// Linear chain: each stage waits for the one before it. The first stage has no dep.
		depends_on: i === 0 ? undefined : [RELEASE_STAGES[i - 1]],
		// A release is sequential — never run stages concurrently.
		parallel: false
	}));
}

export interface CreateReleaseWorkflowInput extends BuildReleaseStepsInput {
	/** Project the release belongs to (owns the workflow; its root is the default cwd). */
	projectId: string;
}

/**
 * Persist the release pipeline as a `workflow` (trigger "manual"). The step DAG is
 * validated inside createWorkflow BEFORE persist (§4.11) — a malformed pipeline never
 * reaches the DB. The project link is validated at the D-016 chokepoint.
 */
export async function createReleaseWorkflow(
	db: Db,
	input: CreateReleaseWorkflowInput
): Promise<WorkflowRow> {
	return createWorkflow(db, {
		name: `release ${input.version}`,
		project: input.projectId,
		steps: buildReleaseSteps(input),
		trigger: 'manual'
	});
}

export interface RunReleaseDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	projectId: string;
	version: string;
	cwd: string;
	model: ModelSelection;
	agent?: string;
}

/**
 * Run a release: create the release workflow, then run it as a tracked workflow_run via
 * the reused 2.17 DAG runner. Each stage executes as one workflow-step session linked to
 * the run. Returns the runner result (runId + terminal status + per-stage step_state +
 * per-stage session ids). Never throws on a STAGE failure (the run records "failed").
 */
export async function runRelease(deps: RunReleaseDeps): Promise<RunReleaseResult> {
	const wf = await createReleaseWorkflow(deps.db, {
		projectId: deps.projectId,
		version: deps.version,
		cwd: deps.cwd,
		model: deps.model,
		agent: deps.agent
	});
	const result = await runWorkflow({
		db: deps.db,
		bus: deps.bus,
		runtime: deps.runtime,
		workflow: wf,
		projectId: deps.projectId,
		// A release is code-changing work (version bump, changelog, tag).
		intent: 'code-write'
	});
	return { ...result, workflowId: wf.id, version: deps.version };
}

export interface RunReleaseResult extends RunWorkflowResult {
	/** The persisted release `workflow` id. */
	workflowId: string;
	/** The target version this run released. */
	version: string;
}

// ── Read-side: the Release tab surface ───────────────────────────────────────────

export interface ReleaseRunSummary {
	runId: string;
	workflowId: string;
	workflowName: string;
	version: string;
	status: string;
	stepState: Record<string, string>;
	startedAt: string;
	endedAt?: string;
}

/**
 * List the release runs for a project, newest first — the read model for the Release
 * tab. A "release run" is a `workflow_run` whose `workflow` is one of the project's
 * release workflows (name begins "release "). Pure read; every row is a real DB row
 * (F-008). The project id is validated at the D-016 chokepoint.
 */
export async function listReleaseRuns(db: Db, projectId: string): Promise<ReleaseRunSummary[]> {
	const pid = new StringRecordId(assertRecordId(projectId));
	// Release workflows of this project. The "release " name prefix is set by
	// createReleaseWorkflow — string::starts_with keeps it a release run, not any pipeline.
	const [runs] = await db.query<
		[
			Array<{
				id: unknown;
				status: string;
				step_state: Record<string, string>;
				started_at: string;
				ended_at?: string;
				workflow: { id: unknown; name: string };
			}>
		]
	>(
		`SELECT id, status, step_state, started_at, ended_at, workflow.{id, name} AS workflow
		   FROM workflow_run
		  WHERE workflow.project = $pid AND string::starts_with(workflow.name, 'release ')
		  ORDER BY started_at DESC;`,
		{ pid }
	);
	return runs.map((r) => ({
		runId: String(r.id),
		workflowId: String(r.workflow.id),
		workflowName: r.workflow.name,
		// "release v0.4" → "v0.4"; the version is the part after the "release " prefix.
		version: r.workflow.name.replace(/^release\s+/, ''),
		status: r.status,
		stepState: r.step_state,
		startedAt: String(r.started_at),
		...(r.ended_at != null ? { endedAt: String(r.ended_at) } : {})
	}));
}
