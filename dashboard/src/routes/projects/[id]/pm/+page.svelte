<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let bootstrapping = $state(false);
	let syncing = $state(false);
	let reviewing = $state(false);
	let openingDiscussion = $state(false);
	let viewScale = $state<'macro' | 'micro' | 'memory'>('macro');

	// Memory filters
	let memoryFilter = $state<string>('all');
	let searchQuery = $state('');
	let showArchived = $state(false);

	// Sprint form
	let showSprintForm = $state(false);
	let sprintName = $state('');
	let sprintGoal = $state('');
	let sprintPhase = $state('');
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

	const statusIcons: Record<string, string> = {
		planned: '⬜', active: '🔵', completed: '✅', blocked: '🔴'
	};
	const statusColors: Record<string, string> = {
		planned: 'text-text-secondary', active: 'text-accent-blue',
		completed: 'text-accent-green', blocked: 'text-accent-red'
	};
	const typeColors: Record<string, string> = {
		observation: 'bg-accent-blue/10 text-accent-blue',
		learning: 'bg-accent-green/10 text-accent-green',
		risk: 'bg-accent-red/10 text-accent-red',
		pattern: 'bg-accent-purple/10 text-accent-purple',
		'decision-context': 'bg-accent-yellow/10 text-accent-yellow'
	};

	async function pmAction(action: string, extra: Record<string, unknown> = {}) {
		const res = await fetch(`/api/projects/${data.projectId}/pm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, ...extra })
		});
		return res;
	}

	async function bootstrap() {
		bootstrapping = true;
		try { const r = await pmAction('bootstrap'); if (r.ok) window.location.reload(); }
		finally { bootstrapping = false; }
	}
	async function syncGitHub() {
		syncing = true;
		try { await pmAction('sync-github'); } finally { syncing = false; }
	}
	async function openDiscussion() {
		openingDiscussion = true;
		try {
			const r = await pmAction('start-discussion');
			if (r.ok) { const { sessionId } = await r.json(); window.location.href = `/chat?session=${sessionId}`; }
		} finally { openingDiscussion = false; }
	}
	async function runReview() {
		reviewing = true;
		try { const r = await pmAction('review'); if (r.ok) window.location.reload(); }
		finally { reviewing = false; }
	}
	async function createSprint() {
		if (!sprintName || !sprintGoal || !sprintPhase) return;
		creatingSprint = true;
		try {
			const r = await pmAction('create-sprint', { name: sprintName, goal: sprintGoal, phaseId: sprintPhase, activate: sprintActivate });
			if (r.ok) window.location.reload();
		} finally { creatingSprint = false; }
	}
	async function completeSprint(sprintId: string) {
		const retro = prompt('Sprint retrospective (optional):');
		const r = await pmAction('complete-sprint', { sprintId, retrospective: retro });
		if (r.ok) window.location.reload();
	}

	// Inline PM input — talk to the PM directly from the dashboard
	let pmInput = $state('');
	let pmProcessing = $state(false);
	let pmFeedback = $state<string | null>(null);

	async function sendToPm() {
		const text = pmInput.trim();
		if (!text || pmProcessing) return;
		pmProcessing = true;
		pmFeedback = null;
		try {
			const r = await pmAction('process-reply', { content: text });
			if (r.ok) {
				const result = await r.json();
				const applied: string[] = [];
				if (result.applied?.purpose) applied.push('purpose');
				if (result.applied?.longTermVision) applied.push('long-term vision');
				if (result.applied?.role) applied.push('role');
				if (result.applied?.keyHighlights?.length) applied.push(`${result.applied.keyHighlights.length} highlights`);
				if (result.applied?.definitionOfDone?.length) applied.push(`${result.applied.definitionOfDone.length} DoD criteria`);
				if (result.applied?.featureComplete?.length) applied.push(`${result.applied.featureComplete.length} feature-complete criteria`);
				pmFeedback = applied.length > 0
					? `Updated: ${applied.join(', ')}. Saved to PM memory.`
					: 'Saved to PM memory. Open a discussion to refine further with Claude.';
				pmInput = '';
				// Reload after a short delay so the user sees the feedback
				setTimeout(() => window.location.reload(), 2000);
			} else {
				const err = await r.json().catch(() => ({ error: 'Failed' }));
				pmFeedback = `Error: ${err.error}`;
			}
		} finally {
			pmProcessing = false;
		}
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const diff = Date.now() - d.getTime();
		if (diff < 60000) return 'just now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return d.toLocaleDateString();
	}
	function confBar(c: number): string {
		return c >= 0.8 ? 'bg-accent-green' : c >= 0.5 ? 'bg-accent-yellow' : 'bg-accent-red';
	}
</script>

{#if !data.hasPm}
	<div class="max-w-lg mx-auto mt-16 text-center">
		<div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-green/10 flex items-center justify-center text-3xl">📋</div>
		<h2 class="text-xl font-semibold text-text-primary mb-2">Project Manager</h2>
		<p class="text-sm text-text-secondary mb-6">
			Bootstrap a PM for this project. It scans the codebase and builds an initial strategic plan —
			purpose, releases, phases, features, and your role. Then you refine it together.
		</p>
		<button onclick={bootstrap} disabled={bootstrapping}
			class="px-6 py-2.5 rounded-lg bg-accent-green text-black font-medium text-sm hover:bg-accent-green/90 transition-colors disabled:opacity-50">
			{bootstrapping ? 'Scanning...' : 'Bootstrap Project Manager'}
		</button>
	</div>
{:else}
	<div class="space-y-6">
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Project Manager</h2>
				{#if data.plan}
					<p class="text-sm text-text-secondary mt-1">Updated {formatDate(data.plan.lastUpdated)} by {data.plan.updatedBy}</p>
				{/if}
			</div>
			<div class="flex gap-2">
				<button onclick={openDiscussion} disabled={openingDiscussion}
					class="px-3 py-1.5 rounded-md bg-accent-green/10 text-accent-green text-xs font-medium hover:bg-accent-green/20 transition-colors disabled:opacity-50">
					{openingDiscussion ? 'Opening...' : 'Open Discussion'}
				</button>
				<button onclick={runReview} disabled={reviewing}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50">
					{reviewing ? 'Reviewing...' : 'Run Review'}
				</button>
				<button onclick={syncGitHub} disabled={syncing}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50">
					{syncing ? 'Syncing...' : 'Sync to GitHub'}
				</button>
				<button onclick={bootstrap} disabled={bootstrapping}
					class="px-3 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary transition-colors disabled:opacity-50">
					Re-scan
				</button>
			</div>
		</div>

		<!-- Inline PM Input -->
		<div class="bg-bg-secondary rounded-lg border border-border p-4">
			<form onsubmit={(e) => { e.preventDefault(); sendToPm(); }} class="flex gap-3">
				<textarea
					bind:value={pmInput}
					placeholder="Tell the PM about your project — purpose, role, releases, features, what 'done' means..."
					rows={2}
					class="flex-1 px-3 py-2 rounded-md bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-green resize-y"
				></textarea>
				<button
					type="submit"
					disabled={pmProcessing || !pmInput.trim()}
					class="self-end px-4 py-2 rounded-md bg-accent-green text-black text-xs font-medium hover:bg-accent-green/90 transition-colors disabled:opacity-50 whitespace-nowrap"
				>
					{pmProcessing ? 'Processing...' : 'Update Plan'}
				</button>
			</form>
			{#if pmFeedback}
				<p class="text-xs mt-2 {pmFeedback.startsWith('Error') ? 'text-accent-red' : 'text-accent-green'}">{pmFeedback}</p>
			{/if}
		</div>

		{#if data.plan}
			{@const m = data.plan.macro}

			<!-- Scale Tabs -->
			<div class="flex gap-1 bg-bg-secondary rounded-lg border border-border p-1">
				{#each [['macro', 'Macro Strategy'], ['micro', 'Sprints'], ['memory', 'PM Memory']] as [key, label]}
					<button onclick={() => viewScale = key as typeof viewScale}
						class="flex-1 px-3 py-2 rounded-md text-xs font-medium transition-colors
							{viewScale === key ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}">
						{label}
						{#if key === 'macro'}
							<span class="ml-1 text-text-secondary">({m.releases.length}R / {m.phases.length}P)</span>
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
					<!-- Identity Card -->
					<div class="bg-bg-secondary rounded-lg border border-border p-5">
						<div class="grid grid-cols-2 gap-6">
							<div>
								<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1">Purpose</h3>
								<p class="text-sm text-text-primary leading-relaxed">{m.purpose}</p>
							</div>
							<div>
								<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1">Long-term Vision</h3>
								<p class="text-sm text-text-primary leading-relaxed">{m.longTermVision}</p>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-6 mt-4 pt-4 border-t border-border">
							<div>
								<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1">Your Role</h3>
								<p class="text-sm font-medium text-text-primary">{m.role.title}</p>
								{#each m.role.responsibilities as r}
									<p class="text-xs text-text-secondary">• {r}</p>
								{/each}
							</div>
							<div>
								<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1">Key Highlights</h3>
								{#if m.keyHighlights.length > 0}
									{#each m.keyHighlights as h}
										<p class="text-xs text-text-primary">• {h}</p>
									{/each}
								{:else}
									<p class="text-xs text-text-secondary italic">Define in discussion</p>
								{/if}
							</div>
						</div>
					</div>

					<!-- Release Roadmap -->
					<div class="bg-bg-secondary rounded-lg border border-border p-4">
						<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-3">
							Release Roadmap ({m.releases.length} release{m.releases.length !== 1 ? 's' : ''})
						</h3>
						<div class="space-y-4">
							{#each m.releases as release}
								{@const relPhases = m.phases.filter(p => p.releaseId === release.id)}
								{@const donePhases = relPhases.filter(p => p.status === 'completed').length}
								<div class="bg-bg-primary rounded-md border border-border p-4">
									<div class="flex items-center justify-between mb-2">
										<div class="flex items-center gap-2">
											<span class="text-sm">{statusIcons[release.status]}</span>
											<span class="text-xs font-mono font-bold text-accent-cyan">{release.version}</span>
											<h4 class="text-sm font-medium {statusColors[release.status]}">{release.name}</h4>
										</div>
										<div class="flex items-center gap-2">
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary font-mono">
												{donePhases}/{relPhases.length} phases
											</span>
											{#if release.targetDate}
												<span class="text-[10px] text-text-secondary font-mono">{release.targetDate}</span>
											{/if}
										</div>
									</div>

									<!-- Feature Complete -->
									{#if release.featureComplete.length > 0 && release.featureComplete[0] !== 'To be defined in PM discussion'}
										<div class="mb-3 pl-6">
											<p class="text-[10px] text-text-secondary uppercase tracking-wider mb-1">Feature Complete =</p>
											{#each release.featureComplete as fc}
												<p class="text-xs text-text-primary">☐ {fc}</p>
											{/each}
										</div>
									{/if}

									<!-- Phases -->
									<div class="space-y-2 pl-6">
										{#each relPhases as phase}
											{@const childSprints = data.plan.sprints.filter(s => s.phaseId === phase.id)}
											<div class="border-l-2 {phase.status === 'active' ? 'border-accent-blue' : phase.status === 'completed' ? 'border-accent-green' : 'border-border'} pl-3 py-1">
												<div class="flex items-center justify-between">
													<div class="flex items-center gap-2">
														<span class="text-xs">{statusIcons[phase.status]}</span>
														<span class="text-xs font-medium {statusColors[phase.status]}">{phase.name}</span>
													</div>
													{#if childSprints.length > 0}
														<span class="text-[10px] text-text-secondary font-mono">
															{childSprints.filter(s => s.status === 'completed').length}/{childSprints.length} sprints
														</span>
													{/if}
												</div>
												{#each phase.goals as goal}
													<p class="text-[10px] text-text-secondary ml-5">{goal}</p>
												{/each}
											</div>
										{/each}
									</div>
								</div>
							{/each}
						</div>
					</div>

					<!-- Feature Map -->
					{#if m.featureMap.length > 0}
						<div class="bg-bg-secondary rounded-lg border border-border p-4">
							<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-3">Feature Map</h3>
							<div class="grid grid-cols-2 gap-2">
								{#each m.featureMap as feat}
									{@const rel = m.releases.find(r => r.id === feat.releaseId)}
									<div class="bg-bg-primary rounded-md border border-border p-2.5">
										<div class="flex items-center gap-2">
											<span class="text-[10px] px-1 py-0.5 rounded {feat.status === 'shipped' ? 'bg-accent-green/10 text-accent-green' : feat.status === 'in-progress' ? 'bg-accent-blue/10 text-accent-blue' : 'bg-bg-tertiary text-text-secondary'}">
												{feat.status}
											</span>
											<span class="text-xs font-medium text-text-primary">{feat.name}</span>
										</div>
										<p class="text-[10px] text-text-secondary mt-1">{feat.description}</p>
										{#if rel}
											<p class="text-[10px] text-text-secondary mt-0.5 font-mono">{rel.version}</p>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Definition of Done + Decisions -->
					<div class="grid grid-cols-2 gap-4">
						<div class="bg-bg-secondary rounded-lg border border-border p-4">
							<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-2">Definition of Done</h3>
							{#each m.definitionOfDone as d}
								<p class="text-xs text-text-primary">☐ {d}</p>
							{/each}
						</div>
						<div class="bg-bg-secondary rounded-lg border border-border p-4">
							<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-2">
								Decisions ({data.plan.decisions.length})
							</h3>
							{#if data.plan.decisions.length > 0}
								{#each data.plan.decisions.slice(0, 5) as dec}
									<div class="mb-2">
										<p class="text-xs font-medium text-text-primary">{dec.title}</p>
										<p class="text-[10px] text-accent-blue">→ {dec.decision}</p>
									</div>
								{/each}
							{:else}
								<p class="text-xs text-text-secondary italic">No decisions recorded yet</p>
							{/if}
						</div>
					</div>

					<!-- Risks -->
					{#if data.risks.length > 0}
						<div class="bg-bg-secondary rounded-lg border border-accent-red/20 p-4">
							<h3 class="text-[10px] font-medium text-accent-red uppercase tracking-wider mb-2">Active Risks ({data.risks.length})</h3>
							{#each data.risks as risk}
								<div class="flex items-start gap-2 mb-1">
									<span class="text-accent-red text-xs">⚠</span>
									<p class="text-xs text-text-primary">{risk.content}</p>
								</div>
							{/each}
						</div>
					{/if}
				</div>

			<!-- ═══ MICRO VIEW ═══ -->
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
								<button onclick={() => { if (activeSprint) completeSprint(activeSprint.id); }}
									class="px-2 py-1 rounded text-[10px] bg-accent-green/10 text-accent-green hover:bg-accent-green/20">
									Complete Sprint
								</button>
							</div>
							<p class="text-xs text-text-secondary">{activeSprint.goal}</p>
							{#each (data.plan?.macro.phases ?? []).filter(p => p.id === activeSprint?.phaseId) as parentPhase}
								{#each (data.plan?.macro.releases ?? []).filter(r => r.id === parentPhase.releaseId) as parentRel}
									<p class="text-[10px] text-text-secondary mt-1">
										{parentRel.version} → <span class="text-accent-blue">{parentPhase.name}</span>
									</p>
								{/each}
							{/each}
							<p class="text-[10px] text-text-secondary mt-1 font-mono">{activeSprint.tasks.length} task(s)</p>
						</div>
					{/if}

					<!-- Create Sprint -->
					{#if showSprintForm}
						<div class="bg-bg-secondary rounded-lg border border-accent-blue/20 p-4">
							<h3 class="text-xs font-medium text-accent-blue uppercase tracking-wider mb-3">New Sprint</h3>
							<div class="space-y-3">
								<input bind:value={sprintName} placeholder="Sprint name" class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue" />
								<input bind:value={sprintGoal} placeholder="Sprint goal" class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue" />
								<select bind:value={sprintPhase} class="w-full px-3 py-1.5 rounded-md bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:border-accent-blue">
									<option value="">Select phase...</option>
									{#each data.plan?.macro.phases ?? [] as phase}
										{#each (data.plan?.macro.releases ?? []).filter(r => r.id === phase.releaseId) as rel}
											<option value={phase.id}>{rel.version} → {phase.name}</option>
										{/each}
									{/each}
								</select>
								<label class="flex items-center gap-2 text-xs text-text-secondary">
									<input type="checkbox" bind:checked={sprintActivate} class="rounded" /> Set as active sprint
								</label>
								<div class="flex gap-2">
									<button onclick={createSprint} disabled={creatingSprint || !sprintName || !sprintGoal || !sprintPhase}
										class="px-4 py-1.5 rounded-md bg-accent-blue text-black text-xs font-medium hover:bg-accent-blue/90 disabled:opacity-50">
										{creatingSprint ? 'Creating...' : 'Create Sprint'}
									</button>
									<button onclick={() => showSprintForm = false}
										class="px-4 py-1.5 rounded-md bg-bg-tertiary text-text-secondary text-xs hover:text-text-primary">Cancel</button>
								</div>
							</div>
						</div>
					{:else}
						<button onclick={() => showSprintForm = true}
							class="w-full py-2 rounded-lg border border-dashed border-border text-xs text-text-secondary hover:text-accent-blue hover:border-accent-blue transition-colors">
							+ New Sprint
						</button>
					{/if}

					<!-- Sprint List -->
					{#if data.plan.sprints.length > 0}
						<div class="bg-bg-secondary rounded-lg border border-border p-4">
							<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-3">All Sprints ({data.plan.sprints.length})</h3>
							<div class="space-y-2">
								{#each data.plan.sprints as sprint}
									<div class="bg-bg-primary rounded-md border border-border p-3 {sprint.id === data.plan.activeSprint ? 'border-accent-blue/30' : ''}">
										<div class="flex items-center justify-between">
											<div class="flex items-center gap-2">
												<span class="text-sm">{statusIcons[sprint.status]}</span>
												<h4 class="text-sm font-medium {statusColors[sprint.status]}">{sprint.name}</h4>
											</div>
											{#each (data.plan?.macro.phases ?? []).filter(p => p.id === sprint.phaseId) as phase}
												{#each (data.plan?.macro.releases ?? []).filter(r => r.id === phase.releaseId) as rel}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">{rel.version} → {phase.name}</span>
												{/each}
											{/each}
										</div>
										<p class="text-xs text-text-secondary mt-1 pl-6">{sprint.goal}</p>
										{#if sprint.retrospective}
											<div class="mt-2 pl-6 border-l-2 border-accent-green/30 ml-2">
												<p class="text-[10px] text-accent-green pl-2">Retro: {sprint.retrospective}</p>
											</div>
										{/if}
										<div class="flex items-center gap-3 mt-1 pl-6 text-[10px] text-text-secondary">
											{#if sprint.startDate}<span>Started {formatDate(sprint.startDate)}</span>{/if}
											{#if sprint.completedAt}<span>Done {formatDate(sprint.completedAt)}</span>{/if}
											<span class="font-mono">{sprint.tasks.length} task(s)</span>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{:else}
						<div class="text-center py-8 text-sm text-text-secondary">
							No sprints yet. Create your first sprint to start executing against the macro roadmap.
						</div>
					{/if}
				</div>

			<!-- ═══ MEMORY VIEW ═══ -->
			{:else if viewScale === 'memory'}
				<div class="space-y-4">
					<div class="bg-bg-secondary rounded-lg border border-border p-4">
						<div class="flex items-center justify-between mb-3">
							<div>
								<h3 class="text-[10px] font-medium text-text-secondary uppercase tracking-wider">PM Memory</h3>
								{#if data.stats}
									<p class="text-[10px] text-text-secondary mt-0.5">
										{data.stats.totalEntries} entries &middot; {data.stats.totalReviews} reviews
										{#if data.stats.lastReviewedAt}&middot; reviewed {formatDate(data.stats.lastReviewedAt)}{/if}
									</p>
								{/if}
							</div>
							<label class="flex items-center gap-1.5 text-[10px] text-text-secondary">
								<input type="checkbox" bind:checked={showArchived} class="rounded" /> Archived
							</label>
						</div>

						{#if data.stats}
							<div class="grid grid-cols-5 gap-2 mb-3">
								{#each Object.entries(data.stats.byType) as [type, count]}
									<button onclick={() => memoryFilter = memoryFilter === type ? 'all' : type}
										class="text-center px-2 py-1.5 rounded-md text-[10px] transition-colors
											{memoryFilter === type ? 'bg-bg-primary border border-accent-blue' : 'bg-bg-tertiary border border-transparent hover:border-border'}">
										<span class="block text-sm font-mono text-text-primary">{count}</span>
										<span class="text-text-secondary">{type}</span>
									</button>
								{/each}
							</div>
						{/if}

						<input type="text" bind:value={searchQuery} placeholder="Search memory..."
							class="w-full px-3 py-1.5 mb-3 rounded-md bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue" />

						<div class="space-y-2 max-h-96 overflow-y-auto">
							{#each filteredMemory as entry}
								<div class="bg-bg-primary rounded-md border border-border p-2.5 {entry.archived ? 'opacity-50' : ''}">
									<div class="flex items-center gap-2 mb-1">
										<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {typeColors[entry.type]}">{entry.type}</span>
										<span class="text-[10px] text-text-secondary">{entry.source}</span>
										<span class="text-[10px] text-text-secondary ml-auto">{formatDate(entry.createdAt)}</span>
									</div>
									<p class="text-xs text-text-primary leading-relaxed">{entry.content}</p>
									<div class="flex items-center gap-2 mt-1.5">
										<div class="flex-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
											<div class="h-full rounded-full {confBar(entry.confidence)}" style="width: {entry.confidence * 100}%"></div>
										</div>
										<span class="text-[10px] text-text-secondary font-mono">{(entry.confidence * 100).toFixed(0)}%</span>
									</div>
								</div>
							{:else}
								<p class="text-sm text-text-secondary text-center py-4">No entries match</p>
							{/each}
						</div>
					</div>

					{#if data.risks.length > 0}
						<div class="bg-bg-secondary rounded-lg border border-accent-red/20 p-4">
							<h3 class="text-[10px] font-medium text-accent-red uppercase tracking-wider mb-2">Active Risks ({data.risks.length})</h3>
							{#each data.risks as risk}
								<div class="flex items-start gap-2 mb-1">
									<span class="text-accent-red text-xs">⚠</span>
									<p class="text-xs text-text-primary">{risk.content}</p>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
{/if}
