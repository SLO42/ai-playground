// TASK B10 / D-B10-2 — the loopback /api/memory/pull endpoint (src/routes/api/memory/pull/+server.ts).
//
// This endpoint is the loopback half of the pull-memory MCP transport: the stdio MCP server
// (scripts/memory-pull-mcp.mjs) POSTs here when a GRANTED live agent invokes the `pull` tool.
// It is a thin AUTH+DISPATCH shell — it re-implements NO recall/fence/screen/budget; those
// chokepoints live in the engine pullMemory() calls (red-teamed against a real corpus in
// src/lib/server/agent/pull-memory.test.ts). This suite proves the SHELL's contract:
//   • D-025 auth (real authorizeHookRequest): an unauthorized caller gets a bare 401, no body;
//   • DISPATCH: an authorized request reaches pullMemory(mem, input) with the coerced input and
//     returns its ALREADY-FENCED result verbatim (D-026 — never re-fenced/mutated here);
//   • SHADOW PATHS (honest, F-008): malformed body → empty-query pull; no DB → honest error;
//     memory unavailable (embeddings down) → honest error; never a fabricated recall.
//
// pullMemory + getMemoryService + tryGetDb are mocked so the shell is tested deterministically
// with no live DB/Ollama (the engine guards have their own live red-team).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks for the dispatch deps (the engine + DB seam) ───────────────────────────────────────
const pullMemoryMock = vi.fn();
const tryGetDbMock = vi.fn();
const getMemoryServiceMock = vi.fn();

vi.mock('$lib/server/agent/pull-memory', () => ({
	pullMemory: (...args: unknown[]) => pullMemoryMock(...args)
}));
vi.mock('$lib/server/db/runtime-init', () => ({
	tryGetDb: () => tryGetDbMock()
}));
vi.mock('$lib/server/harness/wiring', () => ({
	getMemoryService: (...args: unknown[]) => getMemoryServiceMock(...args)
}));

import { POST } from './+server';

const TOKEN = 'boot-token-xyz';
const FAKE_MEM = { __mem: true };
const FAKE_DB = { __db: true };

/** Build a loopback, authorized Request to the endpoint (D-025: token header + loopback Host/Origin). */
function authedRequest(body: unknown, over: { token?: string; host?: string; origin?: string } = {}): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		host: over.host ?? '127.0.0.1:5099'
	};
	if (over.token !== null) headers['x-hook-token'] = over.token ?? TOKEN;
	if (over.origin !== undefined) headers.origin = over.origin;
	return new Request('http://127.0.0.1:5099/api/memory/pull', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

/** Invoke the POST handler the way SvelteKit would (only `request` is read). */
async function invoke(request: Request) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const res = await POST({ request } as any);
	return { status: res.status, body: await res.json() };
}

const PULL_OK = {
	ok: true,
	items: [{ id: 'memory:1', citationId: '#1', score: 0.9, wasNeighbor: false, fenced: {} }],
	text: '⎆BEGIN_REFERENCE⎆ recalled body ⎆END_REFERENCE⎆',
	droppedCount: 1,
	error: null
};

beforeEach(() => {
	vi.clearAllMocks();
	process.env.HOOK_TOKEN = TOKEN;
	tryGetDbMock.mockReturnValue(FAKE_DB);
	getMemoryServiceMock.mockResolvedValue({ available: true, memory: FAKE_MEM, extract: () => {} });
	pullMemoryMock.mockResolvedValue(PULL_OK);
});

describe('POST /api/memory/pull — D-025 auth (fail closed)', () => {
	it('rejects a request with no token → 401, NO result body leaked, engine NEVER called', async () => {
		const { status, body } = await invoke(authedRequest({ query: 'x' }, { token: null as unknown as undefined }));
		expect(status).toBe(401);
		expect(body.ok).toBe(false);
		expect(body.items).toEqual([]);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('rejects a bad token → 401', async () => {
		const { status } = await invoke(authedRequest({ query: 'x' }, { token: 'wrong-token' }));
		expect(status).toBe(401);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('rejects a NON-loopback Host → 401 (DNS-rebind defense)', async () => {
		const { status } = await invoke(authedRequest({ query: 'x' }, { host: '10.0.0.5:5099' }));
		expect(status).toBe(401);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('rejects a cross-origin request → 401', async () => {
		const { status } = await invoke(authedRequest({ query: 'x' }, { origin: 'http://evil.example.com' }));
		expect(status).toBe(401);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('fails closed when NO server token is configured (cannot authenticate → deny)', async () => {
		delete process.env.HOOK_TOKEN;
		const { status } = await invoke(authedRequest({ query: 'x' }));
		expect(status).toBe(401);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});
});

describe('POST /api/memory/pull — dispatch (D-026 fenced DATA pass-through)', () => {
	it('an authorized request reaches pullMemory with the coerced input and returns its result verbatim', async () => {
		const { status, body } = await invoke(authedRequest({ query: 'auth patterns', project: 'project:demo', limit: 5 }));
		expect(status).toBe(200);
		expect(body).toEqual(PULL_OK); // verbatim — no re-fence, no mutation in the shell
		expect(pullMemoryMock).toHaveBeenCalledTimes(1);
		const [mem, input] = pullMemoryMock.mock.calls[0];
		expect(mem).toBe(FAKE_MEM); // the wired MemoryService, not a parallel construction
		expect(input).toEqual({ query: 'auth patterns', project: 'project:demo', limit: 5 });
	});

	it('coerces an untrusted body — drops non-string project / non-number limit / extra fields (D-026)', async () => {
		await invoke(
			authedRequest({ query: 'q', project: 42, limit: 'lots', evil: 'rm -rf', __proto__: { x: 1 } })
		);
		const [, input] = pullMemoryMock.mock.calls[0];
		expect(input).toEqual({ query: 'q' }); // only the typed, expected fields survive
	});
});

describe('POST /api/memory/pull — shadow paths (honest states, F-008)', () => {
	it('malformed JSON body → an empty-query pull (engine returns honest empty), never a crash', async () => {
		const { status } = await invoke(authedRequest('{ not json'));
		expect(status).toBe(200);
		const [, input] = pullMemoryMock.mock.calls[0];
		expect(input).toEqual({ query: '' });
	});

	it('no DB bound → honest ok:false error, engine NEVER called', async () => {
		tryGetDbMock.mockReturnValue(null);
		const { status, body } = await invoke(authedRequest({ query: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/no database connection/i);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('memory backend unavailable (embeddings down) → honest ok:false error with the reason', async () => {
		getMemoryServiceMock.mockResolvedValue({ available: false, reason: 'Ollama has no embed model' });
		const { status, body } = await invoke(authedRequest({ query: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/Ollama has no embed model/);
		expect(pullMemoryMock).not.toHaveBeenCalled();
	});

	it('getMemoryService throwing (probe failure) → honest ok:false error, never an unhandled crash', async () => {
		getMemoryServiceMock.mockRejectedValue(new Error('probe boom'));
		const { status, body } = await invoke(authedRequest({ query: 'x' }));
		expect(status).toBe(200);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/probe boom/);
	});
});
