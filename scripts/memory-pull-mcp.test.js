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
import { callPullEndpoint, renderResult, handleMessage } from './memory-pull-mcp.mjs';

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
