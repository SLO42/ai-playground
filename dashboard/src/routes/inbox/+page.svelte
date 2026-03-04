<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let selectedId = $state(data.conversations[0]?.id ?? '');
	let selected = $derived(data.conversations.find((c) => c.id === selectedId) ?? data.conversations[0]);
	let replyText = $state('');

	const statusColors: Record<string, string> = {
		pending: 'bg-accent-yellow/10 text-accent-yellow border-accent-yellow/30',
		resolved: 'bg-accent-green/10 text-accent-green border-accent-green/30',
		escalated: 'bg-accent-red/10 text-accent-red border-accent-red/30'
	};

	const statusLabels: Record<string, string> = {
		pending: 'Pending',
		resolved: 'Resolved',
		escalated: 'Escalated'
	};

	const agentTypeColors: Record<string, string> = {
		coder: 'bg-accent-blue',
		reviewer: 'bg-accent-purple',
		tester: 'bg-accent-green',
		planner: 'bg-accent-cyan',
		security: 'bg-accent-red'
	};
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-2xl font-bold text-text-primary">Agent Inbox</h1>
		<p class="text-sm text-text-secondary mt-1">Agents waiting for your input</p>
	</div>

	<!-- Stat Cards -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
		<MetricCard label="Awaiting Input" value={data.stats.awaitingInput} accent="yellow" />
		<MetricCard label="In Progress" value={data.stats.inProgress} accent="blue" />
		<MetricCard label="Avg Wait Time" value={data.stats.avgWaitTime} accent="cyan" />
		<MetricCard label="Resolved Today" value={data.stats.resolvedToday} accent="green" />
	</div>

	<!-- Main: Conversation List + Detail -->
	<div class="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
		<!-- Left: Conversation List -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<div class="divide-y divide-border max-h-[550px] overflow-y-auto">
				{#each data.conversations as conv}
					<button
						class="w-full text-left p-3 hover:bg-bg-tertiary transition-colors {conv.id === selectedId ? 'bg-bg-tertiary border-l-2 border-l-accent-blue' : ''}"
						onclick={() => (selectedId = conv.id)}
					>
						<div class="flex items-center gap-2 mb-1">
							<span class="w-2 h-2 rounded-full shrink-0 {agentTypeColors[conv.agentType]}"></span>
							<span class="text-sm font-medium text-text-primary truncate flex-1">{conv.title}</span>
							<span class="text-xs border rounded px-1.5 py-0.5 {statusColors[conv.status]}">{statusLabels[conv.status]}</span>
						</div>
						<div class="flex items-center justify-between text-xs text-text-secondary">
							<span>{conv.project}</span>
							<span>{conv.lastActivity}</span>
						</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Right: Conversation Detail -->
		{#if selected}
			<div class="bg-bg-secondary border border-border rounded-lg flex flex-col">
				<!-- Header -->
				<div class="p-4 border-b border-border flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="w-2.5 h-2.5 rounded-full {agentTypeColors[selected.agentType]}"></span>
						<span class="text-sm font-medium text-text-primary">{selected.agent}</span>
						<span class="text-xs border rounded px-1.5 py-0.5 {statusColors[selected.status]}">{statusLabels[selected.status]}</span>
					</div>
					<span class="text-xs text-text-secondary">{selected.project} &middot; {selected.lastActivity}</span>
				</div>

				<!-- Messages -->
				<div class="flex-1 p-4 space-y-3 overflow-y-auto max-h-[400px]">
					{#each selected.messages as msg}
						<div class="flex {msg.isAgent ? 'justify-start' : 'justify-end'}">
							<div class="max-w-[80%] rounded-lg px-3 py-2 {msg.isAgent ? 'bg-bg-primary border border-border' : 'bg-accent-blue/20 border border-accent-blue/30'}">
								<div class="flex items-center gap-2 mb-1">
									<span class="text-xs font-medium {msg.isAgent ? 'text-accent-cyan' : 'text-accent-blue'}">{msg.sender}</span>
									<span class="text-[10px] text-text-secondary">{msg.timestamp}</span>
								</div>
								<p class="text-sm text-text-primary whitespace-pre-line">{msg.content}</p>
							</div>
						</div>
					{/each}
				</div>

				<!-- Reply Composer -->
				<div class="p-4 border-t border-border">
					<div class="flex items-center gap-2">
						<input
							type="text"
							bind:value={replyText}
							placeholder="Type a response..."
							class="flex-1 bg-bg-primary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary"
						/>
						<button class="px-3 py-2 text-xs font-medium text-white bg-accent-green rounded-lg hover:bg-accent-green/80 transition-colors">Approve</button>
						<button class="px-3 py-2 text-xs font-medium text-white bg-accent-red rounded-lg hover:bg-accent-red/80 transition-colors">Reject</button>
						<button class="px-3 py-2 text-xs font-medium text-text-secondary border border-border rounded-lg hover:bg-bg-tertiary transition-colors">Skip</button>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>
