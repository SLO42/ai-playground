import { describe, it, expect } from 'vitest';
import {
	HOOK_EVENTS,
	hookTimeoutMs,
	isHookEvent,
	buildHookSettings,
	normalizeHookEvent,
	type HookEvent
} from './proxy-config';

describe('HOOK_EVENTS — the wired analytics-capture lifecycle set (D-019)', () => {
	it('is exactly SessionStart/UserPromptSubmit/PostToolUse/Stop (analytics only)', () => {
		expect([...HOOK_EVENTS].sort()).toEqual(
			['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
		);
	});

	it('does NOT include any safety/gate hook (PreToolUse) — no safety on this path (D-024)', () => {
		expect(HOOK_EVENTS as readonly string[]).not.toContain('PreToolUse');
		expect(HOOK_EVENTS as readonly string[]).not.toContain('canUseTool');
	});

	it('isHookEvent narrows known events and rejects others', () => {
		expect(isHookEvent('SessionStart')).toBe(true);
		expect(isHookEvent('PreToolUse')).toBe(false);
		expect(isHookEvent('nonsense')).toBe(false);
	});
});

describe('hookTimeoutMs — per-hook budgets (D-019: SessionStart 30s, UserPromptSubmit 15s, tool hooks 10s)', () => {
	it('uses the documented budgets', () => {
		expect(hookTimeoutMs('SessionStart')).toBe(30_000);
		expect(hookTimeoutMs('UserPromptSubmit')).toBe(15_000);
		expect(hookTimeoutMs('PostToolUse')).toBe(10_000);
		expect(hookTimeoutMs('Stop')).toBe(10_000);
	});
});

describe('buildHookSettings — the .claude settings.json hook map Claude Code runs', () => {
	const settings = buildHookSettings({
		proxyCommand: 'node /abs/scripts/hook-proxy.mjs',
		baseUrl: 'http://127.0.0.1:5173',
		token: 'TOK'
	});

	it('registers an entry for every wired event with the per-hook timeout', () => {
		for (const ev of HOOK_EVENTS) {
			const group = settings[ev];
			expect(group, `missing hook group for ${ev}`).toBeTruthy();
			const hook = group[0].hooks[0];
			expect(hook.type).toBe('command');
			expect(hook.command).toContain('hook-proxy.mjs');
			// the per-hook timeout is carried so Claude Code kills a hung proxy
			expect(hook.timeout).toBe(Math.ceil(hookTimeoutMs(ev) / 1000));
		}
	});

	it('passes the event name to the proxy and NEVER embeds the token in the command string (D-025)', () => {
		// The token must travel via env injected by the runtime, never baked into a
		// settings.json command string that could be read off disk.
		const serialized = JSON.stringify(settings);
		expect(serialized).not.toContain('TOK');
		// the event is identifiable by the proxy (arg or env), here we pass it as an arg
		expect(settings.SessionStart[0].hooks[0].command).toContain('SessionStart');
	});
});

describe('normalizeHookEvent — payload → agent_event analytics row (analytics only)', () => {
	it('maps a PostToolUse payload to a hook agent_event with safe detail', () => {
		const row = normalizeHookEvent('PostToolUse', {
			session_id: 'cc_abc',
			tool_name: 'Bash',
			tool_input: { command: 'ls' },
			cwd: 'F:/code/x'
		});
		expect(row).not.toBeNull();
		expect(row!.type).toBe('hook');
		expect(row!.detail.hook_event).toBe('PostToolUse');
		expect(row!.detail.cc_session_id).toBe('cc_abc');
		expect(row!.detail.tool_name).toBe('Bash');
	});

	it('tolerates a missing/garbage payload (never throws — best-effort analytics)', () => {
		const row = normalizeHookEvent('Stop', undefined);
		expect(row).not.toBeNull();
		expect(row!.type).toBe('hook');
		expect(row!.detail.hook_event).toBe('Stop');
	});

	it('rejects an unknown event by returning null (caller no-ops)', () => {
		expect(normalizeHookEvent('PreToolUse' as HookEvent, {})).toBeNull();
	});
});
