// TASK 2.17 — workflow repo (headless CC pipelines, D-013; DATA-MODEL §4.11).
//
// Persists a `workflow` definition and reads `workflow`/`workflow_run` rows. The
// schema (§4.11) types `steps` as an untyped `array<object>`; the RUNTIME validates
// each step's shape — {id, prompt, agent, model, cwd, depends_on, parallel} — AND the
// dependency DAG (no missing/duplicate ids, no self-/cyclic depends_on) BEFORE persist,
// exactly as the §4.11 comment mandates ("the runtime validates … before persist").
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated
// token is the validated project record id, wrapped as StringRecordId at the
// db/validate.ts chokepoint. Absent optionals are OMITTED, not nulled (§6.1).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { ModelSelection } from '../runtime/index';

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

// ── Step + workflow shapes (the runtime-validated contract over §4.11) ───────────

/**
 * One workflow step (D-013). A step is a single headless Claude Code run: a `prompt`,
 * the `agent` slot to run as, the `model`, the `cwd` to run in, the step ids it
 * `depends_on`, and whether it MAY run in `parallel` with its dependency-free peers.
 */
export interface WorkflowStep {
	/** Unique step id within the workflow (the depends_on / step_state key). */
	id: string;
	/** The headless run's prompt (seeds the session prompt; never a task row). */
	prompt: string;
	/** Agent slot id this step runs as. */
	agent: string;
	/** Model selection for this step (provider/modelId/tier). */
	model: ModelSelection;
	/** Working dir for this step (D-013 may differ from the project root). */
	cwd: string;
	/** Step ids that MUST complete before this step may start (the DAG edges). */
	depends_on?: string[];
	/** Whether this step may run concurrently with its ready peers (default true). */
	parallel?: boolean;
}

export type WorkflowTrigger = 'manual' | 'event' | 'periodic';

export interface CreateWorkflowInput {
	name: string;
	/** Optional owning project (its root is the default cwd if a step omits one). */
	project?: string;
	steps: WorkflowStep[];
	/** When the workflow fires (D-013). Default 'manual'. */
	trigger?: WorkflowTrigger;
}

export interface WorkflowRow {
	id: string;
	name: string;
	project?: string;
	steps: WorkflowStep[];
	trigger: WorkflowTrigger;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type WorkflowRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface WorkflowRunRow {
	id: string;
	workflow: string;
	status: WorkflowRunStatus;
	step_state: Record<string, StepStatus>;
}

const TRIGGERS: readonly WorkflowTrigger[] = ['manual', 'event', 'periodic'];

/**
 * Validate the step list + dependency DAG BEFORE persist (§4.11). Throws loudly at the
 * call site (D-016 discipline) on any malformed step or illegal dependency graph:
 *   • each step shape complete + well-typed;
 *   • step ids unique + non-empty;
 *   • every depends_on id references an existing step (no dangling edge);
 *   • no self-dependency and no cycle (the graph must be a DAG so a topological run
 *     order exists — a cyclic pipeline could never complete).
 */
export function validateSteps(steps: unknown): asserts steps is WorkflowStep[] {
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error('workflow.steps must be a non-empty array');
	}
	const ids = new Set<string>();
	for (const s of steps as WorkflowStep[]) {
		if (!s || typeof s !== 'object') throw new Error('workflow step must be an object');
		if (typeof s.id !== 'string' || !s.id) throw new Error('workflow step.id must be a non-empty string');
		if (ids.has(s.id)) throw new Error(`duplicate workflow step id: ${s.id}`);
		ids.add(s.id);
		if (typeof s.prompt !== 'string' || !s.prompt) throw new Error(`step ${s.id}: prompt required`);
		if (typeof s.agent !== 'string' || !s.agent) throw new Error(`step ${s.id}: agent required`);
		if (typeof s.cwd !== 'string' || !s.cwd) throw new Error(`step ${s.id}: cwd required`);
		const m = s.model;
		if (!m || typeof m !== 'object' || typeof m.provider !== 'string' || typeof m.modelId !== 'string') {
			throw new Error(`step ${s.id}: model {provider, modelId} required`);
		}
		if (s.depends_on !== undefined) {
			if (!Array.isArray(s.depends_on) || s.depends_on.some((d) => typeof d !== 'string')) {
				throw new Error(`step ${s.id}: depends_on must be a string[]`);
			}
		}
		if (s.parallel !== undefined && typeof s.parallel !== 'boolean') {
			throw new Error(`step ${s.id}: parallel must be a boolean`);
		}
	}
	// Edge legality: every depends_on id exists; no self-edge.
	for (const s of steps as WorkflowStep[]) {
		for (const dep of s.depends_on ?? []) {
			if (dep === s.id) throw new Error(`step ${s.id}: cannot depend on itself`);
			if (!ids.has(dep)) throw new Error(`step ${s.id}: depends_on unknown step "${dep}"`);
		}
	}
	// Acyclicity (DAG): a Kahn-style topological pass must consume every node. The set/array
	// legality lives in JS, not SurrealQL (HARD RULE) — this is plain graph math.
	assertAcyclic(steps as WorkflowStep[]);
}

/** Throw if the depends_on graph contains a cycle (Kahn's algorithm). */
function assertAcyclic(steps: WorkflowStep[]): void {
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const s of steps) {
		indeg.set(s.id, (s.depends_on ?? []).length);
		dependents.set(s.id, dependents.get(s.id) ?? []);
		for (const dep of s.depends_on ?? []) {
			dependents.set(dep, [...(dependents.get(dep) ?? []), s.id]);
		}
	}
	const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
	let visited = 0;
	while (queue.length) {
		const id = queue.shift()!;
		visited++;
		for (const next of dependents.get(id) ?? []) {
			const d = (indeg.get(next) ?? 0) - 1;
			indeg.set(next, d);
			if (d === 0) queue.push(next);
		}
	}
	if (visited !== steps.length) throw new Error('workflow steps contain a dependency cycle');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function normWorkflow(row: WorkflowRow & { id: unknown; project?: unknown }): WorkflowRow {
	return {
		...row,
		id: String(row.id),
		project: row.project != null ? String(row.project) : undefined
	};
}

/**
 * Persist a workflow definition. The step list + DAG are validated FIRST (§4.11);
 * a malformed pipeline never reaches the DB. The project link is validated at the
 * D-016 chokepoint; absent optionals are omitted (§6.1).
 */
export async function createWorkflow(db: Db, input: CreateWorkflowInput): Promise<WorkflowRow> {
	validateSteps(input.steps);
	if (input.trigger !== undefined && !TRIGGERS.includes(input.trigger)) {
		throw new Error(`invalid workflow trigger: ${String(input.trigger)}`);
	}
	const content = omitUndefined({
		name: input.name,
		project: input.project ? link(input.project) : undefined,
		// steps persist as plain objects (schema array<object>); the validated shape rides along.
		steps: input.steps.map((s) =>
			omitUndefined({
				id: s.id,
				prompt: s.prompt,
				agent: s.agent,
				model: { provider: s.model.provider, modelId: s.model.modelId, tier: s.model.tier },
				cwd: s.cwd,
				depends_on: s.depends_on,
				parallel: s.parallel
			})
		),
		trigger: input.trigger
	});
	const [rows] = await db.query<[(WorkflowRow & { id: unknown; project?: unknown })[]]>(
		`CREATE workflow CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normWorkflow(rows[0]);
}

export async function getWorkflow(db: Db, id: string): Promise<WorkflowRow | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[(WorkflowRow & { id: unknown; project?: unknown })[]]>(
		`SELECT * FROM $rid;`,
		{ rid }
	);
	return rows[0] ? normWorkflow(rows[0]) : null;
}

export async function getWorkflowRun(db: Db, id: string): Promise<WorkflowRunRow | null> {
	const rid = new StringRecordId(assertRecordId(id));
	const [rows] = await db.query<[(WorkflowRunRow & { id: unknown; workflow: unknown })[]]>(
		`SELECT * FROM $rid;`,
		{ rid }
	);
	const r = rows[0];
	if (!r) return null;
	return { ...r, id: String(r.id), workflow: String(r.workflow) };
}
