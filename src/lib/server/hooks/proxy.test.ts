import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { postHook, type HookProxyEnv } from './proxy';

/** Start a throwaway loopback HTTP server; resolve its base url + a close fn. */
async function listen(
	handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
): Promise<{ url: string; server: Server }> {
	const server = createServer(handler);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const addr = server.address();
	if (!addr || typeof addr === 'string') throw new Error('no address');
	return { url: `http://127.0.0.1:${addr.port}`, server };
}

const servers: Server[] = [];
afterEach(async () => {
	while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

describe('postHook — loopback POST carrying the D-025 token', () => {
	it('POSTs the payload to /api/hooks/<event> with the token header and returns the server JSON', async () => {
		let seenAuth: string | undefined;
		let seenPath: string | undefined;
		let seenBody = '';
		const { url, server } = await listen((req, res) => {
			seenAuth = req.headers['x-hook-token'] as string;
			seenPath = req.url;
			req.on('data', (c) => (seenBody += c));
			req.on('end', () => {
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({}));
			});
		});
		servers.push(server);

		const env: HookProxyEnv = { HOOK_URL: url, HOOK_TOKEN: 'secret-tok' };
		const out = await postHook('SessionStart', { session_id: 'cc1' }, env);

		expect(out).toEqual({}); // the continue/empty response
		expect(seenAuth).toBe('secret-tok');
		expect(seenPath).toBe('/api/hooks/SessionStart');
		expect(JSON.parse(seenBody)).toMatchObject({ session_id: 'cc1' });
	});
});

describe('postHook — GRACEFUL DEGRADATION (D-019): never throws, always returns {} on failure', () => {
	it('returns {} when the server is DOWN (connection refused) — the session is unaffected', async () => {
		// Nothing is listening on this port → ECONNREFUSED.
		const env: HookProxyEnv = { HOOK_URL: 'http://127.0.0.1:9', HOOK_TOKEN: 't' };
		const out = await postHook('PostToolUse', { tool_name: 'Bash' }, env);
		expect(out).toEqual({});
	});

	it('returns {} (and does not hang) when the server is too SLOW (timeout)', async () => {
		const { url, server } = await listen(() => {
			/* never responds — force the client-side timeout */
		});
		servers.push(server);
		const env: HookProxyEnv = { HOOK_URL: url, HOOK_TOKEN: 't' };
		const started = Date.now();
		// override the budget so the test is fast
		const out = await postHook('PostToolUse', {}, env, { timeoutMs: 150 });
		expect(out).toEqual({});
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it('returns {} on a non-2xx response (server error) — best-effort, no surfaced error', async () => {
		const { url, server } = await listen((_req, res) => {
			res.statusCode = 500;
			res.end('boom');
		});
		servers.push(server);
		const env: HookProxyEnv = { HOOK_URL: url, HOOK_TOKEN: 't' };
		expect(await postHook('Stop', {}, env)).toEqual({});
	});

	it('returns {} when HOOK_URL / HOOK_TOKEN are not configured (no env to POST to)', async () => {
		expect(await postHook('SessionStart', {}, {})).toEqual({});
	});

	it('returns {} on a non-loopback HOOK_URL — refuses to leave the loopback boundary (D-025)', async () => {
		const env: HookProxyEnv = { HOOK_URL: 'http://10.0.0.5:5173', HOOK_TOKEN: 't' };
		expect(await postHook('SessionStart', {}, env)).toEqual({});
	});
});
