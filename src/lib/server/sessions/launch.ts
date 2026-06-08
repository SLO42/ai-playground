// TASK 1.6b — session launch + persistence plumbing (the NON-LIVE half of 1.6).
// (ARCHITECTURE §2.3/§2.11; DATA-MODEL §4.3 session/message, §4.4 agent_event; D-011.)
//
// This is the path that LAUNCHES a Claude Code session for a project+task via the 1.4
// AgentRuntime, CONSUMES the runtime's RuntimeEvent stream, and PERSISTS the session
// (+ the cc_session_id bridge), each transcript event as a `message` row, and the
// run's lifecycle as `agent_event` rows — while republishing each transcript event
// onto the one `events` bus so the dashboard renders it LIVE (the SSE fan-out from
// 1.5 is the sole consumer; §2.11).
//
// What this module does NOT do (deliberately, this wave):
//   • It does not spawn a REAL credentialed Claude Code session — there is no
//     CLAUDE_CODE_OAUTH_TOKEN in this wave. The launch logic is identical for the
//     real backend; the capstone live transcript is deferred to the credential wave.
//     A mocked/sandboxed runtime (1.4's CcBackend seam) drives the test — allowed
//     (a mocked runtime in a TEST is not fabricated PRODUCT data; F-008 still holds:
//     every row read back came from the real DB the runtime stream actually produced).
//
// Boundary discipline (D-016): every VALUE binds via $param; the only interpolated
// tokens are record ids validated at the db/validate.ts chokepoint and wrapped as
// StringRecordId so the SDK serializes true record links. Optional fields are OMITTED
// (option<T> rejects explicit NULL — MEMORY-SPEC §6.1). cwd is the PROJECT ROOT,
// passed explicitly (D-002 / 1.4a); the isolated config + permissions.deny guardrail
// ride on the SpawnRequest the runtime turns into a plan (1.4 / 1.4a).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import { writeAgentEvent } from '../analytics/events';
import { getProject } from '../projects/repo';
import type {
	AgentRuntime,
	Intent,
	ModelSelection,
	RuntimeEvent,
	SpawnBudgets,
	ToolPolicy,
	ContextBundle,
	CapabilitySet
} from '../runtime/index';

// ── Input / result shapes ──────────────────────────────────────────────────────

export interface LaunchInput {
	/** Project record id — its root_path becomes the session cwd (D-002 / 1.4a). */
	projectId: string;
	/**
	 * Task record id — the work the session performs; its title/description seed the
	 * prompt. OPTIONAL: a workflow STEP (D-013) has no task — its prompt comes from the
	 * step definition via `promptTask`. Exactly one of `taskId` / `promptTask` must be set.
	 */
	taskId?: string;
	/**
	 * A synthetic task shape supplying the prompt when there is no `taskId` (workflow
	 * steps, D-013). Title/description seed the runtime prompt exactly as a real task
	 * would; the session row carries no task link. Never mutated in place (D-008).
	 */
	promptTask?: { id: string; title: string; description: string };
	/**
	 * Project working dir override (D-013): a workflow step may run in a `cwd` distinct
	 * from the project root. When absent, the project root is used (D-002 / 1.4a default).
	 */
	cwd?: string;
	/** Agent slot id this session runs as (carried into the isolated config dir). */
	agentId: string;
	/** Chosen model (from Routing in a later wave; explicit here). */
	model: ModelSelection;
	intent: Intent;
	budgets: SpawnBudgets;
	toolPolicy: ToolPolicy;
	/** Recalled context — a SEPARATE field, never folded into the task (D-008). */
	context?: ContextBundle;
	/**
	 * Per-task capability set from the resolved intent bundle (D-036 / TASK 5.1). Passed
	 * straight onto the SpawnRequest so the runtime composes harness-base ⊕ THIS set into
	 * the isolated config (catalog-validated, fail closed). Absent ⇒ the harness base only.
	 * NEVER the operator's whole plugin set — D-002 isolation is preserved in the composer.
	 */
	capabilities?: CapabilitySet;
	/** Set when this session is a workflow step (D-013). */
	workflowRunId?: string;
}

export interface LaunchResult {
	/** The persisted `session` record id (e.g. 'session:abc'). */
	sessionId: string;
	/** The Claude Code session id bridged from the runtime, if it reported one. */
	ccSessionId?: string;
	/** Final status the session ended in. */
	status: SessionStatus;
	/** The runtime's final summary. */
	summary: string;
}

export type SessionStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface LaunchDeps {
	db: Db;
	bus: EventBus;
	runtime: AgentRuntime;
	input: LaunchInput;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

/** Map a RuntimeEvent → the `message` row it persists (or null if it is not a message). */
function eventToMessage(
	ev: RuntimeEvent
): { role: 'assistant' | 'tool'; content: string; tool_call?: Record<string, unknown> } | null {
	switch (ev.type) {
		case 'log':
			return { role: 'assistant', content: ev.message };
		case 'tool_call':
			return {
				role: 'tool',
				content: `→ ${ev.name}`,
				tool_call: { name: ev.name, args: ev.args, needs_confirm: ev.needsConfirm }
			};
		case 'tool_result':
			return {
				role: 'tool',
				content: ev.output,
				tool_call: { name: ev.name, ok: ev.ok, phase: 'result' }
			};
		default:
			// token_usage / done / error are lifecycle, not transcript messages —
			// they become agent_event rows / status writes, not message rows.
			return null;
	}
}

// ── The launch + persistence engine ──────────────────────────────────────────────

/**
 * Launch a Claude Code session for `input.projectId` + `input.taskId`, consume the
 * runtime stream, and persist session(+cc_session_id) + message + agent_event rows,
 * republishing each transcript event onto the bus for live render.
 *
 * Sequence:
 *   1. Resolve the project root → the session cwd (D-002 / 1.4a). Fail if missing.
 *   2. CREATE the `session` row (status "running") + a `spawn` agent_event — so the
 *      fleet view shows the running session and analytics records the spawn the
 *      INSTANT it starts (analytics is first-class — every agent event is logged).
 *   3. spawn() the runtime and stream: each transcript event → a `message` row +
 *      a `transcript` bus event; token_usage accumulates; done/error decide the
 *      terminal status + the `completion`/`error` agent_event.
 *   4. UPDATE the session terminal status + ended_at + cc_session_id bridge.
 *
 * Every record id flows through the D-016 chokepoint; every value binds via $param.
 */
export async function launchSession(deps: LaunchDeps): Promise<LaunchResult> {
	const { db, bus, runtime, input } = deps;

	// 1. Resolve project root → cwd. The session runs at the project root (1.4a) unless
	// a workflow step supplies an explicit cwd override (D-013).
	const project = await getProject(db, input.projectId);
	if (!project) throw new Error(`project not found: ${input.projectId}`);
	const cwd = input.cwd ?? project.root_path;

	// Resolve the prompt source. Exactly one of taskId / promptTask drives the prompt:
	//   • taskId    — read the real task; its title/description seed the prompt (D-008).
	//   • promptTask — a workflow step (D-013) with no task row; its prompt is supplied.
	let task: { id: unknown; title: string; description: string } | undefined;
	if (input.taskId) {
		const [taskRows] = await db.query<
			[Array<{ id: unknown; title: string; description: string }>]
		>(`SELECT id, title, description FROM ONLY $tid;`, { tid: link(input.taskId) });
		task = (Array.isArray(taskRows) ? taskRows[0] : taskRows) as typeof task;
		if (!task) throw new Error(`task not found: ${input.taskId}`);
	} else if (input.promptTask) {
		task = input.promptTask;
	} else {
		throw new Error('launchSession requires either taskId or promptTask');
	}

	// 2. CREATE the session row (status "running") — first-class from the instant it starts.
	const sessionContent = omitUndefined({
		project: link(input.projectId),
		// A workflow step (D-013) has no task link — task is option<record<task>>, so omit
		// it rather than nulling (§6.1). The workflow_run link below ties the step to its run.
		task: input.taskId ? link(input.taskId) : undefined,
		kind: 'task',
		model: {
			provider: input.model.provider,
			model_id: input.model.modelId,
			tier: input.model.tier
		},
		runtime: 'claude-code',
		workflow_run: input.workflowRunId ? link(input.workflowRunId) : undefined
	});
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{ content: sessionContent }
	);
	const sessionId = String(created[0].id);
	const sid = link(sessionId);

	// A spawn agent_event the moment the session starts (analytics first-class). The
	// shared writer (2.4) is the one chokepoint; the detail carries the how/why (intent
	// + spawn reason) so the action's decision chain is traceable end-to-end.
	await writeAgentEvent(db, {
		session: sessionId,
		project: input.projectId,
		type: 'spawn',
		model: input.model,
		detail: { intent: input.intent, reason: `spawn for ${input.intent}` }
	});

	// 3. Spawn the runtime and consume the stream.
	const startedAt = Date.now();
	let tokensIn = 0;
	let tokensOut = 0;
	let ccSessionId: string | undefined;
	let summary = '';
	let ok = true;
	let sawDone = false;

	const req = {
		agentId: input.agentId,
		projectId: input.projectId,
		cwd, // EXPLICIT project root (D-002 / 1.4a)
		model: input.model,
		intent: input.intent,
		task: { id: String(task.id), title: task.title, description: task.description },
		context: input.context,
		budgets: input.budgets,
		toolPolicy: input.toolPolicy,
		// D-036: the resolved intent bundle's capability set rides onto the SpawnRequest so
		// the runtime's composeCapabilities validates + composes it against the live catalog.
		capabilities: input.capabilities,
		workflowRunId: input.workflowRunId
	};

	let order = 0;
	for await (const ev of runtime.spawn(req)) {
		// Republish onto the bus for LIVE render — one transcript event per stream
		// event, topic = the session id so the SSE layer routes it to that session's
		// view; `key` = session id+seq so high-frequency events coalesce sanely (§2.11).
		bus.publish({
			type: 'transcript',
			topic: sessionId,
			key: `${sessionId}:${order}`,
			data: { kind: ev.type, seq: order, event: ev }
		});
		order++;

		// Persist transcript messages.
		const msg = eventToMessage(ev);
		if (msg) {
			await db.query(`CREATE message CONTENT $content;`, {
				content: omitUndefined({
					session: sid,
					role: msg.role,
					content: msg.content,
					tool_call: msg.tool_call
				})
			});
			continue;
		}

		// Lifecycle events.
		if (ev.type === 'token_usage') {
			tokensIn += ev.input;
			tokensOut += ev.output;
			// TASK 2.1 (harden): besides the per-seq `transcript` event above (which the
			// message log must never lose), publish a dedicated high-frequency `token_usage`
			// event keyed by the SESSION id (stable). The stable key is what lets the SSE
			// fan-out coalesce latest-wins under backpressure (§2.11) — a slow client gets
			// only the newest cumulative figure per session, never a stalling backlog. The
			// transcript event's key is sessionId:seq (every one distinct), so it is the
			// WRONG carrier for coalescing; this is the right one.
			bus.publish({
				type: 'token_usage',
				topic: sessionId,
				key: sessionId,
				data: { tokensIn, tokensOut }
			});
		} else if (ev.type === 'error') {
			ok = false;
			await writeAgentEvent(db, {
				session: sessionId,
				project: input.projectId,
				type: 'error',
				detail: { error: ev.error }
			});
		} else if (ev.type === 'done') {
			sawDone = true;
			ok = ev.result.ok;
			summary = ev.result.summary;
			if (ev.result.ccSessionId) ccSessionId = ev.result.ccSessionId;
		}
	}

	const status: SessionStatus = sawDone ? (ok ? 'done' : 'failed') : 'failed';
	const durationMs = Date.now() - startedAt;

	// 4. Terminal update: status + ended_at + cc_session_id bridge (the session record
	// carries cc_session_id — D-011). Optionals omitted, not nulled (§6.1).
	await db.query(`UPDATE $sid MERGE $content;`, {
		sid,
		content: omitUndefined({
			status,
			ended_at: new Date(),
			cc_session_id: ccSessionId
		})
	});

	// A completion agent_event with token totals + duration (analytics first-class).
	await writeAgentEvent(db, {
		session: sessionId,
		project: input.projectId,
		type: 'completion',
		model: input.model,
		tokensIn,
		tokensOut,
		durationMs,
		detail: { ok, summary }
	});

	return { sessionId, ccSessionId, status, summary };
}

// agent_event rows are written via the shared analytics writer (writeAgentEvent,
// analytics/events.ts — the one chokepoint, TASK 2.4). The old local insertAgentEvent
// helper was folded into it so every producer shares one shape + the how/why contract.
