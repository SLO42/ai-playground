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

// ── F-045-safe RESERVED pass-through: peer-send is NOT a cc_skill and bypasses the catalog ──
//
// CONVERSATION-LAYER-SPEC (pillar 3). The LOAD-BEARING F-045 proof: a granted spawn (peer-send in
// the capability set) must NOT fail-close at composeCapabilities against a catalog that — correctly
// — does not carry `peer-send`. F-045 was exactly the opposite: an un-catalogued id in
// capabilities.skills fail-closed EVERY spawn. The reserved-id pass-through fixes that WITHOUT
// weakening catalog validation for genuine cc_skill ids.
describe('composeCapabilities — peer-send reserved pass-through (F-045-safe grant)', () => {
	// An EMPTY catalog (the F-045 reality: nothing synced) and a normal one that lacks peer-send.
	const EMPTY_CATALOG: CapabilityCatalog = { skills: new Set(), agents: new Set(), mcp: new Set() };

	it('a peer-send grant composes WITHOUT a throw against an EMPTY catalog (the reserved-path proof)', () => {
		const set: CapabilitySet = { skills: ['peer-send'], agents: [], mcp: [] };
		expect(() => composeCapabilities(set, EMPTY_CATALOG, HARNESS_BASE)).not.toThrow();
		const composed = composeCapabilities(set, EMPTY_CATALOG, HARNESS_BASE);
		// The reserved id survives onto the composed set verbatim (peerSendGranted reads it downstream).
		expect(composed.capabilities.skills).toEqual(['peer-send']);
	});

	it('a peer-send grant composes against a normal catalog that LACKS peer-send (no catalog entry required)', () => {
		// CATALOG has no 'peer-send' anywhere. The grant alongside a REAL catalogued skill is fine.
		const set: CapabilitySet = { skills: ['design', 'peer-send'], agents: [], mcp: [] };
		const composed = composeCapabilities(set, CATALOG, HARNESS_BASE);
		expect(composed.capabilities.skills).toEqual(['design', 'peer-send']);
	});

	it('every peer-send alias bypasses the catalog (one source of truth)', () => {
		for (const alias of ['peer-send', 'peer_send', 'peer-message', 'peer_message', 'fleet-message']) {
			expect(() =>
				composeCapabilities({ skills: [alias], agents: [], mcp: [] }, EMPTY_CATALOG, HARNESS_BASE)
			).not.toThrow();
		}
	});

	it('does NOT weaken the catalog for genuine ids: a real un-catalogued cc_skill STILL fails closed', () => {
		// The F-045 fail-closed for actual skills must stay — only the reserved id is exempted.
		const set: CapabilitySet = { skills: ['no-such-skill'], agents: [], mcp: [] };
		expect(() => composeCapabilities(set, EMPTY_CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
		// And a peer-send grant does NOT launder an adjacent bad id through (the bad id still throws).
		const mixed: CapabilitySet = { skills: ['peer-send', 'no-such-skill'], agents: [], mcp: [] };
		expect(() => composeCapabilities(mixed, EMPTY_CATALOG, HARNESS_BASE)).toThrow(CapabilityValidationError);
	});

	it('a non-granted set (no peer-send) against an empty catalog is unchanged: empty in → empty out', () => {
		const composed = composeCapabilities({ skills: [], agents: [], mcp: [] }, EMPTY_CATALOG, HARNESS_BASE);
		expect(composed.capabilities).toEqual({ skills: [], agents: [], mcp: [] });
	});

	it('D-002 isolation preserved: a peer-send grant does NOT bleed operator plugins/marketplaces', () => {
		const composed = composeCapabilities({ skills: ['peer-send'], agents: [], mcp: [] }, EMPTY_CATALOG, HARNESS_BASE);
		expect(composed.plugins ?? []).toEqual([]);
		expect((composed as Record<string, unknown>).marketplaces ?? []).toEqual([]);
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

	// CCF-1 (D-036 note) — refreshCatalog rebuilds the per-boot snapshot so the NEXT spawn validates
	// against a fresh id-set. A skill removed from the catalog after boot must stop passing.
	it('refreshCatalog swaps the snapshot — a removed id then fails the NEXT spawn closed', async () => {
		let plan: CcSpawnPlan | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => (plan = p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			catalog: { skills: new Set(['design']), agents: new Set(), mcp: new Set() }
		});
		// While 'design' is catalogued the spawn composes it.
		await drain(rt.spawn(baseReq({ capabilities: { skills: ['design'], agents: [], mcp: [] } })));
		expect(plan?.isolated.settings.capabilities?.skills).toEqual(['design']);

		// Rebuild the snapshot WITHOUT 'design' (simulates a deleted skill reconciled out at spawn time).
		rt.refreshCatalog({ skills: new Set(), agents: new Set(), mcp: new Set() });
		const events: RuntimeEvent[] = [];
		for await (const e of rt.spawn(baseReq({ capabilities: { skills: ['design'], agents: [], mcp: [] } }))) {
			events.push(e);
		}
		expect(events.at(-1)?.type).toBe('error');
		expect(events.find((e) => e.type === 'error' && 'error' in e && e.error?.includes('design'))).toBeTruthy();
	});

	// CCF-1 no-op guard — a runtime that never provisioned capabilities (no catalog) must NOT flip
	// provisioning ON via refreshCatalog: the no-catalog legacy path stays byte-identical (F-053).
	it('refreshCatalog is a NO-OP when the runtime has no catalog (provisioning stays OFF)', async () => {
		let plan: CcSpawnPlan | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => (plan = p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc'
			// no catalog ⇒ provisioning OFF
		});
		rt.refreshCatalog({ skills: new Set(['design']), agents: new Set(), mcp: new Set() });
		// Still the legacy harness-only branch: a declared (would-be catalogued) id is NOT composed,
		// and — crucially — an unknown id does NOT fail closed, because composeCapabilities never runs.
		await drain(rt.spawn(baseReq({ capabilities: { skills: ['anything'], agents: [], mcp: [] } })));
		expect(plan?.isolated.settings.capabilities).toBeUndefined();
		expect(plan?.isolated.settings.plugins ?? []).toEqual([]);
	});

	// CCC2-2 (D-036 note) — the PER-SPAWN catalog snapshot. CCF-1 made `this.catalog` mutable; the
	// orchestrator fires parallel unawaited drains, so spawn A can freshen then AWAIT launchSession
	// while sibling drain B overwrites the shared snapshot — A's later plan() would read B's id-set (a
	// torn allow-list). Threading the snapshot on the REQUEST removes that shared read: each spawn
	// validates against its OWN immutable copy, immune to a concurrent refreshCatalog.
	it('CCC2-2: a spawn validates against ITS req.catalog even after the shared snapshot was mutated away', async () => {
		const plans: CcSpawnPlan[] = [];
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => plans.push(p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			// The boot / shared snapshot HAS 'design'.
			catalog: { skills: new Set(['design']), agents: new Set(), mcp: new Set() }
		});
		// A CONCURRENT sibling drain overwrites the SHARED snapshot to one WITHOUT 'design'.
		rt.refreshCatalog({ skills: new Set(['other']), agents: new Set(), mcp: new Set() });
		// THIS spawn carries its own per-spawn snapshot that DOES have 'design' — it must win.
		await drain(
			rt.spawn(
				baseReq({
					capabilities: { skills: ['design'], agents: [], mcp: [] },
					catalog: { skills: new Set(['design']), agents: new Set(), mcp: new Set() }
				})
			)
		);
		// Composed 'design' → validated against req.catalog, NOT the mutated shared snapshot (no throw).
		expect(plans.at(-1)?.isolated.settings.capabilities?.skills).toEqual(['design']);
	});

	it('CCC2-2: two parallel spawns during a freshen each receive a consistent, complete id-set', async () => {
		const plans: CcSpawnPlan[] = [];
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => plans.push(p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			catalog: { skills: new Set(['boot-only']), agents: new Set(), mcp: new Set() }
		});
		// Spawn A validates against {a-skill}; spawn B against {b-skill}. A refreshCatalog (a sibling
		// drain) fires BETWEEN them, mutating the shared snapshot — it must leak into NEITHER plan.
		const spawnA = rt.spawn(
			baseReq({
				capabilities: { skills: ['a-skill'], agents: [], mcp: [] },
				catalog: { skills: new Set(['a-skill']), agents: new Set(), mcp: new Set() }
			})
		);
		rt.refreshCatalog({ skills: new Set(['mid-drain']), agents: new Set(), mcp: new Set() });
		const spawnB = rt.spawn(
			baseReq({
				capabilities: { skills: ['b-skill'], agents: [], mcp: [] },
				catalog: { skills: new Set(['b-skill']), agents: new Set(), mcp: new Set() }
			})
		);
		await Promise.all([drain(spawnA), drain(spawnB)]);
		// Each spawn composed EXACTLY its own id-set — complete + consistent, zero cross-contamination
		// (order is deterministic: plan() runs synchronously when spawn() is called).
		expect(plans[0]?.isolated.settings.capabilities?.skills).toEqual(['a-skill']);
		expect(plans[1]?.isolated.settings.capabilities?.skills).toEqual(['b-skill']);
	});

	it('CCC2-2 / F-053: a no-catalog runtime IGNORES req.catalog (provisioning stays OFF)', async () => {
		const plans: CcSpawnPlan[] = [];
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend((p) => plans.push(p)),
			harnessConfigRoot: 'F:/code/v2/.harness-cc'
			// no catalog ⇒ provisioning OFF
		});
		// A per-spawn catalog must NOT flip provisioning on: the no-catalog legacy path stays
		// byte-identical (an unknown id does NOT fail closed because composeCapabilities never runs).
		await drain(
			rt.spawn(
				baseReq({
					capabilities: { skills: ['anything'], agents: [], mcp: [] },
					catalog: { skills: new Set(['anything']), agents: new Set(), mcp: new Set() }
				})
			)
		);
		expect(plans.at(-1)?.isolated.settings.capabilities).toBeUndefined();
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
