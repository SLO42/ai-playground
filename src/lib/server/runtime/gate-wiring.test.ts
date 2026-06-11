// TASK 13.3 — the SDK/runtime-path gate wiring: ClaudeCodeRuntime.plan() builds
// gateCanUseTool onto every CcSpawnPlan.canUseTool when gates are configured
// (ARCHITECTURE §2.10e, D-018/D-024). This is the MISSING PROOF the 13.3 finding named:
// a mock backend that executes tools programmatically consults plan.canUseTool — a
// DENIED tool call is BLOCKED BEFORE EXECUTION (the tool does not run and a block event
// is emitted), an allowed call passes, and a MALFORMED gate config fails the spawn
// CLOSED (backend never reached). Without the fix, CcSpawnPlan has no canUseTool and
// every assertion here fails.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ClaudeCodeRuntime,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent,
	type SpawnRequest
} from './index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';

interface ScriptedCall {
	name: string;
	input: Record<string, unknown>;
}

/**
 * A mock backend that EXECUTES tools programmatically — the SDK-shaped seam. For each
 * scripted call it consults plan.canUseTool (when present) BEFORE executing: a deny
 * emits a blocked tool_result and the tool is NOT executed; an allow executes it.
 * `executed` records exactly which tools actually ran — the load-bearing assertion.
 */
function gatedMockBackend(calls: ScriptedCall[]): CcBackend & {
	plans: CcSpawnPlan[];
	executed: string[];
} {
	const plans: CcSpawnPlan[] = [];
	const executed: string[] = [];
	return {
		plans,
		executed,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: 'cc_gated_mock',
				async *stream(): AsyncIterable<RuntimeEvent> {
					for (const call of calls) {
						yield { type: 'tool_call', name: call.name, args: call.input, needsConfirm: false };
						const verdict = plan.canUseTool
							? await plan.canUseTool(call.name, call.input)
							: ({ behavior: 'allow', updatedInput: call.input } as const);
						if (verdict.behavior === 'deny') {
							// BLOCKED — the tool is never executed.
							yield { type: 'tool_result', name: call.name, ok: false, output: verdict.message };
							continue;
						}
						executed.push(call.name + ':' + JSON.stringify(call.input));
						yield { type: 'tool_result', name: call.name, ok: true, output: 'ran' };
					}
					yield { type: 'done', result: { ok: true, summary: 'mock complete' } };
				},
				async cancel() {}
			};
		},
		async resume(req) {
			return { ccSessionId: req.ccSessionId, async *stream() {}, async cancel() {} };
		},
		async interject() {}
	};
}

function req(cwd: string, over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'agent_gate_13_3',
		projectId: 'project:demo',
		cwd,
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		task: { id: 'task:1', title: 'gate proof', description: 'gate proof' },
		budgets: { thinking: 'high', toolCalls: 20, concurrency: 1 },
		toolPolicy: { allow: ['Read', 'Edit', 'Bash'] },
		...over
	};
}

async function drain(it: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
	const out: RuntimeEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

describe('13.3 — gateCanUseTool is WIRED onto CcSpawnPlan.canUseTool (mock-backend proof)', () => {
	it('a DENIED tool call is blocked BEFORE execution; an allowed call passes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'v2-gate-wire-'));
		try {
			const denied = { command: 'git push --force origin main' };
			const allowed = { command: 'echo ok' };
			const backend = gatedMockBackend([
				{ name: 'Bash', input: denied },
				{ name: 'Bash', input: allowed }
			]);
			const runtime = new ClaudeCodeRuntime({
				backend,
				harnessConfigRoot: '.harness/claude-config-test-13-3',
				gates: { ...DEFAULT_GATE_POLICY } // EXACTLY what wiring.getRuntime passes
			});

			const events = await drain(runtime.spawn(req(root)));

			// The plan carried the gate callback (the wiring under test).
			expect(backend.plans).toHaveLength(1);
			expect(typeof backend.plans[0].canUseTool).toBe('function');

			// THE PROOF: the dangerous call did NOT run; the benign one did.
			expect(backend.executed).toEqual(['Bash:' + JSON.stringify(allowed)]);

			// The block surfaced as an event carrying the gate's reason.
			const blocked = events.find(
				(e) => e.type === 'tool_result' && !e.ok
			) as Extract<RuntimeEvent, { type: 'tool_result' }>;
			expect(blocked).toBeDefined();
			expect(blocked.output).toContain('[gate:dangerous-bash]');

			// And the run still completed (deny blocks the TOOL, not the session).
			expect(events.at(-1)?.type).toBe('done');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('config-protection denies a .env read through the wired callback', async () => {
		const root = mkdtempSync(join(tmpdir(), 'v2-gate-wire-env-'));
		try {
			const backend = gatedMockBackend([
				{ name: 'Read', input: { file_path: join(root, '.env') } }
			]);
			const runtime = new ClaudeCodeRuntime({
				backend,
				gates: { ...DEFAULT_GATE_POLICY }
			});
			await drain(runtime.spawn(req(root)));
			expect(backend.executed).toEqual([]); // the protected read never ran
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('NO gates configured ⇒ plan.canUseTool is absent (legacy spawns unchanged)', async () => {
		const backend = gatedMockBackend([{ name: 'Bash', input: { command: 'echo ok' } }]);
		const runtime = new ClaudeCodeRuntime({ backend });
		await drain(runtime.spawn(req('F:/code/demo')));
		expect(backend.plans).toHaveLength(1);
		expect(backend.plans[0].canUseTool).toBeUndefined();
	});

	it('a MALFORMED gate config fails the spawn CLOSED — backend never reached (D-024)', async () => {
		const backend = gatedMockBackend([{ name: 'Bash', input: { command: 'echo ok' } }]);
		const runtime = new ClaudeCodeRuntime({
			backend,
			gates: { 'not-a-gate': 'deny' } // unknown gate — must block, never silently allow
		});
		const events = await drain(runtime.spawn(req('F:/code/demo')));
		const err = events.find((e) => e.type === 'error');
		expect(err).toBeDefined();
		expect((err as { error: string }).error).toMatch(/unknown gate/i);
		expect(backend.plans).toHaveLength(0); // never spawned ungated
		expect(backend.executed).toEqual([]);
	});
});

// ── TASK 15.1 (B1 scope-lock) — editScope on the SDK/runtime path ─────────────────────

describe('15.1 — SpawnRequest.editScope is enforced through plan.canUseTool', () => {
	it('an out-of-scope Write is blocked BEFORE execution; an in-scope Write runs', async () => {
		const root = mkdtempSync(join(tmpdir(), 'v2-scope-wire-'));
		try {
			mkdirSync(join(root, 'src'), { recursive: true });
			const outside = { file_path: join(root, 'docs', 'notes.md') };
			const inside = { file_path: join(root, 'src', 'ok.ts') };
			const backend = gatedMockBackend([
				{ name: 'Write', input: outside },
				{ name: 'Write', input: inside }
			]);
			const runtime = new ClaudeCodeRuntime({
				backend,
				gates: { ...DEFAULT_GATE_POLICY }
			});
			const events = await drain(
				runtime.spawn(req(root, { editScope: { scopeRoots: ['src'] } }))
			);

			// THE PROOF: only the in-scope write executed.
			expect(backend.executed).toEqual(['Write:' + JSON.stringify(inside)]);
			const blocked = events.find((e) => e.type === 'tool_result' && !e.ok) as Extract<
				RuntimeEvent,
				{ type: 'tool_result' }
			>;
			expect(blocked).toBeDefined();
			expect(blocked.output).toContain('[gate:edit-scope]');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('a declared editScope forces the gate callback ON even with no gate modes configured', async () => {
		const root = mkdtempSync(join(tmpdir(), 'v2-scope-wire-nogates-'));
		try {
			mkdirSync(join(root, 'src'), { recursive: true });
			const backend = gatedMockBackend([
				{ name: 'Write', input: { file_path: join(root, 'outside.md') } }
			]);
			const runtime = new ClaudeCodeRuntime({ backend }); // NO gates
			await drain(runtime.spawn(req(root, { editScope: { scopeRoots: ['src'] } })));
			expect(backend.plans).toHaveLength(1);
			expect(typeof backend.plans[0].canUseTool).toBe('function'); // scope is never dropped
			expect(backend.executed).toEqual([]); // and it enforced
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('a MALFORMED editScope fails the spawn CLOSED — backend never reached (D-024)', async () => {
		const backend = gatedMockBackend([{ name: 'Bash', input: { command: 'echo ok' } }]);
		const runtime = new ClaudeCodeRuntime({
			backend,
			gates: { ...DEFAULT_GATE_POLICY }
		});
		const events = await drain(
			runtime.spawn(
				req('F:/code/demo', { editScope: { scopeRoots: [] } }) // empty roots — malformed
			)
		);
		const err = events.find((e) => e.type === 'error');
		expect(err).toBeDefined();
		expect((err as { error: string }).error).toMatch(/scopeRoots/);
		expect(backend.plans).toHaveLength(0); // never spawned unscoped
		expect(backend.executed).toEqual([]);
	});

	it('NO editScope ⇒ unchanged 13.3 behaviour (gates only, no scope denials)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'v2-scope-wire-absent-'));
		try {
			const anywhere = { file_path: join(root, 'docs', 'free.md') };
			const backend = gatedMockBackend([{ name: 'Write', input: anywhere }]);
			const runtime = new ClaudeCodeRuntime({ backend, gates: { ...DEFAULT_GATE_POLICY } });
			await drain(runtime.spawn(req(root)));
			expect(backend.executed).toEqual(['Write:' + JSON.stringify(anywhere)]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
