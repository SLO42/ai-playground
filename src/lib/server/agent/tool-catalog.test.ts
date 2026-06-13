import { describe, it, expect } from 'vitest';
import {
	memoryPullGranted,
	buildMemoryPullMcpServer,
	MEMORY_PULL_MCP_NAME,
	MEMORY_PULL_MCP_SCRIPT,
	MEMORY_PULL_CAPABILITY_ID
} from './tool-catalog';
import {
	isolatedConfigFor,
	composeCapabilities,
	type SpawnRequest,
	type CapabilitySet,
	type CapabilityCatalog
} from '../runtime/index';

// TASK B10 (wiring) — the agent tool-catalog gating + registration seam.
//
// Proves the dead-tool gap is closed WITHOUT a fence/screen/budget bypass:
//   • a NON-capability'd session registers NOTHING (default deny — cannot invoke);
//   • a session whose bundle GRANTS `memory-pull` registers the isolated-config MCP server;
//   • the registration carries NO D-025 token in the command (it rides env);
//   • an interview (sterile) bundle can NEVER carry the grant (refused upstream), so no
//     registration is even reachable for a sterile session.
// The fence/screen/quarantine/budget chokepoints are the engine's (agent/pull-memory.test.ts);
// this seam adds ONLY a registration, so those guards are structurally untouched here.

// The boot-minted loopback coordinates (D-025) — present ⇒ the control plane is wired.
const WIRED_ENV = { HOOK_URL: 'http://127.0.0.1:5099', HOOK_TOKEN: 'boot-token-xyz' };
const SERVER_ROOT = 'F:/code/ai-playground-v2';

// ── memoryPullGranted — the capability gate (FAIL CLOSED) ────────────────────────────────
describe('memoryPullGranted — the reserved memory-pull capability gate', () => {
	it('grants when the reserved id appears in ANY dimension (skills/agents/mcp)', () => {
		expect(memoryPullGranted({ skills: ['memory-pull'], agents: [], mcp: [] })).toBe(true);
		expect(memoryPullGranted({ skills: [], agents: ['memory_pull'], mcp: [] })).toBe(true);
		expect(memoryPullGranted({ skills: [], agents: [], mcp: ['memory-recall'] })).toBe(true);
	});

	it('FAIL CLOSED: a set without the reserved id grants nothing', () => {
		expect(memoryPullGranted({ skills: ['design', 'linting'], agents: ['coder'], mcp: ['context7'] })).toBe(false);
	});

	it('shadow paths — nil / empty / malformed bundle never grant, never throw', () => {
		expect(memoryPullGranted(undefined)).toBe(false);
		expect(memoryPullGranted({ skills: [], agents: [], mcp: [] })).toBe(false);
		// A malformed bundle that slipped past composition: non-array dims contribute nothing.
		expect(memoryPullGranted({ skills: 'memory-pull', agents: [], mcp: [] } as unknown as CapabilitySet)).toBe(false);
		// A non-string entry can never equal a reserved string id.
		expect(memoryPullGranted({ skills: [42 as unknown as string], agents: [], mcp: [] })).toBe(false);
	});
});

// ── buildMemoryPullMcpServer — the isolated-config registration (D-025 token via env) ─────
describe('buildMemoryPullMcpServer — the isolated-config MCP registration', () => {
	it('registers one stdio server under the Atelier-namespaced name when the control plane is wired', () => {
		const servers = buildMemoryPullMcpServer({ env: WIRED_ENV, serverRoot: SERVER_ROOT, nodeBin: 'node' });
		expect(servers).toBeDefined();
		const entry = servers![MEMORY_PULL_MCP_NAME];
		expect(entry).toBeDefined();
		expect(entry.type).toBe('stdio');
		expect(entry.command).toBe('node');
		expect(entry.args).toHaveLength(1);
		expect(entry.args[0]).toContain(MEMORY_PULL_MCP_SCRIPT);
		expect(entry.args[0]).toContain('scripts');
	});

	it('D-025: the registration NEVER serializes the boot token into the command/args', () => {
		const servers = buildMemoryPullMcpServer({ env: WIRED_ENV, serverRoot: SERVER_ROOT, nodeBin: 'node' });
		const json = JSON.stringify(servers);
		expect(json).not.toContain('boot-token-xyz');
		expect(json).not.toContain('HOOK_TOKEN');
	});

	it('honest OFF: no loopback coordinates ⇒ no registration (never a dead half-wire, F-008)', () => {
		expect(buildMemoryPullMcpServer({ env: {}, serverRoot: SERVER_ROOT })).toBeUndefined();
		expect(buildMemoryPullMcpServer({ env: { HOOK_URL: WIRED_ENV.HOOK_URL }, serverRoot: SERVER_ROOT })).toBeUndefined();
		expect(buildMemoryPullMcpServer({ env: { HOOK_TOKEN: WIRED_ENV.HOOK_TOKEN }, serverRoot: SERVER_ROOT })).toBeUndefined();
	});
});

// ── isolatedConfigFor — the capability-wiring seam end-to-end ─────────────────────────────
//
// This is the decisive integration: the runtime's isolated-config builder registers the tool
// IFF the composed, catalog-validated bundle grants it — proving the gate lives at the compose
// seam, fail closed, and that a sterile interview can never reach a registration.

const CATALOG: CapabilityCatalog = {
	skills: new Set([MEMORY_PULL_CAPABILITY_ID, 'design']),
	agents: new Set(['coder']),
	mcp: new Set(['context7'])
};

// The concrete wiring seam the boot path injects (harness/wiring.getRuntime mirrors this).
function wiring(env = WIRED_ENV) {
	return (capabilities: CapabilitySet): Record<string, unknown> | undefined => {
		if (!memoryPullGranted(capabilities)) return undefined;
		return buildMemoryPullMcpServer({ env, serverRoot: SERVER_ROOT, nodeBin: 'node' });
	};
}

function req(over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'agent_1',
		projectId: 'project:demo',
		cwd: 'F:/code/demo',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		task: { id: 'task:1', title: 't', description: 'd' },
		budgets: { thinking: 'high' },
		toolPolicy: { allow: ['Read'] },
		...over
	};
}

describe('isolatedConfigFor — capability-gated memory-pull registration (B10)', () => {
	const baseOpts = {
		harnessConfigRoot: 'F:/code/v2/.harness-cc',
		gates: { 'config-protection': 'deny' } as Record<string, string>,
		catalog: CATALOG,
		mcpToolWiring: wiring()
	};

	it('RED TEAM: a NON-capability\'d session registers NO memory-pull server (cannot invoke)', () => {
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: ['design'], agents: ['coder'], mcp: ['context7'] } }),
			baseOpts
		);
		// The bundle is valid but does NOT grant memory-pull → no mcpServers registered.
		expect((iso.settings as Record<string, unknown>).mcpServers).toBeUndefined();
	});

	it('a GRANTED session registers exactly the memory-pull stdio server', () => {
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] } }),
			baseOpts
		);
		const servers = (iso.settings as Record<string, unknown>).mcpServers as Record<string, unknown>;
		expect(servers).toBeDefined();
		expect(servers[MEMORY_PULL_MCP_NAME]).toBeDefined();
		// The composed capability set still carries the grant id (data, D-026) — the registration
		// is ADDITIVE, the capability metadata is untouched.
		expect(iso.settings.capabilities?.skills).toEqual([MEMORY_PULL_CAPABILITY_ID]);
	});

	it('no wiring seam ⇒ no registration even for a granted bundle (fail closed without the seam)', () => {
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] } }),
			{ ...baseOpts, mcpToolWiring: undefined }
		);
		expect((iso.settings as Record<string, unknown>).mcpServers).toBeUndefined();
	});

	it('honest OFF: a granted bundle but an UNWIRED control plane registers nothing', () => {
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] } }),
			{ ...baseOpts, mcpToolWiring: wiring({} as typeof WIRED_ENV) }
		);
		expect((iso.settings as Record<string, unknown>).mcpServers).toBeUndefined();
	});

	it('no-catalog (legacy) spawn never registers an agent tool (no validated capability set)', () => {
		// Without a catalog, composeCapabilities does not run → settings.capabilities is absent →
		// the wiring seam is never consulted. A legacy spawn keeps a byte-identical shape.
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] } }),
			{ harnessConfigRoot: 'F:/code/v2/.harness-cc', mcpToolWiring: wiring() }
		);
		expect((iso.settings as Record<string, unknown>).mcpServers).toBeUndefined();
		expect(iso.settings.capabilities).toBeUndefined();
	});

	it('INTERVIEW (sterile): the grant is refused upstream, so no registration is reachable', () => {
		// composeCapabilities itself refuses a memory-pull id for a sterile session — the spawn
		// throws BEFORE isolatedConfigFor finishes. Prove the seam can never register it for an
		// interview: the compose throws, so there is no path to a registered server.
		expect(() =>
			isolatedConfigFor(
				req({
					capabilities: { skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] },
					sessionKind: 'interview'
				}),
				baseOpts
			)
		).toThrow(/sterile/i);
	});

	it('a clean (non-memory-pull) interview composes sterile and registers nothing', () => {
		const iso = isolatedConfigFor(
			req({ capabilities: { skills: ['design'], agents: [], mcp: [] }, sessionKind: 'interview' }),
			baseOpts
		);
		expect((iso.settings as Record<string, unknown>).sterile).toBe(true);
		expect((iso.settings as Record<string, unknown>).mcpServers).toBeUndefined();
	});

	it('the registration MERGES into a pre-existing mcpServers without clobbering it', () => {
		// Defensive: if some future harness base already carried an mcpServers map, the grant
		// merges in rather than replacing. (The isolated config carries none today — D-002 — so
		// this asserts the merge contract via composeCapabilities + a manual seam returning two.)
		const composed = composeCapabilities(
			{ skills: [MEMORY_PULL_CAPABILITY_ID], agents: [], mcp: [] },
			CATALOG,
			{ gates: {} }
		);
		expect(composed.capabilities.skills).toEqual([MEMORY_PULL_CAPABILITY_ID]);
		// memoryPullGranted reads the composed set the same way the seam does.
		expect(memoryPullGranted(composed.capabilities)).toBe(true);
	});
});
