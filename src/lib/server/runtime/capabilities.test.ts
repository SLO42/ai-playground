import { describe, it, expect } from 'vitest';
import {
	composeCapabilities,
	type CapabilitySet,
	type CapabilityCatalog,
	CapabilityValidationError
} from './capabilities';
import { isolatedConfigFor, ClaudeCodeRuntime, type SpawnRequest, type CcSpawnPlan, type CcBackend, type CcBackendRun, type RuntimeEvent } from './index';
import { evaluateGate, createGateSession, type GateContext } from '../claude-code/gates';

// TASK 5.1 — per-task capability provisioning (D-036). These tests prove the four
// VERIFY criteria against a MOCKED runtime + a catalog FIXTURE (no live creds/Ollama,
// no real spawn — same posture as the 1.4 contract suite):
//
//   1. an intent resolves to a capability set, and a driven session is composed
//      carrying EXACTLY that set of skills/agents/mcp onto the harness base;
//   2. NO operator-plugin bleed — the composed config NEVER carries the operator's
//      whole plugin set (D-002 isolation preserved);
//   3. an unknown skill/agent/mcp id FAILS CLOSED (reject, never silently dropped);
//   4. a provisioned tool the gates DENY is STILL blocked — a capability set can
//      never grant what the gate layer (D-018/D-024) denies.

// ── Catalog fixture: the validated id-set drawn from the cc-config mirror (1.8/2.11) ──
const CATALOG: CapabilityCatalog = {
	skills: new Set(['svelte5-patterns', 'error-learning', 'design']),
	agents: new Set(['coder', 'reviewer', 'tester']),
	mcp: new Set(['context7', 'claude-peers'])
};

const HARNESS_BASE = {
	gates: { 'config-protection': 'deny' } as Record<string, string>,
	hooks: { SessionStart: 'F:/code/v2/scripts/hook-proxy.mjs' } as Record<string, string>
};

describe('composeCapabilities — catalog-validated composition (D-036)', () => {
	it('1. composes EXACTLY the declared set onto the harness base', () => {
		const set: CapabilitySet = {
			skills: ['svelte5-patterns', 'error-learning'],
			agents: ['coder'],
			mcp: ['context7']
		};
		const composed = composeCapabilities(set, CATALOG, HARNESS_BASE);
		// The harness base is preserved verbatim.
		expect(composed.gates).toEqual({ 'config-protection': 'deny' });
		expect(composed.hooks).toEqual({ SessionStart: 'F:/code/v2/scripts/hook-proxy.mjs' });
		// EXACTLY the declared capability set — nothing more, nothing less.
		expect(composed.capabilities).toEqual({
			skills: ['svelte5-patterns', 'error-learning'],
			agents: ['coder'],
			mcp: ['context7']
		});
	});

	it('2. NO operator-plugin bleed — plugins/marketplaces stay empty (D-002 isolation)', () => {
		const set: CapabilitySet = { skills: ['design'], agents: [], mcp: [] };
		const composed = composeCapabilities(set, CATALOG, HARNESS_BASE);
		// The composed config NEVER carries the operator's whole plugin set.
		expect(composed.plugins ?? []).toEqual([]);
		expect((composed as Record<string, unknown>).marketplaces ?? []).toEqual([]);
		// Only the declared skill is present — the rest of the catalog is NOT pulled in.
		expect(composed.capabilities.skills).toEqual(['design']);
		expect(composed.capabilities.skills).not.toContain('svelte5-patterns');
	});

	it('an absent/empty capability set composes to an empty set (defaults, never throws)', () => {
		const composed = composeCapabilities(undefined, CATALOG, HARNESS_BASE);
		expect(composed.capabilities).toEqual({ skills: [], agents: [], mcp: [] });
		expect(composed.gates).toEqual({ 'config-protection': 'deny' });
	});

	it('3. an unknown SKILL id FAILS CLOSED (reject, not silently dropped)', () => {
		const set: CapabilitySet = { skills: ['svelte5-patterns', 'no-such-skill'], agents: [], mcp: [] };
		expect(() => composeCapabilities(set, CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
		try {
			composeCapabilities(set, CATALOG, HARNESS_BASE);
		} catch (err) {
			expect((err as CapabilityValidationError).kind).toBe('skill');
			expect((err as CapabilityValidationError).id).toBe('no-such-skill');
			// It did NOT silently keep the valid one and drop the invalid — it rejected the whole compose.
			expect((err as Error).message).toContain('no-such-skill');
		}
	});

	it('3b. an unknown AGENT id fails closed', () => {
		const set: CapabilitySet = { skills: [], agents: ['ghost-agent'], mcp: [] };
		expect(() => composeCapabilities(set, CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
	});

	it('3c. an unknown MCP id fails closed', () => {
		const set: CapabilitySet = { skills: [], agents: [], mcp: ['evil-mcp'] };
		expect(() => composeCapabilities(set, CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
	});

	it('3d. a malformed (non-array) capability list fails closed', () => {
		const bad = { skills: 'svelte5-patterns', agents: [], mcp: [] } as unknown as CapabilitySet;
		expect(() => composeCapabilities(bad, CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
	});
});

// ── 4. The security INVARIANT: a capability set can NEVER override a gate ────────────
//
// A provisioned skill/MCP runs as ordinary tool calls; those calls still flow through
// the gate layer (D-018/D-024) + permissions.deny (1.4a). We prove that composing a
// capability set does NOT change any gate decision: a tool call the gates DENY is still
// denied regardless of what the capability set declared.

describe('4. capability set cannot override a gate (D-018/D-024 invariant)', () => {
	const ctx: GateContext = {
		projectRoot: 'F:/code/demo',
		codeRoot: 'F:/code',
		session: createGateSession()
	};

	it('a gate-denied tool stays denied even with a fully-provisioned capability set', () => {
		// Compose a maximal, fully-valid capability set.
		const set: CapabilitySet = {
			skills: ['svelte5-patterns', 'error-learning', 'design'],
			agents: ['coder', 'reviewer', 'tester'],
			mcp: ['context7', 'claude-peers']
		};
		const composed = composeCapabilities(set, CATALOG, HARNESS_BASE);
		// Sanity: the set composed fine.
		expect(composed.capabilities.skills.length).toBe(3);

		// A tool call the gates deny: reading a protected secret + a dangerous bash.
		const readEnv = evaluateGate({ name: 'Read', input: { file_path: 'F:/code/demo/.env' } }, ctx);
		expect(readEnv.decision).toBe('deny');
		expect(readEnv.gate).toBe('config-protection');

		const rmrf = evaluateGate({ name: 'Bash', input: { command: 'rm -rf /' } }, ctx);
		expect(rmrf.decision).toBe('deny');

		// The capability set is data; it does not feed the gate evaluator and cannot
		// flip these decisions to allow. The gate layer remains the sole authority.
	});
});

// ── 1+2 end-to-end through the runtime: a driven session carries the composed config ──

function mockBackend(onSpawn: (p: CcSpawnPlan) => void): CcBackend {
	return {
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			onSpawn(plan);
			return {
				ccSessionId: 'cc_mock',
				async *stream(): AsyncGenerator<RuntimeEvent> {
					yield { type: 'done', result: { ok: true, summary: 'ok', ccSessionId: 'cc_mock' } };
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('n/a');
		},
		async interject() {}
	};
}

async function drain(it: AsyncIterable<RuntimeEvent>): Promise<void> {
	for await (const _ of it) void _;
}

function baseReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'agent_coder_1',
		projectId: 'project:demo',
		cwd: 'F:/code/demo',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		task: { id: 'task:1', title: 'do', description: 'do the thing' },
		budgets: { thinking: 'high' },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		...over
	};
}

describe('runtime composes the capability set into the isolated session config', () => {
	it('isolatedConfigFor carries the composed capability set onto the harness base', () => {
		const iso = isolatedConfigFor(
			baseReq({
				capabilities: { skills: ['svelte5-patterns'], agents: ['coder'], mcp: ['context7'] }
			}),
			{
				harnessConfigRoot: 'F:/code/v2/.harness-cc',
				gates: HARNESS_BASE.gates,
				hooks: HARNESS_BASE.hooks,
				catalog: CATALOG
			}
		);
		expect(iso.settings.capabilities).toEqual({
			skills: ['svelte5-patterns'],
			agents: ['coder'],
			mcp: ['context7']
		});
		// Isolation preserved: still no operator plugins.
		expect(iso.settings.plugins ?? []).toEqual([]);
		expect(iso.settings.gates).toEqual(HARNESS_BASE.gates);
	});

	it('a spawn plan carries EXACTLY the intent capability set (no operator bleed)', async () => {
		let plan: CcSpawnPlan | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => (plan = p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			gates: HARNESS_BASE.gates,
			hooks: HARNESS_BASE.hooks,
			catalog: CATALOG
		});
		await drain(
			rt.spawn(
				baseReq({ capabilities: { skills: ['design'], agents: ['reviewer'], mcp: [] } })
			)
		);
		expect(plan?.isolated.settings.capabilities).toEqual({
			skills: ['design'],
			agents: ['reviewer'],
			mcp: []
		});
		expect(plan?.isolated.settings.plugins ?? []).toEqual([]);
	});

	it('a spawn with an UNKNOWN capability id fails closed (error event, no allow)', async () => {
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend(() => {}),
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			catalog: CATALOG
		});
		const events: RuntimeEvent[] = [];
		for await (const e of rt.spawn(
			baseReq({ capabilities: { skills: ['no-such-skill'], agents: [], mcp: [] } })
		)) {
			events.push(e);
		}
		// The spawn never reached the backend with an allowed config — it errored closed.
		expect(events.at(-1)?.type).toBe('error');
		const err = events.find((e) => e.type === 'error');
		expect(err && 'error' in err && err.error).toContain('no-such-skill');
	});
});
