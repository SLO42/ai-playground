import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { postHook, type HookProxyEnv } from './proxy';
import { authorizeHookRequest, ingestHookEvent } from './ingest';

// TASK 8.4 — HOOK→agent_event END-TO-END.
//
// The proxy transport (postHook), the endpoint auth (authorizeHookRequest), and the ingest
// write (ingestHookEvent) each have unit coverage. This suite proves they compose into ONE
// working pipeline: the proxy's REAL POST (the exact headers it sends) authorizes against the
// REAL endpoint logic and produces an `agent_event` row — and that the pipeline stays a clean
// no-op (session unaffected) when the token is wrong or the DB is down (D-019/D-024/D-025).
//
// We stand up a throwaway loopback HTTP server whose handler runs the ACTUAL endpoint code
// (authorize → ingest), so nothing about the request path is mocked except the DB write seam
// (a capturing/throwing writer) — the same seam the real +server.ts injects.

const SERVER_TOKEN = 'boot-minted-token';

/** A captured agent_event write (table + row), as the ingest writer sees it. */
interface Captured {
	table: string;
	row: unknown;
}

/**
 * Stand up a loopback control-plane stub that runs the REAL endpoint logic:
 * authorizeHookRequest (D-025) then ingestHookEvent (analytics-only write, D-024). `dbDown`
 * makes the injected writer throw, exercising the degraded best-effort path (D-019).
 */
async function listenIngest(opts: {
	writes: Captured[];
	dbDown?: boolean;
}): Promise<{ url: string; server: Server }> {
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', async () => {
			// Build a Headers object from the node request, as the SvelteKit endpoint receives.
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
			}
			// D-025 auth — token + loopback Origin/Host. Reject still returns {} (proxy continues).
			const auth = authorizeHookRequest(headers, { HOOK_TOKEN: SERVER_TOKEN });
			let payload: unknown = {};
			try {
				payload = JSON.parse(body);
			} catch {
				payload = {};
			}
			let result: Record<string, never> = {};
			if (auth.ok) {
				const event = (req.url ?? '').replace('/api/hooks/', '');
				result = await ingestHookEvent(event, payload, {
					write: async (table, row) => {
						if (opts.dbDown) throw new Error('db down'); // swallowed by ingest (D-019)
						opts.writes.push({ table, row });
					}
				});
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(result));
		});
	};
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

describe('hook→agent_event END-TO-END (proxy POST → authorize → ingest write, 8.4)', () => {
	it('a SessionStart lifecycle POST authorizes and writes ONE agent_event row', async () => {
		const writes: Captured[] = [];
		const { url, server } = await listenIngest({ writes });
		servers.push(server);

		const env: HookProxyEnv = { HOOK_URL: url, HOOK_TOKEN: SERVER_TOKEN };
		const out = await postHook('SessionStart', { session_id: 'cc_live_1', cwd: 'F:/code/p' }, env);

		// The response is ALWAYS the continue/empty object — analytics only, never a gate (D-024).
		expect(out).toEqual({});
		expect(writes).toHaveLength(1);
		expect(writes[0].table).toBe('agent_event');
		const row = writes[0].row as { type: string; detail: { hook_event: string; cc_session_id?: string } };
		expect(row.type).toBe('hook');
		expect(row.detail.hook_event).toBe('SessionStart');
		expect(row.detail.cc_session_id).toBe('cc_live_1');
	});

	it('drives the FULL lifecycle (SessionStart→UserPromptSubmit→PostToolUse→Stop) → 4 rows', async () => {
		const writes: Captured[] = [];
		const { url, server } = await listenIngest({ writes });
		servers.push(server);
		const env: HookProxyEnv = { HOOK_URL: url, HOOK_TOKEN: SERVER_TOKEN };

		await postHook('SessionStart', { session_id: 'cc2' }, env);
		await postHook('UserPromptSubmit', { session_id: 'cc2' }, env);
		await postHook('PostToolUse', { session_id: 'cc2', tool_name: 'Edit' }, env);
		await postHook('Stop', { session_id: 'cc2' }, env);

		expect(writes.map((w) => (w.row as { detail: { hook_event: string } }).detail.hook_event)).toEqual([
			'SessionStart',
			'UserPromptSubmit',
			'PostToolUse',
			'Stop'
		]);
		// PostToolUse carried the tool name through to the analytics detail (how/why observability).
		const toolRow = writes[2].row as { detail: { tool_name?: string } };
		expect(toolRow.detail.tool_name).toBe('Edit');
	});

	it('a WRONG token is rejected end-to-end — NO row written, session still continues (D-025)', async () => {
		const writes: Captured[] = [];
		const { url, server } = await listenIngest({ writes });
		servers.push(server);

		const out = await postHook('PostToolUse', { tool_name: 'Bash' }, { HOOK_URL: url, HOOK_TOKEN: 'WRONG' });
		expect(out).toEqual({}); // proxy reads any response as continue — session unaffected
		expect(writes).toHaveLength(0); // forged/bad-token hook is never recorded
	});

	it('DB DOWN — the POST still returns {} and never throws (best-effort analytics, D-019)', async () => {
		const writes: Captured[] = [];
		const { url, server } = await listenIngest({ writes, dbDown: true });
		servers.push(server);

		const out = await postHook('Stop', { session_id: 'cc3' }, { HOOK_URL: url, HOOK_TOKEN: SERVER_TOKEN });
		expect(out).toEqual({}); // the session proceeds even though the write threw
		expect(writes).toHaveLength(0); // nothing recorded, but no error surfaced
	});
});
