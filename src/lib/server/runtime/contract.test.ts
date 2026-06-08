import { describe, it, expect } from 'vitest';
import {
	ClaudeCodeRuntime,
	isolatedConfigFor,
	type AgentRuntime,
	type SpawnRequest,
	type RuntimeEvent,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan
} from './index';

// TASK 1.4 — the runtime CONTRACT suite (the swappability guarantee, drafted from
// what S1 proved). It runs against a MOCKED/SANDBOXED backend — NO filesystem-
// capable spawn, no real agent runs here (the first real, fs-capable spawn is 1.6,
// gated on 1.4a's deny rules). The suite asserts the AgentRuntime contract AND the
// S1-mandated isolated-config requirement (D-002): every Claude Code session — SDK
// and CLI — is spawned with a dedicated CLAUDE_CONFIG_DIR / --settings carrying only
// the harness's own gates/hooks, NEVER the operator's inherited global plugins.

// ── A mock backend: records the plan it was handed, emits a scripted event stream ──

interface RecordedSpawn {
	plan: CcSpawnPlan;
}

function mockBackend(opts?: {
	events?: RuntimeEvent[];
	onSpawn?: (plan: CcSpawnPlan) => void;
	resumeRecorder?: (req: { ccSessionId: string; plan: CcSpawnPlan }) => void;
	interjectRecorder?: (msg: { ccSessionId: string; origin: string; body: string }) => void;
}): CcBackend & { spawns: RecordedSpawn[]; cancelled: string[] } {
	const spawns: RecordedSpawn[] = [];
	const cancelled: string[] = [];
	const defaultEvents: RuntimeEvent[] = [
		{ type: 'log', message: 'started' },
		{ type: 'token_usage', input: 10, output: 5 },
		{ type: 'done', result: { ok: true, summary: 'mock complete', ccSessionId: 'cc_mock_1' } }
	];
	return {
		spawns,
		cancelled,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			spawns.push({ plan });
			opts?.onSpawn?.(plan);
			const events = opts?.events ?? defaultEvents;
			return {
				ccSessionId: 'cc_mock_1',
				async *stream() {
					for (const e of events) yield e;
				},
				async cancel() {
					cancelled.push(plan.agentId);
				}
			};
		},
		async resume(req) {
			opts?.resumeRecorder?.(req);
			return {
				ccSessionId: req.ccSessionId,
				async *stream() {
					yield { type: 'done', result: { ok: true, summary: 'resumed', ccSessionId: req.ccSessionId } };
				},
				async cancel() {}
			};
		},
		async interject(msg) {
			opts?.interjectRecorder?.(msg);
		}
	};
}

function baseReq(over: Partial<SpawnRequest> = {}): SpawnRequest {
	return {
		agentId: 'agent_coder_1',
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

// ── Contract: shape + streaming ─────────────────────────────────────────────────

describe('AgentRuntime contract — Claude Code impl (mocked backend)', () => {
	it('implements the full interface surface', () => {
		const rt: AgentRuntime = new ClaudeCodeRuntime({ backend: mockBackend() });
		expect(typeof rt.spawn).toBe('function');
		expect(typeof rt.health).toBe('function');
		expect(typeof rt.tools).toBe('function');
		expect(typeof rt.cancel).toBe('function');
	});

	it('spawn() streams the backend events to completion, ending in done', async () => {
		const rt = new ClaudeCodeRuntime({ backend: mockBackend() });
		const events = await drain(rt.spawn(baseReq()));
		expect(events.at(-1)?.type).toBe('done');
		const usage = events.find((e) => e.type === 'token_usage');
		expect(usage).toMatchObject({ type: 'token_usage', input: 10, output: 5 });
	});

	it('tools() reports the runtime tool surface (file/exec/git capability check)', () => {
		const rt = new ClaudeCodeRuntime({ backend: mockBackend() });
		const names = rt.tools().map((t) => t.name);
		expect(names).toContain('Read');
		expect(names).toContain('Bash');
	});

	it('health() reads provider health from the injected source, never re-probing', async () => {
		let probes = 0;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend(),
			providerHealth: async () => {
				probes++;
				return [{ provider: 'claude', up: true }];
			}
		});
		const h = await rt.health();
		expect(h.providers).toEqual([{ provider: 'claude', up: true }]);
		expect(probes).toBe(1);
	});

	it('concurrent spawns are isolated — two parallel runs both complete (no v1 hang)', async () => {
		const rt = new ClaudeCodeRuntime({ backend: mockBackend() });
		const [a, b] = await Promise.all([
			drain(rt.spawn(baseReq({ agentId: 'a' }))),
			drain(rt.spawn(baseReq({ agentId: 'b' })))
		]);
		expect(a.at(-1)?.type).toBe('done');
		expect(b.at(-1)?.type).toBe('done');
	});

	it('cancel() routes to the running backend run for that agent', async () => {
		const be = mockBackend({ events: [{ type: 'log', message: 'long-running' }] });
		const rt = new ClaudeCodeRuntime({ backend: be });
		const it = rt.spawn(baseReq({ agentId: 'cancel-me' }))[Symbol.asyncIterator]();
		await it.next(); // start the run so it registers
		await rt.cancel('cancel-me');
		expect(be.cancelled).toContain('cancel-me');
	});

	it('surfaces a backend failure as an error event, not an unhandled throw', async () => {
		const be: CcBackend = {
			kind: 'mock',
			run() {
				return {
					ccSessionId: 'cc_x',
					// eslint-disable-next-line require-yield
					async *stream(): AsyncGenerator<RuntimeEvent> {
						throw new Error('spawn boom');
					},
					async cancel() {}
				} as CcBackendRun;
			},
			async resume() {
				throw new Error('n/a');
			},
			async interject() {}
		};
		const rt = new ClaudeCodeRuntime({ backend: be });
		const events = await drain(rt.spawn(baseReq()));
		const err = events.find((e) => e.type === 'error');
		expect(err).toMatchObject({ type: 'error' });
		expect(events.at(-1)?.type).toBe('error');
	});
});

// ── CRITICAL (S1 / D-002): ISOLATED CONFIG on every spawn ────────────────────────

describe('isolated config — S1-mandated determinism (D-002)', () => {
	it('every spawn plan carries a dedicated CLAUDE_CONFIG_DIR, not the operator default', async () => {
		let captured: CcSpawnPlan | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend({ onSpawn: (p) => (captured = p) }),
			harnessConfigRoot: 'F:/code/v2/.harness-cc'
		});
		await drain(rt.spawn(baseReq()));
		expect(captured?.isolated.configDir).toBeTruthy();
		// It is UNDER the harness config root — never an operator/global config dir.
		expect(captured!.isolated.configDir.replace(/\\/g, '/')).toContain('.harness-cc');
		// The spawn env points CLAUDE_CONFIG_DIR at that isolated dir.
		expect(captured!.isolated.env.CLAUDE_CONFIG_DIR).toBe(captured!.isolated.configDir);
	});

	it('the isolated --settings carry ONLY harness gates/hooks — no inherited plugins', () => {
		const iso = isolatedConfigFor(baseReq(), {
			harnessConfigRoot: 'F:/code/v2/.harness-cc',
			gates: { 'config-protection': 'deny' },
			hooks: { SessionStart: 'F:/code/v2/scripts/hook-proxy.mjs' }
		});
		// settings is the harness's own bundle, nothing inherited.
		expect(iso.settings.gates).toEqual({ 'config-protection': 'deny' });
		expect(iso.settings.hooks).toEqual({ SessionStart: 'F:/code/v2/scripts/hook-proxy.mjs' });
		// Determinism guard: NO plugins/marketplaces are carried into a driven agent.
		expect(iso.settings.plugins ?? []).toEqual([]);
		expect((iso.settings as Record<string, unknown>).marketplaces ?? []).toEqual([]);
		// The env strips any inherited CLAUDE_CONFIG_DIR and replaces it with ours.
		expect(iso.env.CLAUDE_CONFIG_DIR).toBe(iso.configDir);
	});

	it('SDK and CLI paths BOTH receive the same isolated config (parity)', async () => {
		const sdkBackend = mockBackend();
		const rtSdk = new ClaudeCodeRuntime({ backend: sdkBackend, harnessConfigRoot: 'F:/cc' });
		await drain(rtSdk.spawn(baseReq()));
		const sdkPlan = sdkBackend.spawns[0].plan;

		// Resume drives the CLI path (interactive parity) — it must carry the SAME isolation.
		let resumePlan: CcSpawnPlan | undefined;
		const cliBackend = mockBackend({ resumeRecorder: (r) => (resumePlan = r.plan) });
		const rtCli = new ClaudeCodeRuntime({ backend: cliBackend, harnessConfigRoot: 'F:/cc' });
		await drain(rtCli.resume('cc_existing', baseReq()));

		expect(sdkPlan.isolated.env.CLAUDE_CONFIG_DIR).toBeTruthy();
		expect(resumePlan?.isolated.env.CLAUDE_CONFIG_DIR).toBeTruthy();
		// Both rooted under the harness config root — neither inherits the operator's.
		expect(sdkPlan.isolated.configDir.replace(/\\/g, '/')).toContain('cc');
		expect(resumePlan!.isolated.configDir.replace(/\\/g, '/')).toContain('cc');
	});

	it('spawn sets cwd to the project root explicitly (D-002 / 1.4a groundwork)', async () => {
		let captured: CcSpawnPlan | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend({ onSpawn: (p) => (captured = p) })
		});
		await drain(rt.spawn(baseReq({ cwd: 'F:/code/demo' })));
		expect(captured?.cwd).toBe('F:/code/demo');
	});
});

// ── interject seam (D-011/D-035 groundwork; full impl in 2.10) ─────────────────

describe('interject seam — origin is carried (D-035 groundwork)', () => {
	it('interject routes through the backend with an explicit origin', async () => {
		let seen: { ccSessionId: string; origin: string; body: string } | undefined;
		const rt = new ClaudeCodeRuntime({
			backend: mockBackend({ interjectRecorder: (m) => (seen = m) })
		});
		await rt.interject('cc_mock_1', { origin: 'agent', body: 'hello' });
		expect(seen).toMatchObject({ ccSessionId: 'cc_mock_1', origin: 'agent', body: 'hello' });
	});
});
