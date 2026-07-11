// server/runtime — the AgentRuntime interface + the default Claude Code impl
// (TASK 1.4; ARCHITECTURE §2.3, D-002/D-003).
//
// A narrow interface the WHOLE system codes against, so the concrete runtime is
// swappable (the OpenClaw replacement seam). Default impl = Claude Code: agents run
// as Claude Code sessions via the Agent SDK (PRIMARY, headless/programmatic) and/or
// the Claude Code CLI (interactive parity — interject/resume). The interface stays
// stable so direct-provider chat (Ollama/Claude) or a future runtime still plug in.
//
// CRITICAL (S1-mandated, D-002): the impl spawns EVERY Claude Code session — SDK and
// CLI — with an ISOLATED config: a dedicated CLAUDE_CONFIG_DIR + `--settings` bundle
// carrying ONLY the harness's own gates/hooks, with NO inherited operator plugins/
// hooks. The S1 spike proved a spawned `claude` CLI otherwise inherits the operator's
// global plugins (caveman/kongcode/peers/routing) → polluted, nondeterministic
// agents + injected hook turns blowing --max-turns. Isolation makes driven agents
// deterministic. This is the load-bearing, asserted behaviour of this module.
//
// The actual SDK/CLI subprocess is hidden behind the CcBackend seam. The contract
// suite injects a MOCKED/SANDBOXED backend — NO filesystem-capable spawn — so no
// real agent runs in 1.4 (the first real, fs-capable spawn is 1.6, gated on 1.4a's
// deny rules). Windows note (when a real backend lands): execFile arrays + shell:true
// for spawn; never process.kill(pid,0) (use tasklist); taskkill to stop.

import type { ProviderHealth } from '../providers/index';
import {
	composeCapabilities,
	type CapabilitySet,
	type CapabilityCatalog
} from './capabilities';
import {
	gateCanUseTool,
	parseGatePolicy,
	parseEditScope,
	parseFetchAllowlist,
	createGateSession,
	type CanUseToolResult,
	type EditScopeInput,
	type FetchAllowlistInput
} from '../claude-code/gates';

// Re-export the gate callback result type so backends can type plan.canUseTool (13.3),
// and the raw edit-scope shape so launch-path callers can type SpawnRequest.editScope (15.1).
export type { CanUseToolResult, EditScopeInput, FetchAllowlistInput } from '../claude-code/gates';

// Re-export the D-036 capability surface so the whole system imports it from `runtime`.
export {
	composeCapabilities,
	CapabilityValidationError,
	SterileCompositionError,
	MEMORY_PULL_CAPABILITY_IDS,
	type CapabilitySet,
	type CapabilityCatalog,
	type CapabilityKind,
	type ComposedCapabilitySettings,
	type ComposeOptions,
	type HarnessBase
} from './capabilities';

// ── Public contract types (ARCHITECTURE §2.3) ───────────────────────────────────

export type Intent =
	| 'simple-question'
	| 'code-read'
	| 'code-write'
	| 'code-debug'
	| 'deep-explore';

export interface ModelSelection {
	provider: string;
	modelId: string;
	tier?: string;
}

// Re-export the canonical model-id vocabulary (CA-0) so the rest of the system
// imports it from `runtime` alongside ModelSelection. The source of truth lives in
// `config/load.ts` (the validation boundary that depends on nothing) to avoid a
// runtime→config layering edge; this is a value+type re-export only.
export { MODEL_IDS, isValidModelId, type ModelId } from '../config/load';

/** Thinking level / tool / concurrency budgets (D-020) — separate from toolPolicy. */
export interface SpawnBudgets {
	thinking?: string;
	toolCalls?: number;
	concurrency?: number;
}

/** Allow-list + confirmation gating. Allow-list ONLY; budgets are separate. */
export interface ToolPolicy {
	allow: string[];
	confirm?: string[];
}

/** Recalled memory/graph context — a SEPARATE field, never folded into the task (D-008). */
export interface ContextBundle {
	items: { text: string; citationId?: string }[];
}

export interface SpawnRequest {
	agentId: string;
	projectId: string;
	cwd: string; // project working dir, passed EXPLICITLY (D-002 / 1.4a)
	model: ModelSelection; // from Routing
	intent: Intent;
	task: { id: string; title: string; description: string };
	context?: ContextBundle; // never mutates task
	budgets: SpawnBudgets;
	toolPolicy: ToolPolicy;
	/**
	 * Per-task capability set from the intent bundle (D-036 / task 5.1). The runtime
	 * composes harness-base ⊕ THIS set into the isolated config (catalog-validated, fail
	 * closed). Absent ⇒ no extra capabilities (the harness base only). It NEVER carries
	 * the operator's whole plugin set — D-002 isolation is preserved (see capabilities.ts).
	 */
	capabilities?: CapabilitySet;
	/**
	 * TASK 15.1 (HARVEST B1 / D-018) — the session's declared SCOPE-LOCK: the file roots
	 * this session may WRITE under ({scopeRoots, scopeAllow glob exceptions}) plus the
	 * operator-configured destructive-bash pattern lists (config/gates.yaml, merged in by
	 * the launch path). Enforced fail-closed on BOTH paths: the SDK canUseTool callback and
	 * the CLI PreToolUse hook deny Edit/Write/NotebookEdit + detectable bash write
	 * redirections outside the scope. A MALFORMED scope fails the spawn closed; an ABSENT
	 * scope means no scope gating (opt-in, requirement (c)).
	 *
	 * HOW IT IS POPULATED (requirement (d)): callers that already DECLARE a file scope pass
	 * it here — the v2-wave workflow template's per-task "files to modify" scope lock, and
	 * D-039 PM proposed-tasks (whose validated task shape carries the declared file scope),
	 * map their declared paths onto `scopeRoots` (+ `scopeAllow` for shared-file exceptions
	 * like docs/fails.md) when building the LaunchInput → SpawnRequest.
	 */
	editScope?: EditScopeInput;
	/**
	 * WORKFORCE-SPEC §7b.4 (fix) — the session's declared FETCH ALLOWLIST: the single origin
	 * a built-in WebFetch may target ({allowedOrigin}). Set by the researcher gauntlet to the
	 * loopback stub-web origin so the candidate's WebFetch is allowlisted to the stub ONLY and
	 * the live internet is unreachable (the §7b.4 determinism/safety guarantee). Enforced
	 * fail-closed on BOTH paths (SDK canUseTool + CLI PreToolUse hook) via the fetch-allowlist
	 * gate family; WebSearch is denied entirely when armed. A MALFORMED policy fails the spawn
	 * closed (never spawns un-gated); ABSENT ⇒ no fetch gating (non-web sessions unchanged).
	 */
	fetchPolicy?: FetchAllowlistInput;
	workflowRunId?: string; // set when this spawn is a workflow step (D-013)
	/**
	 * TASK 16.6 (WORKFORCE-SPEC §3.2) — the session kind this spawn runs as, when the
	 * kind changes COMPOSITION semantics. `'interview'` forces the STERILE composition
	 * at the composeCapabilities seam (fail closed): a declared memory-pull capability
	 * id refuses the spawn (SterileCompositionError → error event, backend never
	 * reached), and the isolated settings carry `sterile: true` as the assertable
	 * proof. Absent ⇒ unchanged legacy composition.
	 */
	sessionKind?: 'interview';
	/**
	 * G-B (PEER-MESSAGE-SPEC / D-035a) — the persisted `session` record id this spawn IS. When
	 * present, the runtime pins it into the isolated spawn env as ATELIER_SESSION_ID so the
	 * capability-gated peer-send MCP server (scripts/peer-send-mcp.mjs) can stamp the SENDER
	 * SERVER-SIDE (the agent cannot set its own env — same trust basis as CLAUDE_CONFIG_DIR). A
	 * spawn WITHOUT it simply cannot peer-send (the endpoint 400s a sender-less request) — honest,
	 * never fabricated. Absent ⇒ no ATELIER_SESSION_ID (legacy spawns unchanged).
	 */
	sessionId?: string;
	/**
	 * CONVERSATION-LAYER-SPEC (pillar 3) — bounded INSTRUCTION sections about the session's OWN
	 * tools/affordances (e.g. the peer-send affordance: "you have a `peer_send` tool, here is who is
	 * reachable, use it sparingly"). DISTINCT from `context` (which is fenced "not instructions"
	 * DATA, D-026): an affordance is a REAL instruction to the DRIVEN agent about a tool IT may call,
	 * composed server-side and emitted ONLY when the corresponding capability is granted. It NEVER
	 * carries a received peer body or any agent-origin DATA (those stay fenced — D-035a). Each entry
	 * is rendered verbatim as its own labelled instruction block by buildPrompt. Absent/empty ⇒ no
	 * affordance block (legacy spawns + non-granted sessions unchanged).
	 */
	affordances?: string[];
}

/** Final result of an agent run. */
export interface AgentResult {
	ok: boolean;
	summary: string;
	ccSessionId?: string;
}

/** The streamed progress union (ARCHITECTURE §2.3). */
export type RuntimeEvent =
	| { type: 'log'; message: string }
	// Extended-thinking block surfaced verbatim (F-008 HONEST: an empty thinking
	// block is an empty string — never invented/backfilled; absence ⇒ no event at all).
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; name: string; args: unknown; needsConfirm: boolean }
	| { type: 'tool_result'; name: string; ok: boolean; output: string }
	| { type: 'token_usage'; input: number; output: number }
	| { type: 'done'; result: AgentResult }
	| { type: 'error'; error: string };

/** Tool the runtime exposes (file/exec/git), for capability checks. */
export interface ToolDescriptor {
	name: string;
	kind: 'file' | 'exec' | 'git' | 'search' | 'other';
}

/** Provider-level health for fallback decisions; read from the providers single owner. */
export interface RuntimeHealth {
	runtime: string;
	providers: ProviderHealth[];
}

/** The narrow interface the whole system codes against. */
export interface AgentRuntime {
	/** Run an agent to completion; streams progress events. */
	spawn(req: SpawnRequest): AsyncIterable<RuntimeEvent>;
	/** Provider-level routing/health for fallback decisions. */
	health(): Promise<RuntimeHealth>;
	/** Tools the runtime exposes (file/exec/git), for capability checks. */
	tools(): ToolDescriptor[];
	/**
	 * Cancel a running agent. The key is the SAME one the run was registered under
	 * (`runKeyFor` = `sessionId ?? agentId`, CCH-1): callers that know the session id
	 * pass it so cancel reaches the exact run even when two sessions share one slot;
	 * legacy no-sessionId callers pass the slot id (byte-identical fallback).
	 */
	cancel(runKey: string): Promise<void>;
	/**
	 * CCF-1 (D-036 note) — rebuild the per-boot D-036 catalog snapshot with a freshly-read
	 * id-set BEFORE the next spawn-plan validation, so a skill DELETED from a scope between
	 * page visits stops passing this fail-closed security boundary. OPTIONAL: a runtime that
	 * never provisioned capabilities (no catalog) is a no-op — this only keeps an EXISTING
	 * snapshot fresh, never flips provisioning ON mid-flight (F-053 additive; the no-catalog
	 * legacy path stays byte-identical). Test/mock runtimes omit it (⇒ caller's `?.` no-op).
	 */
	refreshCatalog?(catalog: CapabilityCatalog): void;
}

// ── Isolated config (S1 / D-002) ─────────────────────────────────────────────────

/** The harness's own gate/hook bundle — the ONLY config a driven agent ever sees. */
export interface HarnessSettings {
	/** D-018 gates: gate-name → 'warn' | 'deny'. */
	gates?: Record<string, string>;
	/**
	 * D-019 hooks: the Claude Code settings.json `hooks` block (event → command-hook groups,
	 * the `buildHookSettings` shape) carried VERBATIM into the isolated settings.json so the
	 * driven session's SessionStart/UserPromptSubmit/PostToolUse/Stop hooks invoke the loopback
	 * proxy (analytics-only, no-op on failure). Opaque here — the value is JSON serialized as-is
	 * (`Record<string, unknown>`) so this layer never has to know the exact CC hook schema.
	 */
	hooks?: Record<string, unknown>;
	/** ALWAYS empty for driven agents — no inherited operator plugins (S1 finding). */
	plugins?: string[];
	/** ALWAYS empty — no inherited marketplaces. */
	marketplaces?: string[];
	/**
	 * D-036 per-task capability set composed onto this harness base — the EXACT, catalog-
	 * validated skills/agents/mcp the driven session may wield. NEVER the operator's whole
	 * plugin set (plugins/marketplaces stay empty). Absent when no catalog was supplied
	 * (legacy spawns / no capability provisioning).
	 */
	capabilities?: CapabilitySet;
	/**
	 * TASK 15.1 — the spawn's declared scope-lock (SpawnRequest.editScope), carried RAW so
	 * the CLI backend pins it onto the PreToolUse hook config. A harness-internal key:
	 * cli-backend strips it from the Claude-Code-schema settings file (like `gates`).
	 */
	editScope?: EditScopeInput;
	/**
	 * WORKFORCE-SPEC §7b.4 (fix) — the spawn's declared fetch allowlist (SpawnRequest.fetchPolicy),
	 * carried RAW so the CLI backend pins it onto the PreToolUse hook config. A harness-internal
	 * key: cli-backend strips it from the Claude-Code-schema settings file (like `gates`/`editScope`).
	 */
	fetchPolicy?: FetchAllowlistInput;
	[k: string]: unknown;
}

/** A fully-resolved isolated config: where it lives, its env, and its settings. */
export interface IsolatedConfig {
	/** Dedicated CLAUDE_CONFIG_DIR for THIS session — never the operator's. */
	configDir: string;
	/** Env to spawn with: CLAUDE_CONFIG_DIR forced to configDir (inherited one stripped). */
	env: Record<string, string>;
	/** The harness-only settings the spawn passes via --settings. */
	settings: HarnessSettings;
}

export interface IsolatedConfigOptions {
	/** Root under which every per-session isolated config dir is created. */
	harnessConfigRoot: string;
	/** Harness gates (D-018). */
	gates?: Record<string, string>;
	/** Harness hooks (D-019) — the Claude Code settings.json hooks block (buildHookSettings shape). */
	hooks?: Record<string, unknown>;
	/**
	 * The cc-config catalog id-set (1.8/2.11) the request's capability set is validated
	 * against (D-036). When present, `req.capabilities` is catalog-validated + composed
	 * onto the harness base; an unknown id throws (fail closed). When ABSENT, no capability
	 * provisioning happens (the harness base only) — legacy/no-catalog spawns are unchanged.
	 */
	catalog?: CapabilityCatalog;
	/**
	 * TASK B10 (capability-gated agent tools) — the tool-catalog wiring seam. Given the
	 * COMPOSED, catalog-validated capability set for this spawn, returns the isolated-config
	 * `mcpServers` block that REGISTERS any capability-granted agent tool (e.g. the B10
	 * memory pull-tool), or undefined when nothing is granted / the control plane is not wired.
	 *
	 * Why an injected callback (not a direct import): the concrete builder lives in
	 * `agent/tool-catalog.ts`, which imports from `runtime/`. Injecting it at the boot seam
	 * (harness/wiring.getRuntime) keeps the runtime layer free of a back-edge to `agent/`
	 * (no cycle) while keeping the GRANT decision at this compose seam — where the validated
	 * capability set actually lives. FAIL CLOSED: absent seam OR a seam that returns undefined
	 * ⇒ NO tool registered (default deny — a non-capability'd session can never invoke it). The
	 * returned map is MERGED into any pre-existing `mcpServers` (it never clobbers the operator's
	 * — the isolated config carries none, D-002 — but the merge is defensive).
	 */
	mcpToolWiring?: (capabilities: CapabilitySet) => Record<string, unknown> | undefined;
}

/** Sanitize an agent id into a filesystem-safe segment for the isolated config dir. */
function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'agent';
}

/**
 * CCH-1 (HARNESS-SPEC §5) — the in-flight run registry key. Mirrors the F-046
 * config-dir fix (`isolatedConfigFor`, keyed by `sessionId ?? agentId`) ONE LAYER UP:
 * two concurrent sessions on the SAME slot (manual launches all default to 'opus-1',
 * wiring.ts) must NOT collide in `ClaudeCodeRuntime.running` — the second would
 * overwrite the first's run handle and `cancel`/`stop` would reach only the latest.
 * Session ids are unique per spawn, so keying by sessionId isolates concurrent
 * same-slot runs; a legacy/no-sessionId spawn falls back to the slot id, byte-identical
 * to the old behaviour. Computed ONCE here so no reader/writer of the map diverges —
 * spawn/resume (writers) and channel.stop (the cancel caller) all key through this.
 * NOTE: not filesystem-bound (a Map key, not a path), so — unlike the config dir — it
 * needs no `safeSegment`; store and lookup only need to agree on the SAME raw string.
 */
export function runKeyFor(req: { sessionId?: string; agentId: string }): string {
	return req.sessionId ?? req.agentId;
}

/**
 * Compute the ISOLATED config for one spawn (S1 / D-002). The returned config dir
 * is UNDER `harnessConfigRoot` (never an operator/global dir), its env forces
 * CLAUDE_CONFIG_DIR to that dir (any inherited value is stripped), and `settings`
 * is the harness's OWN gate/hook bundle with NO inherited plugins/marketplaces.
 * Used identically for the SDK and the CLI (interject/resume parity).
 */
export function isolatedConfigFor(
	req: SpawnRequest,
	opts: IsolatedConfigOptions
): IsolatedConfig {
	const root = opts.harnessConfigRoot.replace(/[\\/]+$/, '');
	// F-046: key the isolated CLAUDE_CONFIG_DIR by SESSION id, not agent slot. The Claude CLI
	// writes `.claude.json` (state/trust) into this dir at startup; two concurrent sessions that
	// shared one slot's dir (the old `${root}/${agentId}`) raced that write → "JSON Parse error:
	// Unexpected EOF" → every-but-one parallel spawn died. Session ids are unique per spawn, so
	// each concurrent session now gets its OWN dir. Resume reuses the SAME session id (channel.ts
	// threads req.sessionId), so the CLI's transcript reuse (keyed by configDir+cwd) still works.
	// Legacy/no-sessionId spawns fall back to the slot id — byte-identical to the old behavior.
	const configDir = `${root}/${safeSegment(req.sessionId ?? req.agentId)}`;

	// Strip the operator's inherited CLAUDE_CONFIG_DIR; pin ours. The whole point of
	// the isolation is that the driven agent never sees the operator's global config.
	const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir };

	// G-B (D-035a) — pin THIS session's record id into the isolated env so the granted peer-send
	// MCP server can stamp the SENDER server-side (the agent cannot forge its own env). Only when
	// the caller supplied it; a legacy spawn keeps a byte-identical env.
	if (req.sessionId) env.ATELIER_SESSION_ID = req.sessionId;

	// D-036: when a catalog is supplied, compose harness-base ⊕ the request's capability
	// set (catalog-validated, fail closed). composeCapabilities forces plugins/marketplaces
	// empty (D-002), so the composed settings can never leak the operator's plugin set.
	// No catalog ⇒ the legacy harness-only bundle (no capability provisioning).
	// TASK 16.6: an interview spawn (§3.2) FORCES the sterile composition at this seam —
	// a memory-pull capability id throws (fail closed), and `sterile: true` rides the
	// settings on BOTH branches (the no-catalog branch provisions nothing, which is
	// trivially sterile — the marker still makes the proof assertable downstream).
	const sterile = req.sessionKind === 'interview';
	const settings: HarnessSettings = opts.catalog
		? composeCapabilities(
				req.capabilities,
				opts.catalog,
				{
					gates: opts.gates,
					hooks: opts.hooks
				},
				{ sterile }
			)
		: {
				gates: opts.gates ?? {},
				hooks: opts.hooks ?? {},
				// Explicitly empty — the S1-proven determinism guard.
				plugins: [],
				marketplaces: [],
				...(sterile ? { sterile: true } : {})
			};

	// TASK 15.1 — a declared scope-lock rides the isolated settings (both compose paths)
	// so the CLI backend pins it onto the PreToolUse hook config. Only set when declared:
	// legacy/unscoped spawns keep a byte-identical settings shape.
	if (req.editScope !== undefined) settings.editScope = req.editScope;

	// WORKFORCE-SPEC §7b.4 (fix) — a declared fetch allowlist rides the isolated settings (both
	// compose paths) so the CLI backend pins it onto the PreToolUse hook config. Only set when
	// declared: legacy/non-web spawns keep a byte-identical settings shape.
	if (req.fetchPolicy !== undefined) settings.fetchPolicy = req.fetchPolicy;

	// TASK B10 — capability-gated AGENT-TOOL registration. When a tool-wiring seam is
	// supplied, ask it for the `mcpServers` block this spawn's COMPOSED, catalog-validated
	// capability set grants (the B10 memory pull-tool registers here iff the bundle granted
	// `memory-pull`). FAIL CLOSED: only the catalog path produces a validated `capabilities`
	// set, so the legacy/no-catalog branch registers nothing; an interview spawn already had
	// the memory-pull id REFUSED at composeCapabilities, so its `capabilities` can never carry
	// it (no tool is registered for a sterile session — by construction, not by a second gate).
	// The seam returns undefined ⇒ default deny ⇒ no registration. `mcpServers` is composed onto
	// the isolated settings HERE, but it is a HARNESS_ONLY strip key (cli-backend.ts
	// HARNESS_ONLY_SETTINGS_KEYS): Claude Code does NOT load MCP servers from the `--settings`
	// file (that path silently ignores an mcpServers block — the B10 fix finding), so the CLI
	// backend STRIPS it from `--settings` and delivers it via `--mcp-config <.mcp.json>`
	// (+ `--strict-mcp-config`) instead (cli-backend.buildMcpConfigArgs). This adds ONLY a
	// registration — every fence/screen/budget chokepoint stays in the engine the registered
	// tool's proxy ultimately calls (pullMemory).
	if (opts.mcpToolWiring && settings.capabilities) {
		const granted = opts.mcpToolWiring(settings.capabilities);
		if (granted && Object.keys(granted).length > 0) {
			const existing = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
			settings.mcpServers = { ...existing, ...granted };
		}
	}

	return { configDir, env, settings };
}

// ── Backend seam (SDK primary; CLI for interject/resume) ─────────────────────────

/** A resolved plan for one spawn, handed to the backend — carries the isolation. */
export interface CcSpawnPlan {
	agentId: string;
	cwd: string;
	model: ModelSelection;
	prompt: string;
	toolPolicy: ToolPolicy;
	budgets: SpawnBudgets;
	/** The S1-mandated isolated config — present on EVERY plan (SDK and CLI). */
	isolated: IsolatedConfig;
	/**
	 * TASK 13.3 (D-018/D-024, ARCHITECTURE §2.10e) — the SDK/runtime-path gate callback,
	 * built by `ClaudeCodeRuntime.plan()` from `gateCanUseTool` whenever the runtime is
	 * configured with gates. A backend that executes tools PROGRAMMATICALLY (the SDK
	 * `canUseTool` option, mock backends) MUST consult this before running each tool and
	 * must NOT execute a tool it denies. The real CLI backend cannot intercept in-process —
	 * it enforces the SAME gate config via the `PreToolUse` hook it registers in the
	 * isolated settings (cli-backend.buildCliSettings → scripts/gate-hook.mjs). Absent when
	 * the runtime has no gates configured.
	 */
	canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<CanUseToolResult>;
	/** Set when resuming an existing Claude Code session (CLI parity path). */
	resumeCcSessionId?: string;
	workflowRunId?: string;
}

/** A live backend run: its Claude Code session id, its event stream, and cancel. */
export interface CcBackendRun {
	ccSessionId: string;
	stream(): AsyncIterable<RuntimeEvent>;
	cancel(): Promise<void>;
}

/**
 * The pluggable Claude Code execution backend. The real impl wraps the Agent SDK
 * (primary) + CLI subprocess (interject/resume). The contract suite injects a
 * MOCKED/SANDBOXED one with no fs-capable spawn.
 */
export interface CcBackend {
	/** 'sdk' | 'cli' | 'mock' — which transport this backend drives. */
	readonly kind: string;
	/**
	 * HONEST capability matrix (TASK 14.6 / F-008). A backend DECLARES what it really
	 * implements; absent/false fails CLOSED — the channel/UI refuse the control up front
	 * ("not supported by this backend") instead of a stub reporting false success. A
	 * backend MUST NOT set a flag true unless the method genuinely delivers.
	 */
	readonly supportsInterject?: boolean;
	readonly supportsResume?: boolean;
	/** Start a fresh headless run from a resolved plan. */
	run(plan: CcSpawnPlan): CcBackendRun;
	/** Resume an existing Claude Code session by id (CLI parity, D-011). */
	resume(req: { ccSessionId: string; plan: CcSpawnPlan }): Promise<CcBackendRun>;
	/**
	 * Push a message INTO a running session (claude/channel; D-011/D-035). `origin` is
	 * server-stamped + immutable by the time it reaches here; `steer` is true ONLY for an
	 * authenticated operator push (D-035a) — the backend delivers a steering push as an
	 * instruction and a non-steering one (agent-origin) as already-fenced DATA. The
	 * backend NEVER sees the D-025 token (the seam resolves origin/steer before this).
	 */
	interject(msg: {
		ccSessionId: string;
		origin: string;
		body: string;
		steer: boolean;
	}): Promise<void>;
}

// ── The default Claude Code runtime ──────────────────────────────────────────────

export interface ClaudeCodeRuntimeOptions {
	backend: CcBackend;
	/** Root for per-session isolated config dirs (S1/D-002). */
	harnessConfigRoot?: string;
	/** Harness gates (D-018) carried into every isolated --settings. */
	gates?: Record<string, string>;
	/**
	 * Harness hooks (D-019) carried into every isolated --settings — the Claude Code
	 * settings.json `hooks` block (buildHookSettings shape) so the driven session's
	 * lifecycle hooks fire and POST the loopback analytics proxy (no-op on failure).
	 */
	hooks?: Record<string, unknown>;
	/**
	 * The cc-config catalog id-set (1.8/2.11) used to validate + compose each spawn's
	 * per-task capability set (D-036). When set, every spawn's isolated config is
	 * harness-base ⊕ its (catalog-validated) capability set; an unknown id fails the
	 * spawn closed. When unset, capability provisioning is OFF (harness base only).
	 */
	catalog?: CapabilityCatalog;
	/**
	 * TASK B10 — the capability-gated agent-tool wiring seam (see IsolatedConfigOptions).
	 * Injected at the boot seam (harness/wiring.getRuntime) so a capability-granted agent tool
	 * (the B10 memory pull-tool) registers as an isolated-config MCP server. Absent ⇒ no
	 * agent-tool registration (fail closed). Threaded onto every plan's isolated config.
	 */
	mcpToolWiring?: (capabilities: CapabilitySet) => Record<string, unknown> | undefined;
	/** Provider health source — read from the providers single owner (§2.5). */
	providerHealth?: () => Promise<ProviderHealth[]>;
	/** Tool surface the runtime exposes; defaults to the standard CC tool set. */
	toolSurface?: ToolDescriptor[];
	/**
	 * MODEL-BENCHMARK-SPEC step 1 — the LOCAL-provider backend (OllamaBackend). When a spawn's
	 * resolved model has `provider === 'ollama'` (the routing ladder's `local` tier), the runtime
	 * routes THAT spawn's `run` here instead of the default (Claude CLI) backend, so the `local`
	 * tier actually executes a local chat turn. ADDITIVE / opt-in: absent ⇒ a local-provider spawn
	 * falls through to the default `backend` UNCHANGED (no-regression — mock/test runtimes keep their
	 * old path). The whole cloud path is byte-identical when provider !== 'ollama'.
	 */
	ollamaBackend?: CcBackend;
}

/** The default tool surface a Claude Code session exposes (capability check). */
const DEFAULT_TOOLS: ToolDescriptor[] = [
	{ name: 'Read', kind: 'file' },
	{ name: 'Write', kind: 'file' },
	{ name: 'Edit', kind: 'file' },
	{ name: 'Glob', kind: 'search' },
	{ name: 'Grep', kind: 'search' },
	{ name: 'Bash', kind: 'exec' }
];

export class ClaudeCodeRuntime implements AgentRuntime {
	private readonly backend: CcBackend;
	/** MODEL-BENCHMARK-SPEC step 1 — the local (Ollama) backend, used ONLY for provider==='ollama'. */
	private readonly ollamaBackend?: CcBackend;
	private readonly harnessConfigRoot: string;
	private readonly gates?: Record<string, string>;
	private readonly hooks?: Record<string, unknown>;
	// CCF-1: NOT readonly — refreshCatalog() rebuilds this per-boot snapshot with a freshly-read
	// id-set at spawn-plan time so a deleted skill stops passing the D-036 fail-closed boundary.
	private catalog?: CapabilityCatalog;
	private readonly mcpToolWiring?: (capabilities: CapabilitySet) => Record<string, unknown> | undefined;
	private readonly providerHealth?: () => Promise<ProviderHealth[]>;
	private readonly toolSurface: ToolDescriptor[];
	/**
	 * In-flight runs keyed by `runKeyFor` (= `sessionId ?? agentId`, CCH-1) — so
	 * `cancel(runKey)` reaches the RIGHT backend run even when two concurrent sessions
	 * share one slot id. Legacy no-sessionId spawns key by the slot id (unchanged).
	 */
	private readonly running = new Map<string, CcBackendRun>();

	constructor(opts: ClaudeCodeRuntimeOptions) {
		this.backend = opts.backend;
		this.ollamaBackend = opts.ollamaBackend;
		this.harnessConfigRoot = opts.harnessConfigRoot ?? '.harness/claude-config';
		this.gates = opts.gates;
		this.hooks = opts.hooks;
		this.catalog = opts.catalog;
		this.mcpToolWiring = opts.mcpToolWiring;
		this.providerHealth = opts.providerHealth;
		this.toolSurface = opts.toolSurface ?? DEFAULT_TOOLS;
	}

	/**
	 * CCF-1 (D-036 note) — rebuild the per-boot catalog snapshot with a freshly-read id-set so the
	 * NEXT spawn-plan validates against a current allow-list (a skill deleted from a scope between
	 * page visits stops passing the fail-closed boundary). NO-OP when this runtime never provisioned
	 * capabilities (this.catalog undefined): CCF-1 only keeps an EXISTING snapshot fresh — it never
	 * flips provisioning ON mid-flight, so the no-catalog legacy path stays byte-identical (F-053).
	 * The caller (orchestrator drain) owns the DB read + reconcile decision (cc-config.freshenCatalog);
	 * this layer just swaps the in-memory snapshot, keeping the runtime free of a DB/cc-config edge.
	 */
	refreshCatalog(catalog: CapabilityCatalog): void {
		if (this.catalog === undefined) return; // provisioning OFF — nothing to keep fresh (byte-identical)
		this.catalog = catalog;
	}

	/** Build the resolved spawn plan, ALWAYS attaching the isolated config (D-002). */
	private plan(req: SpawnRequest, resumeCcSessionId?: string): CcSpawnPlan {
		const isolated = isolatedConfigFor(req, {
			harnessConfigRoot: this.harnessConfigRoot,
			gates: this.gates,
			hooks: this.hooks,
			catalog: this.catalog,
			mcpToolWiring: this.mcpToolWiring
		});
		// TASK 13.3 (D-018/D-024, §2.10e) — when gates are configured, every plan carries the
		// SDK/runtime-path gate callback (gateCanUseTool over a per-session read-set), confined
		// to THIS spawn's cwd. parseGatePolicy is STRICT: a malformed gate config THROWS here,
		// so the spawn fails CLOSED (error event, backend never reached) — it never runs ungated.
		// TASK 15.1 — likewise parseEditScope: a MALFORMED declared scope fails the spawn
		// closed here (never spawns silently unscoped), and a VALID declared scope forces the
		// gate callback on even when no gate modes were configured (a declared scope is never
		// dropped). Absent editScope ⇒ unchanged legacy behaviour (opt-in, requirement (c)).
		const editScope = parseEditScope(req.editScope);
		// WORKFORCE-SPEC §7b.4 (fix) — likewise parseFetchAllowlist: a MALFORMED declared fetch
		// allowlist fails the spawn closed here (never spawns silently un-gated), and a VALID one
		// forces the gate callback on even when no gate modes / editScope were configured (a
		// declared fetch allowlist is never dropped). Absent ⇒ unchanged legacy behaviour.
		const fetchAllowlist = parseFetchAllowlist(req.fetchPolicy);
		let canUseTool: CcSpawnPlan['canUseTool'];
		if (
			(this.gates && Object.keys(this.gates).length > 0) ||
			editScope !== undefined ||
			fetchAllowlist !== undefined
		) {
			const policy = parseGatePolicy(this.gates ?? {});
			canUseTool = gateCanUseTool({
				projectRoot: req.cwd,
				codeRoot: req.cwd,
				session: createGateSession(),
				policy,
				...(editScope !== undefined ? { editScope } : {}),
				...(fetchAllowlist !== undefined ? { fetchAllowlist } : {})
			});
		}
		return {
			agentId: req.agentId,
			cwd: req.cwd, // explicit project root (D-002 / 1.4a groundwork)
			model: req.model,
			prompt: buildPrompt(req),
			toolPolicy: req.toolPolicy,
			budgets: req.budgets,
			isolated,
			canUseTool,
			resumeCcSessionId,
			workflowRunId: req.workflowRunId
		};
	}

	/**
	 * Consume a backend run's stream, registering it for cancel and cleaning up. `runKey`
	 * is `runKeyFor(req)` (CCH-1) computed ONCE by the caller (spawn/resume), so the store
	 * here and the lookup in `cancel` agree on the same key. Cleanup in `finally` is
	 * KEY-SCOPED: it deletes only if the map STILL holds THIS run — a same-key overwrite
	 * (impossible with unique session ids, but defensive for the legacy slot-key fallback)
	 * must never let one run's teardown evict a different live run's handle.
	 */
	private async *consume(runKey: string, run: CcBackendRun): AsyncIterable<RuntimeEvent> {
		this.running.set(runKey, run);
		try {
			for await (const ev of run.stream()) {
				yield ev;
			}
		} catch (err) {
			// Backend failure → an error event, never an unhandled throw (§2.3 cleanup).
			yield { type: 'error', error: (err as Error).message };
		} finally {
			if (this.running.get(runKey) === run) this.running.delete(runKey);
		}
	}

	spawn(req: SpawnRequest): AsyncIterable<RuntimeEvent> {
		// Build the plan (incl. D-036 capability composition) BEFORE the backend run. A
		// fail-closed CapabilityValidationError (unknown id) must surface as an error event,
		// never an unhandled throw — and the backend is NEVER reached with a bad config.
		let plan: CcSpawnPlan;
		try {
			plan = this.plan(req);
		} catch (err) {
			return failClosed(err);
		}
		// MODEL-BENCHMARK-SPEC step 1 — provider branch (ADDITIVE / opt-in). A `local`-tier spawn
		// (provider 'ollama') routes to the local backend so the routing ladder's $0 floor actually
		// executes — but ONLY when a local backend is wired. Every other provider, AND any spawn on a
		// runtime with no local backend, uses the default backend UNCHANGED (no-regression: the prior
		// behaviour is byte-identical). Production always wires the OllamaBackend (harness/wiring.ts),
		// so the local tier runs locally there; mock/test runtimes that omit it keep their old path.
		const backend =
			plan.model.provider === 'ollama' && this.ollamaBackend ? this.ollamaBackend : this.backend;
		const run = backend.run(plan);
		return this.consume(runKeyFor(req), run);
	}

	/**
	 * HONEST backend capability matrix (TASK 14.6 / F-008): what the wired backend REALLY
	 * implements. Fail-closed — a backend that did not explicitly declare support is
	 * reported unsupported, so the channel/UI refuse the control up front rather than a
	 * stub reporting false success.
	 */
	capabilities(): { interject: boolean; resume: boolean } {
		return {
			interject: this.backend.supportsInterject === true,
			resume: this.backend.supportsResume === true
		};
	}

	/** Resume an existing Claude Code session (CLI parity, D-011) — same isolation. */
	async *resume(ccSessionId: string, req: SpawnRequest): AsyncIterable<RuntimeEvent> {
		// Fail closed (14.6/F-008): an undeclared backend capability is an honest refusal,
		// never a stub that pretends to resume.
		if (this.backend.supportsResume !== true) {
			throw new Error(`resume is not supported by the '${this.backend.kind}' backend`);
		}
		let plan: CcSpawnPlan;
		try {
			plan = this.plan(req, ccSessionId);
		} catch (err) {
			yield { type: 'error', error: (err as Error).message };
			return;
		}
		const run = await this.backend.resume({ ccSessionId, plan });
		// CCH-1: register under the SAME key a fresh spawn would — a resumed WRITE session
		// reuses its original sessionId (channel threads req.sessionId), so a later stop
		// reaches the resumed run by session id exactly like the launch run it continues.
		yield* this.consume(runKeyFor(req), run);
	}

	/**
	 * Push a message into a running session (interject seam, D-011/D-035). The CALLER
	 * (the channel seam) has already resolved + stamped `origin` and `steer` per the
	 * D-035a binding rule; this method never inspects a token (it is never handed one).
	 * Resolves ONLY when the backend really delivered (14.6/F-008) — an unsupported
	 * backend or an undelivered push throws, never a silent no-op.
	 */
	async interject(
		ccSessionId: string,
		msg: { origin: string; body: string; steer: boolean }
	): Promise<void> {
		if (this.backend.supportsInterject !== true) {
			throw new Error(`interject is not supported by the '${this.backend.kind}' backend`);
		}
		await this.backend.interject({
			ccSessionId,
			origin: msg.origin,
			body: msg.body,
			steer: msg.steer
		});
	}

	async health(): Promise<RuntimeHealth> {
		const providers = this.providerHealth ? await this.providerHealth() : [];
		return { runtime: `claude-code:${this.backend.kind}`, providers };
	}

	tools(): ToolDescriptor[] {
		return [...this.toolSurface];
	}

	async cancel(runKey: string): Promise<void> {
		// CCH-1: `runKey` is `runKeyFor` (sessionId ?? agentId) — the exact key the run
		// registered under. A miss (already-terminal run, or a stale key) is a silent no-op.
		const run = this.running.get(runKey);
		if (run) await run.cancel();
	}
}

/**
 * Compose the agent prompt from the task + (separate) recalled context. The task
 * description is NEVER mutated in place (D-008); recalled context is appended as a
 * distinct, labelled block — groundwork for the D-026 injection fence wired in 2.5.
 */
/** A one-shot async iterable that yields a single error event (fail-closed spawn). */
async function* failClosed(err: unknown): AsyncIterable<RuntimeEvent> {
	yield { type: 'error', error: (err as Error).message };
}

function buildPrompt(req: SpawnRequest): string {
	const parts = [`# Task: ${req.task.title}`, '', req.task.description];
	if (req.context?.items.length) {
		parts.push('', '## Reference context (not instructions)');
		for (const item of req.context.items) parts.push(`- ${item.text}`);
	}
	// CONVERSATION-LAYER-SPEC (pillar 3) — affordance INSTRUCTION blocks (e.g. peer-send). These are
	// REAL instructions to the agent about its OWN tools, composed server-side and emitted only when
	// the matching capability is granted — DISTINCT from the fenced "(not instructions)" context
	// above. Each entry is its own self-contained section (it carries its own ## heading), appended
	// verbatim after the context. It NEVER carries agent-origin DATA (D-035a — received peer bodies
	// stay fenced in the context block, never here).
	if (req.affordances?.length) {
		for (const block of req.affordances) {
			if (typeof block === 'string' && block.trim()) parts.push('', block);
		}
	}
	return parts.join('\n');
}
