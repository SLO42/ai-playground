<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let bootstrapping = $state(false);
	let syncing = $state(false);
	let reviewing = $state(false);
	let openingDiscussion = $state(false);
	let memoryFilter = $state<string>('all');
	let searchQuery = $state('');
	let showArchived = $state(false);
	let filteredMemory = $derived(
		data.recentMemory.filter(e => {
			if (memoryFilter !== 'all' && e.type !== memoryFilter) return false;
			if (!showArchived && e.archived) return false;
			if (searchQuery && !e.content.toLowerCase().includes(searchQuery.toLowerCase())) return false;
			return true;
		})
	);

	const statusColors: Record<string, string> = {
		planned: 'text-text-secondary',
		active: 'text-accent-blue',
		completed: 'text-accent-green',
		blocked: 'text-accent-red'
	};

	const statusIcons: Record<string, string> = {
		planned: '⬜',
		active: '🔵',
		completed: '✅',
		blocked: '🔴'
	};

	const typeColors: Record<string, string> = {
		observation: 'bg-accent-blue/10 text-accent-blue',
		learning: 'bg-accent-green/10 text-accent-green',
		risk: 'bg-accent-red/10 text-accent-red',
		pattern: 'bg-accent-purple/10 text-accent-purple',
		'decision-context': 'bg-accent-yellow/10 text-accent-yellow'
	};

	async function bootstrap() {
		bootstrapping = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'bootstrap' })
			});
			if (res.ok) {
				// Reload page to show new data
				window.location.reload();
			}
		} finally {
			bootstrapping = false;
		}
	}

	async function syncGitHub() {
		syncing = true;
		try {
			await fetch(`/api/projects/${data.projectId}/pm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'sync-github' })
			});
		} finally {
			syncing = false;
		}
	}

	async function openDiscussion() {
		openingDiscussion = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'start-discussion' })
			});
			if (res.ok) {
				const { sessionId } = await res.json();
				window.location.href = `/chat?session=${sessionId}`;
			}
		} finally {
			openingDiscussion = false;
		}
	}

	async function runReview() {
		reviewing = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'review' })
			});
			if (res.ok) {
				window.location.reload();
			}
		} finally {
			reviewing = false;
		}
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return d.toLocaleDateString();
	}

	function confidenceBar(conf: number): string {
		if (conf >= 0.8) return 'bg-accent-green';
		if (conf >= 0.5) return 'bg-accent-yellow';
		return 'bg-accent-red';
	}
</script>

{#if !data.hasPm}
	<!-- No PM bootstrapped yet -->
	<div class="max-w-lg mx-auto mt-16 text-center">
		<div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-green/10 flex items-center justify-center">
			<span class="text-3xl">📋</span>
		</div>
		<h2 class="text-xl font-semibold text-text-primary mb-2">Project Manager</h2>
		<p class="text-sm text-text-secondary mb-6">
			Bootstrap a PM agent for this project. It will scan the codebase, generate an initial roadmap,
			and create a discussion where you can refine the plan together — even while the project is idle.
		</p>
		<div class="flex flex-col gap-3 items-center">
			<button
				onclick={async () => { await bootstrap(); }}
				disabled={bootstrapping}
				class="px-6 py-2.5 rounded-lg bg-accent-green text-black font-medium text-sm hover:bg-accent-green/90 transition-colors disabled:opacity-50"
			>
				{bootstrapping ? 'Scanning project...' : 'Bootstrap & Open Roadmap'}
			</button>
			<p class="text-xs text-text-secondary">
				Creates the plan, then you build out the roadmap through a conversation.
			</p>
		</div>
	</div>
{:else}
	<div class="space-y-6">
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Project Manager</h2>
				{#if data.plan}
					<p class="text-sm text-text-secondary mt-1">
						Last updated {formatDate(data.plan.lastUpdated)} by {data.plan.updatedBy}
					</p>
				{/if}
			</div>
			<div class="flex gap-2">
				<button
					onclick={openDiscussion}
					disabled={openingDiscussion}
					class="px-3 py-1.5 rounded-md bg-accent-green/10 text-accent-green text-xs font-medium hover:bg-accent-green/20 transition-colors disabled:opacity-50"
				>
					{openingDiscussion ? 'Opening...' : 'Open Discussion'}
				</button>
				<button
					onclick={runReview}
					disabled={reviewing}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50"
				>
					{reviewing ? 'Reviewing...' : 'Run Review'}
				</button>
				<button
					onclick={syncGitHub}
					disabled={syncing}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50"
				>
					{syncing ? 'Syncing...' : 'Sync to GitHub'}
				</button>
				<button
					onclick={bootstrap}
					disabled={bootstrapping}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50"
				>
					Re-scan
				</button>
			</div>
		</div>

		{#if data.plan}
			<!-- Vision -->
			<div class="bg-bg-secondary rounded-lg border border-border p-4">
				<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">Vision</h3>
				<p class="text-sm text-text-primary">{data.plan.vision}</p>
			</div>

			<!-- Roadmap -->
			<div class="bg-bg-secondary rounded-lg border border-border p-4">
				<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
					Roadmap ({data.plan.roadmap.length} milestones)
				</h3>
				<div class="space-y-3">
					{#each data.plan.roadmap as milestone}
						<div class="bg-bg-primary rounded-md border border-border p-3">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-2">
									<span class="text-sm">{statusIcons[milestone.status]}</span>
									<h4 class="text-sm font-medium {statusColors[milestone.status]}">{milestone.name}</h4>
								</div>
								{#if milestone.targetDate}
									<span class="text-[10px] text-text-secondary font-mono">{milestone.targetDate}</span>
								{/if}
							</div>
							<div class="mt-2 pl-6">
								{#each milestone.goals as goal}
									<p class="text-xs text-text-secondary">• {goal}</p>
								{/each}
								{#if milestone.tasks.length > 0}
									<p class="text-[10px] text-text-secondary mt-1 font-mono">
										{milestone.tasks.length} linked task(s)
									</p>
								{/if}
							</div>
							{#if milestone.acceptanceCriteria.length > 0 && milestone.acceptanceCriteria[0] !== 'To be defined in PM discussion'}
								<details class="mt-2 pl-6">
									<summary class="text-[10px] text-text-secondary cursor-pointer hover:text-text-primary">
										Acceptance criteria ({milestone.acceptanceCriteria.length})
									</summary>
									<div class="mt-1 space-y-0.5">
										{#each milestone.acceptanceCriteria as criterion}
											<p class="text-xs text-text-secondary">☐ {criterion}</p>
										{/each}
									</div>
								</details>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Definition of Done -->
			<div class="bg-bg-secondary rounded-lg border border-border p-4">
				<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-2">Definition of Done</h3>
				<div class="space-y-1">
					{#each data.plan.definitionOfDone as criterion}
						<p class="text-sm text-text-primary">☐ {criterion}</p>
					{/each}
				</div>
			</div>

			<!-- Decisions -->
			{#if data.plan.decisions.length > 0}
				<div class="bg-bg-secondary rounded-lg border border-border p-4">
					<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
						Architectural Decisions ({data.plan.decisions.length})
					</h3>
					<div class="space-y-3">
						{#each data.plan.decisions as decision}
							<div class="bg-bg-primary rounded-md border border-border p-3">
								<div class="flex items-center justify-between">
									<h4 class="text-sm font-medium text-text-primary">{decision.title}</h4>
									<span class="text-[10px] text-text-secondary font-mono">{decision.date}</span>
								</div>
								<p class="text-xs text-text-secondary mt-1">{decision.context}</p>
								<p class="text-xs text-accent-blue mt-1">→ {decision.decision}</p>
								{#if decision.consequences.length > 0}
									<div class="mt-1">
										{#each decision.consequences as c}
											<p class="text-[10px] text-text-secondary">⚠ {c}</p>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}

		<!-- PM Memory -->
		<div class="bg-bg-secondary rounded-lg border border-border p-4">
			<div class="flex items-center justify-between mb-3">
				<div>
					<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider">PM Memory</h3>
					{#if data.stats}
						<p class="text-[10px] text-text-secondary mt-0.5">
							{data.stats.totalEntries} entries &middot; {data.stats.totalReviews} reviews
							{#if data.stats.lastReviewedAt}
								&middot; last reviewed {formatDate(data.stats.lastReviewedAt)}
							{/if}
						</p>
					{/if}
				</div>
				<label class="flex items-center gap-1.5 text-[10px] text-text-secondary">
					<input type="checkbox" bind:checked={showArchived} class="rounded" />
					Show archived
				</label>
			</div>

			<!-- Stats Bar -->
			{#if data.stats}
				<div class="grid grid-cols-5 gap-2 mb-3">
					{#each Object.entries(data.stats.byType) as [type, count]}
						<button
							onclick={() => memoryFilter = memoryFilter === type ? 'all' : type}
							class="text-center px-2 py-1.5 rounded-md text-[10px] transition-colors
								{memoryFilter === type ? 'bg-bg-primary border border-accent-blue' : 'bg-bg-tertiary border border-transparent hover:border-border'}"
						>
							<span class="block text-sm font-mono text-text-primary">{count}</span>
							<span class="text-text-secondary">{type}</span>
						</button>
					{/each}
				</div>
			{/if}

			<!-- Search -->
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="Search memory..."
				class="w-full px-3 py-1.5 mb-3 rounded-md bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue"
			/>

			<!-- Entries -->
			<div class="space-y-2 max-h-96 overflow-y-auto">
				{#each filteredMemory as entry}
					<div class="bg-bg-primary rounded-md border border-border p-2.5 {entry.archived ? 'opacity-50' : ''}">
						<div class="flex items-center gap-2 mb-1">
							<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {typeColors[entry.type]}">
								{entry.type}
							</span>
							<span class="text-[10px] text-text-secondary">{entry.source}</span>
							<span class="text-[10px] text-text-secondary ml-auto">{formatDate(entry.createdAt)}</span>
						</div>
						<p class="text-xs text-text-primary leading-relaxed">{entry.content}</p>
						<div class="flex items-center gap-2 mt-1.5">
							<div class="flex-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
								<div
									class="h-full rounded-full {confidenceBar(entry.confidence)}"
									style="width: {entry.confidence * 100}%"
								></div>
							</div>
							<span class="text-[10px] text-text-secondary font-mono">{(entry.confidence * 100).toFixed(0)}%</span>
						</div>
					</div>
				{:else}
					<p class="text-sm text-text-secondary text-center py-4">No memory entries match filters</p>
				{/each}
			</div>
		</div>

		<!-- Risks Summary -->
		{#if data.risks.length > 0}
			<div class="bg-bg-secondary rounded-lg border border-accent-red/20 p-4">
				<h3 class="text-xs font-medium text-accent-red uppercase tracking-wider mb-2">
					Active Risks ({data.risks.length})
				</h3>
				<div class="space-y-1.5">
					{#each data.risks as risk}
						<div class="flex items-start gap-2">
							<span class="text-accent-red text-xs mt-0.5">⚠</span>
							<div class="flex-1 min-w-0">
								<p class="text-xs text-text-primary">{risk.content}</p>
								<p class="text-[10px] text-text-secondary">{risk.source} &middot; confidence: {(risk.confidence * 100).toFixed(0)}%</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
