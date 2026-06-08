// TASK 2.17 — the workflow runner (headless multi-step CC pipelines, D-013;
// DATA-MODEL §4.11; deps 2.2). Used by the release pipeline (3.4).
//
// runWorkflow() executes a `workflow` definition as a tracked `workflow_run`:
//   1. CREATE the workflow_run (status "running", step_state = every step "pending").
//   2. Drive the dependency DAG: a step becomes ready when ALL its depends_on steps are
//      "done". Ready steps marked `parallel` run CONCURRENTLY; a non-parallel ready step
//      runs alone (a serialization point). Each wave runs, step_state is updated, then the
//      next wave's ready set is recomputed — exactly the topological order validateSteps
//      already proved exists (acyclic).
//   3. EACH step is one `session` (DATA-MODEL §4.3) launched via launchSession (1.6b) with
//      `workflowRunId` set, so the step's transcript + analytics + live SSE all flow through
//      the SAME tables (the §4.11 "each executing step is a session" contract). The step's
//      prompt rides on `promptTask` (a workflow step has NO task row); its `cwd` overrides.
//   4. Terminal: if any step failed (or a dependency could never become ready) the run is
//      "failed"; if every step is "done" the run is "done". A failed step SHORT-CIRCUITS its
//      dependents (they can never become ready) — they stay "pending" and the run fails.
//   5. ended_at is stamped; the workflow_run row is the durable, queryable record.
//
// NO LIVE CREDENTIALS THIS WAVE: launchSession drives the 1.4 AgentRuntime, which the
// test injects as a MOCKED/SANDBOXED backend (scripted stream, no Anthropic network).
// The runner logic is identical for the real backend — only the injected runtime differs.
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated token
// is the validated workflow_run record id (StringRecordId at the db/validate.ts chokepoint).
// Optionals are OMITTED, not nulled (§6.1). The step_state object is rewritten wholesale on
// each transition via a bound $param (no per-key SurrealQL — array/object legality in JS).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import type { AgentRuntime, Intent, SpawnBudgets, ToolPolicy } from '../runtime/index';
import { launchSession, type LaunchResult } from '../sessions/launch';
import {
	getWorkflow,
	type StepStatus,
	type WorkflowRunStatus,
	type WorkflowRow,
	type WorkflowStep
} from './repo';

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

export interface RunWorkflowDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	/** The workflow to run — a record id, or a pre-fetched row (release pipeline passes the row). */
	workflow: string | WorkflowRow;
	/**
	 * Project the run belongs to. A step has no task; launchSession still needs a project
	 * for cwd-resolution + analytics. Defaults to the workflow's project when present.
	 */
	projectId?: string;
	/** Per-step spawn knobs (D-020). Defaults applied per step when omitted. */
	intent?: Intent;
	budgets?: SpawnBudgets;
	toolPolicy?: ToolPolicy;
}

export interface RunWorkflowResult {
	/** The persisted `workflow_run` record id. */
	runId: string;
	status: WorkflowRunStatus;
	/** Final per-step state — the same object persisted on the workflow_run row. */
	stepState: Record<string, StepStatus>;
	/** Per-step session ids (only steps that actually ran). */
	sessions: Record<string, string>;
}

const DEFAULT_BUDGETS: SpawnBudgets = { thinking: 'medium', toolCalls: 20, concurrency: 1 };
const DEFAULT_TOOL_POLICY: ToolPolicy = { allow: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] };

/**
 * Run a workflow as a tracked workflow_run. Returns the terminal status + per-step state
 * + per-step session ids. Never throws on a STEP failure (the run records "failed"); it
 * throws only on a malformed/ missing workflow (a programming/data error at the boundary).
 */
export async function runWorkflow(deps: RunWorkflowDeps): Promise<RunWorkflowResult> {
	const { db, bus, runtime } = deps;

	// Resolve the workflow row.
	const wf = typeof deps.workflow === 'string' ? await getWorkflow(db, deps.workflow) : deps.workflow;
	if (!wf) throw new Error(`workflow not found: ${String(deps.workflow)}`);
	const projectId = deps.projectId ?? wf.project;
	if (!projectId) throw new Error('runWorkflow: a projectId is required (workflow has no project)');

	const steps = wf.steps;

	// 1. CREATE the workflow_run — every step starts "pending" (a concrete value, never
	// NONE — the schema DEFAULTs status="running" + step_state={}; we set the full map).
	const stepState: Record<string, StepStatus> = {};
	for (const s of steps) stepState[s.id] = 'pending';
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE workflow_run CONTENT $content RETURN AFTER;`,
		{ content: { workflow: link(wf.id), status: 'running', step_state: stepState } }
	);
	const runId = String(created[0].id);
	const rid = link(runId);

	const sessions: Record<string, string> = {};

	/** Persist the current step_state map (rewritten wholesale via a bound $param). */
	const persistStepState = async (): Promise<void> => {
		await db.query(`UPDATE $rid SET step_state = $state;`, { rid, state: { ...stepState } });
	};

	/** A step is ready when it is pending AND every dependency is "done". */
	const isReady = (s: WorkflowStep): boolean =>
		stepState[s.id] === 'pending' && (s.depends_on ?? []).every((d) => stepState[d] === 'done');

	/** Run ONE step as a workflow-step session (launchSession, workflowRunId set). */
	const runStep = async (s: WorkflowStep): Promise<void> => {
		stepState[s.id] = 'running';
		await persistStepState();
		try {
			const res: LaunchResult = await launchSession({
				db,
				bus,
				runtime,
				input: {
					projectId,
					// A workflow step has NO task row — its prompt rides on promptTask (D-013).
					promptTask: { id: `${runId}:${s.id}`, title: `workflow step ${s.id}`, description: s.prompt },
					cwd: s.cwd, // step cwd override (D-013)
					agentId: s.agent,
					model: s.model,
					intent: deps.intent ?? 'code-write',
					budgets: deps.budgets ?? DEFAULT_BUDGETS,
					toolPolicy: deps.toolPolicy ?? DEFAULT_TOOL_POLICY,
					workflowRunId: runId // ties the step session to this run (§4.11)
				}
			});
			sessions[s.id] = res.sessionId;
			stepState[s.id] = res.status === 'done' ? 'done' : 'failed';
		} catch {
			// A step that throws (launch failure) marks the step failed — never crash the run.
			stepState[s.id] = 'failed';
		}
		await persistStepState();
	};

	// 2. Drive the DAG wave by wave until no step can make progress.
	let anyFailed = false;
	for (;;) {
		// If any step has failed, its dependents can never become ready — stop scheduling.
		if (Object.values(stepState).includes('failed')) {
			anyFailed = true;
			break;
		}
		const ready = steps.filter(isReady);
		if (ready.length === 0) break; // nothing ready → either all done, or a stall

		// A non-parallel ready step is a serialization point: run it ALONE this wave so it
		// fully completes before any peer starts. Parallel-ready steps run concurrently.
		const parallelReady = ready.filter((s) => s.parallel !== false);
		const wave = parallelReady.length > 0 ? parallelReady : [ready[0]];
		await Promise.all(wave.map((s) => runStep(s)));
	}

	// 3. Terminal status: done iff EVERY step is done; else failed (a failure or a stall —
	// e.g. an unreachable step left pending behind a failed dependency).
	const allDone = steps.every((s) => stepState[s.id] === 'done');
	const status: WorkflowRunStatus = allDone && !anyFailed ? 'done' : 'failed';

	await db.query(`UPDATE $rid SET status = $status, ended_at = $ended;`, {
		rid,
		status,
		ended: new Date()
	});

	return { runId, status, stepState: { ...stepState }, sessions };
}
