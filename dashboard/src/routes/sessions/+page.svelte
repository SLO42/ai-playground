<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { apiFetch } from '$lib/api-client.js';
	import type { PageData } from './$types.js';
	import type { ChatMessage } from '$lib/types/chat.js';

	let { data }: { data: PageData } = $props();

	let selectedId = $state(data.sessions[0]?.id ?? '');
	let selected = $derived(data.sessions.find((s) => s.id === selectedId) ?? data.sessions[0]);

	// Chat message preview
	let chatPreview: ChatMessage[] = $state([]);
	let chatPreviewLoading = $state(false);

	async function fetchChatPreview(chatId: string) {
		chatPreviewLoading = true;
		chatPreview = [];
		try {
			const res = await apiFetch(`/api/chat/history/${chatId}`);
			if (!res.ok) return;
			const session = await res.json();
			chatPreview = session.messages ?? [];
		} catch {
			// ignore
		} finally {
			chatPreviewLoading = false;
		}
	}

	// Event timeline state
	interface ConversationEvent {
		s: number;
		ts: string;
		t: 'prompt' | 'tool' | 'stop';
		d?: string;
		len?: number;
		n?: string;
		f?: string;
		ok?: boolean;
	}

	let events = $state<ConversationEvent[]>([]);
	let eventsCursor = $state(0);
	let eventsTotal = $state(0);
	let eventsLoading = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function eventsApiId(sessionId: string): string {
		// Running sessions use 'current', completed use their ID
		const session = data.sessions.find((s) => s.id === sessionId);
		return session?.status === 'running' ? 'current' : sessionId;
	}

	async function fetchEvents(sessionId: string, after = 0, append = false) {
		eventsLoading = true;
		try {
			const apiId = eventsApiId(sessionId);
			const res = await apiFetch(`/api/sessions/${apiId}/events?after=${after}&limit=100`);
			if (!res.ok) return;
			const body = await res.json();
			if (append) {
				events = [...events, ...body.events];
			} else {
				events = body.events;
			}
			eventsCursor = body.nextCursor;
			eventsTotal = body.total;
		} catch {
			// silently fail
		} finally {
			eventsLoading = false;
		}
	}

	function startPolling(sessionId: string) {
		stopPolling();
		const session = data.sessions.find((s) => s.id === sessionId);
		if (session?.status !== 'running') return;
		pollTimer = setInterval(() => {
			if (eventsCursor > 0) {
				fetchEvents(sessionId, eventsCursor, true);
			}
		}, 5000);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// Fetch events/chat preview when selection changes
	$effect(() => {
		if (selectedId) {
			const session = data.sessions.find((s) => s.id === selectedId);
			if (session?.type === 'chat') {
				const chatId = selectedId.replace('chat-', '');
				fetchChatPreview(chatId);
				stopPolling();
			} else {
				chatPreview = [];
				fetchEvents(selectedId);
				startPolling(selectedId);
			}
		}
		return () => stopPolling();
	});

	const statusMap: Record<string, 'online' | 'offline' | 'warning' | 'error'> = {
		running: 'online',
		completed: 'offline',
		error: 'error'
	};

	const statusLabel: Record<string, string> = {
		running: 'Running',
		completed: 'Done',
		error: 'Error'
	};

	const toolColors: Record<string, string> = {
		Bash: 'text-accent-yellow',
		Edit: 'text-accent-blue',
		Write: 'text-accent-blue',
		MultiEdit: 'text-accent-blue',
		Read: 'text-accent-cyan',
		Grep: 'text-accent-cyan',
		Glob: 'text-accent-cyan',
		Agent: 'text-accent-green',
		WebSearch: 'text-accent-purple',
		WebFetch: 'text-accent-purple'
	};

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '\u2014';
		const d = new Date(iso);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function formatEventTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function shortenPath(cwd: string): string {
		if (!cwd) return '\u2014';
		const parts = cwd.replace(/\\/g, '/').split('/');
		return parts.length > 2 ? '.../' + parts.slice(-2).join('/') : cwd;
	}

	function shortenFile(f: string): string {
		if (!f) return '';
		const parts = f.replace(/\\/g, '/').split('/');
		if (parts.length <= 2) return f;
		return '.../' + parts.slice(-2).join('/');
	}

	function shortId(id: string): string {
		return id.length > 12 ? id.slice(0, 12) + '...' : id;
	}

	function displayTitle(session: typeof selected): string {
		if (!session) return '';
		if (session.title) return session.title;
		return session.id;
	}

	function chatSessionId(session: typeof selected): string | null {
		if (!session || session.type !== 'chat') return null;
		return session.id.replace('chat-', '');
	}

	const providerNames: Record<string, string> = {
		ollama: 'Ollama',
		openclaw: 'OpenClaw',
		claude: 'Claude API',
		'claude-code': 'Claude Code'
	};

	const modelShortNames: Record<string, string> = {
		'claude-opus-4-6': 'Opus 4.6',
		'claude-sonnet-4-6': 'Sonnet 4.6',
		'claude-haiku-4-5': 'Haiku 4.5'
	};
</script>

<div class="space-y-6">
	<h1 class="type-page-title text-text-primary">Sessions</h1>

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
		<MetricCard label="Total" value={data.summary.total} subtitle="sessions recorded" accent="blue" />
		<MetricCard label="Running" value={data.summary.running} subtitle="active now" accent="green" />
		<MetricCard label="Completed" value={data.summary.completed} subtitle="finished" accent="cyan" />
		<MetricCard label="Chats" value={data.summary.chatCount ?? 0} subtitle="{data.summary.totalMessages ?? 0} messages" accent="purple" />
		<MetricCard label="Errors" value={data.summary.errored} subtitle="sessions with errors" accent="red" />
		<MetricCard label="Total Edits" value={data.summary.totalEdits} subtitle="across all sessions" accent="yellow" />
	</div>

	<!-- Main Layout: List + Detail -->
	<div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
		<!-- Left: Session List -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<div class="p-3 border-b border-border">
				<p class="text-xs text-text-secondary uppercase tracking-wider">Sessions ({data.sessions.length})</p>
			</div>
			<div class="divide-y divide-border max-h-[600px] overflow-y-auto">
				{#each data.sessions as session}
					<button
						class="w-full text-left p-3 hover:bg-bg-tertiary transition-colors {session.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-blue' : ''}"
						onclick={() => (selectedId = session.id)}
					>
						<div class="flex items-start justify-between mb-1 gap-2">
							<div class="flex items-center gap-1.5 min-w-0">
								{#if session.type === 'chat'}
									<span class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-purple/20 text-accent-purple uppercase">chat</span>
								{:else}
									<span class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue uppercase">agent</span>
								{/if}
								<span class="text-sm font-medium text-text-primary leading-tight line-clamp-2">{displayTitle(session)}</span>
							</div>
							<StatusBadge status={statusMap[session.status]} label={statusLabel[session.status]} size="sm" />
						</div>
						<div class="flex items-center gap-3 text-xs text-text-secondary">
							{#if session.type === 'chat'}
								<span>{providerNames[session.provider ?? ''] ?? session.provider}</span>
								<span>{session.model}</span>
								<span>{session.messageCount} msgs</span>
							{:else}
								<span class="font-mono">{shortId(session.id)}</span>
								<span>{session.duration}</span>
								<span>{session.metrics.edits} edits</span>
							{/if}
						</div>
					</button>
				{:else}
					<div class="p-6 text-center">
						<p class="text-text-secondary text-sm">No sessions found</p>
						<p class="text-text-secondary text-xs mt-1">Sessions appear as Claude Flow processes work.</p>
					</div>
				{/each}
			</div>
		</div>

		<!-- Right: Detail Panel -->
		{#if selected}
			<div class="space-y-4">
				<!-- Session Info -->
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-4">
						<div class="flex items-center gap-2">
							<h2 class="text-sm text-text-secondary uppercase tracking-wider">Session Detail</h2>
							{#if selected.type === 'chat'}
								<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-purple/20 text-accent-purple uppercase">chat</span>
							{:else}
								<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue uppercase">agent</span>
							{/if}
						</div>
						<StatusBadge status={statusMap[selected.status]} label={statusLabel[selected.status]} size="sm" />
					</div>

					{#if selected.title}
						<p class="text-base font-medium text-text-primary mb-3">{selected.title}</p>
					{/if}

					<div class="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3 text-sm">
						<div>
							<span class="text-text-secondary">ID</span>
							<p class="font-mono text-text-primary text-xs mt-0.5 break-all">{selected.id}</p>
						</div>
						<div>
							<span class="text-text-secondary">Provider</span>
							<p class="font-mono text-xs mt-0.5 {selected.type === 'chat' ? 'text-accent-purple' : 'text-accent-blue'}">
								{providerNames[selected.provider ?? ''] ?? selected.provider}
							</p>
						</div>
						<div>
							<span class="text-text-secondary">Model</span>
							<p class="font-mono text-text-primary text-xs mt-0.5">{modelShortNames[selected.model ?? ''] ?? selected.model}</p>
						</div>
						<div>
							<span class="text-text-secondary">Started</span>
							<p class="font-mono text-text-primary text-xs mt-0.5">{formatTimestamp(selected.startedAt)}</p>
						</div>
						<div>
							<span class="text-text-secondary">{selected.type === 'chat' ? 'Last Active' : 'Ended'}</span>
							<p class="font-mono text-text-primary text-xs mt-0.5">{formatTimestamp(selected.endedAt)}</p>
						</div>
						<div>
							<span class="text-text-secondary">Duration</span>
							<p class="font-mono text-accent-cyan text-xs mt-0.5">{selected.duration}</p>
						</div>
						{#if selected.type === 'agent' && selected.cwd}
							<div>
								<span class="text-text-secondary">Working Dir</span>
								<p class="font-mono text-text-primary text-xs mt-0.5" title={selected.cwd}>{shortenPath(selected.cwd)}</p>
							</div>
						{/if}
						{#if selected.restoredAt}
							<div>
								<span class="text-text-secondary">Restored</span>
								<p class="font-mono text-accent-yellow text-xs mt-0.5">{formatTimestamp(selected.restoredAt)}</p>
							</div>
						{/if}
					</div>

					{#if selected.type === 'chat'}
						<div class="mt-4 pt-3 border-t border-border flex items-center justify-between">
							<span class="text-sm text-text-secondary">{selected.messageCount} messages</span>
							<a
								href="/chat?session={chatSessionId(selected)}"
								class="px-3 py-1.5 rounded-lg text-sm font-medium bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30 transition-colors"
							>
								Resume Chat
							</a>
						</div>
					{/if}
				</div>

				<!-- Chat Conversation Preview -->
				{#if selected.type === 'chat'}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Conversation</h2>
					{#if chatPreviewLoading}
						<p class="text-text-secondary text-sm text-center py-4">Loading messages...</p>
					{:else if chatPreview.length === 0}
						<p class="text-text-secondary text-sm text-center py-4">No messages in this session</p>
					{:else}
						<div class="space-y-3 max-h-[400px] overflow-y-auto">
							{#each chatPreview as msg}
								<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
									<div class="max-w-[80%] rounded-lg px-3 py-2 text-sm
										{msg.role === 'user'
											? 'bg-accent-blue/10 text-text-primary'
											: 'bg-bg-tertiary border border-border text-text-primary'}">
										<span class="text-[10px] font-medium uppercase text-text-secondary block mb-0.5">
											{msg.role}
										</span>
										<p class="whitespace-pre-wrap break-words leading-relaxed line-clamp-6">{msg.content}</p>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
				{/if}

				<!-- Session Metrics (agent only) -->
				{#if selected.type === 'agent'}
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-4">Activity Metrics</h2>
					<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div class="border border-border rounded-lg p-3 bg-bg-primary text-center">
							<p class="text-2xl font-bold font-mono text-accent-blue">{selected.metrics.edits}</p>
							<p class="text-xs text-text-secondary mt-1">Edits</p>
						</div>
						<div class="border border-border rounded-lg p-3 bg-bg-primary text-center">
							<p class="text-2xl font-bold font-mono text-accent-cyan">{selected.metrics.commands}</p>
							<p class="text-xs text-text-secondary mt-1">Commands</p>
						</div>
						<div class="border border-border rounded-lg p-3 bg-bg-primary text-center">
							<p class="text-2xl font-bold font-mono text-accent-green">{selected.metrics.tasks}</p>
							<p class="text-xs text-text-secondary mt-1">Tasks</p>
						</div>
						<div class="border border-border rounded-lg p-3 bg-bg-primary text-center">
							<p class="text-2xl font-bold font-mono {selected.metrics.errors > 0 ? 'text-accent-red' : 'text-text-secondary'}">{selected.metrics.errors}</p>
							<p class="text-xs text-text-secondary mt-1">Errors</p>
						</div>
					</div>
				</div>

				<!-- Activity Breakdown Bar -->
				{#if selected.metrics.edits + selected.metrics.commands + selected.metrics.tasks > 0}
				{@const totalActivity = selected.metrics.edits + selected.metrics.commands + selected.metrics.tasks}
					<div class="bg-bg-secondary border border-border rounded-lg p-4">
						<h2 class="text-sm text-text-secondary uppercase tracking-wider mb-3">Activity Breakdown</h2>
						<div class="h-3 rounded-full overflow-hidden flex bg-bg-primary">
							{#if selected.metrics.edits > 0}
								<div class="bg-accent-blue h-full" style="width: {(selected.metrics.edits / totalActivity) * 100}%"></div>
							{/if}
							{#if selected.metrics.commands > 0}
								<div class="bg-accent-cyan h-full" style="width: {(selected.metrics.commands / totalActivity) * 100}%"></div>
							{/if}
							{#if selected.metrics.tasks > 0}
								<div class="bg-accent-green h-full" style="width: {(selected.metrics.tasks / totalActivity) * 100}%"></div>
							{/if}
						</div>
						<div class="flex items-center gap-4 mt-2 text-xs text-text-secondary">
							<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-accent-blue"></span> Edits</span>
							<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-accent-cyan"></span> Commands</span>
							<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-accent-green"></span> Tasks</span>
						</div>
					</div>
				{/if}

				<!-- Event Timeline -->
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<div class="flex items-center justify-between mb-4">
						<h2 class="text-sm text-text-secondary uppercase tracking-wider">Event Timeline</h2>
						<span class="text-xs text-text-secondary">
							{eventsTotal} events
							{#if selected.status === 'running'}
								<span class="inline-block w-1.5 h-1.5 rounded-full bg-accent-green ml-1 animate-pulse"></span>
							{/if}
						</span>
					</div>

					{#if eventsLoading && events.length === 0}
						<div class="text-center py-6">
							<p class="text-text-secondary text-sm">Loading events...</p>
						</div>
					{:else if events.length === 0}
						<div class="text-center py-6">
							<p class="text-text-secondary text-sm">No events recorded yet</p>
							<p class="text-text-secondary text-xs mt-1">Events appear as you interact with Claude.</p>
						</div>
					{:else}
						<div class="space-y-1 max-h-[500px] overflow-y-auto">
							{#each events as event}
								{#if event.t === 'prompt'}
									<!-- Prompt event: blue left border -->
									<div class="border-l-2 border-l-accent-blue pl-3 py-2">
										<div class="flex items-center gap-2 mb-1">
											<span class="text-xs font-medium text-accent-blue">Prompt</span>
											<span class="text-xs text-text-secondary font-mono">{formatEventTime(event.ts)}</span>
											{#if event.len}
												<span class="text-xs text-text-secondary">({event.len} chars)</span>
											{/if}
										</div>
										<p class="text-sm text-text-primary leading-relaxed line-clamp-3">{event.d}</p>
									</div>
								{:else if event.t === 'tool'}
									<!-- Tool event: gray card with tool badge -->
									<div class="border-l-2 border-l-border pl-3 py-1.5 flex items-center gap-2">
										<span class="text-xs text-text-secondary font-mono">{formatEventTime(event.ts)}</span>
										<span class="text-xs font-medium px-1.5 py-0.5 rounded bg-bg-tertiary {toolColors[event.n ?? ''] ?? 'text-text-secondary'}">{event.n ?? 'tool'}</span>
										{#if event.f}
											<span class="text-xs text-text-secondary font-mono truncate max-w-[300px]" title={event.f}>{shortenFile(event.f)}</span>
										{/if}
										{#if event.ok === true}
											<span class="w-1.5 h-1.5 rounded-full bg-accent-green flex-shrink-0" title="Success"></span>
										{:else if event.ok === false}
											<span class="w-1.5 h-1.5 rounded-full bg-accent-red flex-shrink-0" title="Failed"></span>
										{/if}
									</div>
								{:else if event.t === 'stop'}
									<!-- Stop boundary: subtle divider -->
									<div class="flex items-center gap-2 py-2">
										<div class="flex-1 border-t border-border"></div>
										<span class="text-xs text-text-secondary">stop</span>
										<span class="text-xs text-text-secondary font-mono">{formatEventTime(event.ts)}</span>
										<div class="flex-1 border-t border-border"></div>
									</div>
								{/if}
							{/each}
						</div>

						{#if eventsTotal > events.length}
							<button
								class="w-full mt-3 py-2 text-xs text-accent-blue hover:text-accent-cyan transition-colors border border-border rounded"
								onclick={() => fetchEvents(selectedId, eventsCursor, true)}
								disabled={eventsLoading}
							>
								{eventsLoading ? 'Loading...' : `Load more (${eventsTotal - events.length} remaining)`}
							</button>
						{/if}
					{/if}
				</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
