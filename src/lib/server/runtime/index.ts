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
	workflowRunId?: string; // set when this spawn is a workflow step (D-013)
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
	/** Cancel a running agent. */
	cancel(agentId: string): Promise<void>;
}

// ── Isolated config (S1 / D-002) ─────────────────────────────────────────────────

/** The harness's own gate/hook bundle — the ONLY config a driven agent ever sees. */
export interface HarnessSettings {
	/** D-018 gates: gate-name → 'warn' | 'deny'. */
	gates?: Record<string, string>;
	/** D-019 hooks: hook-name → proxy script path (loopback POST, no-op on failure). */
	hooks?: Record<string, string>;
	/** ALWAYS empty for driven agents — no inherited operator plugins (S1 finding). */
	plugins?: string[];
	/** ALWAYS empty — no inherited marketplaces. */
	marketplaces?: string[];
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
	/** Harness hooks (D-019). */
	hooks?: Record<string, string>;
}

/** Sanitize an agent id into a filesystem-safe segment for the isolated config dir. */
function safeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'agent';
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
	const configDir = `${root}/${safeSegment(req.agentId)}`;

	// Strip the operator's inherited CLAUDE_CONFIG_DIR; pin ours. The whole point of
	// the isolation is that the driven agent never sees the operator's global config.
	const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir };

	const settings: HarnessSettings = {
		gates: opts.gates ?? {},
		hooks: opts.hooks ?? {},
		// Explicitly empty — the S1-proven determinism guard.
		plugins: [],
		marketplaces: []
	};

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
	/** Harness hooks (D-019) carried into every isolated --settings. */
	hooks?: Record<string, string>;
	/** Provider health source — read from the providers single owner (§2.5). */
	providerHealth?: () => Promise<ProviderHealth[]>;
	/** Tool surface the runtime exposes; defaults to the standard CC tool set. */
	toolSurface?: ToolDescriptor[];
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
	private readonly harnessConfigRoot: string;
	private readonly gates?: Record<string, string>;
	private readonly hooks?: Record<string, string>;
	private readonly providerHealth?: () => Promise<ProviderHealth[]>;
	private readonly toolSurface: ToolDescriptor[];
	/** In-flight runs by agentId — so cancel(agentId) reaches the right backend run. */
	private readonly running = new Map<string, CcBackendRun>();

	constructor(opts: ClaudeCodeRuntimeOptions) {
		this.backend = opts.backend;
		this.harnessConfigRoot = opts.harnessConfigRoot ?? '.harness/claude-config';
		this.gates = opts.gates;
		this.hooks = opts.hooks;
		this.providerHealth = opts.providerHealth;
		this.toolSurface = opts.toolSurface ?? DEFAULT_TOOLS;
	}

	/** Build the resolved spawn plan, ALWAYS attaching the isolated config (D-002). */
	private plan(req: SpawnRequest, resumeCcSessionId?: string): CcSpawnPlan {
		const isolated = isolatedConfigFor(req, {
			harnessConfigRoot: this.harnessConfigRoot,
			gates: this.gates,
			hooks: this.hooks
		});
		return {
			agentId: req.agentId,
			cwd: req.cwd, // explicit project root (D-002 / 1.4a groundwork)
			model: req.model,
			prompt: buildPrompt(req),
			toolPolicy: req.toolPolicy,
			budgets: req.budgets,
			isolated,
			resumeCcSessionId,
			workflowRunId: req.workflowRunId
		};
	}

	/** Consume a backend run's stream, registering it for cancel and cleaning up. */
	private async *consume(agentId: string, run: CcBackendRun): AsyncIterable<RuntimeEvent> {
		this.running.set(agentId, run);
		try {
			for await (const ev of run.stream()) {
				yield ev;
			}
		} catch (err) {
			// Backend failure → an error event, never an unhandled throw (§2.3 cleanup).
			yield { type: 'error', error: (err as Error).message };
		} finally {
			this.running.delete(agentId);
		}
	}

	spawn(req: SpawnRequest): AsyncIterable<RuntimeEvent> {
		const run = this.backend.run(this.plan(req));
		return this.consume(req.agentId, run);
	}

	/** Resume an existing Claude Code session (CLI parity, D-011) — same isolation. */
	async *resume(ccSessionId: string, req: SpawnRequest): AsyncIterable<RuntimeEvent> {
		const run = await this.backend.resume({
			ccSessionId,
			plan: this.plan(req, ccSessionId)
		});
		yield* this.consume(req.agentId, run);
	}

	/**
	 * Push a message into a running session (interject seam, D-011/D-035). The CALLER
	 * (the channel seam) has already resolved + stamped `origin` and `steer` per the
	 * D-035a binding rule; this method never inspects a token (it is never handed one).
	 */
	async interject(
		ccSessionId: string,
		msg: { origin: string; body: string; steer: boolean }
	): Promise<void> {
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

	async cancel(agentId: string): Promise<void> {
		const run = this.running.get(agentId);
		if (run) await run.cancel();
	}
}

/**
 * Compose the agent prompt from the task + (separate) recalled context. The task
 * description is NEVER mutated in place (D-008); recalled context is appended as a
 * distinct, labelled block — groundwork for the D-026 injection fence wired in 2.5.
 */
function buildPrompt(req: SpawnRequest): string {
	const parts = [`# Task: ${req.task.title}`, '', req.task.description];
	if (req.context?.items.length) {
		parts.push('', '## Reference context (not instructions)');
		for (const item of req.context.items) parts.push(`- ${item.text}`);
	}
	return parts.join('\n');
}
