import { APIS } from '../constants.js';
import { ollamaAdapter } from './ollama.js';
import type { ProviderAdapter, ProviderMessage, StreamChunk, ToolDef } from './types.js';

const OPENCLAW_HEALTH = 'http://127.0.0.1:18789/';

async function isGatewayOnline(): Promise<boolean> {
	try {
		const res = await fetch(OPENCLAW_HEALTH, { signal: AbortSignal.timeout(3000) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

export const openclawAdapter: ProviderAdapter = {
	async *stream(
		messages: ProviderMessage[],
		model: string,
		tools?: ToolDef[]
	): AsyncGenerator<StreamChunk> {
		// OpenClaw is a WSS gateway that routes to Ollama.
		// For the dashboard chat, we proxy through Ollama directly
		// but verify the gateway is reachable first.
		const online = await isGatewayOnline();
		if (!online) {
			yield {
				type: 'error',
				content: 'OpenClaw gateway is not reachable at 127.0.0.1:18789. Start it with: npm run openclaw:start'
			};
			return;
		}

		// Route through Ollama using the same model.
		// OpenClaw's primary model is ollama/gpt-oss:20b — strip the ollama/ prefix if present.
		const ollamaModel = model.replace(/^ollama\//, '');
		yield* ollamaAdapter.stream(messages, ollamaModel, tools);
	}
};
