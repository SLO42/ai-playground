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
import { proposeSkill, type ProposeSkillInput } from '../skills/proposal';
import { captureFileTurnSnapshot } from '../memory/file-snapshot-capture';
import { acquireSessionWorktree, type SessionWorktree } from './worktree';
import { drainInbox } from '../peer/drain';
import { loadFleetSnapshot } from '../peer/repo';
import { buildPeerSendAffordance } from '../peer/affordance';
import { peerSendGranted, PEER_SEND_CAPABILITY_ID } from '../agent/tool-catalog';
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
	/**
	 * LIFECYCLE-GRAPH (m0067) — the EXPLICIT cause of this spawn: the `table:id` of the
	 * triggering work_item / completion / pm_tick that caused it. Threaded straight onto the
	 * spawn `agent_event.parent_event_id` so the node-graph draws Continue→session / PM→new-task
	 * as a REAL edge. Set by the orchestrator drain (which knows the triggering work_item id);
	 * absent ⇒ the column stays NONE and the graph infers that edge from timestamps (honest, F-008).
	 */
	parentEventId?: string;
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
	/**
	 * Synchronous SESSION-ID surface (Create-with-AI ASYNC propose). Fired EXACTLY ONCE, the
	 * instant the `session` row is CREATEd (status 'running') — BEFORE the runtime stream is
	 * consumed and long before launchSession resolves. A caller that needs the live session id up
	 * front (to land it on a tracking row and return to the client while generation continues in
	 * the background) registers this. Best-effort + isolated: a throw from the callback is logged
	 * and swallowed so it can NEVER break or fail the driven session (the launch is the work; this
	 * is observability). Omitted by every existing caller ⇒ no behavioural change.
	 */
	onSessionCreated?: (sessionId: string) => void;
	/**
	 * WI-2 (WORKSPACE-ISOLATION-SPEC) — the per-session worktree acquirer seam. Injected so the
	 * integration test can point it at a real temp git repo (and a unit test at a fake). Defaults
	 * to {@link acquireSessionWorktree}. Called for a WRITE-class session (isWriteIntent) AFTER the
	 * `session` row exists (the sessionId keys the worktree, so resume re-acquires the SAME one) and
	 * BEFORE the runtime spawns into it. A non-git project root throws NotAGitRepoError here — the
	 * write session FAILS CLOSED (surfaced as the session's honest terminal note), NEVER silently
	 * sharing the project root (that re-opens the F-046 race). READ classes never call it.
	 */
	acquireWorktree?: (projectRoot: string, sessionId: string) => Promise<SessionWorktree>;
	/**
	 * SH-2 (SKILL-HARVEST-SPEC §"CAPTURE") — the injected skill-proposal CAPTURE seam. At session
	 * end, on a SUCCESSFUL (`status==='done'`) CODE-WRITE session ONLY (the narrow trigger, §"Scope
	 * guard"), the just-finished, SCREENED (D-026) trajectory is offered to this seam, which may DRAFT
	 * a `skill_proposal` (a reusable procedure worth replaying) or decline (return null — most sessions).
	 *
	 * Mirrors {@link PmProposalGenerator} (pm-propose.ts) EXACTLY: an injected function so UNIT TESTS
	 * pass a STUB (no model spend, deterministic) and PRODUCTION wires the real generator. The seam only
	 * PROPOSES — launchSession persists the returned draft via SH-1 {@link proposeSkill}, which is born
	 * status='open' and can never reach the live catalog without a recorded operator approval (G2/D-039).
	 *
	 * BEST-EFFORT (D-019 / F-014): a harvester fault — a throw, a malformed draft rejected by SH-1's
	 * contract, or a DB write failure — NEVER blocks or fails the session. It is logged and swallowed;
	 * the session's terminal verdict is already decided before this runs. Omitted ⇒ no harvest (the
	 * default boot path), with zero behavioural change.
	 */
	skillHarvester?: SkillHarvester;
	/**
	 * CONVERSATION-LAYER-SPEC (pillar 3) — the live-fleet snapshot loader the peer-send AFFORDANCE
	 * derives its who-list from. Injected so tests can pass a STUBBED FleetSnapshot (deterministic,
	 * no DB) and production wires the real {@link loadFleetSnapshot}. Called ONLY for a session that
	 * is GRANTED peer-send (peerSendGranted) — a non-granted session never loads the fleet and never
	 * sees the affordance. BEST-EFFORT (D-019 / F-014): a loader fault is logged + swallowed and the
	 * affordance is simply omitted (the session still spawns). Omitted ⇒ defaults to loadFleetSnapshot.
	 */
	loadFleet?: (db: Db) => Promise<import('../peer/resolve').FleetSnapshot>;
}

// ── SH-2: the injected skill-proposal CAPTURE seam ───────────────────────────────

/**
 * The screened trajectory a {@link SkillHarvester} reasons over. `transcriptText` is the
 * D-026-screened, bounded session trajectory (secrets already redacted before it reaches the seam);
 * the rest is honest provenance the drafted proposal grounds itself in (project/session/task ids).
 */
export interface SkillHarvestContext {
	/** The screened, bounded transcript text (summary + turns) — D-026-safe by construction. */
	transcriptText: string;
	/** The session that produced the trajectory (`session:…`) — provenance for the draft. */
	sessionId: string;
	/** The project context (`project:…`) — provenance for the draft. */
	projectId: string;
	/** The task title that drove the session — a grounding hint for the draft. */
	taskTitle: string;
}

/**
 * The CAPTURE seam: look at a (screened) successful code-write trajectory and OPTIONALLY draft a
 * skill proposal. PRODUCTION runs a real cheap-tier generator session; UNIT TESTS inject a stub
 * (no creds/network/spend). Returns a {@link ProposeSkillInput} draft, or `null` when the session
 * established nothing reusable (the common case — most sessions harvest nothing). The seam NEVER
 * writes: launchSession persists the returned draft via SH-1 {@link proposeSkill} (born 'open').
 */
export interface SkillHarvester {
	propose(ctx: SkillHarvestContext): Promise<ProposeSkillInput | null>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Validate a `table:id` link at the D-016 chokepoint, then wrap as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * WI-2 (WORKSPACE-ISOLATION-SPEC §"Design — phase-gated isolation") — the WRITE session
 * classes. A WRITE-class session edits + commits source, so it runs in a DEDICATED per-session
 * git worktree (no shared-cwd race, F-046/F-007). READ classes (`code-read` / `deep-explore` /
 * `simple-question`) do not write source and stay in the shared project root, parallel-safe via
 * editScope/D-018. The set is the SINGLE source of truth for the launch + resume decision.
 */
export const WRITE_INTENTS: readonly Intent[] = ['code-write', 'code-debug'];

/** True iff this intent is a WRITE class → gets an isolated worktree on a git root (WI-2). */
export function isWriteIntent(intent: Intent): boolean {
	return WRITE_INTENTS.includes(intent);
}

/** Drop keys whose value is `undefined` so option<T> fields stay NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

/**
 * UO-1 (USAGE-OBSERVABILITY-SPEC) — screen + clean ONE granted-id dimension for persistence.
 * Each id is D-026-screened (opaque ids, but any free-text rides the screen path), trimmed, and
 * empty/blank entries dropped. Returns undefined for an absent/empty/all-blank list so the option
 * field is OMITTED at write (F-013/§6.1) → reads honestly as 'not recorded' (null), never a
 * fabricated empty grant (F-008). A non-array input (a malformed bundle) yields undefined, never a
 * throw (shadow path: nil/empty/non-array all collapse to "nothing persisted").
 */
function cleanGrantedIds(ids: unknown): string[] | undefined {
	if (!Array.isArray(ids)) return undefined;
	const out: string[] = [];
	for (const id of ids) {
		if (typeof id !== 'string') continue;
		const screened = screenText(id).trim();
		if (screened) out.push(screened);
	}
	return out.length ? out : undefined;
}

/**
 * UO-1 — build the OMIT-when-absent granted-capability fields persisted on the session row at
 * CREATE. The set is the ACTUAL composed/effective grant known at spawn (NOT the static bundle,
 * F-008): the three catalog dimensions (skills/agents/mcp), the RESERVED runtime grants actually
 * in effect (peer-send when {@link peerSendGranted}), the allow-listed tool names, and the
 * resolved intent. Every list is screened + omitted-when-empty by {@link cleanGrantedIds}; the
 * intent is a known enum slug (no screen needed, but never blank). This does NOT alter the
 * compose/spawn path — it only records what launchSession already decided.
 */
function grantedCapabilityFields(input: LaunchInput): {
	granted_skills?: string[];
	granted_agents?: string[];
	granted_mcp?: string[];
	granted_reserved?: string[];
	tool_allow?: string[];
	granted_intent?: string;
} {
	const caps = input.capabilities;
	// The RESERVED grants actually in effect — recorded by their reserved id. peer-send is the only
	// reserved runtime affordance today (RESERVED_CAPABILITY_IDS); when another lands, add it here.
	const reserved: string[] = [];
	if (peerSendGranted(caps)) reserved.push(PEER_SEND_CAPABILITY_ID);
	return omitUndefined({
		granted_skills: cleanGrantedIds(caps?.skills),
		granted_agents: cleanGrantedIds(caps?.agents),
		granted_mcp: cleanGrantedIds(caps?.mcp),
		granted_reserved: reserved.length ? reserved : undefined,
		tool_allow: cleanGrantedIds(input.toolPolicy?.allow),
		granted_intent: input.intent ? String(input.intent) : undefined
	});
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
	// WI-2: the BASE cwd is the project root (D-002 / 1.4a) unless a workflow step supplies an
	// explicit override (D-013). For a WRITE-class session on a git root with NO explicit override
	// this is REPLACED below — after the session row exists — by a dedicated per-session worktree
	// (the sessionId keys it, so resume re-acquires the same one). An explicit `input.cwd` override
	// is honored verbatim (a workflow step already picked its cwd) and never worktree-substituted.
	let cwd = input.cwd ?? project.root_path;

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

	// 1c. UO-1 (USAGE-OBSERVABILITY-SPEC) — compute the GRANTED capability set to persist on the
	// row. This is the ACTUAL composed/effective grant known at spawn (input.capabilities +
	// peerSendGranted + toolPolicy.allow + intent), NOT the static orchestration bundle (F-008).
	// We do NOT change the compose/spawn logic — only record what is already decided here.
	//
	// Each id list is SCREENED (D-026 — ids are opaque, not secrets, but any free-text rides the
	// standard screen path) and OMITTED when empty (F-013/§6.1) so a legacy/no-grant row reads as
	// 'not recorded' (null) downstream, never a fabricated empty grant. The reserved grants are the
	// runtime affordances actually in EFFECT (peer-send when peerSendGranted) — the dual of the
	// catalog dimensions, recorded by their reserved id so the surface shows "had peer-send".
	const granted = grantedCapabilityFields(input);

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
		// m0069 — the spawn-time AGENT identity for the living-scene `agent` node (which agent
		// ran this job). The slot id is the only agent identity known at CREATE time (role is
		// stamped LATER by workforce activation). NEW sessions only; historical rows stay NONE
		// → no agent edge (F-008 honest). option<string> on the schema — omitted if ever blank.
		agent: input.agentId,
		runtime: 'claude-code',
		workflow_run: input.workflowRunId ? link(input.workflowRunId) : undefined,
		// UO-1: the persisted granted set (each field already omitted-when-absent by the helper).
		...granted
	});
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session CONTENT $content RETURN AFTER;`,
		{ content: sessionContent }
	);
	const sessionId = String(created[0].id);
	const sid = link(sessionId);

	// WI-2 (WORKSPACE-ISOLATION-SPEC) — a WRITE-class session on a git project root runs in a
	// DEDICATED per-session worktree, not the shared project root (F-046 concurrent-cwd race / F-007
	// shared-index stomping). Acquired HERE — AFTER the session row exists (the sessionId keys the
	// worktree + branch, so resume re-acquires the SAME tree, idempotent) and BEFORE the runtime
	// spawns into it (the tree must be ready first). The acquired cwd REPLACES the shared root for
	// the spawn; the worktree path+branch are PERSISTED on the session row (option fields, OMITTED
	// when absent — F-013/§6.1) so resume + WI-3 merge-back + the fleet UI find the provenance.
	//
	// SKIPPED for: READ classes (unchanged — shared root, parallel-safe via editScope/D-018) AND a
	// session with an explicit `input.cwd` override (a workflow step already chose its cwd, D-013).
	// FAIL CLOSED (WI-1): a WRITE session whose project root is NOT a git repo throws here
	// (NotAGitRepoError) — it is NEVER silently downgraded to the shared root. The terminal-status
	// guard below has not yet been entered, so we stamp the honest, screened failure note on the
	// already-created row and rethrow (callers treat a throw as a failed spawn — same as 13.2).
	const acquireWorktree = deps.acquireWorktree ?? acquireSessionWorktree;
	if (isWriteIntent(input.intent) && input.cwd === undefined) {
		try {
			const wt = await acquireWorktree(project.root_path, sessionId);
			cwd = wt.cwd;
			// Persist the worktree provenance (additive m0059 option fields). Coerced to plain
			// strings (never raw SDK values — F-013 class); both are real strings from WI-1, so the
			// MERGE always sets them on a worktree session and leaves them NONE on a READ session.
			await db.query(`UPDATE $sid MERGE $content;`, {
				sid,
				content: omitUndefined({
					worktree_path: String(wt.cwd),
					worktree_branch: String(wt.branch)
				})
			});
		} catch (wtErr) {
			// Fail closed: stamp the honest, D-026-screened reason on the row + flip it terminal, then
			// rethrow. The session row already exists 'running'; without this it would strand a phantom
			// running session (the 13.2 guard is entered only after the spawn loop starts, below).
			const reason = screenText(
				`worktree acquisition failed (write session not isolated, fail closed): ${(wtErr as Error).message}`
			).trim();
			await db
				.query(`UPDATE $sid MERGE $content;`, {
					sid,
					content: omitUndefined({
						status: 'failed' as SessionStatus,
						ended_at: new Date(),
						note: reason || 'worktree acquisition failed (reason unavailable after secret screening)'
					})
				})
				.catch((markErr) =>
					console.warn(
						`[launch] could not stamp worktree-fail terminal status for ${sessionId} (boot reaper will recover): ${(markErr as Error).message}`
					)
				);
			await writeAgentEvent(db, {
				session: sessionId,
				project: input.projectId,
				type: 'error',
				model: input.model,
				detail: { error: (wtErr as Error).message, reason: 'WI-2 worktree acquisition failed (fail closed)' }
			}).catch(() => undefined);
			throw wtErr;
		}
	}

	// Surface the session id the instant the row exists (Create-with-AI ASYNC propose) — BEFORE
	// the stream is consumed, so a caller can land it on a tracking row + return to the client
	// while generation continues. Isolated/best-effort: a callback throw must never break the
	// driven session (it is observability, not the work — same fail-open discipline as the bus).
	if (deps.onSessionCreated) {
		try {
			deps.onSessionCreated(sessionId);
		} catch (cbErr) {
			console.warn(
				`[launch] onSessionCreated callback threw for ${sessionId} (best-effort, ignored): ${(cbErr as Error).message}`
			);
		}
	}

	// A spawn agent_event the moment the session starts (analytics first-class). The
	// shared writer (2.4) is the one chokepoint; the detail carries the how/why (intent
	// + spawn reason) so the action's decision chain is traceable end-to-end.
	await writeAgentEvent(db, {
		session: sessionId,
		project: input.projectId,
		type: 'spawn',
		model: input.model,
		// LIFECYCLE-GRAPH (m0067): carry the explicit cause when the caller knew it (the orchestrator
		// drain passes the triggering work_item id). Absent ⇒ omitted → NONE (graph infers the edge).
		...(input.parentEventId ? { parentEventId: input.parentEventId } : {}),
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

	// CONVERSATION-LAYER-SPEC (pillar 3 — hires actually converse). Compose the peer-send AFFORDANCE:
	// a REAL instruction to THIS agent about its OWN `peer_send` tool, emitted ONLY when the session
	// is GRANTED peer-send (peerSendGranted on the composed, catalog-validated capability set — the
	// SAME gate the MCP registration uses, so the affordance and the tool appear together, never one
	// without the other). A NON-granted session sees NONE of this (no dead affordance). The who-list
	// is derived from the LIVE FleetSnapshot (real running sessions in THIS project — F-008 honest,
	// never fabricated), so the agent only ever addresses recipients that actually resolve. The
	// affordance advertises ONLY `session`/`role@project` (NOT the inert pm/atelier D-040 placeholders).
	// BEST-EFFORT (D-019 / F-014): a fleet-load fault NEVER blocks the spawn — the affordance is just
	// omitted. This is an instruction to the DRIVEN agent; it carries NO received peer body (those
	// stay fenced DATA in the context block above — D-035a).
	let affordances: string[] | undefined;
	if (peerSendGranted(input.capabilities)) {
		try {
			const loadFleet = deps.loadFleet ?? loadFleetSnapshot;
			const fleet = await loadFleet(db);
			const affordance = buildPeerSendAffordance({
				granted: true,
				sessionId,
				project: input.projectId,
				fleet
			});
			if (affordance) affordances = [affordance];
		} catch (affErr) {
			console.warn(
				`[launch] peer-send affordance skipped for ${sessionId} (best-effort): ${(affErr as Error).message}`
			);
		}
	}

	const req = {
		agentId: input.agentId,
		projectId: input.projectId,
		// G-B (D-035a): pin this session's record id into the isolated spawn env (ATELIER_SESSION_ID)
		// so a granted peer-send tool can stamp the SENDER server-side — never from the agent body.
		sessionId,
		cwd, // EXPLICIT cwd (D-002 / 1.4a): project root for a READ session; the per-session worktree for a WRITE session (WI-2)
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
		// CONVERSATION-LAYER-SPEC (pillar 3): the peer-send affordance instruction (when granted) —
		// a REAL instruction about the agent's OWN tool, rendered by buildPrompt distinct from the
		// fenced "(not instructions)" context. Undefined for a non-granted session (no dead affordance).
		affordances,
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
	// OBSERVABILITY GAP FIX — the honest NON-THROW failure reason. A run can end 'failed'
	// WITHOUT throwing: the runtime yields an `error` event (the cli-backend converts a child
	// spawn-fail / instant pre-init death / non-zero exit into one — F-016 captures the spawn
	// 'error' so it surfaces HERE as an event, NOT a server crash), or it yields a `done` with
	// ok=false. Before this fix only the THROW path stamped `note`, so those failures recorded
	// note=NULL — the live 6-ROUNDS symptom (status='failed', cc_session_id=null, note=null:
	// an invisible failure). We remember the LAST error-event text (the reason closest to the
	// terminal state) and the final done summary so the terminal write below stamps an honest,
	// SCREENED (D-026) reason on EVERY failed exit. NEVER fabricated: when nothing is available
	// we record an honest "failed before producing any output (exit code unknown)" not a guess.
	let lastErrorEvent: string | undefined;
	// FS-2 (b): pair a Read's tool_use (carries the file_path, no body) with the FOLLOWING tool_result
	// (carries the body the agent SAW, no path). A Read emits tool_use then tool_result back-to-back,
	// so we remember the last file-READ path and attach the next tool_result's output to it. A
	// Write/Edit captures inline (its tool_use args carry the new content). State is per-session, reset
	// when any non-result event intervenes so a stale path never mis-pairs (honest, F-008).
	let pendingReadAbsPath: string | null = null;
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
				let persistedMessageId: string | undefined;
				try {
					const [created] = await db.query<[Array<{ id: unknown }>]>(
						`CREATE message CONTENT $content RETURN AFTER;`,
						{
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
						}
					);
					persistedMessageId = created?.length ? String(created[0].id) : undefined;
				} catch (persistErr) {
					console.warn(
						`[launch] transcript message persist failed for ${sessionId} seq ${seq} (fail-open, session continues): ${(persistErr as Error).message}`
					);
				}

				// ── FS-2 (b) AGENT READ/EDIT CAPTURE — link a file_snapshot to THIS transcript turn
				// when it is a FILE tool turn → "what the agent saw / wrote" (FILE-SNAPSHOT-SPEC §3 b).
				// BEST-EFFORT + non-blocking (captureSnapshotSafe never throws): a capture failure must
				// NEVER crash or fail the driven session (F-014 / F-008). Only fires when the message row
				// persisted (we need its id for captured_by). The path a tool reports is ABSOLUTE; we
				// relativize it against the project root (cwd) — a file OUTSIDE the project yields null and
				// is honestly NOT snapshotted. The pairing model handles Read (path now, body in the
				// following tool_result).
				if (persistedMessageId) {
					pendingReadAbsPath = await captureFileTurnSnapshot(db, {
						ev,
						messageId: persistedMessageId,
						projectRoot: cwd,
						projectId: input.projectId,
						pendingReadAbsPath
					});
				} else if (ev.type !== 'tool_call' && ev.type !== 'tool_result') {
					// A non-file event with no persisted id still clears a stale pending Read pairing.
					pendingReadAbsPath = null;
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
				// Remember the error text so the terminal write can stamp it as the honest session
				// `note` (D-026-screened there). The LAST error event wins — it is the reason closest
				// to the terminal state. This is the cli-backend's honest reason: 'claude CLI failed
				// to start: <spawn err>' (instant pre-init fail, cc_session_id=null) or 'claude CLI
				// exited N: <stdout/stderr tail>' (F-029 — a non-zero exit often carries its reason
				// on STDOUT). NEVER fabricated; absent ⇒ the no-output fallback below.
				lastErrorEvent = ev.error;
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

	// OBSERVABILITY GAP FIX — derive the honest, D-026-SCREENED failure note for EVERY failed
	// exit path (the operator must never see a failed session with note=NULL again). Order of
	// precedence picks the reason CLOSEST to the terminal cause:
	//   1. streamError      — the stream/iterator THREW (a DB hiccup, a runtime that does not
	//                          convert backend throws to events): the throw message.
	//   2. lastErrorEvent   — the runtime yielded an `error` event (the common cli-backend case:
	//                          a child spawn-fail / instant pre-init death with cc_session_id=null,
	//                          or a non-zero exit whose reason rides STDOUT — F-029). This is the
	//                          path that previously recorded note=null (the 6-ROUNDS symptom).
	//   3. done(ok=false)   — the run completed but reported a failure result: the summary if it
	//                          carries one, else an honest "completed with a failure result".
	//   4. nothing at all   — no done, no error, no throw: an honest "failed before producing any
	//                          output" — NEVER a fabricated/guessed reason (F-008).
	// screenText() (D-026, fail-closed) redacts any secret the reason text might carry (a token in
	// a stderr tail, an OAuth value echoed by the CLI) BEFORE it is ever persisted or rendered.
	let failureNote: string | undefined;
	if (status === 'failed') {
		const raw = streamError
			? `failed mid-stream: ${streamError.message}`
			: lastErrorEvent
				? lastErrorEvent
				: sawDone
					? summary.trim()
						? `completed with a failure result: ${summary.trim()}`
						: 'completed with a failure result (no detail reported)'
					: 'failed before producing any output (no done/error event, no exit reason)';
		// Screen, then guard against an empty result (a reason that screened to '' must still be
		// an honest non-empty note, never a blank that reads like the old null).
		const screened = screenText(raw).trim();
		failureNote = screened || 'failed (reason unavailable after secret screening)';
	}

	// 4. Terminal update: status + ended_at + cc_session_id bridge (the session record
	// carries cc_session_id — D-011). Optionals omitted, not nulled (§6.1). Runs on EVERY
	// exit path (13.2); a failed path stamps the honest, screened failure note (F-008). If the
	// terminal write ITSELF fails (DB down — likely the same fault that broke the stream), the
	// boot reaper (orchestrator/reaper.ts) recovers the still-'running' row on the next boot; we
	// never mask the original stream error with the write error.
	try {
		await db.query(`UPDATE $sid MERGE $content;`, {
			sid,
			content: omitUndefined({
				status,
				ended_at: new Date(),
				cc_session_id: ccSessionId,
				note: failureNote
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

	// 6. CAPTURE on session-end (SH-2 / SKILL-HARVEST-SPEC §"CAPTURE") — offer the just-finished
	// trajectory to the injected skill-proposal seam, which may DRAFT a `skill_proposal`. Start NARROW
	// (§"Scope guard"): ONLY a SUCCESSFUL (`status==='done'`) CODE-WRITE session harvests — a failed or
	// non-code-write session establishes no replayable procedure worth proposing. The harvester sees the
	// SCREENED (D-026) trajectory ONLY (the parts were already screened in eventToMessage; we re-screen
	// the assembled text + the summary so a secret can NEVER reach the proposal, defense-in-depth ahead
	// of SH-1's own field screen). A returned draft is persisted through SH-1 proposeSkill — born
	// status='open', never promoted here (G2/D-039); a returned null means "nothing reusable" (the common
	// case, F-008 honest — we draft NOTHING rather than fabricate a skill). Entirely BEST-EFFORT (D-019 /
	// F-014): a throw, a contract rejection by proposeSkill, or a DB fault is logged + swallowed and NEVER
	// changes the session's terminal verdict (the work is already done; this is observability/learning).
	if (deps.skillHarvester && status === 'done' && input.intent === 'code-write' && transcriptParts.length) {
		try {
			// Screen the assembled trajectory (summary + screened turn tail) BEFORE the seam sees it.
			const rawTrajectory = [summary, ...transcriptParts].filter(Boolean).join('\n').slice(0, 16_000);
			const transcriptText = screen(rawTrajectory).text;
			const draft = await deps.skillHarvester.propose({
				transcriptText,
				sessionId,
				projectId: input.projectId,
				taskTitle: task.title
			});
			if (draft) {
				// SH-1 chokepoint: born 'open', dedup-bumped on recurrence, every field re-screened (D-026).
				// We stamp the session/project provenance HERE (server-side) so the seam cannot forge it; a
				// draft that supplies its own is overridden with the real ids.
				await proposeSkill(db, { ...draft, session: sessionId, project: input.projectId });
			}
		} catch (err) {
			console.warn(`[launch] skill harvest skipped for ${sessionId} (best-effort): ${(err as Error).message}`);
		}
	}

	return { sessionId, ccSessionId, status, summary };
}

// agent_event rows are written via the shared analytics writer (writeAgentEvent,
// analytics/events.ts — the one chokepoint, TASK 2.4). The old local insertAgentEvent
// helper was folded into it so every producer shares one shape + the how/why contract.
