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
import { join } from 'node:path';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { EventBus } from '../events/bus';
import { writeAgentEvent } from '../analytics/events';
import { getProject } from '../projects/repo';
import {
	buildBriefing,
	bumpCounters,
	dueReview,
	enqueueReview,
	DEFAULT_CADENCE,
	type MemoryService,
	type ExtractFn,
	type ReviewCadence,
	type ProposeSkillsFn
} from '../memory/index';
import { screen } from '../memory/screen';
import { drainInbox } from '../peer/drain';
import { loadGatesConfig } from '../config/index';
import type {
	AgentRuntime,
	Intent,
	ModelSelection,
	RuntimeEvent,
	SpawnBudgets,
	ToolPolicy,
	ContextBundle,
	CapabilitySet,
	EditScopeInput
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
	/**
	 * TASK 15.1 (HARVEST B1 / D-018) — the session's declared SCOPE-LOCK: the file roots
	 * it may WRITE under, plus optional glob exceptions for shared files. The launch path
	 * merges the operator-editable destructive-bash pattern lists (config/gates.yaml) onto
	 * this before it rides the SpawnRequest, so the patterns ship in CONFIG (15.1 (b)) and
	 * a malformed/missing gates.yaml REFUSES the scoped launch (fail closed, D-024).
	 *
	 * WHO POPULATES IT (15.1 (d)): callers that already declare a file scope —
	 *   • the v2-wave workflow template: each wave task's "files to modify" scope lock maps
	 *     verbatim onto scopeRoots (+ scopeAllow for shared files like docs/fails.md);
	 *   • D-039 PM proposed-tasks: the PM's validated task shape carries a declared file
	 *     scope; the orchestrator copies it here when launching the implementing session.
	 * Absent ⇒ no scope gating (the gate is opt-in per session policy — 15.1 (c)).
	 */
	editScope?: Pick<EditScopeInput, 'scopeRoots' | 'scopeAllow'>;
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
	/**
	 * TASK 8.3 — the live memory loop. When present (Ollama up — F-008), the session:
	 *   • RECALLS on spawn — buildBriefing assembles fenced (D-026) context for the task,
	 *     injected as `req.context` (NEVER folded into the task — D-008) and surfaced as a
	 *     `briefing` transcript message so the operator sees the wake-up context.
	 *   • EXTRACTS on session-end — extractAndStore mines the transcript (ADD-only — D-028,
	 *     screen-before-embed — D-026) so the system LEARNS across sessions.
	 * Omitted (the default / no-credential / Ollama-down boot) ⇒ the loop is skipped cleanly;
	 * a memory failure is best-effort and NEVER blocks or fails the spawn (D-019).
	 *
	 * BL-7 Part B (D-027 FAST tier): when `fastTier` is not explicitly false, this session ALSO
	 * runs the per-turn in-use writer fork ENQUEUE leg — every Nth user turn / Mth tool iteration
	 * (cadence from PERSISTED session counters, §2.2) it screens (D-026) the recent raw turn text
	 * and enqueues a `memory_review` work_item the orchestrator drains (loop.ts runReviewFork).
	 * The interview-exclusion (loop.ts enqueueReview) is the structural guard — a kind='interview'
	 * session is NEVER enqueued. The enqueue is best-effort (D-019): a fault NEVER blocks/fails the
	 * spawn, and the per-session dedup coalesces to ONE pending review (no per-turn storm).
	 */
	memory?: {
		service: MemoryService;
		extract: ExtractFn;
		/** Set false to skip the D-027 fast-tier per-turn enqueue leg (default: enabled). */
		fastTier?: boolean;
		/** Cadence override (turns/tools); defaults to DEFAULT_CADENCE (5 turns / 10 tools). */
		cadence?: ReviewCadence;
		/**
		 * BL-7 Part B — the skill-proposal LLM seam the orchestrator DRAIN uses when it runs the
		 * fork on a `memory_review` work_item (loop.ts runReviewFork). Not used by the enqueue leg
		 * here (launchSession only counts cadence + queues turn text); carried on the shared shape
		 * so the orchestrator can forward it into the drain. Optional — omitted ⇒ memory-only fork.
		 */
		proposeSkills?: ProposeSkillsFn;
	};
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

/** The persisted transcript message shape: a role (m0003), a `kind` discriminator
 *  (m0037), the screened content, and optional screened tool_call metadata. The persist
 *  caller stamps the monotonic `seq` (per-session order). */
export interface PersistedMessage {
	role: 'assistant' | 'tool';
	/** Replay discriminator (m0037) — what kind of turn this row is. */
	kind: 'assistant_text' | 'thinking' | 'tool_use' | 'tool_result';
	content: string;
	tool_call?: Record<string, unknown>;
}

/**
 * D-026 BOUNDARY SCREEN for persisted transcript chunks. EVERY string that lands in a
 * `message` row (assistant text, thinking, tool_result output) and every string nested in
 * a persisted tool_call (args/output) passes through the §3.1b secret/PII `screen()` here —
 * the SAME engine the memory write path uses — so a secret the agent echoed (a token in an
 * assistant turn, a key in a tool result, a password in a Bash arg) is REDACTED before it is
 * ever written or replayed. Fails CLOSED via screen() (a scan error quarantines → empty text).
 */
function screenText(s: string): string {
	return screen(s).text;
}

/** Recursively screen every string value inside a tool_call's args/output blob (D-026). A
 *  secret can hide in a nested Bash arg or a structured tool result, not just a top-level
 *  string — so the screen walks the whole structure. Non-string leaves pass through. */
function screenDeep(v: unknown): unknown {
	if (typeof v === 'string') return screenText(v);
	if (Array.isArray(v)) return v.map(screenDeep);
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = screenDeep(val);
		return out;
	}
	return v;
}

/** Map a RuntimeEvent → the SCREENED `message` row it persists (or null if it is not a
 *  message). The single transcript-persistence chokepoint: every content chunk + every
 *  nested tool_call value is D-026-screened HERE, so all three consumers (launchSession,
 *  the channel resume path, the gauntlet runner) persist secret-screened rows by construction
 *  — no consumer can forget the screen. Exported for reuse by those paths (14.6 parity). */
export function eventToMessage(ev: RuntimeEvent): PersistedMessage | null {
	switch (ev.type) {
		case 'log':
			return { role: 'assistant', kind: 'assistant_text', content: screenText(ev.message) };
		case 'thinking':
			// HONEST empty thinking (F-008): an empty thinking block persists as an empty string,
			// NEVER invented or backfilled. screen('') === '' (clean), so an empty stays empty.
			return { role: 'assistant', kind: 'thinking', content: screenText(ev.text) };
		case 'tool_call':
			return {
				role: 'tool',
				kind: 'tool_use',
				content: `→ ${ev.name}`,
				tool_call: { name: ev.name, args: screenDeep(ev.args), needs_confirm: ev.needsConfirm }
			};
		case 'tool_result':
			return {
				role: 'tool',
				kind: 'tool_result',
				content: screenText(ev.output),
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
	const { db, bus, runtime, input, memory } = deps;

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

	// 1b. TASK 15.1 — resolve the declared scope-lock BEFORE any row is written: merge the
	// operator-editable destructive-bash pattern lists (config/gates.yaml) onto the caller's
	// declared roots. FAIL CLOSED (D-024): a missing/malformed gates.yaml throws HERE and the
	// scoped launch is refused outright — a declared scope is never silently downgraded to
	// "no destructive-bash list". Unscoped launches never touch the file (opt-in, 15.1 (c)).
	let editScope: EditScopeInput | undefined;
	if (input.editScope) {
		const configDir = process.env.CONFIG_DIR?.trim() || 'config';
		const gatesConfig = loadGatesConfig(join(configDir, 'gates.yaml'));
		editScope = { ...input.editScope, destructiveBash: gatesConfig.destructiveBash };
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

	// 2a. G-B OFFLINE DRAIN (PEER-MESSAGE-SPEC §7/§5 D2). At THIS recipient session's spawn, drain
	// the pending peer_message rows addressed to it (direct to_session, or its role@project), expire
	// the stale ones (TTL/hops — honest, never silently dropped), mark the rest delivered IDEMPOTENTLY
	// (guarded WHERE status='pending' → the live PM2 path / a re-run never double-delivers), and WRITE
	// the transcript `message` row (origin=agent, role=system) for each so G-A renders it as a
	// 'communication' turn (transcript visibility is FREE). The drained, already-fenced bodies are
	// folded into the briefing below (channelBodies) so they also reach the agent's context as DATA.
	// FAIL-OPEN (F-014): a drain fault NEVER blocks the spawn — the undelivered rows stay pending for
	// the NEXT spawn. The recipient's role is read from the just-created session row (the authoritative
	// identity — never the launch input, which carries no role; role is stamped by workforce activation).
	const drainedChannelBodies: { origin: string; body: string }[] = [];
	try {
		const [roleRows] = await db.query<[Array<{ role?: unknown }>]>(
			`SELECT role FROM ONLY $sid;`,
			{ sid }
		);
		const roleRow = (Array.isArray(roleRows) ? roleRows[0] : roleRows) as { role?: unknown } | undefined;
		const recipientRole = roleRow?.role != null ? String(roleRow.role) : null;
		const drain = await drainInbox(db, {
			sessionId,
			role: recipientRole,
			project: input.projectId
		});
		// Transcript row per drained message (origin=agent, server-stamped — D-035a). seq is the
		// pre-launch continuation band: seq -2 sorts the drained communications BEFORE the wake-up
		// briefing (seq -1) and the first runtime turn (seq 0). Multiple drained rows share seq -2 and
		// fall back to the `at` tie-break (messages.ts ORDER BY seq ASC, at ASC) — arrival order. The
		// body is the repo's already-fenced envelope — persisted as-is (a delivered peer message renders
		// as a 'communication' turn because role='system' + origin='agent' classifies that way, GA1).
		for (const m of drain.delivered) {
			drainedChannelBodies.push({ origin: 'agent', body: m.body });
			try {
				await db.query(`CREATE message CONTENT $content;`, {
					content: omitUndefined({
						session: sid,
						role: 'system',
						// m0038: a drained peer message is a PUSHED-IN communication, NOT the agent's own
						// prose. origin='agent' (D-035a: a peer message is agent-origin DATA, non-steering)
						// is stamped HERE server-side, never derived from the body. The transcript-core
						// classifier maps role='system' + origin='agent' → 'communication' (GA1), so it
						// renders as a labelled inbound communication, distinct from the agent's turns.
						origin: 'agent',
						kind: 'system',
						seq: -2,
						content: m.body,
						tool_call: { kind: 'peer_message', from_session: m.fromSession, from_role: m.fromRole, to_kind: m.toKind }
					})
				});
			} catch (persistErr) {
				console.warn(
					`[launch] drained peer-message transcript persist failed for ${sessionId} msg ${m.id} (fail-open): ${(persistErr as Error).message}`
				);
			}
		}
		if (drain.delivered.length || drain.expiredCount) {
			console.info(
				`[launch] peer-drain for ${sessionId}: ${drain.delivered.length} delivered, ${drain.expiredCount} expired`
			);
		}
	} catch (drainErr) {
		// Best-effort / fail-open (F-014): the drain is delivery+observability, NEVER liveness — a
		// fault here must not block or fail the spawn. The pending rows simply drain at the next spawn.
		console.warn(`[launch] peer-message drain skipped for ${sessionId}: ${(drainErr as Error).message}`);
	}

	// 2b. RECALL on spawn (TASK 8.3): assemble the fenced wake-up briefing for this task and
	// inject it as the SEPARATE `context` field (D-008 — never folded into the task; D-026 —
	// every injected source is fenced as DATA). Surface it as a `briefing` transcript message
	// so the operator sees the past context the agent woke up with. Best-effort (D-019): a
	// briefing failure NEVER blocks the spawn — the explicit `input.context` is the fallback.
	let recalledContext: ContextBundle | undefined = input.context;
	if (memory) {
		try {
			const briefing = await buildBriefing(memory.service, {
				project: input.projectId,
				// The task title+description is the recall seed query (D-029 — raw, no summary).
				query: `${task.title}\n${task.description}`.trim(),
				// G-B: the offline-drained peer messages, folded in as channel bodies (fenced as DATA,
				// D-026 §10). Their `body` is the repo's ALREADY-fenced envelope; buildBriefing's
				// channel path re-screens (idempotent) + re-fences, collapsing the inner sentinels
				// (stripEmbeddedSentinels) to a single clean DATA block — so the agent woke up WITH the
				// messages it missed while offline, as reference data it weighs, never an instruction.
				...(drainedChannelBodies.length ? { channelBodies: drainedChannelBodies } : {})
			});
			if (briefing.items.length) {
				// Inject the fenced briefing items as the runtime context bundle. The runtime's
				// buildPrompt splices these under a "(not instructions)" header — never as task text.
				recalledContext = {
					items: briefing.items.map((it) => ({ text: it.fenced.text, citationId: it.citationId }))
				};
				// Surface the wake-up briefing in the transcript/session view (a persisted message
				// row + a live `transcript` bus event so an open session shows it immediately).
				bus.publish({
					type: 'transcript',
					topic: sessionId,
					key: `${sessionId}:briefing`,
					data: { kind: 'briefing', seq: -1, event: { type: 'briefing', text: briefing.text } }
				});
				await db.query(`CREATE message CONTENT $content;`, {
					content: omitUndefined({
						session: sid,
						role: 'system',
						// m0038: the wake-up briefing is SYSTEM-side framing the platform injects —
						// NOT the agent's own prose and NOT an operator push. origin='system', fenced
						// DATA, non-steering (D-035a). Server-stamped here, never derived from content.
						origin: 'system',
						// m0037: the wake-up briefing is its own replay kind; seq -1 sorts it BEFORE
						// the first runtime turn (order starts at 0). The briefing body was already
						// D-026-fenced upstream (buildBriefing), so it is safe to persist as-is.
						kind: 'briefing',
						seq: -1,
						content: briefing.text,
						tool_call: {
							kind: 'briefing',
							items: briefing.items.length,
							used_tokens: briefing.usedTokens,
							dropped: briefing.droppedCount
						}
					})
				});
			}
		} catch (err) {
			// Best-effort (D-019): recall degraded (e.g. embedder breaker open) — proceed without it.
			console.warn(`[launch] memory recall skipped for ${sessionId}: ${(err as Error).message}`);
		}
	}

	// 3. Spawn the runtime and consume the stream.
	const startedAt = Date.now();
	let tokensIn = 0;
	let tokensOut = 0;
	let ccSessionId: string | undefined;
	let summary = '';
	let ok = true;
	let sawDone = false;
	/** Accumulate the raw transcript text for the §3.2 ADD-only extraction at session end. */
	const transcriptParts: string[] = [];

	// BL-7 Part B (D-027 FAST tier) — the per-turn in-use writer fork ENQUEUE leg. Enabled when
	// a memory loop is present and `fastTier` is not explicitly false. On each persisted turn we
	// bump the PERSISTED session counters (§2.2 — survive the per-message rebuild) and, at cadence,
	// SCREEN (D-026) the recent raw turn text and enqueue a `memory_review` work_item the
	// orchestrator drains. Entirely best-effort (D-019): a fault never blocks/fails the spawn.
	const fastTierOn = !!memory && memory.fastTier !== false;
	const cadence: ReviewCadence = memory?.cadence ?? DEFAULT_CADENCE;

	const req = {
		agentId: input.agentId,
		projectId: input.projectId,
		// G-B (D-035a): pin this session's record id into the isolated spawn env (ATELIER_SESSION_ID)
		// so a granted peer-send tool can stamp the SENDER server-side — never from the agent body.
		sessionId,
		cwd, // EXPLICIT project root (D-002 / 1.4a)
		model: input.model,
		intent: input.intent,
		task: { id: String(task.id), title: task.title, description: task.description },
		context: recalledContext,
		budgets: input.budgets,
		toolPolicy: input.toolPolicy,
		// D-036: the resolved intent bundle's capability set rides onto the SpawnRequest so
		// the runtime's composeCapabilities validates + composes it against the live catalog.
		capabilities: input.capabilities,
		// TASK 15.1: the resolved scope-lock (declared roots + config-merged patterns) rides
		// onto the SpawnRequest; the runtime enforces it on BOTH paths (canUseTool + hook).
		editScope,
		workflowRunId: input.workflowRunId
	};

	// TASK 13.2 — the terminal-status guarantee. The session row was CREATEd 'running';
	// it MUST reach a terminal status on EVERY exit path. The stream loop below can throw
	// (a message-persist DB hiccup, a bus consumer fault, an AgentRuntime whose iterator
	// throws — the ClaudeCodeRuntime converts backend throws to `error` events, but other
	// impls/SDK seams may not). Without this guard a mid-stream throw skipped the terminal
	// UPDATE entirely, leaving the row 'running' forever (phantom running agents on every
	// dashboard count). Any throw is captured here; the terminal write below runs on BOTH
	// paths — 'failed' with the honest throw message as `note` (F-008) + ended_at — then
	// the error is rethrown (callers already treat a throw as a failed spawn: orchestrator
	// #runItem marks the work_item failed, runner runStep marks the step failed).
	let streamError: Error | undefined;
	try {
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

			// Persist transcript messages. `seq` = the per-session monotonic order index (this
			// event's `order`, already assigned above) so the read side replays turns in the
			// exact order they streamed — independent of same-millisecond `at` ties (m0037). The
			// content + nested tool_call values are D-026-screened inside eventToMessage.
			const seq = order - 1; // `order` was post-incremented after the bus publish above
			const msg = eventToMessage(ev);
			if (msg) {
				// Accumulate the RAW turn text for the §3.2 ADD-only extraction at session end
				// (D-029 — raw transcript, no summary). Bounded so a long session can't blow the
				// extraction prompt; the tail is the most recent (most extraction-worthy) work.
				// The screened content is what we accumulate (the screen already ran in
				// eventToMessage) — a secret never reaches the extraction prompt either.
				if (transcriptParts.length < 400) transcriptParts.push(`${msg.role}: ${msg.content}`);
				// FAIL-OPEN persistence (F-014): a transcript write error must NEVER break or fail
				// the driven session — it is observability, not the work. A failed message insert is
				// logged and swallowed so the stream keeps flowing (the live bus event already fired
				// above, and the terminal status write / reaper still guarantee an honest verdict).
				try {
					await db.query(`CREATE message CONTENT $content;`, {
						content: omitUndefined({
							session: sid,
							role: msg.role,
							kind: msg.kind,
							// m0038: a launched transcript turn is the driven agent's OWN output
							// (assistant_text/thinking/tool_use/tool_result) — a SELF-turn, not a
							// pushed-in communication. origin='agent', server-stamped, non-steering
							// (D-035a). It is NEVER derived from the turn's content.
							origin: 'agent',
							seq,
							content: msg.content,
							tool_call: msg.tool_call
						})
					});
				} catch (persistErr) {
					console.warn(
						`[launch] transcript message persist failed for ${sessionId} seq ${seq} (fail-open, session continues): ${(persistErr as Error).message}`
					);
				}

				// BL-7 Part B (D-027 FAST tier ENQUEUE) — count this turn against the PERSISTED
				// cadence counters and, when due, enqueue a screened `memory_review` work_item.
				// We map the runtime stream to the two cadence axes (§2.2): an assistant TEXT turn
				// is a "user turn" tick; a tool USE is a "tool iteration" tick. The fork mines the
				// recent RAW turn text (D-029), so we SCREEN it (D-026) here — BEFORE it is queued —
				// reusing the same screen() the persist path uses; a planted secret in a turn is
				// redacted/quarantined and NEVER queued raw. Best-effort (D-019): any fault is
				// logged + swallowed so the stream keeps flowing and the spawn verdict is unchanged.
				if (fastTierOn && (msg.kind === 'assistant_text' || msg.kind === 'tool_use')) {
					try {
						const delta = msg.kind === 'tool_use' ? { toolIters: 1 } : { userTurns: 1 };
						const { userTurnCount, toolIterCount } = await bumpCounters(db, sessionId, delta);
						const kind = dueReview(userTurnCount, toolIterCount, cadence);
						if (kind) {
							// Mine the recent raw turn tail (already-screened transcript parts) + re-screen
							// the assembled text so the QUEUED payload can never carry a raw secret (D-026).
							// The interview-exclusion lives in enqueueReview (loop.ts) — a kind='interview'
							// session returns null (never enqueued); the per-session dedup coalesces to ONE
							// pending review so rapid turns cannot spawn a storm (bounded by D-021 caps too).
							const recent = transcriptParts.slice(-40).join('\n').slice(0, 16_000);
							const turnText = screen(recent).text;
							if (turnText.trim()) {
								await enqueueReview(db, {
									session: sessionId,
									kind,
									project: input.projectId,
									turnText
								});
							}
						}
					} catch (fastErr) {
						console.warn(
							`[launch] fast-tier enqueue skipped for ${sessionId} (best-effort): ${(fastErr as Error).message}`
						);
					}
				}
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
	} catch (err) {
		streamError = err instanceof Error ? err : new Error(String(err));
		ok = false;
	}

	const status: SessionStatus = streamError ? 'failed' : sawDone ? (ok ? 'done' : 'failed') : 'failed';
	const durationMs = Date.now() - startedAt;

	// 4. Terminal update: status + ended_at + cc_session_id bridge (the session record
	// carries cc_session_id — D-011). Optionals omitted, not nulled (§6.1). Runs on EVERY
	// exit path (13.2); a throw path stamps the honest failure note (F-008). If the terminal
	// write ITSELF fails (DB down — likely the same fault that broke the stream), the boot
	// reaper (orchestrator/reaper.ts) recovers the still-'running' row on the next boot; we
	// never mask the original stream error with the write error.
	try {
		await db.query(`UPDATE $sid MERGE $content;`, {
			sid,
			content: omitUndefined({
				status,
				ended_at: new Date(),
				cc_session_id: ccSessionId,
				note: streamError ? `failed mid-stream: ${streamError.message}` : undefined
			})
		});

		// The terminal agent_event (analytics first-class): a completion with token totals on
		// a consumed stream; an `error` carrying the throw on the crash path (the how/why of
		// the failed verdict is recorded, not just the status flip).
		if (streamError) {
			await writeAgentEvent(db, {
				session: sessionId,
				project: input.projectId,
				type: 'error',
				model: input.model,
				durationMs,
				detail: {
					error: streamError.message,
					reason: 'stream threw mid-run — terminal status stamped by launchSession (13.2)'
				}
			});
		} else {
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
		}
	} catch (writeErr) {
		if (!streamError) throw writeErr;
		console.warn(
			`[launch] terminal-status write failed for ${sessionId} after a stream error (boot reaper will recover): ${(writeErr as Error).message}`
		);
	}

	if (streamError) throw streamError;

	// 5. EXTRACT on session-end (TASK 8.3): mine the just-finished transcript for durable,
	// ADD-only memories (D-028 — one cheap LLM call, additive only; the screen-before-embed
	// gate in store.ts redacts/quarantines secrets BEFORE any embedding, D-026). This is how
	// the system LEARNS across sessions. Best-effort (D-019): an extraction failure NEVER
	// changes the session's terminal verdict — it is logged and swallowed. The summary is
	// folded in so a session that ended with a clear summary still yields a memory.
	if (memory && transcriptParts.length) {
		try {
			const turnText = [summary, ...transcriptParts].filter(Boolean).join('\n').slice(0, 16_000);
			await memory.service.extractAndStore(memory.extract, {
				turnText,
				project: input.projectId,
				// m0033 provenance (16.6): every transcript-derived row records its originating
				// session, so the D-029 recall filter can exclude interview-born rows.
				session: sessionId
			});
		} catch (err) {
			console.warn(`[launch] memory extraction skipped for ${sessionId}: ${(err as Error).message}`);
		}
	}

	return { sessionId, ccSessionId, status, summary };
}

// agent_event rows are written via the shared analytics writer (writeAgentEvent,
// analytics/events.ts — the one chokepoint, TASK 2.4). The old local insertAgentEvent
// helper was folded into it so every producer shares one shape + the how/why contract.
