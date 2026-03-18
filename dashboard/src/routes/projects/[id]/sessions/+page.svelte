<script lang="ts">
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let selectedId = $state(data.sessions[0]?.id ?? '');
	let selected = $derived(data.sessions.find((s) => s.id === selectedId) ?? data.sessions[0]);

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

	function formatTimestamp(iso: string | null): string {
		if (!iso) return '\u2014';
		const d = new Date(iso);
		return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function shortId(id: string): string {
		return id.length > 12 ? id.slice(0, 12) + '...' : id;
	}

	function displayTitle(session: typeof selected): string {
		if (!session) return '';
		if (session.title) return session.title;
		return session.id;
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="type-page-title text-text-primary">Project Sessions</h1>
		<p class="text-xs text-text-secondary mt-0.5">Agent and chat sessions scoped to this project</p>
	</div>

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
		<MetricCard label="Total" value={data.summary.total} subtitle="sessions" accent="blue" />
		<MetricCard label="Running" value={data.summary.running} subtitle="active now" accent="green" />
		<MetricCard label="Completed" value={data.summary.completed} subtitle="finished" accent="cyan" />
		<MetricCard label="Chats" value={data.summary.chatCount} subtitle="chat sessions" accent="purple" />
		<MetricCard label="Errors" value={data.summary.errored} subtitle="with errors" accent="red" />
		<MetricCard label="Total Edits" value={data.summary.totalEdits} subtitle="across sessions" accent="yellow" />
	</div>

	<!-- Empty State -->
	{#if data.sessions.length === 0}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No sessions for this project</h2>
			<p class="text-text-secondary text-xs">Sessions appear as agents and chats interact with this project.</p>
		</div>
	{:else}
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
									<span>{session.messageCount} msgs</span>
								{:else}
									<span class="font-mono">{shortId(session.id)}</span>
									<span>{session.duration}</span>
									<span>{session.metrics.edits} edits</span>
								{/if}
							</div>
						</button>
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
						</div>

						{#if selected.type === 'chat'}
							<div class="mt-4 pt-3 border-t border-border flex items-center justify-between">
								<span class="text-sm text-text-secondary">{selected.messageCount} messages</span>
								<a
									href="/chat?session={selected.id.replace('chat-', '')}"
									class="px-3 py-1.5 rounded-lg text-sm font-medium bg-accent-purple/20 text-accent-purple hover:bg-accent-purple/30 transition-colors"
								>
									Resume Chat
								</a>
							</div>
						{/if}
					</div>

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
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
