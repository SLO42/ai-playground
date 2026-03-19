<script lang="ts">
	import { apiFetch, apiPost } from '$lib/api-client.js';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { PageData } from './$types.js';
	import type { ChatMessage } from '$lib/types/chat.js';

	let { data }: { data: PageData } = $props();

	let messages = $state<ChatMessage[]>(data.lastSession?.messages?.filter((m: ChatMessage) => m.role !== 'system') ?? []);
	let input = $state('');
	let selectedProvider = $state('ollama');
	let isStreaming = $state(false);
	let messagesEl: HTMLDivElement | undefined = $state();
	let abortController: AbortController | null = null;

	const providers = [
		{ id: 'ollama', name: 'Ollama (Local)' },
		{ id: 'openclaw', name: 'OpenClaw' },
		{ id: 'claude', name: 'Claude API' }
	];

	function scrollToBottom() {
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	async function sendMessage() {
		const text = input.trim();
		if (!text || isStreaming) return;

		messages.push({ role: 'user', content: text });
		input = '';
		isStreaming = true;
		scrollToBottom();

		// Add empty assistant message for streaming
		messages.push({ role: 'assistant', content: '' });
		const assistantIdx = messages.length - 1;

		try {
			abortController = new AbortController();
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: text,
					provider: selectedProvider,
					projectId: data.projectId,
					projectPath: data.projectPath,
					systemContext: `You are assisting with the project "${data.projectName}" located at ${data.projectPath}. Focus your answers on this project's codebase, tech stack, and tasks.`
				}),
				signal: abortController.signal
			});

			if (!res.ok || !res.body) {
				messages[assistantIdx] = { role: 'assistant', content: `Error: ${res.statusText}` };
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				for (const line of chunk.split('\n')) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6);
					if (payload === '[DONE]') break;
					try {
						const parsed = JSON.parse(payload);
						if (parsed.text) {
							messages[assistantIdx] = { role: 'assistant', content: (messages[assistantIdx].content ?? '') + parsed.text };
							scrollToBottom();
						}
					} catch { /* skip non-JSON lines */ }
				}
			}
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				messages[assistantIdx] = { role: 'assistant', content: `Error: ${(e as Error).message}` };
			}
		} finally {
			isStreaming = false;
			abortController = null;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}
</script>

<div class="flex flex-col h-[calc(100vh-120px)]">
	<!-- Header -->
	<div class="flex items-center justify-between pb-3 border-b border-border mb-3">
		<div>
			<h1 class="text-lg font-bold text-text-primary">{data.projectName} Chat</h1>
			<p class="text-xs text-text-secondary">{data.sessions?.length ?? 0} sessions · Project-scoped context</p>
		</div>
		<select bind:value={selectedProvider} class="bg-bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary">
			{#each providers as p}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>
	</div>

	<!-- Messages -->
	<div bind:this={messagesEl} class="flex-1 overflow-y-auto space-y-3 pb-4">
		{#if messages.length === 0}
			<div class="flex items-center justify-center h-full">
				<div class="text-center">
					<p class="text-text-secondary text-sm">Ask anything about <span class="text-accent-blue font-medium">{data.projectName}</span></p>
					<p class="text-text-secondary text-xs mt-1">The AI has context about this project's codebase, tasks, and tech stack.</p>
				</div>
			</div>
		{:else}
			{#each messages as msg}
				<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
					<div class="max-w-[75%] rounded-xl px-4 py-3 text-sm break-words
						{msg.role === 'user'
							? 'bg-accent-blue/20 text-text-primary whitespace-pre-wrap'
							: 'bg-bg-secondary border border-border text-text-primary'}">
						{#if msg.role === 'assistant'}
							<Markdown content={msg.content} />{#if isStreaming && msg === messages[messages.length - 1]}<span class="inline-block w-2 h-4 ml-0.5 bg-accent-cyan animate-pulse rounded-sm"></span>{/if}
						{:else}
							{msg.content}
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Input -->
	<div class="border-t border-border pt-3">
		<div class="flex gap-2">
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				placeholder="Ask about {data.projectName}..."
				rows="2"
				class="flex-1 bg-bg-secondary border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary resize-none"
			></textarea>
			<button
				onclick={sendMessage}
				disabled={isStreaming || !input.trim()}
				class="px-4 py-2 bg-accent-blue text-white rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50 self-end"
			>
				{isStreaming ? '...' : 'Send'}
			</button>
		</div>
	</div>
</div>
