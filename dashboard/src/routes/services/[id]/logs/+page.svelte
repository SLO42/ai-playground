<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { apiGet } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let lines: string[] = $state([]);
	let autoScroll = $state(true);
	let connected = $state(false);
	let loading = $state(true);
	let streamError: string | null = $state(null);
	let logContainer: HTMLElement | null = $state(null);
	let eventSource: EventSource | null = null;

	function scrollToBottom() {
		if (autoScroll && logContainer) {
			logContainer.scrollTop = logContainer.scrollHeight;
		}
	}

	async function loadInitial() {
		loading = true;
		streamError = null;
		const json = await apiGet<{ lines: string[] }>(`/api/services/${data.serviceId}/logs?lines=100`, { silent: true });
		if (json) {
			lines = json.lines ?? [];
			requestAnimationFrame(scrollToBottom);
		} else {
			streamError = 'Failed to load initial logs';
		}
		loading = false;
	}

	function startStream() {
		streamError = null;
		eventSource = new EventSource(`/api/services/${data.serviceId}/logs/stream`);
		eventSource.onopen = () => {
			connected = true;
			streamError = null;
		};
		eventSource.onmessage = (e) => {
			try {
				const line = JSON.parse(e.data);
				lines = [...lines, line];
				// Cap at 1000 lines to prevent memory bloat
				if (lines.length > 1000) lines = lines.slice(-800);
				requestAnimationFrame(scrollToBottom);
			} catch {
				// ignore parse errors (keepalives etc)
			}
		};
		eventSource.onerror = () => {
			connected = false;
			streamError = 'Log stream disconnected — retrying...';
		};
	}

	function handleScroll() {
		if (!logContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = logContainer;
		// If user scrolled up more than 50px from bottom, pause auto-scroll
		autoScroll = scrollHeight - scrollTop - clientHeight < 50;
	}

	onMount(() => {
		loadInitial();
		startStream();
	});

	onDestroy(() => {
		eventSource?.close();
	});
</script>

<div class="space-y-4">
	<!-- Controls -->
	<div class="flex items-center justify-end gap-3">
		<span class="flex items-center gap-1.5 text-xs">
			<span class="w-2 h-2 rounded-full {connected ? 'bg-accent-green' : 'bg-accent-red'}"></span>
			{connected ? 'Live' : 'Disconnected'}
		</span>
		<button
			onclick={() => { autoScroll = !autoScroll; if (autoScroll) scrollToBottom(); }}
			class="px-2 py-1 text-xs border rounded transition-colors
				{autoScroll
					? 'text-accent-green border-accent-green/30 bg-accent-green/10'
					: 'text-text-secondary border-border hover:bg-bg-secondary'}"
		>
			{autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
		</button>
	</div>

	<!-- Error banner -->
	{#if streamError}
		<div class="flex items-center gap-2 px-3 py-2 text-xs rounded border border-accent-red/30 bg-accent-red/10 text-accent-red">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			{streamError}
		</div>
	{/if}

	<!-- Log viewer -->
	<div
		bind:this={logContainer}
		onscroll={handleScroll}
		class="bg-[#0d1117] border border-border rounded-lg p-4 h-[calc(100vh-12rem)] overflow-y-auto font-mono text-xs leading-relaxed"
	>
		{#if loading}
			<div class="flex items-center gap-2 text-gray-500">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
				Loading logs...
			</div>
		{:else if lines.length === 0}
			<p class="text-gray-500">Waiting for log output...</p>
		{:else}
			{#each lines as line, i}
				<div class="hover:bg-white/5 px-1 {line.includes('error') || line.includes('ERROR') ? 'text-red-400' : line.includes('warn') || line.includes('WARN') ? 'text-yellow-400' : 'text-gray-300'}">
					<span class="text-gray-600 select-none mr-3">{String(i + 1).padStart(4)}</span>{line}
				</div>
			{/each}
		{/if}
	</div>
</div>
