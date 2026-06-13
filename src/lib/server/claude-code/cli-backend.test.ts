// TASK 13.3 — cli-backend.buildCliSettings: the isolated settings.json a REAL CLI spawn
// writes must register the D-018/D-024 PreToolUse GATE hook whenever the plan's config
// carries gates (ARCHITECTURE §2.10e). This is the regression test for the 13.3 finding:
// before the fix, run() stripped the harness `gates` key (correct — not a CC settings key)
// but registered NOTHING in its place, so the gate layer was never consulted on any
// production spawn. Without the fix, the PreToolUse assertions below fail.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCliSettings, buildMcpConfigArgs } from './cli-backend';
import { decodeGateHookConfig } from './gate-transport';
import { DEFAULT_GATE_POLICY } from './gates';
import { parseSettings } from '../cc-config/parse';
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

	// ── TASK 15.1 (B1 scope-lock) — editScope pinned onto the hook config ─────────────

	it('pins a declared editScope onto the PreToolUse hook config (15.1)', () => {
		const editScope = { scopeRoots: ['src'], scopeAllow: ['**/docs/fails.md'] };
		const out = buildCliSettings(
			plan({ gates: { ...DEFAULT_GATE_POLICY }, editScope, hooks: {} }),
			OPTS
		);
		const pre = (out.hooks as Record<string, unknown>).PreToolUse as Array<{
			hooks: Array<{ command: string }>;
		}>;
		const arg = pre[0].hooks[0].command.split(' ').at(-1)!;
		expect(decodeGateHookConfig(arg)).toEqual({
			gates: { ...DEFAULT_GATE_POLICY },
			projectRoot: 'F:/code/demo',
			editScope
		});
		// …and the harness-internal editScope key never lands in the CC settings file.
		expect(out.editScope).toBeUndefined();
	});

	it('a declared editScope FORCES the gate hook on even with no gates configured (15.1)', () => {
		const editScope = { scopeRoots: ['src'] };
		const out = buildCliSettings(plan({ editScope, hooks: {} }), OPTS);
		const pre = (out.hooks as Record<string, unknown>).PreToolUse as Array<{
			hooks: Array<{ command: string }>;
		}>;
		expect(Array.isArray(pre)).toBe(true);
		const arg = pre[0].hooks[0].command.split(' ').at(-1)!;
		expect(decodeGateHookConfig(arg)).toEqual({
			gates: {},
			projectRoot: 'F:/code/demo',
			editScope
		});
	});
});

// ── TASK B10 (fix) — MCP servers reach a CLI-HONORED load path, not the inert --settings file ──
//
// THE FAILURE THIS GUARDS (F-016/F-008): the prior B10 build wrote the granted `mcpServers`
// block into the --settings file (it was NOT a HARNESS_ONLY strip key). Claude Code does NOT
// load MCP servers from --settings — only from --mcp-config / .mcp.json / ~/.claude.json (CLI
// reference: "--mcp-config — Load MCP servers from JSON files or strings"). So a granted session
// would NEVER see mcp__atelier-memory__pull — the wire was silently inert. The earlier tests
// asserted only object-SHAPE (is `settings.mcpServers` built); none asserted the registration
// reaches a path the live CLI honors. These do, mirroring the F-016 lesson: a config key is only
// "wired" once tested against the real consumer.
const MEMORY_SERVERS = {
	'atelier-memory': { type: 'stdio', command: 'C:/nodejs/node.exe', args: ['F:/code/server/scripts/memory-pull-mcp.mjs'] }
};

describe('cli-backend MCP delivery — mcpServers go to --mcp-config, NOT the --settings file', () => {
	it('strips mcpServers from the --settings file (it is silently ignored there — F-016)', () => {
		const out = buildCliSettings(plan({ gates: {}, hooks: {}, mcpServers: MEMORY_SERVERS }), OPTS);
		// The inert --settings file must NOT carry mcpServers (CC would ignore it; leaving it is
		// the dishonest looks-live state F-008 forbids).
		expect(out.mcpServers).toBeUndefined();
	});

	it('buildMcpConfigArgs writes a .mcp.json the CLI loads and returns --mcp-config + --strict-mcp-config', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'));
		try {
			const args = buildMcpConfigArgs(plan({ mcpServers: MEMORY_SERVERS }), dir);
			// The flags that actually load MCP servers (NOT --settings).
			expect(args[0]).toBe('--mcp-config');
			const mcpJsonPath = args[1];
			expect(mcpJsonPath).toBe(join(dir, '.mcp.json'));
			// --strict-mcp-config keeps D-002 isolation: ONLY this file's servers load, no operator
			// ~/.claude.json or project .mcp.json servers leak in.
			expect(args).toContain('--strict-mcp-config');

			// THE LOAD-PATH ASSERTION: the file on disk is a real .mcp.json the CLI honors, and its
			// content round-trips through the SAME parser the cc-config mirror uses to read a real
			// .mcp.json — i.e. the granted server is reachable by a session, not merely "an object".
			expect(existsSync(mcpJsonPath)).toBe(true);
			const onDisk = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
			expect(onDisk).toEqual({ mcpServers: MEMORY_SERVERS });
			const parsed = parseSettings(undefined, readFileSync(mcpJsonPath, 'utf8'));
			expect(parsed.mcpServers).toHaveLength(1);
			expect(parsed.mcpServers[0]).toMatchObject({
				name: 'atelier-memory',
				type: 'stdio',
				command: 'C:/nodejs/node.exe'
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('honest OFF: no granted servers ⇒ no .mcp.json, no --mcp-config flag (byte-identical legacy spawn)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'));
		try {
			expect(buildMcpConfigArgs(plan({ hooks: {} }), dir)).toEqual([]);
			expect(buildMcpConfigArgs(plan({ mcpServers: {} }), dir)).toEqual([]);
			// Nothing granted ⇒ nothing written to disk.
			expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
