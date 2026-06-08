import { describe, it, expect } from 'vitest';
import {
	OllamaProvider,
	ClaudeProvider,
	collectText,
	ProviderError,
	type ChatMessage,
	type StreamChunk
} from './index';

// TASK 1.4 — provider adapters share ONE stream contract (ARCHITECTURE §2.4).
// `stream(messages, tools)` yields a common StreamChunk shape regardless of
// provider, so routing/runtime/chat code is provider-agnostic. The adapters take
// an injected `fetch` so the contract is exercised against a MOCK transport — no
// network, no live model (F-008: tests may use fixtures; runtime serves live).
//
// Both adapters: Ollama (REST 127.0.0.1:11434/api/chat, NO /v1 suffix — D-003) and
// Claude (Anthropic Messages API SSE). `providers` is the SINGLE owner of provider
// health (§2.5) — both expose health() and neither caller re-probes.

// ── helpers ─────────────────────────────────────────────────────────────────────

/** A fake fetch that returns a streaming body built from the supplied lines. */
function streamingFetch(lines: string[], status = 200): typeof fetch {
	return (async () => {
		const enc = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const line of lines) controller.enqueue(enc.encode(line));
				controller.close();
			}
		});
		return new Response(body, { status });
	}) as unknown as typeof fetch;
}

/** A fake fetch that returns a non-streaming JSON body (for health probes). */
function jsonFetch(obj: unknown, status = 200): typeof fetch {
	return (async () => new Response(JSON.stringify(obj), { status })) as unknown as typeof fetch;
}

async function drain(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of it) out.push(c);
	return out;
}

const HELLO: ChatMessage[] = [{ role: 'user', content: 'hi' }];

// ── Ollama adapter ──────────────────────────────────────────────────────────────

describe('OllamaProvider — common stream contract', () => {
	it('streams NDJSON deltas as text chunks then a final done chunk', async () => {
		const fetchImpl = streamingFetch([
			JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n',
			JSON.stringify({ message: { content: 'lo' }, done: false }) + '\n',
			JSON.stringify({
				message: { content: '' },
				done: true,
				prompt_eval_count: 3,
				eval_count: 2
			}) + '\n'
		]);
		const p = new OllamaProvider({
			endpoint: 'http://127.0.0.1:11434',
			model: 'gpt-oss:20b',
			fetchImpl
		});
		const chunks = await drain(p.stream(HELLO));
		expect(collectText(chunks)).toBe('Hello');
		const done = chunks.at(-1);
		expect(done?.type).toBe('done');
		// usage maps to the common shape (input/output token counts).
		expect(done).toMatchObject({ type: 'done', usage: { input: 3, output: 2 } });
	});

	it('rejects an endpoint carrying a /v1 suffix (project rule D-003)', () => {
		expect(
			() =>
				new OllamaProvider({
					endpoint: 'http://127.0.0.1:11434/v1',
					model: 'gpt-oss:20b',
					fetchImpl: jsonFetch({})
				})
		).toThrow(ProviderError);
	});

	it('posts to /api/chat on the configured host (no /v1)', async () => {
		let seenUrl = '';
		const fetchImpl = (async (url: string) => {
			seenUrl = String(url);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode(JSON.stringify({ done: true }) + '\n'));
						c.close();
					}
				})
			);
		}) as unknown as typeof fetch;
		const p = new OllamaProvider({
			endpoint: 'http://127.0.0.1:11434',
			model: 'gpt-oss:20b',
			fetchImpl
		});
		await drain(p.stream(HELLO));
		expect(seenUrl).toBe('http://127.0.0.1:11434/api/chat');
	});

	it('health() reports up when /api/tags responds, down on failure', async () => {
		const up = new OllamaProvider({
			endpoint: 'http://127.0.0.1:11434',
			model: 'gpt-oss:20b',
			fetchImpl: jsonFetch({ models: [{ name: 'gpt-oss:20b' }] })
		});
		expect((await up.health()).up).toBe(true);

		const down = new OllamaProvider({
			endpoint: 'http://127.0.0.1:11434',
			model: 'gpt-oss:20b',
			fetchImpl: (async () => {
				throw new Error('ECONNREFUSED');
			}) as unknown as typeof fetch
		});
		const h = await down.health();
		expect(h.up).toBe(false);
		expect(h.detail).toContain('ECONNREFUSED');
	});

	it('surfaces a non-2xx response as a ProviderError', async () => {
		const p = new OllamaProvider({
			endpoint: 'http://127.0.0.1:11434',
			model: 'gpt-oss:20b',
			fetchImpl: jsonFetch({ error: 'model not found' }, 404)
		});
		await expect(drain(p.stream(HELLO))).rejects.toThrow(ProviderError);
	});
});

// ── Claude direct-chat adapter ────────────────────────────────────────────────

describe('ClaudeProvider — common stream contract', () => {
	it('parses Anthropic SSE deltas into the SAME chunk shape as Ollama', async () => {
		const sse = [
			'event: message_start\n',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
			'event: content_block_delta\n',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
			'event: content_block_delta\n',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
			'event: message_delta\n',
			'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
			'event: message_stop\n',
			'data: {"type":"message_stop"}\n\n'
		];
		const p = new ClaudeProvider({
			endpoint: 'https://api.anthropic.com',
			model: 'claude-opus-4-8',
			apiKey: 'sk-test',
			fetchImpl: streamingFetch(sse)
		});
		const chunks = await drain(p.stream(HELLO));
		expect(collectText(chunks)).toBe('Hello');
		const done = chunks.at(-1);
		expect(done).toMatchObject({ type: 'done', usage: { input: 5, output: 2 } });
	});

	it('health() is down (not throwing) when no API key is configured', async () => {
		const p = new ClaudeProvider({
			endpoint: 'https://api.anthropic.com',
			model: 'claude-opus-4-8',
			fetchImpl: jsonFetch({})
		});
		const h = await p.health();
		expect(h.up).toBe(false);
		expect(h.detail?.toLowerCase()).toContain('api key');
	});

	it('does not embed the API key in any thrown error', async () => {
		const p = new ClaudeProvider({
			endpoint: 'https://api.anthropic.com',
			model: 'claude-opus-4-8',
			apiKey: 'sk-super-secret-123',
			fetchImpl: jsonFetch({ error: { message: 'overloaded' } }, 529)
		});
		const err = await drain(p.stream(HELLO)).catch((e) => e as Error);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as Error).message).not.toContain('sk-super-secret-123');
	});
});
