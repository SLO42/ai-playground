// TASK 13.3 — cli-backend.buildCliSettings: the isolated settings.json a REAL CLI spawn
// writes must register the D-018/D-024 PreToolUse GATE hook whenever the plan's config
// carries gates (ARCHITECTURE §2.10e). This is the regression test for the 13.3 finding:
// before the fix, run() stripped the harness `gates` key (correct — not a CC settings key)
// but registered NOTHING in its place, so the gate layer was never consulted on any
// production spawn. Without the fix, the PreToolUse assertions below fail.

import { describe, it, expect } from 'vitest';
import { buildCliSettings } from './cli-backend';
import { decodeGateHookConfig } from './gate-transport';
import { DEFAULT_GATE_POLICY } from './gates';
import type { CcSpawnPlan } from '../runtime/index';

function plan(settings: Record<string, unknown>): CcSpawnPlan {
	return {
		agentId: 'opus-1',
		cwd: 'F:/code/demo',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		prompt: 'do the thing',
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		isolated: {
			configDir: '.harness/claude-config/opus-1',
			env: { CLAUDE_CONFIG_DIR: '.harness/claude-config/opus-1' },
			settings
		}
	};
}

const OPTS = { nodeBin: 'C:/nodejs/node.exe', serverRoot: 'F:/code/server' };

describe('buildCliSettings — the 13.3 gate-hook wiring on the CLI path', () => {
	it('registers the PreToolUse gate hook when the plan carries gates', () => {
		const out = buildCliSettings(plan({ gates: { ...DEFAULT_GATE_POLICY }, hooks: {} }), OPTS);

		const hooks = out.hooks as Record<string, unknown>;
		expect(hooks).toBeDefined();
		const pre = hooks.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string; timeout: number }>;
		}>;
		expect(Array.isArray(pre)).toBe(true);
		expect(pre).toHaveLength(1);
		expect(pre[0].matcher).toBe('*');
		const cmd = pre[0].hooks[0].command;
		expect(cmd).toContain('scripts/gate-hook.mjs');
		expect(cmd).toContain('"C:/nodejs/node.exe"');

		// The encoded arg round-trips to THIS session's gate config, pinned to its cwd.
		const arg = cmd.split(' ').at(-1)!;
		expect(decodeGateHookConfig(arg)).toEqual({
			gates: { ...DEFAULT_GATE_POLICY },
			projectRoot: 'F:/code/demo'
		});
	});

	it('preserves the 8.4 analytics hooks alongside the gate hook (both fire)', () => {
		const analytics = {
			SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'proxy SessionStart', timeout: 30 }] }]
		};
		const out = buildCliSettings(
			plan({ gates: { 'dangerous-bash': 'deny' }, hooks: analytics }),
			OPTS
		);
		const hooks = out.hooks as Record<string, unknown>;
		expect(hooks.SessionStart).toEqual(analytics.SessionStart);
		expect(Array.isArray(hooks.PreToolUse)).toBe(true);
	});

	it('registers NO PreToolUse hook when the plan has no gates (legacy/ungated spawn unchanged)', () => {
		const out = buildCliSettings(plan({ hooks: {} }), OPTS);
		const hooks = (out.hooks ?? {}) as Record<string, unknown>;
		expect(hooks.PreToolUse).toBeUndefined();

		const outEmpty = buildCliSettings(plan({ gates: {}, hooks: {} }), OPTS);
		expect(((outEmpty.hooks ?? {}) as Record<string, unknown>).PreToolUse).toBeUndefined();
	});

	it('still strips the harness-internal keys (gates/capabilities/plugins) from the file (8.4)', () => {
		const out = buildCliSettings(
			plan({
				gates: { ...DEFAULT_GATE_POLICY },
				capabilities: { skills: ['x'], agents: [], mcp: [] },
				plugins: [],
				marketplaces: [],
				permissions: { deny: ['WebFetch'] }
			}),
			OPTS
		);
		expect(out.gates).toBeUndefined();
		expect(out.capabilities).toBeUndefined();
		expect(out.plugins).toBeUndefined();
		expect(out.marketplaces).toBeUndefined();
		// Genuinely-valid CC settings keys pass through.
		expect(out.permissions).toEqual({ deny: ['WebFetch'] });
	});
});
