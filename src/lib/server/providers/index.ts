// server/providers — provider adapters + the ONE common stream contract (TASK 1.4;
// ARCHITECTURE §2.4/§2.5, D-003).
//
// One adapter per provider, all implementing `stream(messages, tools)` and yielding
// the SAME `StreamChunk` union, so routing / runtime direct-chat / simple chat are
// provider-agnostic. `providers` is the SINGLE owner of provider health (§2.5):
// every adapter exposes `health()`; routing and runtime READ it here and never
// re-probe. Model identity is config-driven (D-003) — swapping a model is config,
// not code.
//
// Adapters:
//   - Ollama:  local REST `127.0.0.1:11434/api/chat` (NO `/v1` suffix — project rule),
//              NDJSON stream, default `gpt-oss:20b`. $0/offline.
//   - Claude:  Anthropic Messages API SSE; Opus/Sonnet/Haiku. API key from config/env
//              (NEVER committed); never echoed into errors.
//
// Boundary discipline: adapters take an injected `fetchImpl` so the contract is
// tested against a mock transport — no network in the contract suite (F-008: tests
// may use fixtures; the runtime serves live data).

// ── Common contract ───────────────────────────────────────────────────────────

/** A chat message in the provider-neutral shape. */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
}

/** A tool descriptor passed to a provider that supports tool-use. */
export interface ToolSpec {
	name: string;
	description?: string;
	input_schema?: unknown;
}

/** Token usage in the provider-neutral shape. */
export interface Usage {
	input: number;
	output: number;
}

/**
 * One unit emitted by `stream()`. The union is identical across providers so a
 * caller never branches on which provider produced it.
 *   - `text`  — an incremental output delta.
 *   - `done`  — terminal; carries final usage + stop reason.
 */
export type StreamChunk =
	| { type: 'text'; text: string }
	| { type: 'done'; usage?: Usage; stop?: string };

/** Provider health — the single source the rest of the system reads (§2.5). */
export interface ProviderHealth {
	provider: string;
	up: boolean;
	detail?: string;
}

/** The contract every provider adapter implements. */
export interface Provider {
	readonly name: string;
	/** Stream a chat completion as provider-neutral chunks. */
	stream(messages: ChatMessage[], tools?: ToolSpec[]): AsyncIterable<StreamChunk>;
	/** Probe reachability. providers is the SINGLE owner of this (§2.5). */
	health(): Promise<ProviderHealth>;
}

/** A provider-layer failure (transport, bad config, non-2xx). Never carries secrets. */
export class ProviderError extends Error {
	override readonly name = 'ProviderError';
	constructor(
		message: string,
		readonly provider: string
	) {
		super(message);
	}
}

/** Concatenate the text deltas of a drained chunk list (test/convenience helper). */
export function collectText(chunks: StreamChunk[]): string {
	let out = '';
	for (const c of chunks) if (c.type === 'text') out += c.text;
	return out;
}

// ── Line/SSE framing over a fetch Response body ──────────────────────────────────

/** Yield decoded text lines from a Response body, splitting on `\n`. */
async function* lines(res: Response): AsyncIterable<string> {
	const body = res.body;
	if (!body) return;
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				yield buf.slice(0, nl);
				buf = buf.slice(nl + 1);
			}
		}
		buf += dec.decode();
		if (buf.length) yield buf;
	} finally {
		reader.releaseLock();
	}
}

// ── Ollama adapter ──────────────────────────────────────────────────────────────

export interface OllamaOptions {
	/** Base host, e.g. `http://127.0.0.1:11434`. MUST NOT carry a `/v1` suffix. */
	endpoint: string;
	model: string;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

export class OllamaProvider implements Provider {
	readonly name = 'ollama';
	private readonly endpoint: string;
	private readonly model: string;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: OllamaOptions) {
		// Project rule (D-003): the local Ollama endpoint MUST NOT include /v1.
		if (/\/v1\/?$/.test(opts.endpoint)) {
			throw new ProviderError(
				`ollama endpoint must not include a /v1 suffix ("${opts.endpoint}")`,
				'ollama'
			);
		}
		this.endpoint = opts.endpoint.replace(/\/+$/, '');
		this.model = opts.model;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	async *stream(messages: ChatMessage[], tools?: ToolSpec[]): AsyncIterable<StreamChunk> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages,
			stream: true
		};
		if (tools && tools.length) body.tools = tools;

		let res: Response;
		try {
			res = await this.fetchImpl(`${this.endpoint}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch (err) {
			throw new ProviderError(`ollama request failed: ${(err as Error).message}`, 'ollama');
		}
		if (!res.ok) {
			throw new ProviderError(`ollama returned HTTP ${res.status}`, 'ollama');
		}

		// Ollama streams NDJSON: one JSON object per line.
		for await (const line of lines(res)) {
			const t = line.trim();
			if (!t) continue;
			let obj: {
				message?: { content?: string };
				done?: boolean;
				prompt_eval_count?: number;
				eval_count?: number;
			};
			try {
				obj = JSON.parse(t);
			} catch {
				continue; // tolerate partial/keepalive lines
			}
			const piece = obj.message?.content;
			if (piece) yield { type: 'text', text: piece };
			if (obj.done) {
				yield {
					type: 'done',
					usage: {
						input: obj.prompt_eval_count ?? 0,
						output: obj.eval_count ?? 0
					}
				};
				return;
			}
		}
		// Stream ended without an explicit done flag — emit a terminal chunk anyway.
		yield { type: 'done' };
	}

	async health(): Promise<ProviderHealth> {
		try {
			const res = await this.fetchImpl(`${this.endpoint}/api/tags`, { method: 'GET' });
			return { provider: 'ollama', up: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
		} catch (err) {
			return { provider: 'ollama', up: false, detail: (err as Error).message };
		}
	}
}

// ── Claude direct-chat adapter (Anthropic Messages API) ──────────────────────────

export interface ClaudeOptions {
	endpoint: string;
	model: string;
	/** Anthropic API key. From config/env — NEVER committed, NEVER echoed in errors. */
	apiKey?: string;
	/** Max output tokens; default sized to avoid HTTP timeouts on non-stream paths. */
	maxTokens?: number;
	fetchImpl?: typeof fetch;
}

/** Anthropic API version pinned per the Messages API contract. */
const ANTHROPIC_VERSION = '2023-06-01';

export class ClaudeProvider implements Provider {
	readonly name = 'claude';
	private readonly endpoint: string;
	private readonly model: string;
	private readonly apiKey?: string;
	private readonly maxTokens: number;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: ClaudeOptions) {
		this.endpoint = opts.endpoint.replace(/\/+$/, '');
		this.model = opts.model;
		this.apiKey = opts.apiKey;
		this.maxTokens = opts.maxTokens ?? 16000;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	async *stream(messages: ChatMessage[], tools?: ToolSpec[]): AsyncIterable<StreamChunk> {
		if (!this.apiKey) {
			throw new ProviderError('claude provider has no API key configured', 'claude');
		}
		// Anthropic separates the system prompt from the message turns.
		const system = messages
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n\n');
		const turns = messages
			.filter((m) => m.role !== 'system')
			.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

		const body: Record<string, unknown> = {
			model: this.model,
			max_tokens: this.maxTokens,
			stream: true,
			messages: turns
		};
		if (system) body.system = system;
		if (tools && tools.length) body.tools = tools;

		let res: Response;
		try {
			res = await this.fetchImpl(`${this.endpoint}/v1/messages`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-api-key': this.apiKey,
					'anthropic-version': ANTHROPIC_VERSION
				},
				body: JSON.stringify(body)
			});
		} catch (err) {
			// Never include the API key (only the headers object held it; it is not in the message).
			throw new ProviderError(`claude request failed: ${(err as Error).message}`, 'claude');
		}
		if (!res.ok) {
			throw new ProviderError(`claude returned HTTP ${res.status}`, 'claude');
		}

		// Anthropic streams SSE: `event:` + `data:` line pairs separated by blank lines.
		let usage: Usage = { input: 0, output: 0 };
		let stop: string | undefined;
		for await (const raw of lines(res)) {
			const line = raw.trimEnd();
			if (!line.startsWith('data:')) continue;
			const payload = line.slice('data:'.length).trim();
			if (!payload || payload === '[DONE]') continue;
			let evt: {
				type?: string;
				delta?: { type?: string; text?: string; stop_reason?: string };
				message?: { usage?: { input_tokens?: number; output_tokens?: number } };
				usage?: { input_tokens?: number; output_tokens?: number };
			};
			try {
				evt = JSON.parse(payload);
			} catch {
				continue;
			}
			if (evt.type === 'message_start' && evt.message?.usage) {
				usage = {
					input: evt.message.usage.input_tokens ?? 0,
					output: evt.message.usage.output_tokens ?? 0
				};
			} else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
				if (evt.delta.text) yield { type: 'text', text: evt.delta.text };
			} else if (evt.type === 'message_delta') {
				if (evt.usage?.output_tokens != null) usage.output = evt.usage.output_tokens;
				if (evt.delta?.stop_reason) stop = evt.delta.stop_reason;
			} else if (evt.type === 'message_stop') {
				break;
			}
		}
		yield { type: 'done', usage, stop };
	}

	async health(): Promise<ProviderHealth> {
		if (!this.apiKey) {
			return { provider: 'claude', up: false, detail: 'no API key configured' };
		}
		// A cheap liveness probe: GET /v1/models. Any 2xx => up; auth/transport => down.
		try {
			const res = await this.fetchImpl(`${this.endpoint}/v1/models`, {
				method: 'GET',
				headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
			});
			return { provider: 'claude', up: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
		} catch (err) {
			return { provider: 'claude', up: false, detail: (err as Error).message };
		}
	}
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** A live set of provider adapters keyed by name; the health single-owner surface. */
export class ProviderRegistry {
	private readonly byName = new Map<string, Provider>();

	register(p: Provider): this {
		this.byName.set(p.name, p);
		return this;
	}

	get(name: string): Provider {
		const p = this.byName.get(name);
		if (!p) throw new ProviderError(`no provider registered: ${name}`, name);
		return p;
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	/** Health of every registered provider — the single source for routing/runtime. */
	async health(): Promise<ProviderHealth[]> {
		return Promise.all([...this.byName.values()].map((p) => p.health()));
	}
}
