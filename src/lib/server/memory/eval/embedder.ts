// MEMORY-SPEC §11 re-validation harness — deterministic EVAL embedder.
//
// WHY a second embedder: the production path is OllamaEmbedder (qwen3, live; the deferred
// proof) and the existing test double is FakeEmbedder, whose vectors are a sha256 of the
// WHOLE string — identical text ⇒ identical vector (good for cache tests) but lexically/
// semantically RELATED text ⇒ uncorrelated vectors. That is fine for determinism tests but
// USELESS for measuring recall QUALITY: precision/recall/novelty-gate numbers need a signal
// where "deploy the dashboard" sits closer to "dashboard deploy pipeline" than to "the cat
// sat on the mat". This embedder supplies exactly that controllable signal.
//
// It is a deterministic bag-of-token hashed-projection embedder: each token is hashed into
// a small set of dimensions (feature hashing), counts accumulate, the vector is unit-
// normalized. Lexically-overlapping texts therefore share dimensions and score high cosine;
// disjoint texts score near 0. No network, fully reproducible — same text ⇒ same vector, so
// the L1/L2 cache and HNSW index behave exactly as in production.
//
// SCOPE (F-008): this is an EVAL/TEST embedder, never wired into the product. A mocked
// embedder in measurement code is allowed; fabricated PRODUCT data is not. The §11 tunables
// are exercised against THIS controllable corpus to produce ACTUAL measured numbers; the
// numbers are evidence for re-validation, not a claim about live qwen3 behaviour (that stays
// the deferred live proof). The harness MEASURES — it never mutates a weight or prunes a row.

import { createHash } from 'node:crypto';
import { EMBEDDING_DIM, type Embedder, type EmbedRole } from '../embed';

/** How many dimensions each token contributes to (feature hashing fan-out). */
const HASHES_PER_TOKEN = 4;

/**
 * High-frequency English function words. Stripped before hashing so the eval signal reflects
 * CONTENT-word overlap, not shared stopwords — otherwise two topically-disjoint sentences that
 * both contain "the/in/on/a" score a misleadingly high cosine and the novelty gate / precision
 * numbers blur. This sharpens the controllable signal; it is an EVAL embedder concern only.
 */
const STOPWORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by',
	'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
	'as', 'from', 'into', 'then', 'than', 'so', 'not', 'no', 'do', 'does', 'how', 'what', 'per'
]);

/** Tokenize to lowercase alphanumeric content-word stems — the unit lexical overlap is measured on. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Stable 32-bit hash of a string (FNV-1a) — deterministic across runs/platforms. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		// 32-bit FNV prime multiply via shifts, kept in uint32.
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h >>> 0;
}

/**
 * A deterministic, semantics-bearing eval embedder. Cosine(a,b) rises with shared tokens
 * and is ~0 for disjoint vocab. Unit-normalized so the §7.2 `1 - dist` boundary and the
 * recall scorer behave identically to production. The `role` tag is accepted and ignored
 * (this embedder does not distinguish add vs search) — same contract as FakeEmbedder.
 */
export class LexicalEmbedder implements Embedder {
	readonly modelVersion: string;
	embedCalls = 0;

	constructor(modelVersion = 'lexical-eval-1024:v1') {
		this.modelVersion = modelVersion;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async embed(text: string, _role: EmbedRole = 'add'): Promise<number[]> {
		this.embedCalls++;
		const v = new Array<number>(EMBEDDING_DIM).fill(0);
		const tokens = tokenize(text);
		for (const tok of tokens) {
			for (let j = 0; j < HASHES_PER_TOKEN; j++) {
				const h = fnv1a(`${tok}#${j}`);
				const dim = h % EMBEDDING_DIM;
				// Sign bit decorrelates collisions so unrelated tokens that hash to the same
				// dim do not always reinforce — borrowed from the signed feature-hashing trick.
				const sign = (h & 0x80000000) !== 0 ? -1 : 1;
				v[dim] += sign;
			}
		}
		let norm = 0;
		for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i] * v[i];
		norm = Math.sqrt(norm);
		if (norm === 0) {
			// Empty/punctuation-only text ⇒ a fixed unit vector on dim 0, so the embedder never
			// returns a zero vector (HNSW COSINE on a zero vector is undefined). Such an item
			// will sit at cosine 0 to any real-token query, which is the honest "no signal".
			v[0] = 1;
			return v;
		}
		for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
		return v;
	}
}

/** sha256 helper kept local so the module has no incidental imports beyond embed.ts. */
export function textDigest(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
