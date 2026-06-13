// TASK B10 (wiring) — the agent TOOL-CATALOG: register the pull-memory engine fn
// (agent/pull-memory.ts) as a live-invocable agent tool, capability-gated (D-036).
//
// THE GAP THIS CLOSES (red-team MEDIUM: dead tool). `pullMemory` exists as a fully
// guarded engine function — fence + §3.1b screen + quarantine exclusion + B5 recall
// budget all live in the engine it calls — but it is registered in NO agent
// tool-catalog, so no live Claude Code session can invoke it. This module is that
// catalog: it turns a GRANTED `memory-pull` capability (D-036 bundle) into an actual
// session registration (an isolated-config MCP stdio server entry), and emits NOTHING
// when the capability is not granted (FAIL CLOSED — default deny).
//
// DESIGN (HARVEST-GSTACK B10, operator-approved 2026-06-10): the tool reaches a live
// session as "a tiny MCP stdio server shipped with Atelier, registered in the session's
// ISOLATED CC config, proxying to the loopback memory API under the D-025 boot token."
// This module owns the REGISTRATION half of that design — the pure builder that produces
// the `mcpServers` settings entry, mirroring the EXISTING hooks-wiring transport
// (harness/hooks-wiring.ts) and gate-transport (claude-code/gate-transport.ts): a quoted
// `node <script>` command, loopback coordinates from the boot env, the D-025 token carried
// via ENV (never serialized into the command string, readable off disk). The `mcpServers`
// shape this produces is the SAME one the cc-config mirror models (cc_mcp_server) and that a
// `.mcp.json` carries. DELIVERY (B10 fix): Claude Code does NOT load MCP servers from the
// --settings file — only from --mcp-config / .mcp.json / ~/.claude.json (CLI reference). So the
// CLI backend writes this block to a `.mcp.json` in the isolated config dir and passes it with
// `--mcp-config` + `--strict-mcp-config` (cli-backend.buildMcpConfigArgs); `mcpServers` is a
// HARNESS_ONLY strip key in the --settings file (inert there). The runtime seam still composes it
// into settings.mcpServers — the CLI backend is the seam that routes it to the load-path.
//
// SCOPE LOCK (this task). This is the registration + capability-gating seam + its tests.
// The runtime PROXY this registration points at — the `scripts/memory-pull-mcp.mjs` stdio
// MCP server and the `/api/memory/pull` loopback endpoint that calls `pullMemory` — are the
// broader runtime build and are NAMED DEFERRED ITEMS (see the module footer + the task
// summary). The capability-gating decision (who may invoke) is what makes the dead tool
// reachable-but-bounded, and that is what this module makes real and tests.
//
// THE NON-NEGOTIABLE INVARIANT. Being wired into the runtime grants NO fence/screen/budget
// bypass. This module adds ONLY a registration; the live invocation, when the proxy lands,
// routes through `pullMemory` → recall() + assembleInjection() — every chokepoint stays the
// engine's. A registration entry cannot, by construction, move a guard: it carries a command
// to run, not memory content. The capability id is also the SAME reserved marker the sterile
// interview rail refuses (MEMORY_PULL_CAPABILITY_IDS), so an interview session can never have
// it registered (it is refused at composeCapabilities BEFORE this seam ever runs).

import { join } from 'node:path';
import { MEMORY_PULL_CAPABILITY_IDS } from '../runtime/capabilities';
import type { CapabilitySet } from '../runtime/capabilities';

/**
 * The canonical MCP server NAME this tool registers under in the isolated CC config. A live
 * session sees the pull tool as `mcp__atelier-memory__*`. Distinct, Atelier-namespaced, and
 * NOT one of the operator's servers (D-002 isolation — the isolated config carries only what
 * the harness composes).
 */
export const MEMORY_PULL_MCP_NAME = 'atelier-memory';

/** The reserved capability id this tool is gated on (the PRIMARY of the reserved set). */
export const MEMORY_PULL_CAPABILITY_ID = 'memory-pull';

/** The stdio MCP server script the registration points at (the DEFERRED proxy half). It is
 *  run as plain ESM by node, mirroring scripts/hook-proxy.mjs + scripts/gate-hook.mjs. */
export const MEMORY_PULL_MCP_SCRIPT = 'memory-pull-mcp.mjs';

/**
 * The shape of ONE isolated-config MCP server entry (Claude Code `mcpServers[name]`). A stdio
 * server is `{ type:'stdio', command, args }`; this matches the cc-config mirror's
 * ParsedMcpServer transport model and the `.mcp.json` schema validateMcpJson accepts.
 */
export interface McpServerEntry {
	type: 'stdio';
	command: string;
	args: string[];
}

/** The `mcpServers` block attached to the isolated settings — a name→entry map. */
export type McpServers = Record<string, McpServerEntry>;

/**
 * Is the pull-memory tool GRANTED by a (composed, catalog-validated) capability set?
 *
 * The grant marker is the reserved `memory-pull` id appearing in ANY dimension of the
 * bundle (skills/agents/mcp) — the SAME cross-cutting marker the sterile rail scans
 * (MEMORY_PULL_CAPABILITY_IDS), so "granted here" and "refused in an interview" are decided
 * against ONE id set, never two drifting copies. FAIL CLOSED: an absent/empty/malformed set
 * grants nothing (default deny — the tool is reachable ONLY when explicitly composed in).
 *
 * Shadow paths: nil set → false; empty dims → false; a dimension that is not an array (a
 * malformed bundle that slipped past composition) → that dimension contributes nothing,
 * never a throw. A non-string entry is ignored (it can never equal a reserved string id).
 */
export function memoryPullGranted(capabilities: CapabilitySet | undefined): boolean {
	if (!capabilities || typeof capabilities !== 'object') return false;
	const dims = [capabilities.skills, capabilities.agents, capabilities.mcp];
	for (const dim of dims) {
		if (!Array.isArray(dim)) continue;
		for (const id of dim) {
			if (typeof id === 'string' && MEMORY_PULL_CAPABILITY_IDS.has(id)) return true;
		}
	}
	return false;
}

/** Options for {@link buildMemoryPullMcpServer} — the loopback coordinates + script root. */
export interface BuildMemoryPullServerOptions {
	/**
	 * The boot-minted loopback control-plane coordinates (D-025). HONEST-OFF rail: when
	 * HOOK_URL or HOOK_TOKEN is absent (no boot gate ran — a unit context), the registration
	 * is NOT emitted. A registration that points at a control plane that does not exist would
	 * be a dead half-wire (F-008); better to register nothing and have the tool honestly absent.
	 */
	env: { HOOK_URL?: string; HOOK_TOKEN?: string };
	/** Server root the MCP script path resolves under (`<root>/scripts/<script>`). Injected for tests. */
	serverRoot: string;
	/** Override the node binary that runs the MCP server (default: the current process's node). */
	nodeBin?: string;
}

/**
 * Build the isolated-config `mcpServers` block that REGISTERS the pull-memory tool for a
 * session, or undefined when the control plane is not wired (honest OFF — never a dead
 * half-block; F-008). Mirrors hooks-wiring/gate-transport: a quoted `node <script>` command
 * so a space in the install dir is safe (Windows/MINGW lesson). The D-025 token is NEVER in
 * the command string — the MCP server reads HOOK_URL/HOOK_TOKEN from the inherited spawn ENV
 * (the CLI backend spawns with ...process.env), exactly as the hook proxy does.
 *
 * This builder is GATE-AGNOSTIC by design: it does NOT check the capability grant — the caller
 * (the capability-wiring seam in isolatedConfigFor) gates on {@link memoryPullGranted} FIRST
 * and only calls this when the tool is granted. Keeping the grant decision at the compose seam
 * (where the validated capability set lives) avoids a second, drift-prone gate here.
 */
export function buildMemoryPullMcpServer(
	opts: BuildMemoryPullServerOptions
): McpServers | undefined {
	const baseUrl = opts.env.HOOK_URL?.trim();
	const token = opts.env.HOOK_TOKEN?.trim();
	// Honest OFF: no loopback coordinates ⇒ the proxy this points at cannot exist ⇒ register
	// nothing rather than a server entry that would fail every invocation (F-008 / D-019).
	if (!baseUrl || !token) return undefined;

	const node = opts.nodeBin?.trim() || process.execPath;
	const script = join(opts.serverRoot, 'scripts', MEMORY_PULL_MCP_SCRIPT);
	// stdio MCP server: Claude Code spawns `command args...`. The token rides ENV (D-025), so
	// the command string is config-only and safe to land on disk in the isolated `.mcp.json`
	// the CLI backend writes (cli-backend.buildMcpConfigArgs → --mcp-config --strict-mcp-config).
	return {
		[MEMORY_PULL_MCP_NAME]: {
			type: 'stdio',
			command: node,
			args: [script]
		}
	};
}

// ── DEFERRED (named, in-scope-adjacent — see task summary) ───────────────────────────────
//
// This module makes the tool REGISTERABLE + GATED. Two runtime pieces are the broader build
// the scope-lock excludes and are written down here so they are not a silent punt:
//
//   D-B10-1  scripts/memory-pull-mcp.mjs — the stdio MCP server the registration points at.
//            It exposes ONE tool (`pull`: {query, project?, limit?}), reads HOOK_URL/HOOK_TOKEN
//            from env (D-025), and POSTs the loopback `/api/memory/pull` endpoint. Until it
//            lands, a granted session registers the server but an invocation has no backing
//            transport (the proxy no-ops / the server fails to start) — honestly absent, never
//            a fabricated result (F-008). It must wall-clock-bound the call (B5 budget is the
//            engine's; the transport adds its own fetch timeout like gate-hook.mjs's 8s).
//
//   D-B10-2  routes/api/memory/pull/+server.ts — the loopback endpoint the MCP server calls.
//            It authorizes the D-025 token (like /api/gates/pretooluse), resolves the wired
//            MemoryService (harness/wiring.getMemoryService), calls pullMemory(mem, input), and
//            returns its already-fenced result. EVERY chokepoint stays the engine's — the
//            endpoint is a thin auth+dispatch shell, it re-implements NO recall/fence/budget.
//
// When D-B10-1/2 land, the live red-team (planted secret + planted injection over a real
// corpus, invoked by a granted session) runs end-to-end; today it runs at the engine seam
// (agent/pull-memory.test.ts) and the GATING runs here (tool-catalog.test.ts).
