// TASK 2.5 — embeddings: Ollama adapter + two-tier cache (MEMORY-SPEC §7; D-014).
//
// Embedding is the hot path of every ADD and every recall, so it is cached (§7.1):
//   • L1 — in-process LRU.
//   • L2 — persistent `embedding_cache` table (DATA-MODEL §4.15).
//   • Key — sha256(text) ':' model_version. L1 and L2 construct the key IDENTICALLY,
//     so an L1 miss / L2 hit recomputes the same key. A model change invalidates
//     cleanly because model_version is in the key.
//   • Screened-text-only — callers MUST pass already-screened text (§3.1b runs in the
//     extraction pipeline BEFORE this). The cache therefore never sees a raw secret;
//     no secret-derived vector lands in L2 and the key is never computed over a secret.
//   • Resilience — per-call timeout + circuit breaker so a stalled Ollama never wedges
//     recall (§7.1). On breaker-open, embed() throws an EmbeddingError; recall degrades.
//   • Soft-prune — L2 entries are pruned via `pruned_at`, never DELETE (§5.3 ethos).
//
// Stack (D-014): Ollama, 1024-dim, COSINE. Endpoint MUST NOT carry a /v1 suffix
// (project rule). The model is config-driven (`qwen3-embedding:0.6b` validated
// candidate); the dimension is a single config constant (DATA-MODEL §7), never a
// scattered literal — changing the model = re-embed + bump model_version.
//
// Boundary discipline (F-008): the adapter takes an injected `fetchImpl` so the logic
// is verifiable against a mocked transport — no network in tests. A live qwen3 round-
// trip is the deferred live proof (no Ollama in this sandbox).

import { createHash } from 'node:crypto';
import type { Db } from '../db/client';

/** The locked embedding dimension (D-014). Single constant — never scatter the literal. */
export const EMBEDDING_DIM = 1024;

/** Role tag (§7.2): some models embed queries and documents differently. */
export type EmbedRole = 'add' | 'search';

/** A provider-layer embedding failure. Never carries secrets. */
export class EmbeddingError extends Error {
	override readonly name = 'EmbeddingError';
}

/** The narrow embedder contract — the real impl hits Ollama; tests inject a mock. */
export interface Embedder {
	readonly modelVersion: string;
	/** Embed ONE already-screened string. role tags add vs search (§7.2). */
	embed(text: string, role?: EmbedRole): Promise<number[]>;
}

// ── Ollama embedder ─────────────────────────────────────────────────────────────

export interface OllamaEmbedderOptions {
	/** Base host, e.g. `http://127.0.0.1:11434`. MUST NOT carry a /v1 suffix. */
	endpoint: string;
	/** Model id, e.g. `qwen3-embedding:0.6b` (D-014). Part of the cache key. */
	model: string;
	/** Per-call timeout (ms). Default 10s — a stalled Ollama must not wedge recall. */
	timeoutMs?: number;
	/** Circuit breaker: open after this many consecutive failures. Default 3. */
	breakerThreshold?: number;
	/** Breaker cool-down (ms) before a half-open retry. Default 30s. */
	breakerCooldownMs?: number;
	/** Injected for tests; defaults to global fetch (F-008 boundary). */
	fetchImpl?: typeof fetch;
}

export class OllamaEmbedder implements Embedder {
	readonly modelVersion: string;
	private readonly endpoint: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly breakerThreshold: number;
	private readonly breakerCooldownMs: number;
	private readonly fetchImpl: typeof fetch;
	// Circuit-breaker state.
	private consecutiveFailures = 0;
	private openedAt = 0;

	constructor(opts: OllamaEmbedderOptions) {
		// Project rule (D-003): the local Ollama endpoint MUST NOT include /v1.
		if (/\/v1\/?$/.test(opts.endpoint)) {
			throw new EmbeddingError(`ollama embed endpoint must not include a /v1 suffix ("${opts.endpoint}")`);
		}
		this.endpoint = opts.endpoint.replace(/\/+$/, '');
		this.model = opts.model;
		// model_version IS the model id — bumping the model invalidates the cache key.
		this.modelVersion = opts.model;
		this.timeoutMs = opts.timeoutMs ?? 10_000;
		this.breakerThreshold = opts.breakerThreshold ?? 3;
		this.breakerCooldownMs = opts.breakerCooldownMs ?? 30_000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	private breakerOpen(): boolean {
		if (this.consecutiveFailures < this.breakerThreshold) return false;
		// Half-open after cooldown: allow one trial call.
		if (Date.now() - this.openedAt >= this.breakerCooldownMs) return false;
		return true;
	}

	async embed(text: string, role: EmbedRole = 'add'): Promise<number[]> {
		if (this.breakerOpen()) {
			throw new EmbeddingError('embedding circuit breaker is open (Ollama unhealthy)');
		}
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
		try {
			// New canonical batch endpoint: POST /api/embed { model, input } → { embeddings:[[…]] }.
			// role is advisory metadata for models that distinguish add/search; harmless otherwise.
			const res = await this.fetchImpl(`${this.endpoint}/api/embed`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model: this.model, input: text, options: { role } }),
				signal: ctl.signal
			});
			if (!res.ok) {
				throw new EmbeddingError(`ollama embed returned HTTP ${res.status}`);
			}
			const json = (await res.json()) as { embeddings?: number[][]; embedding?: number[] };
			// Support both the batch ({embeddings:[[…]]}) and legacy ({embedding:[…]}) shapes.
			const vec = json.embeddings?.[0] ?? json.embedding;
			if (!Array.isArray(vec) || vec.length === 0) {
				throw new EmbeddingError('ollama embed returned no vector');
			}
			if (vec.length !== EMBEDDING_DIM) {
				throw new EmbeddingError(
					`ollama embed dim ${vec.length} != expected ${EMBEDDING_DIM} (D-014)`
				);
			}
			this.consecutiveFailures = 0;
			return vec;
		} catch (err) {
			this.consecutiveFailures++;
			if (this.consecutiveFailures >= this.breakerThreshold) this.openedAt = Date.now();
			if (err instanceof EmbeddingError) throw err;
			const msg = (err as Error).name === 'AbortError' ? `timed out after ${this.timeoutMs}ms` : (err as Error).message;
			throw new EmbeddingError(`ollama embed failed: ${msg}`);
		} finally {
			clearTimeout(timer);
		}
	}
}

// ── Cache key (§7.1): sha256(text) ':' model_version — digest-then-append ──────────

/** Construct the cache key. L1 and L2 MUST call this so a miss/hit computes the same key. */
export function cacheKey(text: string, modelVersion: string): string {
	const digest = createHash('sha256').update(text, 'utf8').digest('hex');
	return `${digest}:${modelVersion}`;
}

// ── L1 — in-process LRU ─────────────────────────────────────────────────────────

class Lru<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly cap: number) {}
	get(k: string): V | undefined {
		const v = this.map.get(k);
		if (v !== undefined) {
			this.map.delete(k); // re-insert to mark most-recently-used
			this.map.set(k, v);
		}
		return v;
	}
	set(k: string, v: V): void {
		if (this.map.has(k)) this.map.delete(k);
		this.map.set(k, v);
		while (this.map.size > this.cap) {
			const oldest = this.map.keys().next().value as string;
			this.map.delete(oldest);
		}
	}
	get size(): number {
		return this.map.size;
	}
}

// ── Two-tier cached embedder (L1 LRU + L2 embedding_cache table) ───────────────────

export interface CachedEmbedderOptions {
	embedder: Embedder;
	db: Db;
	/** L1 capacity (entries). Default 512. */
	l1Capacity?: number;
}

/**
 * Wraps an Embedder with the two-tier cache (§7.1). Lookups: L1 → L2 → embed+fill.
 * The model_version is part of the key, so a model swap misses cleanly. Callers MUST
 * pass already-screened text — the cache never sees a raw secret (§3.1b ordering).
 */
export class CachedEmbedder implements Embedder {
	readonly modelVersion: string;
	private readonly inner: Embedder;
	private readonly db: Db;
	private readonly l1: Lru<number[]>;
	// Telemetry for tests/recall-explain.
	stats = { l1Hits: 0, l2Hits: 0, misses: 0 };

	constructor(opts: CachedEmbedderOptions) {
		this.inner = opts.embedder;
		this.db = opts.db;
		this.modelVersion = opts.embedder.modelVersion;
		this.l1 = new Lru<number[]>(opts.l1Capacity ?? 512);
	}

	async embed(text: string, role: EmbedRole = 'add'): Promise<number[]> {
		const key = cacheKey(text, this.modelVersion);

		// L1.
		const hot = this.l1.get(key);
		if (hot) {
			this.stats.l1Hits++;
			return hot;
		}

		// L2 — persistent table. Skip soft-pruned rows.
		const [rows] = await this.db.query<[Array<{ vector: number[] }>]>(
			`SELECT vector FROM embedding_cache WHERE hash = $hash AND pruned_at IS NONE LIMIT 1;`,
			{ hash: key }
		);
		if (rows.length && Array.isArray(rows[0].vector) && rows[0].vector.length) {
			this.stats.l2Hits++;
			this.l1.set(key, rows[0].vector);
			return rows[0].vector;
		}

		// Miss — embed, then fill BOTH tiers.
		this.stats.misses++;
		const vec = await this.inner.embed(text, role);
		this.l1.set(key, vec);
		// UPSERT by hash (UNIQUE). Idempotent: a concurrent fill just overwrites identically.
		await this.db.query(
			`UPSERT embedding_cache:[$hash] SET hash = $hash, vector = $vector, model_version = $mv, pruned_at = NONE;`,
			{ hash: key, vector: vec, mv: this.modelVersion }
		);
		return vec;
	}

	/** Current L1 occupancy (test/observability). */
	get l1Size(): number {
		return this.l1.size;
	}
}

// ── §7.2 normalized-similarity boundary contract ──────────────────────────────────

/**
 * Convert an HNSW COSINE *distance* to a normalized similarity in [0,1] (DATA-MODEL
 * §4.5: similarity = 1 - dist). The scorer (§4.3 WMR) must NEVER see a raw distance —
 * this is the hard boundary invariant (§7.2). Clamped so float noise can't escape [0,1].
 */
export function distanceToSimilarity(dist: number): number {
	const sim = 1 - dist;
	if (sim < 0) return 0;
	if (sim > 1) return 1;
	return sim;
}

/** A test/dev embedder: deterministic pseudo-vectors derived from text. No network. */
export class FakeEmbedder implements Embedder {
	readonly modelVersion: string;
	embedCalls = 0;
	constructor(modelVersion = 'fake-1024:test') {
		this.modelVersion = modelVersion;
	}
	async embed(text: string): Promise<number[]> {
		this.embedCalls++;
		// Deterministic: seed each dim from a rolling hash of the text. Unit-normalized so
		// cosine math behaves like a real embedder. Same text ⇒ same vector (cache-testable).
		const h = createHash('sha256').update(text, 'utf8').digest();
		const v = new Array<number>(EMBEDDING_DIM);
		let norm = 0;
		for (let i = 0; i < EMBEDDING_DIM; i++) {
			const b = h[i % h.length];
			const x = (b / 255) * 2 - 1;
			v[i] = x;
			norm += x * x;
		}
		norm = Math.sqrt(norm) || 1;
		for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
		return v;
	}
}
