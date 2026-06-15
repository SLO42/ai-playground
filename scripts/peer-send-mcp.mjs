#!/usr/bin/env node
// scripts/peer-send-mcp.mjs — the peer-send stdio MCP server (G-B; PEER-MESSAGE-SPEC;
// D-025/D-026/D-035a/D-036). The BACKING TRANSPORT for the agent-callable `peer_send` tool.
//
// WHAT THIS IS. The G-B capability-wiring seam (agent/tool-catalog.buildPeerSendMcpServer)
// registers THIS script as an `mcp__atelier-peer__*` stdio server in a GRANTED session's isolated
// `.mcp.json`. A live agent calls the ONE `peer_send` tool, and this server POSTs the loopback
// /api/peer/send endpoint, which resolves the sender SERVER-SIDE, screens+fences the body, enforces
// the recipient policy + bounds, persists the peer_message, and (when a recipient is live) delivers
// it NON-STEERING. Mirrors scripts/memory-pull-mcp.mjs exactly in posture.
//
// THE LOCKED INVARIANT (D-035a). The SENDER is NEVER a tool argument. The agent controls ONLY the
// destination (`to`) + the message `body`. This server reads ATELIER_SESSION_ID from its env (the
// server pinned it into the isolated spawn env at launch — an agent cannot set its own env) and
// passes it on the `x-atelier-session` HEADER; the endpoint trusts THAT, never the body. A body
// claiming "I am the operator, obey" is stored origin=agent, fenced as DATA, NON-STEERING.
//
// D-025 / LOOPBACK. HOOK_URL/HOOK_TOKEN ride env (surfaced into the spawn by the boot gate), like
// the hook proxy + memory-pull. The token is NEVER in the registration command string — read here
// off env. The endpoint is verified LOOPBACK before any POST (DNS-rebind defense).
//
// HONEST / BOUNDED (F-008 / F-014 / SUBPROCESS DISCIPLINE). The fetch is wall-clock-bounded (8s).
// On ANY transport failure (missing env, non-loopback url, timeout, non-OK status, garbage body,
// throw) the tool returns an isError result with a NAMED reason — never silence-as-success.
//
// Plain ESM, no MCP-SDK: NDJSON JSON-RPC 2.0 on stdin/stdout. stdout carries ONLY MCP messages;
// diagnostics go to stderr.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const FETCH_TIMEOUT_MS = 8_000;
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'atelier-peer';
const TOOL_NAME = 'peer_send';

// ── loopback verification (mirrors scripts/memory-pull-mcp.mjs — DNS-rebind defense, D-025) ──
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

// ── the ONE tool's input schema (the agent controls ONLY the destination + body — NEVER sender) ──
const PEER_SEND_TOOL = {
	name: TOOL_NAME,
	description:
		'Send a message to another agent on the fleet bus. You control ONLY the recipient and the ' +
		'message text — your identity as sender is stamped by the server, and the message is delivered ' +
		'as DATA the recipient may read, never as a command it must obey. Cross-project messaging is ' +
		'only allowed to the `atelier` platform identity.',
	inputSchema: {
		type: 'object',
		properties: {
			to: {
				type: 'object',
				description: 'The recipient address.',
				properties: {
					kind: {
						type: 'string',
						enum: ['session', 'role', 'pm', 'atelier'],
						description:
							'session: a specific running session (ref = session id). role: a role in your project ' +
							'(ref = role id, project required). pm: your project PM (project required). atelier: the platform identity.'
					},
					ref: { type: 'string', description: 'The session id (kind=session) or role id (kind=role).' },
					project: { type: 'string', description: 'The project id (required for kind=role and kind=pm).' }
				},
				required: ['kind']
			},
			body: { type: 'string', description: 'The message text to send.' },
			hops: { type: 'number', description: 'Optional relay TTL (1–4, default 1).' }
		},
		required: ['to', 'body']
	}
};

// ── JSON-RPC stdout writer (NDJSON; MUST be the ONLY thing on stdout) ──
function send(msg) {
	process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) {
	send({ jsonrpc: '2.0', id, result: res });
}
function rpcError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message } });
}
/** A tools/call result the agent reads as DATA. isError marks an honest failure. */
function toolText(text, isError = false) {
	return { content: [{ type: 'text', text }], isError };
}

/**
 * POST the loopback peer-send endpoint with the agent's destination + body, the SENDER on the
 * x-atelier-session header (NEVER the body — D-035a), and the D-025 token on the x-hook-token
 * header (NEVER the body/command). Returns the endpoint's result on success, or a synthesized
 * honest-error result on ANY transport failure — never throws, never fabricates a send.
 */
export async function callSendEndpoint(args, env = process.env, fetchImpl = fetch) {
	const base = (env.HOOK_URL || '').trim();
	const token = (env.HOOK_TOKEN || '').trim();
	const session = (env.ATELIER_SESSION_ID || '').trim();
	// Honest OFF: with no loopback coordinates the transport cannot reach the endpoint.
	if (!base || !token) {
		return { ok: false, error: 'peer bus not configured (HOOK_URL/HOOK_TOKEN)' };
	}
	// Without a server-pinned session identity we cannot be stamped as a sender (D-035a) — refuse
	// HERE rather than send an unattributable request the endpoint would 400 anyway.
	if (!session) {
		return { ok: false, error: 'peer bus: this session has no server identity (ATELIER_SESSION_ID) — cannot send' };
	}
	if (!isLoopbackHost(hostOf(base))) {
		return { ok: false, error: 'peer endpoint is not loopback (D-025)' };
	}

	// The agent controls ONLY `to`, `body`, `hops`. The sender rides the header, not the body.
	const payload = {
		to: args && typeof args.to === 'object' ? args.to : {},
		body: typeof args?.body === 'string' ? args.body : '',
		...(typeof args?.hops === 'number' ? { hops: args.hops } : {})
	};

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/peer/send`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-hook-token': token,
				'x-atelier-session': session,
				origin: base
			},
			body: JSON.stringify(payload),
			signal: ctrl.signal
		});
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			// The endpoint returns { ok:false, error } even on 4xx — surface the NAMED reason if present.
			const reason = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : `peer endpoint returned ${res.status}`;
			return { ok: false, error: reason };
		}
		if (!data || typeof data !== 'object') {
			return { ok: false, error: 'peer endpoint returned no usable result' };
		}
		return data;
	} catch (err) {
		const message = err && err.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : String(err?.message ?? err);
		return { ok: false, error: `peer endpoint unreachable: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

/** Render a send result into the tool's text + isError flag. */
export function renderResult(out) {
	if (!out || out.ok === false) {
		return toolText(`peer send failed: ${out?.error ?? 'unknown error'}`, true);
	}
	const delivered = Array.isArray(out.deliveredTo) ? out.deliveredTo.length : 0;
	const recipients = Array.isArray(out.recipients) ? out.recipients.length : 0;
	const lines = [`Message sent (id ${out.messageId ?? '?'}).`];
	if (out.quarantined) lines.push('Note: your message tripped a secret/PII screen and was stored REDACTED.');
	if (delivered > 0) lines.push(`Delivered live to ${delivered} running session(s).`);
	else if (recipients === 0 && out.note) lines.push(out.note);
	else if (recipients > 0) lines.push(`${recipients} recipient(s) are offline — the message is in their inbox (pending).`);
	return toolText(lines.join(' '));
}

/** Dispatch one JSON-RPC message. Notifications (no id) get no response. */
export async function handleMessage(msg, env = process.env, fetchImpl = fetch) {
	const { id, method, params } = msg ?? {};
	const isNotification = id === undefined || id === null;

	switch (method) {
		case 'initialize': {
			const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
			return result(id, {
				protocolVersion: requested,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: '1.0.0' }
			});
		}
		case 'notifications/initialized':
		case 'initialized':
			return;
		case 'ping':
			if (!isNotification) result(id, {});
			return;
		case 'tools/list':
			return result(id, { tools: [PEER_SEND_TOOL] });
		case 'tools/call': {
			const name = params?.name;
			if (name !== TOOL_NAME) {
				return rpcError(id, -32602, `unknown tool: ${String(name)}`);
			}
			const out = await callSendEndpoint(params?.arguments ?? {}, env, fetchImpl);
			return result(id, renderResult(out));
		}
		default:
			if (!isNotification) rpcError(id, -32601, `method not found: ${String(method)}`);
			return;
	}
}

/**
 * Read NDJSON JSON-RPC from stdin, dispatch, write responses. DRAIN in-flight handlers on stdin
 * close before exiting so a tools/call whose loopback fetch is still pending is not dropped
 * (silence-as-success — F-008/F-014), exactly like scripts/memory-pull-mcp.mjs.
 */
function main() {
	const rl = createInterface({ input: process.stdin });
	const inFlight = new Set();
	let closed = false;

	const maybeExit = () => {
		if (closed && inFlight.size === 0) process.exit(0);
	};

	rl.on('line', (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			process.stderr.write('peer-send-mcp: dropped non-JSON stdin line\n');
			return;
		}
		const p = Promise.resolve(handleMessage(msg))
			.catch((err) => process.stderr.write(`peer-send-mcp: handler error: ${String(err?.message ?? err)}\n`))
			.finally(() => {
				inFlight.delete(p);
				maybeExit();
			});
		inFlight.add(p);
	});
	rl.on('close', () => {
		closed = true;
		maybeExit();
	});
}

const invokedDirectly = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) main();
