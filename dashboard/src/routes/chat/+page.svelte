<script lang="ts">
	import { tick, onMount, onDestroy } from 'svelte';
	import { apiFetch, apiPost, apiPut, apiDelete, apiGet } from '$lib/api-client.js';
	import type { PageData } from './$types.js';
	import type { ChatMessage, ChatSession, ChatSessionMeta, ChatToolCall, ChatToolResult, SessionStatus } from '$lib/types/chat.js';
	import Markdown from '$lib/components/Markdown.svelte';

	interface Provider {
		id: string;
		name: string;
	}

	const PROVIDERS: Provider[] = [
		{ id: 'ollama', name: 'Ollama (Local)' },
		{ id: 'openclaw', name: 'OpenClaw' },
		{ id: 'claude', name: 'Claude API' }
	];

	let { data }: { data: PageData } = $props();

	let sessions: ChatSessionMeta[] = $state(data.sessions ?? []);
	let activeSessionId: string | null = $state(data.lastSession?.id ?? null);
	let messages: ChatMessage[] = $state(data.lastSession?.messages ?? []);
	let input = $state('');
	let selectedProvider = $state(data.lastSession?.provider ?? 'ollama');
	let toolsEnabled = $state(true);
	let isStreaming = $state(false);
	let messagesEl: HTMLDivElement | undefined = $state();
	let inputEl: HTMLTextAreaElement | undefined = $state();
	let abortController: AbortController | null = null;
	let userScrolledUp = $state(false);
	let requireConfirmation = $state(data.generalSettings?.requireConfirmation ?? true);
	let isLoadingSession = $state(false);
	let sessionError = $state<string | null>(null);
	let chatError = $state<string | null>(null);
	let isSending = $state(false);
	let pollFailures = $state(0);
	let serverUnreachable = $derived(pollFailures >= 3);

	// Scroll to bottom on initial load + poll session list
	let sessionPollTimer: ReturnType<typeof setInterval> | null = null;

	onMount(async () => {
		await tick();
		scrollToBottom(true);

		// Poll session index every 10s to catch new agent sessions
		sessionPollTimer = setInterval(async () => {
			try {
				const res = await apiFetch('/api/chat/history', { signal: AbortSignal.timeout(5000) });
				if (res.ok) {
					pollFailures = 0;
					const data = await res.json();
					if (Array.isArray(data)) {
						sessions = data.sort((a: ChatSessionMeta, b: ChatSessionMeta) =>
							new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
						);
					}
				} else {
					pollFailures++;
				}
			} catch {
				pollFailures++;
			}
		}, 10_000);
	});

	onDestroy(() => {
		if (sessionPollTimer) clearInterval(sessionPollTimer);
		if (liveReconnectTimer) clearTimeout(liveReconnectTimer);
		stopDiscussionPoll();
	});

	// Live session state
	let liveSource: EventSource | null = null;
	let liveStatus = $state<SessionStatus>('idle');
	let liveConnectionLost = $state(false);
	let liveReconnectAttempt = 0;
	let liveReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let activeSessionMeta = $derived(
		sessions.find((s) => s.id === activeSessionId)
	);
	let isClaw = $derived(activeSessionMeta?.source === 'claw');
	let isDiscussionSession = $derived(
		isClaw && (activeSessionMeta?.status === 'waiting' || activeSessionId?.startsWith('discuss-'))
	);
	let isLiveSession = $derived(
		isClaw && !isDiscussionSession
	);

	// Tool call events displayed inline
	interface ToolEvent {
		type: 'call' | 'result' | 'confirm';
		call?: ChatToolCall;
		result?: ChatToolResult;
		confirm?: ChatToolCall;
	}
	let toolEvents: ToolEvent[] = $state([]);

	// Compute available models based on provider
	let availableModels = $derived.by(() => {
		switch (selectedProvider) {
			case 'claude':
				return data.claudeModels ?? [];
			case 'openclaw':
				return data.ollamaModels ?? [];
			default:
				return data.ollamaModels ?? [];
		}
	});

	let selectedModel = $state(
		data.lastSession?.model ?? data.ollamaModels?.[0] ?? 'gpt-oss:20b'
	);

	// When provider changes, reset model to first available
	$effect(() => {
		const models = availableModels;
		if (models.length > 0 && !models.includes(selectedModel)) {
			selectedModel = models[0];
		}
	});

	// Connect to live SSE when viewing a claw session
	function connectLive(sessionId: string) {
		disconnectLive();
		liveConnectionLost = false;
		liveReconnectAttempt = 0;

		function setupSource() {
			liveSource = new EventSource(`/api/chat/sessions/${sessionId}/live`);

			liveSource.onopen = () => {
				liveConnectionLost = false;
				liveReconnectAttempt = 0;
			};

			liveSource.onmessage = (e) => {
				try {
					const event = JSON.parse(e.data);
					switch (event.type) {
						case 'status':
							liveStatus = event.status;
							break;
						case 'message':
							if (event.message) {
								messages = [...messages, event.message];
								scrollToBottom();
							}
							break;
						case 'content_delta':
							if (event.content && messages.length > 0) {
								const last = messages[messages.length - 1];
								if (last.role === 'assistant') {
									messages[messages.length - 1] = {
										...last,
										content: last.content + event.content
									};
									scrollToBottom();
								}
							}
							break;
						case 'tool_call':
							if (event.tool_call) {
								toolEvents = [...toolEvents, { type: 'call', call: event.tool_call }];
								scrollToBottom();
							}
							break;
						case 'tool_result':
							if (event.tool_result) {
								toolEvents = [...toolEvents, { type: 'result', result: event.tool_result }];
								scrollToBottom();
							}
							break;
						case 'error':
							liveStatus = 'idle';
							break;
						case 'done':
							liveStatus = 'idle';
							break;
					}
				} catch { /* ignore parse errors */ }
			};

			liveSource.onerror = () => {
				liveSource?.close();
				liveSource = null;
				liveConnectionLost = true;

				if (!isLiveSession || activeSessionId !== sessionId) return;

				// Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
				const delay = Math.min(1000 * Math.pow(2, liveReconnectAttempt), 30_000);
				liveReconnectAttempt++;

				if (liveReconnectAttempt > 10) return;

				liveReconnectTimer = setTimeout(() => {
					if (activeSessionId === sessionId && isLiveSession) {
						setupSource();
					}
				}, delay);
			};
		}

		setupSource();
	}

	function reconnectLiveNow() {
		if (liveReconnectTimer) {
			clearTimeout(liveReconnectTimer);
			liveReconnectTimer = null;
		}
		if (activeSessionId && isLiveSession) {
			connectLive(activeSessionId);
		}
	}

	function disconnectLive() {
		if (liveReconnectTimer) {
			clearTimeout(liveReconnectTimer);
			liveReconnectTimer = null;
		}
		if (liveSource) {
			liveSource.close();
			liveSource = null;
		}
		liveStatus = 'idle';
		liveConnectionLost = false;
		liveReconnectAttempt = 0;
	}

	// Auto-connect when switching to a live claw session
	// Skip auto-connect if we have an active discussion poll (just replied)
	$effect(() => {
		if (activeSessionId && isLiveSession && !discussionPollTimer) {
			connectLive(activeSessionId);
		} else if (!isLiveSession) {
			disconnectLive();
		}
		return () => disconnectLive();
	});

	async function pauseLive() {
		if (!activeSessionId) return;
		await apiPost('/api/chat/auto', { action: 'pause', sessionId: activeSessionId }, { silent: true });
	}

	async function resumeLive() {
		if (!activeSessionId) return;
		await apiPost('/api/chat/auto', { action: 'resume', sessionId: activeSessionId }, { silent: true });
	}

	async function injectMessage() {
		const text = input.trim();
		if (!text || !activeSessionId) return;
		input = '';
		await apiPost('/api/chat/auto', { action: 'inject', sessionId: activeSessionId, message: text }, { silent: true });
	}

	async function replyToDiscussion() {
		const text = input.trim();
		if (!text || !activeSessionId) return;

		messages = [...messages, { role: 'user' as const, content: text }];
		input = '';
		chatError = null;
		userScrolledUp = false;
		await scrollToBottom(true);

		try {
			await saveSession();
		} catch (err: unknown) {
			const e = err as { message?: string };
			chatError = e.message ?? 'Failed to send reply';
			return;
		}

		// Poll the session file for heartbeat responses (agent spawning, progress)
		// since the heartbeat writes directly to the file, not via SSE
		startDiscussionPoll(activeSessionId);
	}

	let discussionPollTimer: ReturnType<typeof setTimeout> | null = null;
	function startDiscussionPoll(sessionId: string) {
		stopDiscussionPoll();
		let pollCount = 0;
		let consecutiveFailures = 0;
		const BASE_INTERVAL = 10_000;
		const MAX_INTERVAL = 120_000; // 2 min cap

		async function poll() {
			pollCount++;
			if (pollCount > 30 || activeSessionId !== sessionId) {
				stopDiscussionPoll();
				return;
			}
			try {
				const session = await apiGet<ChatSession>(`/api/chat/history/${sessionId}`);
				if (session && session.messages.length > messages.length) {
					messages = session.messages;
					await scrollToBottom();
				}
				consecutiveFailures = 0;
			} catch {
				consecutiveFailures++;
			}
			// Exponential backoff: 10s, 20s, 40s, 80s, capped at 120s
			const delay = Math.min(BASE_INTERVAL * Math.pow(2, consecutiveFailures), MAX_INTERVAL);
			discussionPollTimer = setTimeout(poll, delay);
		}

		discussionPollTimer = setTimeout(poll, BASE_INTERVAL);
	}
	function stopDiscussionPoll() {
		if (discussionPollTimer) {
			clearTimeout(discussionPollTimer);
			discussionPollTimer = null;
		}
	}

	function isNearBottom(): boolean {
		if (!messagesEl) return true;
		const threshold = 100;
		return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
	}

	function onMessagesScroll() {
		userScrolledUp = !isNearBottom();
	}

	async function scrollToBottom(force = false) {
		await tick();
		if (messagesEl && (force || !userScrolledUp)) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	async function createSession(): Promise<string> {
		const session = await apiPost<ChatSession>('/api/chat/history', { model: selectedModel, provider: selectedProvider });
		if (!session) throw new Error('Failed to create session');
		activeSessionId = session.id;
		sessions = [
			{
				id: session.id,
				title: 'New Chat',
				model: session.model,
				provider: session.provider,
				messageCount: 0,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt
			},
			...sessions
		];
		return session.id;
	}

	async function saveSession() {
		if (!activeSessionId || messages.length === 0) return;
		// Don't overwrite model/provider for claw-owned sessions (they use 'system'/'internal')
		const body = isClaw
			? { messages }
			: { messages, model: selectedModel, provider: selectedProvider };
		await apiPut(`/api/chat/history/${activeSessionId}`, body, { silent: true });
		const firstUserMsg = messages.find((m) => m.role === 'user');
		const title = firstUserMsg ? firstUserMsg.content.slice(0, 40) : 'New Chat';
		sessions = sessions.map((s) =>
			s.id === activeSessionId
				? { ...s, title, messageCount: messages.length, updatedAt: new Date().toISOString() }
				: s
		);
	}

	async function switchSession(id: string) {
		if (id === activeSessionId) return;
		stopDiscussionPoll();
		isLoadingSession = true;
		sessionError = null;
		try {
			const session = await apiGet<ChatSession>(`/api/chat/history/${id}`);
			if (!session) {
				sessionError = 'Failed to load session';
				return;
			}
			activeSessionId = session.id;
			messages = session.messages;
			selectedModel = session.model;
			selectedProvider = session.provider;
			toolEvents = [];
			userScrolledUp = false;
			await scrollToBottom(true);
		} catch (err: unknown) {
			const e = err as { message?: string };
			sessionError = e.message ?? 'Failed to load session';
		} finally {
			isLoadingSession = false;
		}
	}

	async function newChat() {
		stopDiscussionPoll();
		activeSessionId = null;
		messages = [];
		toolEvents = [];
		input = '';
	}

	async function deleteSession(id: string) {
		try {
			await apiDelete(`/api/chat/history/${id}`);
			sessions = sessions.filter((s) => s.id !== id);
			if (activeSessionId === id) {
				activeSessionId = null;
				messages = [];
				toolEvents = [];
			}
		} catch (err: unknown) {
			const e = err as { message?: string };
			chatError = e.message ?? 'Failed to delete session';
		}
	}

	async function send() {
		const text = input.trim();
		if (!text || isStreaming) return;

		chatError = null;
		isSending = true;

		if (!activeSessionId) {
			try {
				await createSession();
			} catch (err: unknown) {
				const e = err as { message?: string };
				chatError = e.message ?? 'Failed to create chat session';
				isSending = false;
				return;
			}
		}

		messages.push({ role: 'user', content: text });
		input = '';
		isStreaming = true;
		toolEvents = [];

		const assistantIdx = messages.length;
		messages.push({ role: 'assistant', content: '' });
		userScrolledUp = false;
		await scrollToBottom(true);

		abortController = new AbortController();

		try {
			// Streaming response — use apiFetch (not apiPost) to access the raw Response body
			const res = await apiFetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: messages.slice(0, assistantIdx),
					model: selectedModel,
					provider: selectedProvider,
					tools: toolsEnabled
				}),
				signal: abortController.signal
			});

			isSending = false;

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: 'Request failed' }));
				chatError = err.error ?? res.statusText;
				messages[assistantIdx] = {
					role: 'assistant',
					content: `Error: ${err.error ?? res.statusText}`
				};
				isStreaming = false;
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				messages[assistantIdx] = { role: 'assistant', content: 'Error: No response stream' };
				isStreaming = false;
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';

				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data: ')) continue;
					try {
						const payload = JSON.parse(line.slice(6));

						switch (payload.type) {
							case 'content':
								if (payload.content) {
									messages[assistantIdx] = {
										role: 'assistant',
										content: messages[assistantIdx].content + payload.content
									};
									await scrollToBottom();
								}
								break;

							case 'tool_call':
								if (payload.tool_call) {
									toolEvents = [...toolEvents, { type: 'call', call: payload.tool_call }];
									await scrollToBottom();
								}
								break;

							case 'tool_confirm':
								if (payload.tool_confirm && requireConfirmation) {
									toolEvents = [...toolEvents, { type: 'confirm', confirm: payload.tool_confirm }];
									await scrollToBottom();
								}
								break;

							case 'tool_result':
								if (payload.tool_result) {
									toolEvents = [...toolEvents, { type: 'result', result: payload.tool_result }];
									await scrollToBottom();
								}
								break;

							case 'error':
								messages[assistantIdx] = {
									role: 'assistant',
									content: messages[assistantIdx].content + `\n\nError: ${payload.content}`
								};
								break;

							case 'done':
								break;
						}
					} catch {
						// skip
					}
				}
			}
		} catch (err: unknown) {
			const errObj = err instanceof Error ? err : null;
			if (errObj?.name !== 'AbortError') {
				chatError = errObj?.message ?? 'Connection failed';
				messages[assistantIdx] = {
					role: 'assistant',
					content: `Error: ${errObj?.message ?? 'Connection failed'}`
				};
			}
		} finally {
			isStreaming = false;
			isSending = false;
			abortController = null;
			inputEl?.focus();
			await saveSession();
		}
	}

	function stop() {
		abortController?.abort();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (isDiscussionSession) replyToDiscussion();
			else if (isLiveSession) injectMessage();
			else send();
		}
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		// Escape — stop streaming
		if (e.key === 'Escape' && isStreaming) {
			e.preventDefault();
			stop();
			return;
		}

		// Ctrl+N — new chat
		if (e.key === 'n' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
			e.preventDefault();
			newChat();
			return;
		}

		// Ctrl+/ — toggle tools
		if (e.key === '/' && (e.ctrlKey || e.metaKey) && !isStreaming) {
			e.preventDefault();
			toolsEnabled = !toolsEnabled;
			return;
		}
	}

	function providerName(id: string): string {
		return PROVIDERS.find((p) => p.id === id)?.name ?? id;
	}

	// ── Session grouping ──────────────────────────────────────────────
	type SessionFilter = 'all' | 'waiting' | 'active' | 'completed';
	let sessionFilter = $state<SessionFilter>('all');

	interface GroupedSessions {
		waiting: ChatSessionMeta[];
		active: ChatSessionMeta[];
		completed: ChatSessionMeta[];
	}

	let grouped = $derived.by((): GroupedSessions => {
		const waiting: ChatSessionMeta[] = [];
		const active: ChatSessionMeta[] = [];
		const completed: ChatSessionMeta[] = [];

		for (const s of sessions) {
			if (s.status === 'waiting') {
				waiting.push(s);
			} else if (s.status === 'streaming' || s.status === 'paused') {
				active.push(s);
			} else {
				completed.push(s);
			}
		}

		return { waiting, active, completed };
	});

	let filteredSessions = $derived.by((): ChatSessionMeta[] => {
		switch (sessionFilter) {
			case 'waiting': return grouped.waiting;
			case 'active': return grouped.active;
			case 'completed': return grouped.completed;
			default: return [...grouped.waiting, ...grouped.active, ...grouped.completed];
		}
	});

	let waitingCount = $derived(grouped.waiting.length);
	let activeCount = $derived(grouped.active.length);

	function formatArgs(args: Record<string, unknown>): string {
		const entries = Object.entries(args);
		if (entries.length === 0) return '';
		return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
	}

	function truncateResult(content: string): string {
		try {
			const parsed = JSON.parse(content);
			const pretty = JSON.stringify(parsed, null, 2);
			return pretty.length > 300 ? pretty.slice(0, 300) + '...' : pretty;
		} catch {
			return content.length > 300 ? content.slice(0, 300) + '...' : content;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<svelte:head>
	<title>Chat — ai-playground</title>
</svelte:head>

<div class="flex h-[calc(100vh-7rem)] gap-0">
	<!-- Session sidebar -->
	<div class="w-56 shrink-0 border-r border-border flex flex-col">
		<button
			onclick={newChat}
			class="m-2 px-3 py-2 rounded-lg text-sm font-medium bg-accent-blue/20 text-accent-blue
				hover:bg-accent-blue/30 transition-colors text-center"
		>
			+ New Chat
		</button>

		<!-- Filter tabs -->
		<div class="flex px-1 pb-1 gap-0.5 text-[10px] font-medium border-b border-border">
			<button
				onclick={() => sessionFilter = 'all'}
				class="flex-1 py-1 rounded transition-colors {sessionFilter === 'all' ? 'bg-bg-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}"
			>All</button>
			<button
				onclick={() => sessionFilter = 'waiting'}
				class="flex-1 py-1 rounded transition-colors relative {sessionFilter === 'waiting' ? 'bg-accent-yellow/20 text-accent-yellow' : 'text-text-secondary hover:text-text-primary'}"
			>
				Reply
				{#if waitingCount > 0}
					<span class="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 text-[8px] font-bold rounded-full bg-accent-yellow text-bg-primary flex items-center justify-center">{waitingCount}</span>
				{/if}
			</button>
			<button
				onclick={() => sessionFilter = 'active'}
				class="flex-1 py-1 rounded transition-colors relative {sessionFilter === 'active' ? 'bg-accent-green/20 text-accent-green' : 'text-text-secondary hover:text-text-primary'}"
			>
				Active
				{#if activeCount > 0}
					<span class="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 text-[8px] font-bold rounded-full bg-accent-green text-bg-primary flex items-center justify-center">{activeCount}</span>
				{/if}
			</button>
			<button
				onclick={() => sessionFilter = 'completed'}
				class="flex-1 py-1 rounded transition-colors {sessionFilter === 'completed' ? 'bg-bg-secondary text-text-primary' : 'text-text-secondary hover:text-text-primary'}"
			>Done</button>
		</div>

		<div class="flex-1 overflow-y-auto">
			{#each filteredSessions as session (session.id)}
				<div
					role="button"
					tabindex="0"
					onclick={() => switchSession(session.id)}
					onkeydown={(e) => { if (e.key === 'Enter') switchSession(session.id); }}
					class="w-full text-left px-3 py-2.5 text-sm border-b border-border/50 group cursor-pointer
						hover:bg-bg-secondary transition-colors
						{session.id === activeSessionId ? 'bg-bg-secondary border-l-2 border-l-accent-cyan' : ''}"
				>
					<div class="flex items-center justify-between gap-1">
						{#if session.status === 'waiting'}
							<span class="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-accent-yellow/20 text-accent-yellow uppercase animate-pulse">reply</span>
						{:else if session.status === 'streaming'}
							<span class="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-accent-green/20 text-accent-green uppercase">live</span>
						{:else if session.status === 'paused'}
							<span class="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-accent-purple/20 text-accent-purple uppercase">paused</span>
						{:else if session.source === 'claw'}
							<span class="shrink-0 text-[9px] font-bold px-1 py-0.5 rounded bg-bg-primary/50 text-text-secondary uppercase">done</span>
						{/if}
						<span class="truncate text-text-primary">{session.title}</span>
						<button
							onclick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
							class="opacity-0 group-hover:opacity-100 text-text-secondary hover:text-red-400 transition-all shrink-0 p-0.5"
							title="Delete"
						>
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
									d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
							</svg>
						</button>
					</div>
					<div class="text-xs text-text-secondary mt-0.5 truncate">
						{session.model} · {providerName(session.provider)}
					</div>
				</div>
			{/each}
			{#if filteredSessions.length === 0}
				<p class="px-3 py-4 text-xs text-text-secondary text-center">
					{#if sessionFilter === 'all'}No chat history{:else}No {sessionFilter} sessions{/if}
				</p>
			{/if}
		</div>
	</div>

	<!-- Chat area -->
	<div class="flex-1 flex flex-col min-w-0">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 pb-4 pt-1 border-b border-border gap-3">
			<h2 class="text-lg font-semibold text-text-primary shrink-0">Chat</h2>
			<div class="flex items-center gap-2">
				<select
					bind:value={selectedProvider}
					disabled={isStreaming}
					class="bg-bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary
						focus:outline-none focus:border-accent-cyan disabled:opacity-50"
				>
					{#each PROVIDERS as provider}
						<option value={provider.id}>{provider.name}</option>
					{/each}
				</select>
				<select
					bind:value={selectedModel}
					disabled={isStreaming}
					class="bg-bg-secondary border border-border rounded-lg px-3 py-1.5 text-sm text-text-primary
						focus:outline-none focus:border-accent-cyan disabled:opacity-50"
				>
					{#each availableModels as model}
						<option value={model}>{model}</option>
					{/each}
				</select>
				<button
					onclick={() => { toolsEnabled = !toolsEnabled; }}
					disabled={isStreaming}
					class="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50
						{toolsEnabled
							? 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30'
							: 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'}"
					title={toolsEnabled ? 'Tools enabled — click to disable' : 'Tools disabled — click to enable'}
				>
					Tools {toolsEnabled ? 'ON' : 'OFF'}
				</button>
			</div>
		</div>

		<!-- Server connection indicator -->
		{#if serverUnreachable}
			<div class="flex items-center gap-2 px-4 py-1.5 border-b border-accent-yellow/20 bg-accent-yellow/5">
				<span class="w-1.5 h-1.5 rounded-full bg-accent-yellow animate-pulse"></span>
				<span class="text-[11px] text-accent-yellow">Server unreachable — session list may be stale</span>
			</div>
		{/if}

		<!-- Messages -->
		<div bind:this={messagesEl} onscroll={onMessagesScroll} class="flex-1 overflow-y-auto py-4 px-4 space-y-4">
			{#if sessionError || chatError}
				<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm">
					<svg class="w-5 h-5 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
							d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<span class="text-red-300">{sessionError ?? chatError}</span>
					<button
						onclick={() => { sessionError = null; chatError = null; }}
						class="ml-auto text-red-400 hover:text-red-300 transition-colors"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>
			{/if}
			{#if isLoadingSession}
				<div class="flex items-center justify-center h-full">
					<div class="flex items-center gap-3 text-text-secondary text-sm">
						<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
						</svg>
						Loading session...
					</div>
				</div>
			{:else if messages.length === 0}
				<div class="flex items-center justify-center h-full">
					<p class="text-text-secondary text-sm">Start a conversation</p>
				</div>
			{:else}
				{#each messages as msg, i}
					{#if msg.role === 'user' || msg.role === 'assistant'}
						<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
							<div
								class="max-w-[75%] rounded-xl px-4 py-3 text-sm break-words
									{msg.role === 'user'
										? 'bg-accent-blue/20 text-text-primary whitespace-pre-wrap'
										: 'bg-bg-secondary border border-border text-text-primary'}"
								style={msg.sender ? `border-left: 3px solid ${msg.sender.color}` : ''}
							>
								{#if msg.sender}
									<span
										class="inline-block text-[10px] font-bold uppercase px-1.5 py-0.5 rounded mb-1 mr-1"
										style="background: {msg.sender.color}20; color: {msg.sender.color}"
									>{msg.sender.label}</span>
								{/if}
								{#if msg.role === 'assistant'}
									<Markdown content={msg.content} />{#if isStreaming && msg === messages[messages.length - 1]}<span class="inline-block w-2 h-4 ml-0.5 bg-accent-cyan animate-pulse rounded-sm"></span>{/if}
								{:else}
									{msg.content}
								{/if}
							</div>
						</div>
					{/if}
				{/each}

				{#if isSending}
					<div class="flex items-center gap-2 text-text-secondary text-sm py-2 px-1">
						<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
						</svg>
						Connecting...
					</div>
				{/if}

				<!-- Tool events (inline, shown during/after streaming) -->
				{#if toolEvents.length > 0}
					<div class="space-y-1.5 mx-4">
						{#each toolEvents as evt}
							{#if evt.type === 'call' && evt.call}
								<div class="flex items-start gap-2 text-xs text-text-secondary bg-bg-secondary/50 border border-border/50 rounded-lg px-3 py-2">
									<span class="text-accent-cyan shrink-0 mt-px">&#9889;</span>
									<div class="min-w-0">
										<span class="font-mono text-text-primary">{evt.call.name}</span>
										{#if Object.keys(evt.call.arguments).length > 0}
											<span class="text-text-secondary">({formatArgs(evt.call.arguments)})</span>
										{/if}
									</div>
								</div>
							{:else if evt.type === 'confirm' && evt.confirm}
								<div class="flex items-center gap-2 text-xs bg-accent-yellow/10 border border-accent-yellow/30 rounded-lg px-3 py-2">
									<span class="text-accent-yellow shrink-0">&#9888;</span>
									<span class="text-text-primary">Confirmation required:</span>
									<span class="font-mono text-accent-yellow">{evt.confirm.name}</span>
									{#if Object.keys(evt.confirm.arguments).length > 0}
										<span class="text-text-secondary">({formatArgs(evt.confirm.arguments)})</span>
									{/if}
									<span class="text-text-secondary ml-auto text-[10px]">auto-approved by server</span>
								</div>
							{:else if evt.type === 'result' && evt.result}
								<div class="flex items-start gap-2 text-xs text-text-secondary bg-bg-secondary/30 border border-border/30 rounded-lg px-3 py-2 ml-4">
									<span class="text-green-400 shrink-0 mt-px">&#8594;</span>
									<pre class="font-mono text-[11px] whitespace-pre-wrap break-all min-w-0">{truncateResult(evt.result.content)}</pre>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			{/if}
		</div>

		<!-- Connection lost banner -->
		{#if liveConnectionLost && isLiveSession}
			<div class="flex items-center gap-3 px-4 py-2 border-t border-red-500/30 bg-red-500/10">
				<span class="w-2 h-2 rounded-full bg-red-400 animate-pulse"></span>
				<span class="text-xs text-red-400 font-medium">
					Live connection lost{#if liveReconnectAttempt > 0 && liveReconnectAttempt <= 10} — reconnecting (attempt {liveReconnectAttempt}/10)...{:else if liveReconnectAttempt > 10} — reconnect failed{/if}
				</span>
				<button
					onclick={reconnectLiveNow}
					class="ml-auto px-3 py-1 rounded-lg text-xs font-medium bg-red-500/20 text-red-400
						hover:bg-red-500/30 transition-colors"
				>
					Reconnect
				</button>
			</div>
		{/if}

		<!-- Discussion session status bar -->
		{#if isDiscussionSession}
			<div class="flex items-center gap-3 px-4 py-2 border-t border-border bg-accent-yellow/5">
				<span class="w-2 h-2 rounded-full bg-accent-yellow animate-pulse"></span>
				<span class="text-xs text-accent-yellow font-medium">Claw is waiting for your response</span>
				<span class="text-xs text-text-secondary ml-auto">Reply below — Claw will act on the next heartbeat cycle</span>
			</div>
		{/if}

		<!-- Live session status bar -->
		{#if isLiveSession}
			<div class="flex items-center gap-3 px-4 py-2 border-t border-border bg-bg-secondary/50">
				<div class="flex items-center gap-2">
					{#if liveStatus === 'streaming'}
						<span class="w-2 h-2 rounded-full bg-accent-green animate-pulse"></span>
						<span class="text-xs text-accent-green font-medium">Claw is working...</span>
					{:else if liveStatus === 'paused'}
						<span class="w-2 h-2 rounded-full bg-accent-yellow"></span>
						<span class="text-xs text-accent-yellow font-medium">Paused</span>
					{:else}
						<span class="w-2 h-2 rounded-full bg-text-secondary"></span>
						<span class="text-xs text-text-secondary">Idle</span>
					{/if}
				</div>
				<div class="flex items-center gap-1.5 ml-auto">
					{#if liveStatus === 'streaming'}
						<button
							onclick={pauseLive}
							class="px-3 py-1 rounded-lg text-xs font-medium bg-accent-yellow/20 text-accent-yellow
								hover:bg-accent-yellow/30 transition-colors"
						>
							Pause
						</button>
					{:else if liveStatus === 'paused'}
						<button
							onclick={resumeLive}
							class="px-3 py-1 rounded-lg text-xs font-medium bg-accent-green/20 text-accent-green
								hover:bg-accent-green/30 transition-colors"
						>
							Resume
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Input -->
		<div class="border-t border-border pt-4 px-4">
			<form onsubmit={(e) => { e.preventDefault(); isDiscussionSession ? replyToDiscussion() : isLiveSession ? injectMessage() : send(); }} class="flex gap-3 items-end">
				<textarea
					bind:this={inputEl}
					bind:value={input}
					onkeydown={handleKeydown}
					placeholder={isDiscussionSession ? 'Reply to Claw\'s discussion...' : isLiveSession ? 'Inject a message into Claw\'s session...' : 'Type a message...'}
					rows={1}
					disabled={isStreaming && !isLiveSession}
					class="flex-1 bg-bg-secondary border border-border rounded-xl px-4 py-3 text-sm text-text-primary
						placeholder:text-text-secondary resize-none
						focus:outline-none focus:border-accent-cyan disabled:opacity-50"
				></textarea>
				{#if isStreaming && !isLiveSession}
					<button
						type="button"
						onclick={stop}
						class="px-4 py-3 rounded-xl text-sm font-medium bg-red-500/20 text-red-400
							hover:bg-red-500/30 transition-colors"
					>
						Stop
					</button>
				{:else}
					<button
						type="submit"
						disabled={!input.trim()}
						class="px-4 py-3 rounded-xl text-sm font-medium bg-accent-blue/20 text-accent-blue
							hover:bg-accent-blue/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
					>
						{isDiscussionSession ? 'Reply' : isLiveSession ? 'Inject' : 'Send'}
					</button>
				{/if}
			</form>
			<div class="flex items-center gap-3 mt-1.5 mb-1 text-[10px] text-text-secondary">
				<span><kbd class="px-1 py-0.5 rounded bg-bg-secondary border border-border/50 font-mono text-[9px]">Enter</kbd> Send</span>
				<span><kbd class="px-1 py-0.5 rounded bg-bg-secondary border border-border/50 font-mono text-[9px]">Esc</kbd> Stop</span>
				<span><kbd class="px-1 py-0.5 rounded bg-bg-secondary border border-border/50 font-mono text-[9px]">Ctrl+N</kbd> New chat</span>
				<span><kbd class="px-1 py-0.5 rounded bg-bg-secondary border border-border/50 font-mono text-[9px]">Ctrl+/</kbd> Toggle tools</span>
			</div>
		</div>
	</div>
</div>
