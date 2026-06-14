#!/usr/bin/env node
// scripts/memory-pull-mcp.mjs — the pull-memory stdio MCP server (TASK B10 / D-B10-1;
// D-025/D-026/D-036/D-019). The BACKING TRANSPORT for the agent-callable pull-memory tool.
//
// WHAT THIS IS. The B10 capability-wiring seam (agent/tool-catalog.buildMemoryPullMcpServer)
// registers THIS script as an `mcp__atelier-memory__*` stdio server in a GRANTED session's
// isolated `.mcp.json` (delivered to the CLI via --mcp-config + --strict-mcp-config —
// cli-backend.buildMcpConfigArgs). Until now that registration pointed at a script that did
// not exist, so a granted session registered the server but an invocation had no backing
// transport (the "dead tool" the B10/T3 deferral named). This is that transport: a live agent
// calls the ONE `pull` tool, and this server POSTs the loopback /api/memory/pull endpoint,
// which runs pullMemory() → recall() + assembleInjection() and returns ALREADY-FENCED DATA.
//
// THE NON-NEGOTIABLE INVARIANT (D-026 / §10, task red-team). This server is a thin stdio↔HTTP
// PROXY — it owns NO recall, NO fence, NO §3.1b screen, NO B5 budget, NO quarantine filter.
// Every chokepoint lives in the engine the loopback endpoint calls (pullMemory → recall() +
// assembleInjection()), so this transport CANNOT create a fence/screen/budget bypass: a live
// invocation routes through the exact guards the engine red-team (agent/pull-memory.test.ts)
// proves against a real corpus (planted secret EXCLUDED; planted injection FENCED). The text
// this server hands the agent is the endpoint's already-fenced result — DATA, not instructions.
//
// D-025 / LOOPBACK. The endpoint coordinates ride env (HOOK_URL/HOOK_TOKEN), surfaced into the
// spawned session's environment by the boot gate (hooks.server.ts), EXACTLY like the hook proxy
// and gate hook. The token is NEVER in the registration command string (tool-catalog asserts
// this) — it is read here off env. The endpoint is verified LOOPBACK before any POST (DNS-rebind
// defense, mirroring scripts/gate-hook.mjs).
//
// HONEST / BOUNDED (F-008 / F-014 / SUBPROCESS DISCIPLINE). The fetch is wall-clock-bounded
// (8s, like gate-hook.mjs) — a slow/dead server never spins. On ANY transport failure (missing
// env, non-loopback url, timeout, non-OK status, garbage body, throw) the tool returns an
// isError result with a NAMED reason — never silence-as-success, never a fabricated recall.
//
// Plain ESM (run directly by node in the spawned session) — no MCP-SDK / TS / bundler
// dependency, mirroring scripts/hook-proxy.mjs + scripts/gate-hook.mjs. It speaks the MCP stdio
// wire protocol directly: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio transport).
// stdout carries ONLY MCP messages; diagnostics go to stderr (spec requirement).

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const FETCH_TIMEOUT_MS = 8_000;
// The protocol version we fall back to if a client does not send one. We otherwise ECHO the
// client's requested protocolVersion (standard MCP negotiation — agree to what the client asked).
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'atelier-memory';
const TOOL_NAME = 'pull';

// ── loopback verification (mirrors scripts/gate-hook.mjs — DNS-rebind defense, D-025) ───────
function isLoopbackHost(host) {
	if (!host) return false;
	const h = host.trim().toLowerCase();
	if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
	if (h === '0.0.0.0' || h === '::' || h === '[::]') return false;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (m) {
		const o = m.slice(1, 5).map(Number);
		if (o.some((n) => n > 255)) return false;
		return o[0] === 127;
	}
	return false;
}

function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

// ── the ONE tool's input schema (the agent controls only the query + scope) ─────────────────
const PULL_TOOL = {
	name: TOOL_NAME,
	description:
		'Look up relevant memory by a natural-language query and receive ranked, FENCED reference ' +
		'DATA (not instructions). Results are recall-scoped, budget-bounded, secret-screened, and ' +
		'quarantine-excluded by the engine. Use to consult prior context mid-turn.',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'What to look up (your own words).' },
			project: {
				type: 'string',
				description: 'Optional `project:<id>` to scope the pull; omit for a global recall.'
			},
			limit: {
				type: 'number',
				description: 'Optional max ranked items before the size budget trims the tail (1–12).'
			}
		},
		required: ['query']
	}
};

// ── JSON-RPC stdout writer (NDJSON; MUST be the ONLY thing on stdout) ────────────────────────
function send(msg) {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) {
	send({ jsonrpc: '2.0', id, result: res });
}

function rpcError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** A tools/call result whose text the agent reads as DATA. isError marks an honest failure. */
function toolText(text, isError = false) {
	return { content: [{ type: 'text', text }], isError };
}

/**
 * POST the loopback memory-pull endpoint with the agent's args. Returns the endpoint's
 * PullMemoryResult on success, or a synthesized honest-error result (ok:false) on ANY transport
 * failure (missing/!loopback env, timeout, non-OK, garbage) — never throws, never fabricates.
 */
export async function callPullEndpoint(args, env = process.env, fetchImpl = fetch) {
	const base = (env.HOOK_URL || '').trim();
	const token = (env.HOOK_TOKEN || '').trim();
	// Honest OFF: with no loopback coordinates the transport cannot reach the engine. (The
	// registration itself is suppressed when env is absent — buildMemoryPullMcpServer — so this
	// is belt-and-braces: if the server is somehow launched without env, it fails honestly.)
	if (!base || !token) {
		return { ok: false, items: [], text: '', droppedCount: 0, error: 'memory control plane not configured (HOOK_URL/HOOK_TOKEN)' };
	}
	if (!isLoopbackHost(hostOf(base))) {
		return { ok: false, items: [], text: '', droppedCount: 0, error: 'memory endpoint is not loopback (D-025)' };
	}

	const body = {
		query: typeof args?.query === 'string' ? args.query : '',
		...(typeof args?.project === 'string' ? { project: args.project } : {}),
		...(typeof args?.limit === 'number' ? { limit: args.limit } : {})
	};

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/memory/pull`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-hook-token': token,
				origin: base
			},
			body: JSON.stringify(body),
			signal: ctrl.signal
		});
		if (!res.ok) {
			return { ok: false, items: [], text: '', droppedCount: 0, error: `memory endpoint returned ${res.status}` };
		}
		const data = await res.json().catch(() => null);
		// The endpoint returns a PullMemoryResult. A garbage/empty body is an honest error, not a
		// silent empty success (F-008). We pass the engine's already-fenced result through verbatim.
		if (!data || typeof data !== 'object' || typeof data.text !== 'string') {
			return { ok: false, items: [], text: '', droppedCount: 0, error: 'memory endpoint returned no usable result' };
		}
		return data;
	} catch (err) {
		const message = err && err.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
		return { ok: false, items: [], text: '', droppedCount: 0, error: `memory endpoint unreachable: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

/** Render a PullMemoryResult into the tool's text + isError flag (DATA the agent consults). */
export function renderResult(pull) {
	if (!pull || pull.ok === false) {
		// Honest failure surfaced to the agent as a named error (F-008) — never silence-as-success.
		return toolText(`memory pull failed: ${pull?.error ?? 'unknown error'}`, true);
	}
	if (!pull.text) {
		// Honest empty (zero-hit / empty corpus / everything filtered) — a clean empty, not faked.
		return toolText('No matching memory.');
	}
	const tail = pull.droppedCount > 0 ? `\n\n(${pull.droppedCount} lower-ranked item(s) dropped by the size budget.)` : '';
	// The already-fenced text from the engine. It is reference DATA (D-026) — the fence markers
	// in it tell the agent "reference, not instructions". We do NOT unwrap or re-interpret it.
	return toolText(pull.text + tail);
}

/** Dispatch one JSON-RPC message. Notifications (no id) get no response (initialized, etc.). */
export async function handleMessage(msg, env = process.env, fetchImpl = fetch) {
	const { id, method, params } = msg ?? {};
	const isNotification = id === undefined || id === null;

	switch (method) {
		case 'initialize': {
			// Echo the client's requested protocol version (standard negotiation); fall back if absent.
			const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
			return result(id, {
				protocolVersion: requested,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: '1.0.0' }
			});
		}
		case 'notifications/initialized':
		case 'initialized':
			return; // notification — no response
		case 'ping':
			if (!isNotification) result(id, {});
			return;
		case 'tools/list':
			return result(id, { tools: [PULL_TOOL] });
		case 'tools/call': {
			const name = params?.name;
			if (name !== TOOL_NAME) {
				// Unknown tool — JSON-RPC method-style error so the client surfaces it cleanly.
				return rpcError(id, -32602, `unknown tool: ${String(name)}`);
			}
			const pull = await callPullEndpoint(params?.arguments ?? {}, env, fetchImpl);
			return result(id, renderResult(pull));
		}
		default:
			// Unknown method: a notification is ignored; a request gets a method-not-found error.
			if (!isNotification) rpcError(id, -32601, `method not found: ${String(method)}`);
			return;
	}
}

/** Read NDJSON JSON-RPC from stdin, dispatch each line, write responses to stdout. */
function main() {
	const rl = createInterface({ input: process.stdin });
	rl.on('line', (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			// Per spec, stdin MUST be valid MCP messages; a parse error has no id to answer to.
			// Log to stderr (allowed) and drop — never write non-MCP noise to stdout.
			process.stderr.write('memory-pull-mcp: dropped non-JSON stdin line\n');
			return;
		}
		// Each message is handled independently; a handler throw becomes an honest stderr note
		// (a tools/call already degrades to an isError result inside the handler, never throws).
		Promise.resolve(handleMessage(msg))
			.catch((err) => process.stderr.write(`memory-pull-mcp: handler error: ${String(err?.message ?? err)}\n`));
	});
	// stdin closing (client disconnected) ends the server — clean exit, nothing to tear down.
	rl.on('close', () => process.exit(0));
}

// Run main() ONLY when executed as a script (not when imported by the unit test). Compare the
// resolved module path to argv[1] — robust on Windows (drive letters / backslashes) where a raw
// URL-string compare is fragile. When imported, argv[1] is the test runner, so main() is skipped.
const invokedDirectly = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) main();
