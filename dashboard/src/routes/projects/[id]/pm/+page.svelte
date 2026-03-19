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
	let viewScale = $state<'macro' | 'micro' | 'memory'>('macro');

	// Sprint creation
	let showSprintForm = $state(false);
	let sprintName = $state('');
	let sprintGoal = $state('');
	let sprintMilestone = $state('');
	let sprintActivate = $state(true);
	let creatingSprint = $state(false);

	let filteredMemory = $derived(
		data.recentMemory.filter(e => {
			if (memoryFilter !== 'all' && e.type !== memoryFilter) return false;
			if (!showArchived && e.archived) return false;
			if (searchQuery && !e.content.toLowerCase().includes(searchQuery.toLowerCase())) return false;
			return true;
		})
	);

	let activeSprint = $derived(
		data.plan?.sprints.find(s => s.id === data.plan?.activeSprint) ?? null
	);

	let macroProgress = $derived(() => {
		if (!data.plan) return { completed: 0, total: 0, pct: 0 };
		const total = data.plan.roadmap.length;
		const completed = data.plan.roadmap.filter(m => m.status === 'completed').length;
		return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
	});

	let sprintProgress = $derived(() => {
		if (!data.plan) return { completed: 0, total: 0, pct: 0 };
		const total = data.plan.sprints.length;
		const completed = data.plan.sprints.filter(s => s.status === 'completed').length;
		return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
	});

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
			if (res.ok) window.location.reload();
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
			if (res.ok) window.location.reload();
		} finally {
			reviewing = false;
		}
	}

	async function createSprint() {
		if (!sprintName || !sprintGoal || !sprintMilestone) return;
		creatingSprint = true;
		try {
			const res = await fetch(`/api/projects/${data.projectId}/pm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'create-sprint',
					name: sprintName,
					goal: sprintGoal,
					milestoneId: sprintMilestone,
					activate: sprintActivate
				})
			});
			if (res.ok) window.location.reload();
		} finally {
			creatingSprint = false;
		}
	}

	async function completeSprint(sprintId: string) {
		const retro = prompt('Sprint retrospective (optional):');
		const res = await fetch(`/api/projects/${data.projectId}/pm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'complete-sprint', sprintId, retrospective: retro })
		});
		if (res.ok) window.location.reload();
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

			<!-- Progress Overview -->
			<div class="grid grid-cols-3 gap-4">
				<div class="bg-bg-secondary rounded-lg border border-border p-4 text-center">
					<p class="text-2xl font-bold text-text-primary font-mono">{macroProgress().pct}%</p>
					<p class="text-[10px] text-text-secondary uppercase tracking-wider mt-1">Macro Progress</p>
					<p class="text-xs text-text-secondary">{macroProgress().completed}/{macroProgress().total} phases</p>
				</div>
				<div class="bg-bg-secondary rounded-lg border border-border p-4 text-center">
					<p class="text-2xl font-bold text-text-primary font-mono">{sprintProgress().completed}</p>
					<p class="text-[10px] text-text-secondary uppercase tracking-wider mt-1">Sprints Done</p>
					<p class="text-xs text-text-secondary">{sprintProgress().total} total</p>
				</div>
				<div class="bg-bg-secondary rounded-lg border {activeSprint ? 'border-accent-blue/30' : 'border-border'} p-4 text-center">
					{#if activeSprint}
						<p class="text-sm font-semibold text-accent-blue">{activeSprint.name}</p>
						<p class="text-[10px] text-text-secondary uppercase tracking-wider mt-1">Active Sprint</p>
						<p class="text-xs text-text-secondary">{activeSprint.goal}</p>
					{:else}
						<p class="text-sm text-text-secondary">No active sprint</p>
						<p class="text-[10px] text-text-secondary uppercase tracking-wider mt-1">Sprint Status</p>
						<button
							onclick={() => { showSprintForm = true; viewScale = 'micro'; }}
							class="text-xs text-accent-blue hover:underline mt-1"
						>
							Create one
						</button>
					{/if}
				</div>
			</div>

			<!-- Scale Tabs -->
			<div class="flex gap-1 bg-bg-secondary rounded-lg border border-border p-1">
				{#each [['macro', 'Macro Roadmap'], ['micro', 'Sprints'], ['memory', 'PM Memory']] as [key, label]}
					<button
						onclick={() => viewScale = key as typeof viewScale}
						class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-colors
							{viewScale === key
								? 'bg-bg-primary text-text-primary shadow-sm'
								: 'text-text-secondary hover:text-text-primary'}"
					>
						{label}
						{#if key === 'macro'}
							<span class="ml-1 text-text-secondary">({data.plan.roadmap.length})</span>
						{:else if key === 'micro'}
							<span class="ml-1 text-text-secondary">({data.plan.sprints.length})</span>
						{:else if key === 'memory' && data.stats}
							<span class="ml-1 text-text-secondary">({data.stats.totalEntries})</span>
						{/if}
					</button>
				{/each}
			</div>

			<!-- ═══ MACRO VIEW ═══ -->
			{#if viewScale === 'macro'}
				<div class="space-y-4">
					<!-- Roadmap -->
					<div class="bg-bg-secondary rounded-lg border border-border p-4">
						<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
							Strategic Phases ({data.plan.roadmap.length})
						</h3>
						<div class="space-y-3">
							{#each data.plan.roadmap as milestone}
								{@const childSprints = data.plan.sprints.filter(s => s.milestoneId === milestone.id)}
								<div class="bg-bg-primary rounded-md border border-border p-3">
									<div class="flex items-start justify-between">
										<div class="flex items-center gap-2">
											<span class="text-sm">{statusIcons[milestone.status]}</span>
											<h4 class="text-sm font-medium {statusColors[milestone.status]}">{milestone.name}</h4>
										</div>
										<div class="flex items-center gap-2">
											{#if childSprints.length > 0}
												<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary font-mono">
													{childSprints.filter(s => s.status === 'completed').length}/{childSprints.length} sprints
												</span>
											{/if}
											{#if milestone.targetDate}
												<span class="text-[10px] text-text-secondary font-mono">{milestone.targetDate}</span>
											{/if}
										</div>
									</div>
									<div class="mt-2 pl-6">
										{#each milestone.goals as goal}
											<p class="text-xs text-text-secondary">• {goal}</p>
										{/each}
									</div>
									<!-- Child sprints preview -->
									{#if childSprints.length > 0}
										<div class="mt-2 pl-6 border-l-2 border-border ml-2">
											{#each childSprints as sprint}
												<div class="flex items-center gap-2 py-0.5 pl-2">
													<span class="text-[10px]">{statusIcons[sprint.status]}</span>
													<span class="text-[10px] text-text-secondary">{sprint.name}</span>
													<span class="text-[10px] text-text-secondary/50">— {sprint.goal}</span>
												</div>
											{/each}
										</div>
									{/if}
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
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>

			<!-- ═══ MICRO (SPRINTS) VIEW ═══ -->
			{:else if viewScale === 'micro'}
				<div class="space-y-4">
					<!-- Active Sprint -->
					{#if activeSprint}
						<div class="bg-bg-secondary rounded-lg border border-accent-blue/30 p-4">
							<div class="flex items-center justify-between mb-2">
								<div class="flex items-center gap-2">
									<span class="w-2 h-2 rounded-full bg-accent-blue animate-pulse"></span>
									<h3 class="text-sm font-semibold text-accent-blue">{activeSprint.name}</h3>
								</div>
								<div class="flex items-center gap-2">
									{#if activeSprint.endDate}
										<span class="text-[10px] text-text-secondary font-mono">ends {formatDate(activeSprint.endDate)}</span>
									{/if}
									<button
										onclick={() => { if (activeSprint) completeSprint(activeSprint.id); }}
										class="px-2 py-1 rounded text-[10px] bg-accent-green/10 text-accent-green hover:bg-accent-green/20"
									>
										Complete Sprint
									</button>
								</div>
							</div>
							<p class="text-xs text-text-secondary mb-2">{activeSprint.goal}</p>
							{#each data.plan.roadmap.filter(m => m.id === activeSprint?.milestoneId).slice(0, 1) as parentMs}
								<p class="text-[10px] text-text-secondary">
									Part of: <span class="text-accent-blue">{parentMs.name}</span>
								</p>
							{/each}
							{#if activeSprint.tasks.length > 0}
								<p class="text-[10px] text-text-secondary mt-1 font-mono">{activeSprint.tasks.length} task(s) linked</p>
							{:else}
								<p class="text-[10px] text-text-secondary mt-1">No tasks linked yet — link tasks from the Tasks page</p>
							{/if}
						</div>
					{/if}

					<!-- Create Sprint Form -->
					{#if showSprintForm}
						<div class="bg-bg-secondary rounded-lg border border-accent-blue/20 p-4">
							<h3 class="text-xs font-medium text-accent-blue uppercase tracking-wider mb-3">New Sprint</h3>
							<div class="space-y-3">
								<div>
									<label class="block text-[10px] text-text-secondary mb-1">Name</label>
									<input bind:value={sprintName} placeholder="Sprint 1: Setup" class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue" />
								</div>
								<div>
									<label class="block text-[10px] text-text-secondary mb-1">Goal</label>
									<input bind:value={sprintGoal} placeholder="What this sprint achieves" class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue" />
								</div>
								<div>
									<label class="block text-[10px] text-text-secondary mb-1">Parent Milestone</label>
									<select bind:value={sprintMilestone} class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue">
										<option value="">Select milestone...</option>
										{#each data.plan.roadmap as ms}
											<option value={ms.id}>{ms.name}</option>
										{/each}
									</select>
								</div>
								<label class="flex items-center gap-2 text-xs text-text-secondary">
									<input type="checkbox" bind:checked={sprintActivate} class="rounded" />
									Set as active sprint
								</label>
								<div class="flex gap-2">
									<button
										onclick={createSprint}
										disabled={creatingSprint || !sprintName || !sprintGoal || !sprintMilestone}
										class="px-4 py-1.5 rounded-md bg-accent-blue text-black text-xs font-medium hover:bg-accent-blue/90 disabled:opacity-50"
									>
										{creatingSprint ? 'Creating...' : 'Create Sprint'}
									</button>
									<button
										onclick={() => showSprintForm = false}
										class="px-4 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary"
									>
										Cancel
									</button>
								</div>
							</div>
						</div>
					{:else}
						<button
							onclick={() => showSprintForm = true}
							class="w-full py-2 rounded-lg border border-dashed border-border text-xs text-text-secondary hover:text-accent-blue hover:border-accent-blue transition-colors"
						>
							+ New Sprint
						</button>
					{/if}

					<!-- All Sprints -->
					{#if data.plan.sprints.length > 0}
						<div class="bg-bg-secondary rounded-lg border border-border p-4">
							<h3 class="text-xs font-medium text-text-secondary uppercase tracking-wider mb-3">
								All Sprints ({data.plan.sprints.length})
							</h3>
							<div class="space-y-2">
								{#each data.plan.sprints as sprint}
									{@const parentMs = data.plan.roadmap.find(m => m.id === sprint.milestoneId)}
									<div class="bg-bg-primary rounded-md border border-border p-3 {sprint.id === data.plan.activeSprint ? 'border-accent-blue/30' : ''}">
										<div class="flex items-center justify-between">
											<div class="flex items-center gap-2">
												<span class="text-sm">{statusIcons[sprint.status]}</span>
												<h4 class="text-sm font-medium {statusColors[sprint.status]}">{sprint.name}</h4>
											</div>
											{#if parentMs}
												<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
													{parentMs.name}
												</span>
											{/if}
										</div>
										<p class="text-xs text-text-secondary mt-1 pl-6">{sprint.goal}</p>
										{#if sprint.retrospective}
											<div class="mt-2 pl-6 border-l-2 border-accent-green/30 ml-2">
												<p class="text-[10px] text-accent-green pl-2">Retro: {sprint.retrospective}</p>
											</div>
										{/if}
										<div class="flex items-center gap-3 mt-1 pl-6 text-[10px] text-text-secondary">
											{#if sprint.startDate}
												<span>Started {formatDate(sprint.startDate)}</span>
											{/if}
											{#if sprint.completedAt}
												<span>Completed {formatDate(sprint.completedAt)}</span>
											{/if}
											<span class="font-mono">{sprint.tasks.length} task(s)</span>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{:else}
						<div class="text-center py-8 text-sm text-text-secondary">
							No sprints yet. Create your first sprint to start breaking the roadmap into actionable chunks.
						</div>
					{/if}
				</div>

			<!-- ═══ MEMORY VIEW ═══ -->
			{:else if viewScale === 'memory'}
				<div class="space-y-4">
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

						<input
							type="text"
							bind:value={searchQuery}
							placeholder="Search memory..."
							class="w-full px-3 py-1.5 mb-3 rounded-md bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue"
						/>

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
											<p class="text-[10px] text-text-secondary">{risk.source} &middot; {(risk.confidence * 100).toFixed(0)}%</p>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
{/if}
