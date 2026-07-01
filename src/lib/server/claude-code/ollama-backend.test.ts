import { describe, it, expect } from 'vitest';
import { OllamaBackend, type OllamaStreamSource } from './ollama-backend';
import type { CcSpawnPlan, RuntimeEvent } from '../runtime/index';
import type { ChatMessage, StreamChunk } from '../providers/index';

// MODEL-BENCHMARK-SPEC step 1 — the OllamaBackend adapter: StreamChunk → RuntimeEvent bridging,
// honest capability matrix (F-008), and an honest single error event on a transport failure.

function plan(over: Partial<CcSpawnPlan> = {}): CcSpawnPlan {
	return {
		agentId: 'agent_1',
		cwd: 'F:/code/demo',
		model: { provider: 'ollama', modelId: 'gpt-oss:20b', tier: 'local' },
		prompt: 'do the thing',
		toolPolicy: { allow: [] },
		budgets: {},
		isolated: {} as CcSpawnPlan['isolated'],
		...over
	};
}

async function drain(it: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
	const out: RuntimeEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

/** A fake stream source that yields a scripted chunk list (or throws). */
function fakeSource(chunks: StreamChunk[] | (() => AsyncIterable<StreamChunk>)): OllamaStreamSource {
	return {
		async *stream(_messages: ChatMessage[]) {
			void _messages;
			if (typeof chunks === 'function') {
				yield* chunks();
				return;
			}
			for (const c of chunks) yield c;
		}
	};
}

describe('OllamaBackend — RuntimeEvent bridge (MODEL-BENCHMARK-SPEC step 1)', () => {
	it('declares an HONEST capability matrix (no interject / no resume)', () => {
		const be = new OllamaBackend();
		expect(be.kind).toBe('ollama');
		expect(be.supportsInterject).toBe(false);
		expect(be.supportsResume).toBe(false);
	});

	it('bridges text deltas → one log block, then token_usage, then done', async () => {
		const src = fakeSource([
			{ type: 'text', text: 'Hello ' },
			{ type: 'text', text: 'world' },
			{ type: 'done', usage: { input: 12, output: 3 } }
		]);
		const be = new OllamaBackend({ providerFor: () => src });
		const run = be.run(plan());
		expect(run.ccSessionId).toMatch(/^ollama-/);

		const events = await drain(run.stream());
		const log = events.find((e) => e.type === 'log');
		expect(log).toEqual({ type: 'log', message: 'Hello world' });
		expect(events.find((e) => e.type === 'token_usage')).toEqual({
			type: 'token_usage',
			input: 12,
			output: 3
		});
		const done = events.at(-1);
		expect(done).toMatchObject({ type: 'done', result: { ok: true, summary: 'Hello world' } });
		expect((done as { result: { ccSessionId: string } }).result.ccSessionId).toMatch(/^ollama-/);
	});

	it('passes the built prompt as the single user turn', async () => {
		let seen: ChatMessage[] | undefined;
		const src: OllamaStreamSource = {
			async *stream(messages: ChatMessage[]) {
				seen = messages;
				yield { type: 'done', usage: { input: 1, output: 1 } };
			}
		};
		const be = new OllamaBackend({ providerFor: () => src });
		await drain(be.run(plan({ prompt: 'PROMPT-BODY' })).stream());
		expect(seen).toEqual([{ role: 'user', content: 'PROMPT-BODY' }]);
	});

	it('surfaces a provider/transport failure as ONE honest error event (never a throw)', async () => {
		const src = fakeSource(async function* () {
			yield { type: 'text', text: 'partial' } as StreamChunk;
			throw new Error('ollama returned HTTP 500');
		});
		const be = new OllamaBackend({ providerFor: () => src });
		const events = await drain(be.run(plan()).stream());
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ type: 'error', error: 'ollama returned HTTP 500' });
	});

	it('resume() and interject() throw honestly (Stage-1 unsupported)', async () => {
		const be = new OllamaBackend();
		await expect(be.resume()).rejects.toThrow(/not supported/i);
		await expect(be.interject()).rejects.toThrow(/not supported/i);
	});
});
