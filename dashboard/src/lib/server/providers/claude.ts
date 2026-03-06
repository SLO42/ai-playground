import type { ProviderAdapter, ProviderMessage, StreamChunk, ToolDef } from './types.js';

function toClaudeMessages(messages: ProviderMessage[]): { system?: string; messages: object[] } {
	let system: string | undefined;
	const out: object[] = [];

	for (const m of messages) {
		if (m.role === 'system') {
			system = m.content;
			continue;
		}
		if (m.role === 'tool') {
			out.push({
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: m.tool_call_id,
						content: m.content
					}
				]
			});
			continue;
		}
		if (m.role === 'assistant' && m.tool_calls?.length) {
			const content: object[] = [];
			if (m.content) {
				content.push({ type: 'text', text: m.content });
			}
			for (const tc of m.tool_calls) {
				content.push({
					type: 'tool_use',
					id: tc.id,
					name: tc.name,
					input: tc.arguments
				});
			}
			out.push({ role: 'assistant', content });
			continue;
		}
		out.push({ role: m.role, content: m.content });
	}

	return { system, messages: out };
}

function toClaudeTools(tools: ToolDef[]): object[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters
	}));
}

export const claudeAdapter: ProviderAdapter = {
	async *stream(
		messages: ProviderMessage[],
		model: string,
		tools?: ToolDef[]
	): AsyncGenerator<StreamChunk> {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			yield { type: 'error', content: 'ANTHROPIC_API_KEY not set in environment' };
			return;
		}

		const { system, messages: claudeMessages } = toClaudeMessages(messages);

		const body: Record<string, unknown> = {
			model,
			max_tokens: 4096,
			messages: claudeMessages,
			stream: true
		};
		if (system) body.system = system;
		if (tools?.length) body.tools = toClaudeTools(tools);

		let res: Response;
		try {
			res = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01'
				},
				body: JSON.stringify(body)
			});
		} catch {
			yield { type: 'error', content: 'Failed to connect to Claude API' };
			return;
		}

		if (!res.ok) {
			const text = await res.text().catch(() => 'Unknown error');
			yield { type: 'error', content: `Claude API error (${res.status}): ${text}` };
			return;
		}

		const reader = res.body?.getReader();
		if (!reader) {
			yield { type: 'error', content: 'No response body from Claude API' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		let currentToolId = '';
		let currentToolName = '';
		let toolInputJson = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6).trim();
					if (data === '[DONE]') {
						yield { type: 'done' };
						continue;
					}

					try {
						const event = JSON.parse(data);

						switch (event.type) {
							case 'content_block_start':
								if (event.content_block?.type === 'tool_use') {
									currentToolId = event.content_block.id;
									currentToolName = event.content_block.name;
									toolInputJson = '';
								}
								break;

							case 'content_block_delta':
								if (event.delta?.type === 'text_delta') {
									yield { type: 'text', content: event.delta.text };
								} else if (event.delta?.type === 'input_json_delta') {
									toolInputJson += event.delta.partial_json;
								}
								break;

							case 'content_block_stop':
								if (currentToolId && currentToolName) {
									let args: Record<string, unknown> = {};
									try {
										args = JSON.parse(toolInputJson || '{}');
									} catch {
										// empty args
									}
									yield {
										type: 'tool_call',
										tool_call: {
											id: currentToolId,
											name: currentToolName,
											arguments: args
										}
									};
									currentToolId = '';
									currentToolName = '';
									toolInputJson = '';
								}
								break;

							case 'message_stop':
								yield { type: 'done' };
								break;
						}
					} catch {
						// skip malformed
					}
				}
			}
		}
	}
};
