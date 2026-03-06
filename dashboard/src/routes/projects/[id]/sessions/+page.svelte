<script lang="ts">
	import { navigating } from '$app/stores';
	import { page } from '$app/stores';
	import { goto, invalidateAll } from '$app/navigation';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	async function sessionAction(sessionId: string, name: string, action: 'pause' | 'resume' | 'stop') {
		const labels = { pause: 'Pausing', resume: 'Resuming', stop: 'Stopping' } as const;
		const past = { pause: 'paused', resume: 'resumed', stop: 'stopped' } as const;
		notifications.push('info', `${labels[action]} "${name}"...`, `Session ${sessionId}`);
		try {
			const res = await fetch(`/api/sessions/${sessionId}/${action}`, { method: 'POST' });
			if (res.ok) {
				notifications.push('success', `Session ${past[action]}`, `"${name}" has been ${past[action]}.`);
				invalidateAll();
			} else {
				const body = await res.json().catch(() => ({ error: 'Unknown error' }));
				notifications.push('error', `Failed to ${action}`, body.error ?? `Could not ${action} session.`);
			}
		} catch {
			notifications.push('warning', 'API not available', `Session ${action} endpoint is not implemented yet.`);
		}
	}

	function viewSession(sessionId: string) {
		goto(`/sessions?id=${encodeURIComponent(sessionId)}`);
	}

	const timelineColors: Record<string, string> = {
		cyan: 'bg-accent-cyan',
		green: 'bg-accent-green',
		yellow: 'bg-accent-yellow',
		red: 'bg-accent-red',
		purple: 'bg-accent-purple',
		blue: 'bg-accent-blue',
	};

	let isLoading = $derived(!!$navigating);

	// Lazy-load sentinels for heavy sections
	let timelineSentinel: HTMLDivElement | undefined = $state();
	let resourceSentinel: HTMLDivElement | undefined = $state();
	let showTimeline = $state(false);
	let showResources = $state(false);

	$effect(() => {
		if (!timelineSentinel || !resourceSentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					if (entry.target === timelineSentinel) showTimeline = true;
					if (entry.target === resourceSentinel) showResources = true;
					observer.unobserve(entry.target);
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(timelineSentinel);
		observer.observe(resourceSentinel);
		return () => observer.disconnect();
	});

	function goToPage(p: number) {
		const url = new URL($page.url);
		url.searchParams.set('page', String(p));
		goto(url.toString(), { keepFocus: true, noScroll: true });
	}

	const statusDots: Record<string, string> = {
		active: 'bg-accent-green',
		paused: 'bg-accent-yellow',
		completed: 'bg-bg-tertiary'
	};

	const typeColors: Record<string, string> = {
		sparc: 'bg-accent-purple/20 text-accent-purple',
		debug: 'bg-accent-red/20 text-accent-red',
		swarm: 'bg-accent-blue/20 text-accent-blue',
		tdd: 'bg-accent-green/20 text-accent-green',
		agent: 'bg-accent-cyan/20 text-accent-cyan',
		chat: 'bg-accent-blue/20 text-accent-blue'
	};
</script>

<svelte:head>
	<title>Sessions – {data.project?.name ?? 'Project'} | AI Playground</title>
	<meta name="description" content="Track and manage sessions for {data.project?.name ?? 'this project'} — view active workflows, session timelines, and resource usage." />
	<meta property="og:title" content="Sessions – {data.project?.name ?? 'Project'} | AI Playground" />
	<meta property="og:description" content="Track and manage sessions for {data.project?.name ?? 'this project'} — view active workflows, session timelines, and resource usage." />
	<meta property="og:type" content="website" />
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Sessions</h1>
			<p class="text-sm text-text-secondary mt-1">Workflows and sessions scoped to ai-playground</p>
		</div>
		<button
			onclick={() => notifications.push('info', 'New Session', 'Session creation is not yet implemented.')}
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
		>
			+ New Session
		</button>
	</div>

	<!-- Loading Overlay -->
	{#if isLoading}
		<div role="status" aria-live="polite" class="flex items-center gap-3 px-4 py-3 bg-accent-blue/10 border border-accent-blue/30 rounded-lg">
			<svg class="animate-spin h-4 w-4 text-accent-blue" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			<span class="text-sm text-accent-blue">Loading sessions...</span>
		</div>
	{/if}

	<!-- Error Banner -->
	{#if data.error}
		<div role="alert" class="flex items-center justify-between gap-3 px-4 py-3 bg-accent-red/10 border border-accent-red/30 rounded-lg">
			<div class="flex items-center gap-3">
				<svg class="h-4 w-4 text-accent-red flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
				</svg>
				<span class="text-sm text-accent-red">{data.error}</span>
			</div>
			<button
				onclick={() => invalidateAll()}
				class="text-xs px-3 py-1 bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors"
			>
				Retry
			</button>
		</div>
	{/if}

	<!-- Summary -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
		<MetricCard label="Active" value={data.summary.active} accent="green" />
		<MetricCard label="Paused" value={data.summary.paused} accent="yellow" />
		<MetricCard label="Completed" value={data.summary.completed} accent="blue" />
		<MetricCard label="Total Turns" value={data.summary.totalTurns.toLocaleString()} accent="cyan" />
	</div>

	<!-- Session Table -->
	<section aria-labelledby="sessions-heading">
		<h2 id="sessions-heading" class="text-xs text-text-secondary uppercase tracking-wider mb-3">Active Sessions</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden" role="table" aria-label="Active sessions">
			<div class="sr-only" role="row">
				<span role="columnheader">Session</span>
				<span role="columnheader">Type</span>
				<span role="columnheader">Status</span>
				<span role="columnheader">Agents</span>
				<span role="columnheader">Turns</span>
				<span role="columnheader">Duration</span>
				<span role="columnheader">Actions</span>
			</div>
			{#each data.sessions as session}
				<div role="row" class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<div class="min-w-0 flex-1" role="cell">
						<div class="flex items-center gap-2">
							<span class="text-sm font-medium text-text-primary">{session.name}</span>
							<span class="text-[10px] font-mono text-text-secondary">{session.id}</span>
						</div>
					</div>
					<span role="cell" class="text-[10px] px-2 py-0.5 rounded font-mono {typeColors[session.type]}">{session.type}</span>
					<div role="cell" class="flex items-center gap-1.5">
						<span class="w-2 h-2 rounded-full {statusDots[session.status]}" aria-hidden="true"></span>
						<span class="text-xs text-text-secondary">{session.status}</span>
					</div>
					<span role="cell" class="text-xs font-mono text-text-secondary w-8 text-center"><span class="sr-only">Agents: </span>{session.agents}</span>
					<span role="cell" class="text-xs font-mono text-text-secondary w-12 text-center"><span class="sr-only">Turns: </span>{session.turns}</span>
					<span role="cell" class="text-xs font-mono text-text-secondary w-16 text-right"><span class="sr-only">Duration: </span>{session.duration}</span>
					<div role="cell" class="flex gap-1 w-20 justify-end">
						{#if session.status === 'active'}
							<button onclick={() => sessionAction(session.id, session.name, 'pause')} aria-label="Pause session {session.name}" class="text-[10px] px-2 py-1 bg-accent-yellow/20 text-accent-yellow rounded hover:bg-accent-yellow/30 transition-colors">Pause</button>
							<button onclick={() => sessionAction(session.id, session.name, 'stop')} aria-label="Stop session {session.name}" class="text-[10px] px-2 py-1 bg-accent-red/20 text-accent-red rounded hover:bg-accent-red/30 transition-colors">Stop</button>
						{:else if session.status === 'paused'}
							<button onclick={() => notifications.push('info', 'Resume Session', `Resume requested for "${session.name}" — not yet implemented.`)} aria-label="Resume session {session.name}" class="text-[10px] px-2 py-1 bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 transition-colors">Resume</button>
						{:else}
							<button onclick={() => notifications.push('info', 'View Session', `Viewing "${session.name}" — not yet implemented.`)} aria-label="View session {session.name}" class="text-[10px] px-2 py-1 bg-bg-tertiary text-text-secondary rounded hover:text-text-primary transition-colors">View</button>
						{/if}
					</div>
				</div>
			{:else}
				<div class="px-4 py-8 text-center">
					<p class="text-text-secondary text-sm">No sessions yet</p>
					<p class="text-text-secondary text-xs mt-1">Start a new session to begin working.</p>
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		{#if data.pagination.totalPages > 1}
			<nav aria-label="Session pagination" class="flex items-center justify-between px-4 py-3">
				<span class="text-xs text-text-secondary">
					Showing {(data.pagination.page - 1) * data.pagination.perPage + 1}–{Math.min(data.pagination.page * data.pagination.perPage, data.pagination.totalSessions)} of {data.pagination.totalSessions}
				</span>
				<div class="flex items-center gap-1">
					<button
						onclick={() => goToPage(data.pagination.page - 1)}
						disabled={data.pagination.page <= 1}
						aria-label="Previous page"
						class="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						Prev
					</button>
					{#each Array.from({ length: data.pagination.totalPages }, (_, i) => i + 1) as p}
						<button
							onclick={() => goToPage(p)}
							aria-label="Page {p}"
							aria-current={p === data.pagination.page ? 'page' : undefined}
							class="px-2 py-1 text-xs rounded border transition-colors {p === data.pagination.page ? 'border-accent-blue bg-accent-blue/20 text-accent-blue' : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary'}"
						>
							{p}
						</button>
					{/each}
					<button
						onclick={() => goToPage(data.pagination.page + 1)}
						disabled={data.pagination.page >= data.pagination.totalPages}
						aria-label="Next page"
						class="px-2 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
					>
						Next
					</button>
				</div>
			</nav>
		{/if}
	</section>

	<!-- Session Timeline (lazy-loaded) -->
	<section bind:this={timelineSentinel} aria-labelledby="timeline-heading">
		{#if showTimeline}
			<h2 id="timeline-heading" class="text-xs text-text-secondary uppercase tracking-wider mb-3">Session Timeline</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				{#if data.timeline.length > 0}
					<ol class="flex items-center justify-between" aria-label="Session timeline events">
						{#each data.timeline as event}
							<li class="flex flex-col items-center gap-2">
								<span class="w-3 h-3 rounded-full {timelineColors[event.color] ?? 'bg-accent-cyan'}" aria-hidden="true"></span>
								<span class="text-[10px] font-mono text-text-secondary">{event.time}</span>
								<span class="text-[10px] text-text-secondary text-center max-w-20">{event.label}</span>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-text-secondary text-sm text-center py-2">No timeline events yet</p>
				{/if}
			</div>
		{:else}
			<h2 id="timeline-heading" class="sr-only">Session Timeline</h2>
			<div class="h-24 bg-bg-secondary border border-border rounded-lg animate-pulse" aria-hidden="true"></div>
		{/if}
	</section>

	<!-- Resource Usage (lazy-loaded) -->
	<section bind:this={resourceSentinel} aria-labelledby="resources-heading">
		{#if showResources}
			<h2 id="resources-heading" class="text-xs text-text-secondary uppercase tracking-wider mb-3">Resource Usage</h2>
			<div class="grid grid-cols-3 gap-4">
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<p class="text-xs text-text-secondary" id="api-tokens-label">API Tokens Used</p>
					<p class="text-2xl font-bold font-mono text-accent-blue" aria-labelledby="api-tokens-label">{data.resources.apiTokens.value.toLocaleString()}</p>
					<p class="text-xs text-text-secondary mt-1">{data.resources.apiTokens.cost}</p>
				</div>
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<p class="text-xs text-text-secondary" id="local-tokens-label">Local Tokens</p>
					<p class="text-2xl font-bold font-mono text-accent-green" aria-labelledby="local-tokens-label">{data.resources.localTokens.value.toLocaleString()}</p>
					<p class="text-xs text-text-secondary mt-1">{data.resources.localTokens.cost}</p>
				</div>
				<div class="bg-bg-secondary border border-border rounded-lg p-4">
					<p class="text-xs text-text-secondary" id="memory-nodes-label">Memory Nodes</p>
					<p class="text-2xl font-bold font-mono text-accent-purple" aria-labelledby="memory-nodes-label">{data.resources.memoryNodes.value}</p>
					<p class="text-xs text-text-secondary mt-1">{data.resources.memoryNodes.label}</p>
				</div>
			</div>
		{:else}
			<h2 id="resources-heading" class="sr-only">Resource Usage</h2>
			<div class="grid grid-cols-3 gap-4" aria-hidden="true">
				<div class="h-24 bg-bg-secondary border border-border rounded-lg animate-pulse"></div>
				<div class="h-24 bg-bg-secondary border border-border rounded-lg animate-pulse"></div>
				<div class="h-24 bg-bg-secondary border border-border rounded-lg animate-pulse"></div>
			</div>
		{/if}
	</section>
</div>
