import { APIS } from '../constants.js';
import { ollamaAdapter } from './ollama.js';
import { getGatewayClient } from '../heartbeat/gateway-client.js';
import type { ProviderAdapter, ProviderMessage, StreamChunk, ToolDef } from './types.js';

const OPENCLAW_HEALTH = 'http://127.0.0.1:18789/';

// ── Health check cache ──────────────────────────────────────────────
let healthCache: { online: boolean; checkedAt: number } | null = null;
const HEALTH_CACHE_TTL = 15_000; // 15 seconds

async function isGatewayOnline(): Promise<boolean> {
	if (healthCache && Date.now() - healthCache.checkedAt < HEALTH_CACHE_TTL) {
		return healthCache.online;
	}
	try {
		const res = await fetch(OPENCLAW_HEALTH, { signal: AbortSignal.timeout(3000) });
		const online = res.ok; // 2xx only
		healthCache = { online, checkedAt: Date.now() };
		return online;
	} catch {
		healthCache = { online: false, checkedAt: Date.now() };
		return false;
	}
}

export const openclawAdapter: ProviderAdapter = {
	async *stream(
		messages: ProviderMessage[],
		model: string,
		tools?: ToolDef[]
	): AsyncGenerator<StreamChunk> {
		const online = await isGatewayOnline();
		if (!online) {
			yield {
				type: 'error',
				content: 'OpenClaw gateway is not reachable at 127.0.0.1:18789. Start it with: npm run openclaw:start'
			};
			return;
		}

		// Build prompt from messages for the gateway
		const prompt = messages
			.map(m => {
				if (m.role === 'system') return `[System] ${m.content}`;
				if (m.role === 'assistant') {
					// Include tool calls made by the assistant
					const toolCallText = m.tool_calls?.length
						? '\n' + m.tool_calls.map(tc => `[Tool Call: ${tc.name}(${JSON.stringify(tc.arguments)})]`).join('\n')
						: '';
					return `[Assistant] ${m.content}${toolCallText}`;
				}
				if (m.role === 'tool') return `[Tool Result: ${m.tool_call_id ?? 'unknown'}]\n${m.content}`;
				return m.content;
			})
			.join('\n\n');

		try {
			// Route through the OpenClaw gateway WS — agent gets tools access
			const client = await getGatewayClient();
			const response = await client.chat(prompt, `chat-${Date.now()}`);

			// Emit the full response as text chunks
			// Gateway returns the complete response after streaming internally
			if (response) {
				yield { type: 'text', content: response };
			}
			yield { type: 'done' };
		} catch (err) {
			// Invalidate health cache on connection failure
			healthCache = null;
			const errMsg = err instanceof Error ? err.message : String(err);
			console.warn('[openclaw] Gateway failed, falling back to Ollama:', errMsg);
			yield { type: 'text', content: `⚠ OpenClaw gateway error — falling back to Ollama: ${errMsg}\n\n` };
			// Fallback to direct Ollama if gateway WS fails
			const ollamaModel = model.replace(/^ollama\//, '');
			yield* ollamaAdapter.stream(messages, ollamaModel, tools);
		}
	}
};
