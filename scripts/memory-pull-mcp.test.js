// TASK B10 / D-B10-1 — the pull-memory stdio MCP server transport (scripts/memory-pull-mcp.mjs).
//
// Proves the BACKING TRANSPORT the B10 registration points at is real and SAFE:
//   • it speaks the MCP stdio wire protocol (initialize / tools/list / tools/call);
//   • a tools/call PROXIES to the loopback /api/memory/pull endpoint with the D-025 token on a
//     header (NEVER the command/args) and an `origin` that is verified loopback FIRST;
//   • it adds NO fence/screen/budget — it passes the endpoint's ALREADY-FENCED result through
//     verbatim (D-026), and surfaces an honest NAMED error on any transport failure (F-008),
//     never silence-as-success and never a fabricated recall;
//   • it is wall-clock-bounded and fails closed when the loopback control plane is absent or
//     non-loopback (D-025 / F-014).
//
// The engine guards (quarantine exclusion, §3.1b screen, fence, B5 budget) are red-teamed at the
// engine seam against a REAL corpus (src/lib/server/agent/pull-memory.test.ts). This suite covers
// the TRANSPORT half only — it must not be able to bypass a guard because it owns none.

import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { callPullEndpoint, renderResult, handleMessage } from './memory-pull-mcp.mjs';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'memory-pull-mcp.mjs');

const WIRED = { HOOK_URL: 'http://127.0.0.1:5099', HOOK_TOKEN: 'boot-token-xyz' };

/** A fake fetch that records the one request it received and returns a scripted response. */
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

describe('callPullEndpoint — loopback proxy to /api/memory/pull (D-025/D-026)', () => {
	it('POSTs the endpoint with the token on a HEADER (never the body), origin loopback, and returns the result verbatim', async () => {
		const engineResult = {
			ok: true,
			items: [{ id: 'memory:1', citationId: '#1', score: 0.9, wasNeighbor: false, fenced: {} }],
			text: '⎆BEGIN_REFERENCE⎆ recalled body ⎆END_REFERENCE⎆',
			droppedCount: 2,
			error: null
		};
		const f = fakeFetch(() => okResponse(engineResult));
		const out = await callPullEndpoint({ query: 'auth patterns', project: 'project:demo', limit: 5 }, WIRED, f);

		expect(out).toEqual(engineResult); // passed through verbatim — no re-fence, no mutation
		expect(f.calls).toHaveLength(1);
		const { url, init } = f.calls[0];
		expect(url).toBe('http://127.0.0.1:5099/api/memory/pull');
		expect(init.method).toBe('POST');
		// D-025: the token rides a HEADER; the body carries ONLY the agent's query + scope.
		expect(init.headers['x-hook-token']).toBe('boot-token-xyz');
		expect(init.headers.origin).toBe('http://127.0.0.1:5099');
		const body = JSON.parse(init.body);
		expect(body).toEqual({ query: 'auth patterns', project: 'project:demo', limit: 5 });
		expect(init.body).not.toContain('boot-token-xyz');
	});

	it('FAIL CLOSED: missing HOOK_URL/HOOK_TOKEN ⇒ honest error, NO fetch attempted', async () => {
		const f = fakeFetch(() => okResponse({ ok: true, text: '', items: [], droppedCount: 0, error: null }));
		const out = await callPullEndpoint({ query: 'x' }, {}, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/control plane not configured/i);
		expect(f.calls).toHaveLength(0); // never reached the network
	});

	it('FAIL CLOSED: a NON-loopback endpoint is refused before any POST (DNS-rebind defense, D-025)', async () => {
		const f = fakeFetch(() => okResponse({ ok: true, text: '', items: [], droppedCount: 0, error: null }));
		const out = await callPullEndpoint({ query: 'x' }, { HOOK_URL: 'http://10.0.0.5:5099', HOOK_TOKEN: 't' }, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/not loopback/i);
		expect(f.calls).toHaveLength(0);
	});

	it('honest error on a non-OK status (never silence-as-success, F-008)', async () => {
		const f = fakeFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
		const out = await callPullEndpoint({ query: 'x' }, WIRED, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/returned 503/);
	});

	it('honest error on a garbage/unusable response body', async () => {
		const f = fakeFetch(() => ({ ok: true, status: 200, json: async () => 'not-an-object' }));
		const out = await callPullEndpoint({ query: 'x' }, WIRED, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/no usable result/i);
	});

	it('honest error when the transport throws (unreachable) — never crashes', async () => {
		const f = fakeFetch(() => {
			throw new Error('ECONNREFUSED');
		});
		const out = await callPullEndpoint({ query: 'x' }, WIRED, f);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/unreachable/i);
	});

	it('shadow path — nil/zero-length query is coerced to an empty-query body (engine returns honest empty)', async () => {
		const f = fakeFetch(() => okResponse({ ok: true, text: '', items: [], droppedCount: 0, error: null }));
		await callPullEndpoint({}, WIRED, f);
		expect(JSON.parse(f.calls[0].init.body)).toEqual({ query: '' });
	});
});

describe('renderResult — fenced DATA pass-through + honest states (D-026/F-008)', () => {
	it('returns the engine-fenced text verbatim as tool content (no unwrap, no re-interpret)', () => {
		const fencedText = '⎆BEGIN_REFERENCE⎆ body ⎆END_REFERENCE⎆';
		const out = renderResult({ ok: true, text: fencedText, items: [], droppedCount: 0, error: null });
		expect(out.isError).toBe(false);
		expect(out.content[0].text).toContain(fencedText);
	});

	it('surfaces a dropped-count note when the budget trimmed the tail (§4.3 visibility)', () => {
		const out = renderResult({ ok: true, text: 'X', items: [], droppedCount: 3, error: null });
		expect(out.content[0].text).toMatch(/3 lower-ranked item/);
	});

	it('honest EMPTY: zero-hit pull renders a clean "no matching memory", not a faked block', () => {
		const out = renderResult({ ok: true, text: '', items: [], droppedCount: 0, error: null });
		expect(out.isError).toBe(false);
		expect(out.content[0].text).toMatch(/no matching memory/i);
	});

	it('honest FAILURE: ok:false renders an isError tool result with the named reason', () => {
		const out = renderResult({ ok: false, text: '', items: [], droppedCount: 0, error: 'recall failed: breaker open' });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/recall failed: breaker open/);
	});
});

describe('handleMessage — MCP stdio protocol', () => {
	it('initialize ECHOes the client protocol version and advertises the tools capability', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, WIRED);
		spy.mockRestore();
		expect(sent).toHaveLength(1);
		expect(sent[0].id).toBe(1);
		expect(sent[0].result.protocolVersion).toBe('2025-11-25');
		expect(sent[0].result.capabilities.tools).toBeDefined();
		expect(sent[0].result.serverInfo.name).toBe('atelier-memory');
	});

	it('tools/list returns exactly the one `pull` tool with query required', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, WIRED);
		spy.mockRestore();
		expect(sent[0].result.tools).toHaveLength(1);
		expect(sent[0].result.tools[0].name).toBe('pull');
		expect(sent[0].result.tools[0].inputSchema.required).toContain('query');
	});

	it('tools/call dispatches `pull` to the endpoint and returns the rendered result', async () => {
		const f = fakeFetch(() => okResponse({ ok: true, text: '⎆BEGIN_REFERENCE⎆ hit ⎆END_REFERENCE⎆', items: [], droppedCount: 0, error: null }));
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pull', arguments: { query: 'x' } } }, WIRED, f);
		spy.mockRestore();
		expect(sent[0].id).toBe(3);
		expect(sent[0].result.content[0].text).toContain('⎆BEGIN_REFERENCE⎆');
		expect(sent[0].result.isError).toBe(false);
	});

	it('tools/call for an UNKNOWN tool returns a JSON-RPC error (never a fabricated result)', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evil', arguments: {} } }, WIRED);
		spy.mockRestore();
		expect(sent[0].error).toBeDefined();
		expect(sent[0].error.message).toMatch(/unknown tool/i);
	});

	it('notifications/initialized is a NOTIFICATION — no response is written', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(s);
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, WIRED);
		spy.mockRestore();
		expect(sent).toHaveLength(0);
	});

	it('an unknown REQUEST method returns method-not-found; an unknown NOTIFICATION is silent', async () => {
		const sent = [];
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
			sent.push(JSON.parse(s));
			return true;
		});
		await handleMessage({ jsonrpc: '2.0', id: 9, method: 'frobnicate' }, WIRED); // request
		await handleMessage({ jsonrpc: '2.0', method: 'frobnicate' }, WIRED); // notification
		spy.mockRestore();
		expect(sent).toHaveLength(1);
		expect(sent[0].error.code).toBe(-32601);
	});
});

// ── main() lifecycle: REAL subprocess stdio round-trip (the transport actually delivered) ────
// The prior verdict CLAIMED a subprocess round-trip but none existed (gap-2). This drives the
// real `main()` NDJSON loop in a spawned child against a SLOW loopback endpoint, then closes
// stdin while the fetch is still in flight — the exact close-race that DROPPED the response
// (gap-1). The fix drains in-flight handlers before exit; this test fails on the old code.
describe('main() lifecycle — real subprocess NDJSON stdio (gap-1 close-race, gap-2 untested loop)', () => {
	/** Start a loopback HTTP endpoint that delays its /api/memory/pull response by `delayMs`. */
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

	/**
	 * Spawn the script, feed it `lines` (each a JSON-RPC object), then END stdin. Collect stdout
	 * NDJSON until the child exits. `closeAfterMs` lets the request land before stdin closes.
	 */
	function driveChild(lines, env, closeAfterMs = 50) {
		return new Promise((res, rej) => {
			const child = spawn(process.execPath, [SCRIPT_PATH], {
				env: { ...process.env, ...env },
				stdio: ['pipe', 'pipe', 'pipe']
			});
			let out = '';
			let err = '';
			child.stdout.on('data', (c) => (out += c));
			child.stderr.on('data', (c) => (err += c));
			child.on('error', rej);
			child.on('close', (code) => {
				const msgs = out
					.split('\n')
					.map((l) => l.trim())
					.filter(Boolean)
					.map((l) => JSON.parse(l));
				res({ code, msgs, err });
			});
			for (const line of lines) child.stdin.write(JSON.stringify(line) + '\n');
			// Close stdin shortly after writing — while the slow fetch is still in flight.
			setTimeout(() => child.stdin.end(), closeAfterMs);
		});
	}

	it('DELIVERS the tools/call response even when stdin closes mid-fetch (no silent drop)', async () => {
		const { srv, port } = await startSlowEndpoint(200, {
			ok: true,
			text: '⎆BEGIN_REFERENCE⎆ delayed hit ⎆END_REFERENCE⎆',
			items: [],
			droppedCount: 0,
			error: null
		});
		try {
			const env = { HOOK_URL: `http://127.0.0.1:${port}`, HOOK_TOKEN: 'boot-token-xyz' };
			const { code, msgs } = await driveChild(
				[{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pull', arguments: { query: 'auth' } } }],
				env,
				50 // close stdin at ~50ms, long before the 200ms endpoint responds
			);
			expect(code).toBe(0);
			const reply = msgs.find((m) => m.id === 7);
			expect(reply, 'tools/call response for id:7 was DROPPED (gap-1 regression)').toBeDefined();
			expect(reply.result.isError).toBe(false);
			expect(reply.result.content[0].text).toContain('delayed hit');
		} finally {
			await new Promise((r) => srv.close(r));
		}
	}, 15_000);

	it('completes a full initialize → tools/list → tools/call round-trip over real stdio', async () => {
		const { srv, port } = await startSlowEndpoint(10, {
			ok: true,
			text: '⎆BEGIN_REFERENCE⎆ ok ⎆END_REFERENCE⎆',
			items: [],
			droppedCount: 0,
			error: null
		});
		try {
			const env = { HOOK_URL: `http://127.0.0.1:${port}`, HOOK_TOKEN: 'boot-token-xyz' };
			const { code, msgs } = await driveChild(
				[
					{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
					{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
					{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pull', arguments: { query: 'x' } } }
				],
				env,
				80
			);
			expect(code).toBe(0);
			expect(msgs.find((m) => m.id === 1).result.protocolVersion).toBe('2025-11-25');
			expect(msgs.find((m) => m.id === 2).result.tools[0].name).toBe('pull');
			expect(msgs.find((m) => m.id === 3).result.content[0].text).toContain('ok');
		} finally {
			await new Promise((r) => srv.close(r));
		}
	}, 15_000);
});
