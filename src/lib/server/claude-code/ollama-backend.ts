// LOCAL Ollama session backend (MODEL-BENCHMARK-SPEC step 1 — the missing runtime edge).
//
// The routing ladder's `local` tier (config/agent-pool.yaml: local → {ollama, gpt-oss:20b},
// the $0 floor of local→haiku→sonnet→opus) RESOLVES today but could never EXECUTE: the only
// wired CcBackend is the Claude CLI (cli-backend.ts), which hardcodes `--model plan.model.modelId`
// onto the `claude` .exe. Handing it `gpt-oss:20b` would fail. This backend closes that edge: it
// wraps `OllamaProvider.stream()` (the local `127.0.0.1:11434/api/chat` NDJSON adapter, D-003 — no
// `/v1`) and adapts its `StreamChunk` output to the common `RuntimeEvent` stream the launch path
// consumes, so a `local`-provider spawn runs a real local chat turn.
//
// HONEST capability boundary (F-008, and the very thing the benchmark measures): Ollama does NOT
// speak the Claude CLI protocol (isolated-config trust dialog / PreToolUse gate hook / interject-
// resume). So this is a STAGE-1 backend — a single basic chat-stream turn. It declares
// supportsInterject:false / supportsResume:false and its resume()/interject() throw honestly
// rather than pretend. It does NOT run tools, enforce the D-018 edit-scope gate, or emit tool_call
// events — a local session is a plain assistant turn over the built prompt. That capability delta
// (local can't tool-gate / interject / spawn children like a Claude CLI session) is exactly what
// the local-vs-cloud benchmark is built to quantify; we surface it honestly, never fake it.

import { randomUUID } from 'node:crypto';
import type { CcBackend, CcBackendRun, CcSpawnPlan, RuntimeEvent } from '../runtime/index';
import { OllamaProvider, type ChatMessage, type StreamChunk } from '../providers/index';

/** The minimal streaming surface this backend needs — lets tests inject a fake provider. */
export interface OllamaStreamSource {
	stream(messages: ChatMessage[]): AsyncIterable<StreamChunk>;
}

export interface OllamaBackendOptions {
	/** Ollama base host (no `/v1`, D-003). Defaults to OLLAMA_HOST or 127.0.0.1:11434. */
	endpoint?: string;
	/** Injected transport for tests; forwarded to the OllamaProvider. */
	fetchImpl?: typeof fetch;
	/**
	 * Test seam: build a stream source for a given model id. Defaults to a real OllamaProvider
	 * over `endpoint`/`fetchImpl`. Production leaves this unset.
	 */
	providerFor?: (modelId: string) => OllamaStreamSource;
}

/**
 * The local-provider CcBackend. `run(plan)` starts one chat turn against `plan.model.modelId`
 * on the local Ollama host; the returned run's `stream()` bridges provider chunks → RuntimeEvents.
 * `resume`/`interject` are honestly unsupported (Stage-1). The runtime only routes a spawn here
 * when `plan.model.provider === 'ollama'` (see ClaudeCodeRuntime.spawn); the Claude path is
 * untouched.
 */
export class OllamaBackend implements CcBackend {
	readonly kind = 'ollama';
	// HONEST matrix (F-008): a local chat turn has none of the Claude CLI channel controls.
	readonly supportsInterject = false;
	readonly supportsResume = false;

	private readonly endpoint: string;
	private readonly fetchImpl?: typeof fetch;
	private readonly providerFor?: (modelId: string) => OllamaStreamSource;

	constructor(opts: OllamaBackendOptions = {}) {
		this.endpoint = opts.endpoint?.trim() || process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
		this.fetchImpl = opts.fetchImpl;
		this.providerFor = opts.providerFor;
	}

	run(plan: CcSpawnPlan): CcBackendRun {
		const ccSessionId = `ollama-${randomUUID()}`;
		const source =
			this.providerFor?.(plan.model.modelId) ??
			new OllamaProvider({
				endpoint: this.endpoint,
				model: plan.model.modelId,
				...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
			});
		// The built prompt (system + task + fenced context + affordances) is one string; a chat model
		// takes it as the single user turn. A local session is a plain turn — no tool loop (Stage-1).
		const messages: ChatMessage[] = [{ role: 'user', content: plan.prompt }];
		let aborted = false;

		async function* bridge(): AsyncIterable<RuntimeEvent> {
			let text = '';
			let usage: { input: number; output: number } | undefined;
			try {
				for await (const chunk of source.stream(messages)) {
					if (aborted) break;
					if (chunk.type === 'text') text += chunk.text;
					else if (chunk.type === 'done') usage = chunk.usage;
				}
			} catch (err) {
				// A local transport/model failure surfaces as ONE honest error event — never an
				// unhandled throw (§2.3 cleanup; mirrors cli-backend's error mapping).
				yield { type: 'error', error: (err as Error).message };
				return;
			}
			if (aborted) {
				yield { type: 'error', error: 'local session cancelled' };
				return;
			}
			// Emit the assistant turn as ONE log block (the CLI backend maps whole content blocks,
			// not tokens — accumulating Ollama's token deltas into one block matches that shape and
			// avoids flooding the transcript/bus with per-token rows).
			if (text) yield { type: 'log', message: text };
			if (usage) yield { type: 'token_usage', input: usage.input, output: usage.output };
			yield { type: 'done', result: { ok: true, summary: text, ccSessionId } };
		}

		return {
			ccSessionId,
			stream: bridge,
			// Best-effort cancel: the provider.stream signature takes no AbortSignal, so we flip a
			// flag the bridge checks between chunks (bounded by chunk cadence). Honest, not a no-op lie.
			cancel: async () => {
				aborted = true;
			}
		};
	}

	// STAGE-1 honest refusals (F-008): the local backend cannot resume or interject a session —
	// declaring supportsResume/supportsInterject false already makes the runtime refuse these up
	// front; these throws are the defense-in-depth backstop if a caller reaches the method anyway.
	async resume(): Promise<CcBackendRun> {
		throw new Error("resume is not supported by the 'ollama' backend (local sessions are single-turn)");
	}

	async interject(): Promise<void> {
		throw new Error("interject is not supported by the 'ollama' backend (local sessions are single-turn)");
	}
}
