import { describe, it, expect } from 'vitest';
import { authorizeHookRequest, ingestHookEvent, type HookIngestEnv } from './ingest';

const TOKEN = 'per-boot-token';
const env: HookIngestEnv = { HOOK_TOKEN: TOKEN };

describe('authorizeHookRequest — D-025 control-plane auth (token + Origin/Host)', () => {
	it('accepts a request bearing the correct token and a loopback Host', () => {
		const r = authorizeHookRequest(
			new Headers({ 'x-hook-token': TOKEN, host: '127.0.0.1:5173' }),
			env
		);
		expect(r.ok).toBe(true);
	});

	it('REJECTS a missing/wrong token (forged hook response defeated)', () => {
		expect(authorizeHookRequest(new Headers({ host: '127.0.0.1:5173' }), env).ok).toBe(false);
		expect(
			authorizeHookRequest(new Headers({ 'x-hook-token': 'wrong', host: '127.0.0.1:5173' }), env).ok
		).toBe(false);
	});

	it('REJECTS a cross-origin / DNS-rebind Origin (CSRF defeated, D-025)', () => {
		const r = authorizeHookRequest(
			new Headers({ 'x-hook-token': TOKEN, host: '127.0.0.1:5173', origin: 'http://evil.example' }),
			env
		);
		expect(r.ok).toBe(false);
	});

	it('REJECTS a non-loopback Host header (rebind defeated)', () => {
		const r = authorizeHookRequest(
			new Headers({ 'x-hook-token': TOKEN, host: 'evil.example:5173' }),
			env
		);
		expect(r.ok).toBe(false);
	});

	it('fails CLOSED when no server token is configured (cannot authenticate → deny)', () => {
		const r = authorizeHookRequest(new Headers({ 'x-hook-token': TOKEN, host: '127.0.0.1' }), {});
		expect(r.ok).toBe(false);
	});
});

describe('ingestHookEvent — analytics ONLY, never a gate decision (D-024)', () => {
	it('records a normalized agent_event via the supplied writer and returns the continue/empty response', async () => {
		const writes: { table: string; row: unknown }[] = [];
		const res = await ingestHookEvent(
			'PostToolUse',
			{ session_id: 'cc9', tool_name: 'Edit', cwd: 'F:/code/p' },
			{ write: async (table, row) => void writes.push({ table, row }) }
		);
		// CRITICAL: the response NEVER carries a permission/gate decision — analytics only.
		expect(res).toEqual({});
		expect(writes).toHaveLength(1);
		expect(writes[0].table).toBe('agent_event');
		expect((writes[0].row as { type: string }).type).toBe('hook');
	});

	it('no-ops the write when the DB is down but STILL returns {} (session unaffected, D-019)', async () => {
		const res = await ingestHookEvent(
			'SessionStart',
			{ session_id: 'cc1' },
			{
				write: async () => {
					throw new Error('db down');
				}
			}
		);
		expect(res).toEqual({}); // never throws, never blocks
	});

	it('ignores an unknown/safety event without writing and still returns {}', async () => {
		let wrote = false;
		const res = await ingestHookEvent(
			'PreToolUse',
			{ tool_name: 'Bash' },
			{ write: async () => void (wrote = true) }
		);
		expect(res).toEqual({});
		expect(wrote).toBe(false); // no safety hook is ever processed here
	});
});
