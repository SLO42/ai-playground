import { describe, it, expect } from 'vitest';
import {
	ClaudeCodeRuntime,
	type SpawnRequest,
	type RuntimeEvent,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan
} from './index';

// MODEL-BENCHMARK-SPEC step 1 — the provider branch. Proves ClaudeCodeRuntime.spawn routes a
// `provider === 'ollama'` spawn to the injected local backend and every other provider to the
// default (Claude) backend UNCHANGED, and fails CLOSED when a local spawn has no local backend.

function recordingBackend(
	kind: string,
	events: RuntimeEvent[] = [{ type: 'done', result: { ok: true, summary: kind, ccSessionId: `cc_${kind}` } }]
): CcBackend & { spawns: CcSpawnPlan[] } {
	const spawns: CcSpawnPlan[] = [];
	return {
		spawns,
		kind,
		supportsInterject: false,
		supportsResume: false,
		run(plan: CcSpawnPlan): CcBackendRun {
			spawns.push(plan);
			return {
				ccSessionId: `cc_${kind}`,
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('not supported');
		},
		async interject() {
			throw new Error('not supported');
		}
	};
}

function baseReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'agent_1',
		projectId: 'project:demo',
		cwd: 'F:/code/demo',
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		intent: 'code-write',
		task: { id: 'task:1', title: 'do', description: 'do the thing' },
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

describe('ClaudeCodeRuntime — provider branch (MODEL-BENCHMARK-SPEC step 1)', () => {
	it('routes a provider="ollama" spawn to the local backend, NOT the default', async () => {
		const claude = recordingBackend('claude');
		const ollama = recordingBackend('ollama');
		const rt = new ClaudeCodeRuntime({ backend: claude, ollamaBackend: ollama });

		const events = await drain(
			rt.spawn(baseReq({ model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' } }))
		);

		expect(ollama.spawns).toHaveLength(1);
		expect(claude.spawns).toHaveLength(0);
		expect(ollama.spawns[0].model.provider).toBe('ollama');
		expect(events.at(-1)).toMatchObject({ type: 'done', result: { ok: true } });
	});

	it('routes a provider="claude" spawn to the default backend (cloud path unchanged)', async () => {
		const claude = recordingBackend('claude');
		const ollama = recordingBackend('ollama');
		const rt = new ClaudeCodeRuntime({ backend: claude, ollamaBackend: ollama });

		await drain(rt.spawn(baseReq({ model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' } })));

		expect(claude.spawns).toHaveLength(1);
		expect(ollama.spawns).toHaveLength(0);
	});

	it('the cloud path is byte-identical when NO local backend is wired', async () => {
		const claude = recordingBackend('claude');
		const rt = new ClaudeCodeRuntime({ backend: claude }); // no ollamaBackend
		const events = await drain(rt.spawn(baseReq()));
		expect(claude.spawns).toHaveLength(1);
		expect(events.at(-1)?.type).toBe('done');
	});

	it('falls through to the default backend for a local spawn when NO local backend is wired (no-regression)', async () => {
		// ADDITIVE / opt-in: a runtime built without an ollamaBackend keeps its prior behaviour — a
		// local-tier spawn goes to the default backend UNCHANGED (mock/test runtimes rely on this;
		// production always wires the local backend so the local tier runs locally there).
		const claude = recordingBackend('claude');
		const rt = new ClaudeCodeRuntime({ backend: claude }); // no ollamaBackend
		const events = await drain(
			rt.spawn(baseReq({ model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' } }))
		);
		expect(claude.spawns).toHaveLength(1);
		expect(events.at(-1)?.type).toBe('done');
	});
});
