import { describe, it, expect } from 'vitest';
import {
	OllamaEmbedder,
	EmbeddingError,
	EMBEDDING_DIM,
	cacheKey,
	distanceToSimilarity,
	FakeEmbedder
} from './embed';

// TASK 2.5 VERIFY — Ollama embedder (§7, D-014) against a MOCKED fetch (no network). The
// live qwen3 round-trip is the deferred live proof (no Ollama in this sandbox). Cache-key,
// dimension guard, /v1 rejection, timeout/circuit-breaker, and the §7.2 boundary contract
// are all verifiable here without a server.

function vec(dim = EMBEDDING_DIM): number[] {
	return new Array(dim).fill(0).map((_, i) => (i % 7) / 7);
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init)) as unknown as typeof fetch;
}

describe('§7.1 cache key', () => {
	it('is digest-then-append: sha256(text):model_version', () => {
		const k = cacheKey('hello', 'qwen3-embedding:0.6b');
		expect(k).toMatch(/^[0-9a-f]{64}:qwen3-embedding:0\.6b$/);
	});

	it('a model change invalidates the key cleanly (different model_version ⇒ different key)', () => {
		expect(cacheKey('x', 'a')).not.toBe(cacheKey('x', 'b'));
	});

	it('same text + model ⇒ identical key (L1 and L2 construct it identically)', () => {
		expect(cacheKey('same', 'm')).toBe(cacheKey('same', 'm'));
	});
});

describe('§7.2 normalized-similarity boundary', () => {
	it('similarity = 1 - dist, clamped into [0,1]', () => {
		expect(distanceToSimilarity(0)).toBe(1);
		expect(distanceToSimilarity(1)).toBe(0);
		expect(distanceToSimilarity(2)).toBe(0); // clamped
		expect(distanceToSimilarity(-0.5)).toBe(1); // clamped
	});
});

describe('OllamaEmbedder (mocked transport)', () => {
	it('rejects a /v1 endpoint (project rule, D-003)', () => {
		expect(() => new OllamaEmbedder({ endpoint: 'http://127.0.0.1:11434/v1', model: 'm' })).toThrow(EmbeddingError);
	});

	it('POSTs /api/embed and returns the 1024-dim vector from {embeddings:[[…]]}', async () => {
		let calledUrl = '';
		const e = new OllamaEmbedder({
			endpoint: 'http://127.0.0.1:11434',
			model: 'qwen3-embedding:0.6b',
			fetchImpl: mockFetch((url) => {
				calledUrl = url;
				return new Response(JSON.stringify({ embeddings: [vec()] }), { status: 200 });
			})
		});
		const v = await e.embed('hello', 'add');
		expect(calledUrl).toBe('http://127.0.0.1:11434/api/embed');
		expect(v).toHaveLength(EMBEDDING_DIM);
		expect(e.modelVersion).toBe('qwen3-embedding:0.6b');
	});

	it('supports the legacy {embedding:[…]} shape', async () => {
		const e = new OllamaEmbedder({
			endpoint: 'http://127.0.0.1:11434',
			model: 'm',
			fetchImpl: mockFetch(() => new Response(JSON.stringify({ embedding: vec() }), { status: 200 }))
		});
		expect(await e.embed('x')).toHaveLength(EMBEDDING_DIM);
	});

	it('throws on a wrong-dimension vector (D-014 guard)', async () => {
		const e = new OllamaEmbedder({
			endpoint: 'http://127.0.0.1:11434',
			model: 'm',
			fetchImpl: mockFetch(() => new Response(JSON.stringify({ embeddings: [vec(512)] }), { status: 200 }))
		});
		await expect(e.embed('x')).rejects.toThrow(/dim 512/);
	});

	it('throws on a non-2xx response', async () => {
		const e = new OllamaEmbedder({
			endpoint: 'http://127.0.0.1:11434',
			model: 'm',
			fetchImpl: mockFetch(() => new Response('err', { status: 500 }))
		});
		await expect(e.embed('x')).rejects.toThrow(/HTTP 500/);
	});

	it('opens the circuit breaker after consecutive failures (stalled Ollama never wedges recall)', async () => {
		let calls = 0;
		const e = new OllamaEmbedder({
			endpoint: 'http://127.0.0.1:11434',
			model: 'm',
			breakerThreshold: 2,
			breakerCooldownMs: 60_000,
			fetchImpl: mockFetch(() => {
				calls++;
				return new Response('err', { status: 503 });
			})
		});
		await expect(e.embed('a')).rejects.toThrow();
		await expect(e.embed('b')).rejects.toThrow();
		// Breaker now open — the next call short-circuits WITHOUT another fetch.
		await expect(e.embed('c')).rejects.toThrow(/circuit breaker is open/);
		expect(calls).toBe(2);
	});
});

describe('FakeEmbedder (deterministic, no network — the test embedder)', () => {
	it('returns a unit-normalized 1024-dim vector, deterministic per text', async () => {
		const f = new FakeEmbedder();
		const a = await f.embed('alpha');
		const b = await f.embed('alpha');
		const c = await f.embed('beta');
		expect(a).toHaveLength(EMBEDDING_DIM);
		expect(a).toEqual(b); // deterministic
		expect(a).not.toEqual(c);
		const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
		expect(norm).toBeCloseTo(1, 5);
	});
});
