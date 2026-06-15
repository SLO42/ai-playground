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

// ════════════════════════════════════════════════════════════════════════════════════════════
// G-B — PEER_SEND fleet-bus tool (PEER-MESSAGE-SPEC; D-035a/D-026/D-036). MIRRORS the B10
// memory-pull surface above exactly: a reserved capability id, a `*Granted()` scan, and a
// `build*McpServer` registration builder. The two surfaces are independent (a session may be
// granted one, both, or neither); the runtime merges whichever blocks are granted.
//
// THE NON-NEGOTIABLE INVARIANT (D-035a). Registering this tool grants NO steering: a sent
// peer message is origin=agent → FENCED as DATA, NON-STEERING, with the sender stamped
// SERVER-SIDE at the ingress (NEVER from the tool-call body). This module owns ONLY the
// registration + capability-gating; every guard (screen→fence, the PM1 recipient policy, the
// cross-project isolation, the per-session/recipient/hops bounds) lives behind the loopback
// /api/peer/send endpoint the registration points at. A registration entry carries a command
// to run, not message content — it cannot, by construction, move a guard.
// ════════════════════════════════════════════════════════════════════════════════════════════

/** The canonical MCP server NAME the peer-send tool registers under. A granted session sees the
 *  tool as `mcp__atelier-peer__peer_send`. Atelier-namespaced, distinct from the operator's
 *  servers (D-002 isolation). */
export const PEER_SEND_MCP_NAME = 'atelier-peer';

/** The PRIMARY reserved capability id the peer-send tool is gated on. */
export const PEER_SEND_CAPABILITY_ID = 'peer-send';

/**
 * The reserved capability-id alias set for the peer-send surface. A grant marker is ANY of these
 * appearing in any dimension of the (composed, catalog-validated) bundle. Mirrors
 * MEMORY_PULL_CAPABILITY_IDS so "granted here" is decided against ONE id set, never a drifting
 * copy. (The fleet bus has no sterile-interview rail of its own — an interview session simply
 * never declares a peer-send id; if that ever changes, mirror the §3.2 refusal.)
 */
export const PEER_SEND_CAPABILITY_IDS: ReadonlySet<string> = new Set([
	'peer-send',
	'peer_send',
	'peer-message',
	'peer_message',
	'fleet-message'
]);

/** The stdio MCP server script the peer-send registration points at (plain ESM, like memory-pull). */
export const PEER_SEND_MCP_SCRIPT = 'peer-send-mcp.mjs';

/**
 * Is the peer-send tool GRANTED by a (composed, catalog-validated) capability set? The grant
 * marker is a reserved `peer-send` alias in ANY dimension (skills/agents/mcp). FAIL CLOSED: an
 * absent/empty/malformed set grants nothing (default deny — the tool is reachable ONLY when
 * explicitly composed in). Shadow paths mirror memoryPullGranted exactly: nil set → false; a
 * non-array dimension contributes nothing (never throws); a non-string entry is ignored.
 */
export function peerSendGranted(capabilities: CapabilitySet | undefined): boolean {
	if (!capabilities || typeof capabilities !== 'object') return false;
	const dims = [capabilities.skills, capabilities.agents, capabilities.mcp];
	for (const dim of dims) {
		if (!Array.isArray(dim)) continue;
		for (const id of dim) {
			if (typeof id === 'string' && PEER_SEND_CAPABILITY_IDS.has(id)) return true;
		}
	}
	return false;
}

/** Options for {@link buildPeerSendMcpServer} — identical shape to the memory-pull builder. */
export interface BuildPeerSendServerOptions {
	/** Boot-minted loopback control-plane coordinates (D-025). HONEST-OFF: absent ⇒ no registration. */
	env: { HOOK_URL?: string; HOOK_TOKEN?: string };
	/** Server root the MCP script resolves under (`<root>/scripts/<script>`). Injected for tests. */
	serverRoot: string;
	/** Override the node binary that runs the MCP server (default: the current process's node). */
	nodeBin?: string;
}

/**
 * Build the isolated-config `mcpServers` block that REGISTERS the peer-send tool for a session, or
 * undefined when the control plane is not wired (honest OFF — never a dead half-block; F-008).
 * Mirrors buildMemoryPullMcpServer byte-for-byte in posture: a quoted `node <script>` command (a
 * space in the install dir is safe — Windows/MINGW lesson), and the D-025 token is NEVER in the
 * command string (the MCP server reads HOOK_URL/HOOK_TOKEN from the inherited spawn ENV).
 *
 * GATE-AGNOSTIC by design: it does NOT check the grant — the caller (wiring.mcpToolWiring) gates
 * on {@link peerSendGranted} FIRST and only calls this when granted.
 */
export function buildPeerSendMcpServer(opts: BuildPeerSendServerOptions): McpServers | undefined {
	const baseUrl = opts.env.HOOK_URL?.trim();
	const token = opts.env.HOOK_TOKEN?.trim();
	if (!baseUrl || !token) return undefined; // honest OFF — no coordinates ⇒ register nothing
	const node = opts.nodeBin?.trim() || process.execPath;
	const script = join(opts.serverRoot, 'scripts', PEER_SEND_MCP_SCRIPT);
	return {
		[PEER_SEND_MCP_NAME]: {
			type: 'stdio',
			command: node,
			args: [script]
		}
	};
}

// ── BACKING TRANSPORT (DELIVERED — was deferred D-B10-1/2, landed in the B10-transport wave) ──
//
// This module makes the tool REGISTERABLE + GATED. The two runtime pieces it pointed at — the
// stdio MCP server and the loopback endpoint — are now BUILT (the dead tool is reachable):
//
//   D-B10-1  scripts/memory-pull-mcp.mjs — the stdio MCP server the registration points at.
//            Exposes ONE tool (`pull`: {query, project?, limit?}), reads HOOK_URL/HOOK_TOKEN
//            from env (D-025 — never the command string), loopback-verifies, and POSTs the
//            loopback `/api/memory/pull` endpoint with an 8s fetch bound (like gate-hook.mjs).
//            Plain ESM speaking NDJSON JSON-RPC 2.0 (initialize/tools/list/tools/call). On any
//            transport failure it returns an honest NAMED error to the agent, never a fabricated
//            result (F-008). Unit + subprocess-round-trip tests: scripts/memory-pull-mcp.test.js.
//
//   D-B10-2  routes/api/memory/pull/+server.ts — the loopback endpoint the MCP server calls.
//            Authorizes the D-025 token (authorizeHookRequest, like /api/gates/pretooluse),
//            resolves the wired MemoryService (harness/wiring.getMemoryService), calls
//            pullMemory(mem, input), and returns its already-fenced result verbatim. EVERY
//            chokepoint stays the engine's — a thin auth+dispatch shell, re-implements NO
//            recall/fence/budget. Tests: src/routes/api/memory/pull/server.test.ts.
//
// The fence/screen/quarantine/budget red-team runs at the engine seam against a REAL corpus
// (agent/pull-memory.test.ts: planted secret EXCLUDED, planted injection FENCED); the GATING +
// CLI load-path delivery run here + in cli-backend.test.ts. The transport owns no guard, so it
// cannot bypass one — a live invocation routes through pullMemory → recall() + assembleInjection().
