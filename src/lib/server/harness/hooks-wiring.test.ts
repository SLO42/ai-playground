import { describe, it, expect } from 'vitest';
import { buildDrivenHookSettings } from './hooks-wiring';
import { HOOK_EVENTS, hookTimeoutMs } from '../hooks/index';

// TASK 8.4 — the wiring that closes the hook→agent_event gap for LIVE sessions: a driven
// Claude Code session's isolated settings.json must actually CONTAIN the hook commands that
// invoke the loopback proxy, or no lifecycle hook ever fires. These tests prove the pure
// builder emits a FIRING block when the boot coordinates are present and honestly NOTHING
// (F-008) when they are not — and that the D-025 token never leaks into the command string.

const ENV = { HOOK_URL: 'http://127.0.0.1:5173', HOOK_TOKEN: 'per-boot-secret' };
const ROOT = 'F:/code/ai-playground-v2';

describe('buildDrivenHookSettings — wire the firing hook block onto a driven session (D-019/8.4)', () => {
	it('emits a command-hook for EVERY wired lifecycle event so all of them fire', () => {
		const block = buildDrivenHookSettings({ env: ENV, projectRoot: ROOT });
		expect(block).toBeTruthy();
		for (const ev of HOOK_EVENTS) {
			const group = block![ev];
			expect(group, `missing hook group for ${ev}`).toBeTruthy();
			const hook = group[0].hooks[0];
			expect(hook.type).toBe('command');
			// the command runs the real proxy script with the event name as its argument
			expect(hook.command).toContain('hook-proxy.mjs');
			expect(hook.command).toContain(ev);
			// per-hook timeout carried so Claude Code reaps a hung proxy (belt to the proxy abort)
			expect(hook.timeout).toBe(Math.ceil(hookTimeoutMs(ev) / 1000));
		}
	});

	it('points the command at the proxy under the supplied project root (resolved path)', () => {
		const block = buildDrivenHookSettings({ env: ENV, projectRoot: ROOT });
		const cmd = block!.SessionStart[0].hooks[0].command;
		// the resolved path lands under <root>/scripts/hook-proxy.mjs (slash-normalized compare)
		expect(cmd.replace(/\\/g, '/')).toContain('ai-playground-v2/scripts/hook-proxy.mjs');
	});

	it('NEVER embeds the D-025 token in the command string (it rides env only)', () => {
		const block = buildDrivenHookSettings({ env: ENV, projectRoot: ROOT });
		expect(JSON.stringify(block)).not.toContain('per-boot-secret');
	});

	it('uses an explicit node bin when supplied (cross-platform spawn)', () => {
		const block = buildDrivenHookSettings({
			env: ENV,
			projectRoot: ROOT,
			nodeBin: '/usr/bin/node'
		});
		expect(block!.Stop[0].hooks[0].command).toContain('/usr/bin/node');
	});

	it('honestly OFF (undefined) when HOOK_URL is absent — no half-wired block (F-008)', () => {
		expect(buildDrivenHookSettings({ env: { HOOK_TOKEN: 't' }, projectRoot: ROOT })).toBeUndefined();
	});

	it('honestly OFF (undefined) when HOOK_TOKEN is absent — nothing to authorize with (F-008)', () => {
		expect(
			buildDrivenHookSettings({ env: { HOOK_URL: 'http://127.0.0.1:5173' }, projectRoot: ROOT })
		).toBeUndefined();
	});

	it('honestly OFF for empty/whitespace coordinates (a blank env is not configured)', () => {
		expect(buildDrivenHookSettings({ env: { HOOK_URL: '  ', HOOK_TOKEN: '  ' }, projectRoot: ROOT })).toBeUndefined();
	});
});
