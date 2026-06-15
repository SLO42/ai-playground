// G-B — the peer-send stdio MCP server transport (scripts/peer-send-mcp.mjs).
//
// Proves the BACKING TRANSPORT the G-B registration points at is real + SAFE (mirrors
// scripts/memory-pull-mcp.test.js):
//   • it speaks the MCP stdio wire protocol (initialize / tools/list / tools/call);
//   • a tools/call PROXIES to the loopback /api/peer/send endpoint with the D-025 token + the
//     SENDER identity on HEADERS (NEVER the body) and an `origin` verified loopback FIRST;
//   • D-035a: the SENDER is ATELIER_SESSION_ID off env (the server pinned it) — NEVER a tool arg;
//   • it surfaces an honest NAMED error on any transport failure (F-008), never silence-as-success;
//   • it is wall-clock-bounded and fails closed when the control plane / session identity is absent.

import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { callSendEndpoint, renderResult, handleMessage } from './peer-send-mcp.mjs';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'peer-send-mcp.mjs');

const WIRED = { HOOK_URL: 'http://127.0.0.1:5099', HOOK_TOKEN: 'boot-token-xyz', ATELIER_SESSION_ID: 'session:me' };

function fakeFetch(impl) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, init });
		return impl(url, init);
	};
	fn.calls = calls;
	return fn;
}
function okResponse(json) {
	return { ok: true, status: 200, json: async () => json };
}

describe('callSendEndpoint — loopback proxy to /api/peer/send (D-025/D-035a)', () => {
	it('POSTs with the token + SENDER on HEADERS (never the body), origin loopback, result verbatim', async () => {
		const engineResult = { ok: true, messageId: 'peer_message:1', recipients: ['session:r1'], deliveredTo: ['session:r1'], quarantined: false, note: null };
		const f = fakeFetch(() => okResponse(engineResult));
		const out = await callSendEndpoint({ to: { kind: 'session', ref: 'session:r1' }, body: 'hi', hops: 2 }, WIRED, f);

		expect(out).toEqual(engineResult);
		expect(f.calls).toHaveLength(1);
		const { url, init } = f.calls[0];
		expect(url).toBe('http://127.0.0.1:5099/api/peer/send');
		expect(init.method).toBe('POST');
		expect(init.headers['x-hook-token']).toBe('boot-token-xyz');
		expect(init.headers['x-atelier-session']).toBe('session:me'); // SENDER on a header (D-035a)
		expect(init.headers.origin).toBe('http://127.0.0.1:5099');
		const body = JSON.parse(init.body);
		// The body carries ONLY the agent-controlled destination + text + hops — NEVER the sender.
		expect(body).toEqual({ to: { kind: 'session', ref: 'session:r1' }, body: 'hi', hops: 2 });
		expect(init.body).not.toContain('boot-token-xyz');
		expect(init.body).not.toContain('session:me');
	});

	it('FAIL CLOSED: missing HOOK_URL/HOOK_TOKEN ⇒ honest error, NO fetch', async () => {
		const f = fakeFetch(() => okResponse({ ok: true }));
		const out = await callSendEndpoint({ to: { kind: 'atelier' }, body: 'x' }, { ATELIER_SESSION_ID: 'session:me' }, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/not configured/i);
		expect(f.calls).toHaveLength(0);
	});

	it('FAIL CLOSED: no ATELIER_SESSION_ID ⇒ honest error (cannot be a sender), NO fetch (D-035a)', async () => {
		const f = fakeFetch(() => okResponse({ ok: true }));
		const out = await callSendEndpoint({ to: { kind: 'atelier' }, body: 'x' }, { HOOK_URL: 'http://127.0.0.1:5099', HOOK_TOKEN: 't' }, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/no server identity/i);
		expect(f.calls).toHaveLength(0);
	});

	it('FAIL CLOSED: a NON-loopback endpoint is refused before any POST (DNS-rebind, D-025)', async () => {
		const f = fakeFetch(() => okResponse({ ok: true }));
		const out = await callSendEndpoint({ to: { kind: 'atelier' }, body: 'x' }, { ...WIRED, HOOK_URL: 'http://10.0.0.5:5099' }, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/not loopback/i);
		expect(f.calls).toHaveLength(0);
	});

	it('surfaces the endpoint NAMED error on a 4xx (never silence-as-success, F-008)', async () => {
		const f = fakeFetch(() => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'cross-project FORBIDDEN' }) }));
		const out = await callSendEndpoint({ to: { kind: 'session', ref: 'session:b' }, body: 'x' }, WIRED, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/cross-project FORBIDDEN/);
	});

	it('honest error when the transport throws (unreachable) — never crashes', async () => {
		const f = fakeFetch(() => {
			throw new Error('ECONNREFUSED');
		});
		const out = await callSendEndpoint({ to: { kind: 'atelier' }, body: 'x' }, WIRED, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/unreachable/i);
	});
});

describe('renderResult — honest delivery states (F-008)', () => {
	it('a live-delivered send reports how many sessions it reached', () => {
		const out = renderResult({ ok: true, messageId: 'peer_message:1', recipients: ['a'], deliveredTo: ['a'], note: null });
		expect(out.isError).toBe(false);
		expect(out.content[0].text).toMatch(/Delivered live to 1/);
	});
	it('an offline recipient reports pending inbox', () => {
		const out = renderResult({ ok: true, messageId: 'peer_message:1', recipients: ['a'], deliveredTo: [], note: 'offline' });
		expect(out.content[0].text).toMatch(/offline|pending/i);
	});
	it('a quarantined body is reported honestly (stored redacted)', () => {
		const out = renderResult({ ok: true, messageId: 'peer_message:1', recipients: [], deliveredTo: [], quarantined: true, note: null });
		expect(out.content[0].text).toMatch(/REDACTED/);
	});
	it('a failure renders an isError tool result with the named reason', () => {
		const out = renderResult({ ok: false, error: 'budget exhausted' });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/budget exhausted/);
	});
});

describe('handleMessage — MCP stdio protocol', () => {
	it('initialize ECHOes the protocol version and advertises tools', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, WIRED);
		spy.mockRestore();
		expect(sent[0].result.protocolVersion).toBe('2025-11-25');
		expect(sent[0].result.serverInfo.name).toBe('atelier-peer');
	});

	it('tools/list returns exactly the one peer_send tool with to+body required', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, WIRED);
		spy.mockRestore();
		expect(sent[0].result.tools).toHaveLength(1);
		expect(sent[0].result.tools[0].name).toBe('peer_send');
		expect(sent[0].result.tools[0].inputSchema.required).toEqual(expect.arrayContaining(['to', 'body']));
	});

	it('tools/call dispatches peer_send and returns the rendered result', async () => {
		const f = fakeFetch(() => okResponse({ ok: true, messageId: 'peer_message:9', recipients: ['x'], deliveredTo: ['x'], note: null }));
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'peer_send', arguments: { to: { kind: 'atelier' }, body: 'x' } } }, WIRED, f);
		spy.mockRestore();
		expect(sent[0].id).toBe(3);
		expect(sent[0].result.isError).toBe(false);
		expect(sent[0].result.content[0].text).toMatch(/sent/i);
	});

	it('tools/call for an UNKNOWN tool returns a JSON-RPC error (never a fabricated result)', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evil', arguments: {} } }, WIRED);
		spy.mockRestore();
		expect(sent[0].error.message).toMatch(/unknown tool/i);
	});

	it('notifications/initialized is a NOTIFICATION — no response', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(s);
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, WIRED);
		spy.mockRestore();
		expect(sent).toHaveLength(0);
	});
});

// ── main() lifecycle: REAL subprocess stdio round-trip (the close-race drain, mirrors memory-pull) ──
describe('main() lifecycle — real subprocess NDJSON stdio (close-race drain)', () => {
	function startSlowEndpoint(delayMs, payload) {
		return new Promise((res) => {
			const srv = createServer((req, sink) => {
				let buf = '';
				req.on('data', (c) => (buf += c));
				req.on('end', () => {
					setTimeout(() => {
						sink.writeHead(200, { 'content-type': 'application/json' });
						sink.end(JSON.stringify(payload));
					}, delayMs);
				});
			});
			srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
		});
	}

	function driveChild(lines, env, closeAfterMs = 50) {
		return new Promise((res, rej) => {
			const child = spawn(process.execPath, [SCRIPT_PATH], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
			let out = '';
			child.stdout.on('data', (c) => (out += c));
			child.on('error', rej);
			child.on('close', (code) => {
				const msgs = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
				res({ code, msgs });
			});
			for (const line of lines) child.stdin.write(JSON.stringify(line) + '\n');
			setTimeout(() => child.stdin.end(), closeAfterMs);
		});
	}

	it('DELIVERS the tools/call response even when stdin closes mid-fetch (no silent drop)', async () => {
		const { srv, port } = await startSlowEndpoint(200, { ok: true, messageId: 'peer_message:7', recipients: ['x'], deliveredTo: ['x'], note: null });
		try {
			const env = { HOOK_URL: `http://127.0.0.1:${port}`, HOOK_TOKEN: 'boot-token-xyz', ATELIER_SESSION_ID: 'session:me' };
			const { code, msgs } = await driveChild(
				[{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'peer_send', arguments: { to: { kind: 'atelier' }, body: 'x' } } }],
				env,
				50
			);
			expect(code).toBe(0);
			const reply = msgs.find((m) => m.id === 7);
			expect(reply, 'tools/call response for id:7 was DROPPED (close-race regression)').toBeDefined();
			expect(reply.result.isError).toBe(false);
		} finally {
			await new Promise((r) => srv.close(r));
		}
	}, 15_000);

	it('completes a full initialize → tools/list → tools/call round-trip over real stdio', async () => {
		const { srv, port } = await startSlowEndpoint(10, { ok: true, messageId: 'peer_message:8', recipients: [], deliveredTo: [], note: 'atelier offline' });
		try {
			const env = { HOOK_URL: `http://127.0.0.1:${port}`, HOOK_TOKEN: 'boot-token-xyz', ATELIER_SESSION_ID: 'session:me' };
			const { code, msgs } = await driveChild(
				[
					{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
					{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
					{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'peer_send', arguments: { to: { kind: 'atelier' }, body: 'x' } } }
				],
				env,
				80
			);
			expect(code).toBe(0);
			expect(msgs.find((m) => m.id === 1).result.protocolVersion).toBe('2025-11-25');
			expect(msgs.find((m) => m.id === 2).result.tools[0].name).toBe('peer_send');
			expect(msgs.find((m) => m.id === 3).result.content[0].text).toBeTruthy();
		} finally {
			await new Promise((r) => srv.close(r));
		}
	}, 15_000);
});
