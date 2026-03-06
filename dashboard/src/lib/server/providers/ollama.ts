import { APIS } from '../constants.js';
import type { ProviderAdapter, ProviderMessage, StreamChunk, ToolDef } from './types.js';

function toOllamaTools(tools: ToolDef[]): object[] {
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}
	}));
}

function toOllamaMessages(messages: ProviderMessage[]): object[] {
	return messages.map((m) => {
		if (m.role === 'tool') {
			return { role: 'tool', content: m.content };
		}
		if (m.role === 'assistant' && m.tool_calls?.length) {
			return {
				role: 'assistant',
				content: m.content || '',
				tool_calls: m.tool_calls.map((tc) => ({
					function: { name: tc.name, arguments: tc.arguments }
				}))
			};
		}
		return { role: m.role, content: m.content };
	});
}

export const ollamaAdapter: ProviderAdapter = {
	async *stream(
		messages: ProviderMessage[],
		model: string,
		tools?: ToolDef[]
	): AsyncGenerator<StreamChunk> {
		const body: Record<string, unknown> = {
			model,
			messages: toOllamaMessages(messages),
			stream: true
		};
		if (tools?.length) {
			body.tools = toOllamaTools(tools);
		}

		let res: Response;
		try {
			res = await fetch(`${APIS.ollama}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		} catch {
			yield { type: 'error', content: 'Ollama is not reachable' };
			return;
		}

		if (!res.ok) {
			const text = await res.text().catch(() => 'Unknown error');
			yield { type: 'error', content: `Ollama error: ${text}` };
			return;
		}

		const reader = res.body?.getReader();
		if (!reader) {
			yield { type: 'error', content: 'No response body from Ollama' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const chunk = JSON.parse(line);

					// Check for tool calls
					if (chunk.message?.tool_calls?.length) {
						for (const tc of chunk.message.tool_calls) {
							yield {
								type: 'tool_call',
								tool_call: {
									id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
									name: tc.function.name,
									arguments: typeof tc.function.arguments === 'string'
										? JSON.parse(tc.function.arguments)
										: tc.function.arguments
								}
							};
						}
					}

					if (chunk.message?.content) {
						yield { type: 'text', content: chunk.message.content };
					}

					if (chunk.done) {
						yield { type: 'done' };
					}
				} catch {
					// skip malformed
				}
			}
		}

		// Flush remaining buffer
		if (buffer.trim()) {
			try {
				const chunk = JSON.parse(buffer);
				if (chunk.message?.tool_calls?.length) {
					for (const tc of chunk.message.tool_calls) {
						yield {
							type: 'tool_call',
							tool_call: {
								id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
								name: tc.function.name,
								arguments: typeof tc.function.arguments === 'string'
									? JSON.parse(tc.function.arguments)
									: tc.function.arguments
							}
						};
					}
				}
				if (chunk.message?.content) {
					yield { type: 'text', content: chunk.message.content };
				}
				if (chunk.done) {
					yield { type: 'done' };
				}
			} catch {
				// skip
			}
		}
	}
};
