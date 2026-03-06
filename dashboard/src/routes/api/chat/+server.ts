import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import type { ChatRequest } from '$lib/types/chat.js';
import type { ProviderMessage, StreamChunk, ToolCall } from '$lib/server/providers/types.js';
import { ollamaAdapter } from '$lib/server/providers/ollama.js';
import { claudeAdapter } from '$lib/server/providers/claude.js';
import { openclawAdapter } from '$lib/server/providers/openclaw.js';
import { TOOL_DEFINITIONS, executeTool } from '$lib/server/chat-tools.js';
import { logRoutingDecision } from '$lib/server/routing-telemetry.js';
import { loadGeneralSettings, shouldAutoExecute } from '$lib/server/general-settings.js';
import { loadModelRoutingSettings, resolveRoute } from '$lib/server/model-routing-settings.js';

const MAX_TOOL_LOOPS = 5;

function getAdapter(provider: string) {
	switch (provider) {
		case 'claude':
			return claudeAdapter;
		case 'openclaw':
			return openclawAdapter;
		default:
			return ollamaAdapter;
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let body: ChatRequest;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!body.messages?.length) {
		return json({ error: 'messages array is required' }, { status: 400 });
	}

	// Apply model routing strategy
	const routingSettings = await loadModelRoutingSettings();
	const complexity = typeof body.complexity === 'number' ? body.complexity : 0.3;
	const resolved = resolveRoute(routingSettings, complexity, body.provider, body.model);
	const model = resolved.model;
	const provider = resolved.provider;
	const useTools = body.tools !== false;
	const adapter = getAdapter(provider);

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const chatStartTime = Date.now();

			function send(eventType: string, data: unknown) {
				const payload = JSON.stringify({ type: eventType, ...data as object });
				controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
			}

			try {
				const settings = await loadGeneralSettings();
				const history: ProviderMessage[] = body.messages.map((m) => ({
					role: m.role,
					content: m.content,
					tool_calls: m.tool_calls,
					tool_call_id: m.tool_call_id
				}));

				const tools = useTools ? TOOL_DEFINITIONS : undefined;
				let loops = 0;

				while (loops < MAX_TOOL_LOOPS) {
					loops++;
					let fullText = '';
					const pendingToolCalls: ToolCall[] = [];
					let hadError = false;

					for await (const chunk of adapter.stream(history, model, tools)) {
						switch (chunk.type) {
							case 'text':
								fullText += chunk.content ?? '';
								send('content', { content: chunk.content });
								break;

							case 'tool_call':
								if (chunk.tool_call) {
									pendingToolCalls.push(chunk.tool_call);
									send('tool_call', {
										tool_call: {
											id: chunk.tool_call.id,
											name: chunk.tool_call.name,
											arguments: chunk.tool_call.arguments
										}
									});
								}
								break;

							case 'error':
								send('error', { content: chunk.content });
								hadError = true;
								break;

							case 'done':
								// Will handle after loop
								break;
						}
					}

					if (hadError) break;

					// No tool calls — we're done
					if (pendingToolCalls.length === 0) {
						send('done', { done: true });
						break;
					}

					// Append assistant message with tool calls to history
					history.push({
						role: 'assistant',
						content: fullText,
						tool_calls: pendingToolCalls
					});

					// Check which tools need confirmation vs auto-execute
					const needsConfirmation = pendingToolCalls.filter(
						(tc) => !shouldAutoExecute(tc.name, settings)
					);

					// Notify client about tools that need confirmation
					if (needsConfirmation.length > 0) {
						for (const tc of needsConfirmation) {
							send('tool_confirm', {
								tool_confirm: {
									id: tc.id,
									name: tc.name,
									arguments: tc.arguments
								}
							});
						}
					}

					// Execute each tool and append results
					for (const tc of pendingToolCalls) {
						const autoExec = shouldAutoExecute(tc.name, settings);
						if (!autoExec) {
							send('tool_pending', {
								tool_pending: { id: tc.id, name: tc.name, status: 'auto-approved' }
							});
						}
						const result = await executeTool(tc);
						send('tool_result', {
							tool_result: { call_id: tc.id, name: tc.name, content: result }
						});
						history.push({
							role: 'tool',
							content: result,
							tool_call_id: tc.id
						});
					}

					// Loop continues — re-prompt with tool results
				}

				if (loops >= MAX_TOOL_LOOPS) {
					send('content', { content: '\n\n[Tool call limit reached]' });
					send('done', { done: true });
				}
				// Log routing telemetry
				const lastUserMsg = body.messages.filter((m) => m.role === 'user').pop();
				logRoutingDecision({
					model,
					provider,
					agent: provider === 'ollama' ? 'gpt-oss' : provider,
					taskType: 'chat',
					complexity,
					latencyMs: Date.now() - chatStartTime,
					success: true,
					source: 'user'
				}).catch(() => {});

			} catch (err) {
				const msg = err instanceof Error ? err.message : 'Stream failed';
				send('error', { content: msg });

				logRoutingDecision({
					model,
					provider,
					agent: provider === 'ollama' ? 'gpt-oss' : provider,
					taskType: 'chat',
					complexity,
					latencyMs: Date.now() - chatStartTime,
					success: false,
					source: 'user',
					reason: msg
				}).catch(() => {});
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
