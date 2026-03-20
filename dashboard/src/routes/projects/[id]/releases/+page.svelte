<script lang="ts">
	import MetricCard from '$lib/components/MetricCard.svelte';
	import { navigating } from '$app/stores';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let releases = $state(data.releases ?? []);
	let currentVersion = $state(data.currentVersion ?? '0.0.0');
	let error = $state<string | null>(null);
	let loading = $derived(!!$navigating);

	// Create release modal
	let showModal = $state(false);
	let bumpType = $state<'major' | 'minor' | 'patch'>('patch');
	let customVersion = $state('');
	let changelog = $state('');
	let isDraft = $state(false);
	let isPrerelease = $state(false);
	let creating = $state(false);
	let releaseUrl = $state<string | null>(null);

	// Expanded release cards
	let expandedIds = $state<Set<string>>(new Set());

	const suggestedVersion = $derived(
		customVersion || data.suggestedBump?.[bumpType] || '0.0.1'
	);

	const summary = $derived.by(() => {
		const total = releases.length;
		const latest = releases.length > 0 ? releases[0].tag : 'none';
		const lastDate = releases.length > 0 ? releases[0].date : null;
		const daysSince = lastDate
			? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
			: -1;
		const hasGithub = releases.some((r: { source: string }) => r.source === 'github');
		return { total, latest, daysSince, hasGithub };
	});

	function toggleExpand(tag: string) {
		const next = new Set(expandedIds);
		if (next.has(tag)) {
			next.delete(tag);
		} else {
			next.add(tag);
		}
		expandedIds = next;
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return iso;
		}
	}

	function clearError() {
		error = null;
	}

	function openModal() {
		customVersion = '';
		// Pre-fill changelog from generated notes if available
		changelog = data.generatedNotes && data.generatedNotes !== 'No changes.'
			? data.generatedNotes
			: '';
		bumpType = 'patch';
		isDraft = false;
		isPrerelease = false;
		releaseUrl = null;
		showModal = true;
	}

	async function createRelease() {
		if (creating) return;
		const version = suggestedVersion;
		if (!version) {
			error = 'Version is required';
			return;
		}
		if (!changelog.trim()) {
			error = 'Changelog is required';
			return;
		}

		creating = true;
		error = null;

		try {
			const res = await fetch(`/api/projects/${data.projectId}/releases`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					version,
					changelog: changelog.trim(),
					draft: isDraft,
					prerelease: isPrerelease
				})
			});

			const result = await res.json();

			if (!res.ok) {
				error = result.message ?? result.error ?? `Failed to create release (${res.status})`;
				return;
			}

			releaseUrl = result.url ?? null;
			notifications.push('success', 'Release created', `v${result.version} has been published`);
			showModal = false;

			// Refresh releases
			const refreshRes = await fetch(`/api/projects/${data.projectId}/releases`);
			if (refreshRes.ok) {
				const refreshed = await refreshRes.json();
				releases = refreshed.releases ?? [];
				currentVersion = refreshed.currentVersion ?? currentVersion;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create release';
		} finally {
			creating = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="type-page-title text-text-primary">Releases</h1>
			<p class="text-xs text-text-secondary mt-0.5">
				Current version: <span class="font-mono text-accent-cyan">{currentVersion}</span>
			</p>
		</div>
		<button
			onclick={openModal}
			class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
		>
			<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
			</svg>
			Create Release
		</button>
	</div>

	<!-- gh CLI warning -->
	{#if !data.hasGh}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow text-sm">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
			</svg>
			<span class="flex-1">
				GitHub CLI (gh) not detected. Install it from
				<a href="https://cli.github.com/" target="_blank" rel="noopener noreferrer" class="underline hover:text-accent-yellow/80">cli.github.com</a>
				to create GitHub releases.
			</span>
		</div>
	{/if}

	<!-- Error Banner -->
	{#if error}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-red/10 border border-accent-red/20 text-accent-red text-sm">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
			</svg>
			<span class="flex-1">{error}</span>
			<button onclick={clearError} class="text-accent-red/70 hover:text-accent-red transition-colors">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/if}

	<!-- Success Banner (after release creation) -->
	{#if releaseUrl}
		<div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-accent-green/10 border border-accent-green/20 text-accent-green text-sm">
			<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<span class="flex-1">
				Release published successfully.
				<a href={releaseUrl} target="_blank" rel="noopener noreferrer" class="underline hover:text-accent-green/80">View on GitHub</a>
			</span>
			<button onclick={() => (releaseUrl = null)} class="text-accent-green/70 hover:text-accent-green transition-colors">
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/if}

	<!-- Loading -->
	{#if loading}
		<div class="flex items-center gap-2 text-text-secondary text-sm">
			<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			Loading releases...
		</div>
	{/if}

	<!-- Summary Metrics -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
		<MetricCard label="Total" value={summary.total} subtitle="releases" accent="blue" />
		<MetricCard label="Latest" value={summary.latest} subtitle="version tag" accent="cyan" />
		<MetricCard
			label="Since Last"
			value={summary.daysSince >= 0 ? summary.daysSince : '--'}
			subtitle="days"
			accent="green"
		/>
		<MetricCard
			label="GitHub"
			value={data.hasGh ? (summary.hasGithub ? 'Connected' : 'Available') : 'N/A'}
			subtitle={data.hasGh ? 'gh CLI detected' : 'gh CLI not found'}
			accent={data.hasGh ? 'green' : 'yellow'}
		/>
	</div>

	<!-- Release List -->
	{#if releases.length === 0 && !loading}
		<div class="bg-bg-secondary border border-border rounded-lg p-12 flex flex-col items-center justify-center text-center">
			<svg class="w-12 h-12 text-text-secondary/40 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6z" />
			</svg>
			<h2 class="text-text-primary text-sm font-medium mb-1">No releases yet</h2>
			<p class="text-text-secondary text-xs mb-4">Create your first release to get started</p>
			<button
				onclick={openModal}
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors"
			>
				<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
				</svg>
				Create Release
			</button>
		</div>
	{:else}
		<div class="space-y-3">
			{#each releases as release (release.tag)}
				{@const isExpanded = expandedIds.has(release.tag)}
				<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
					<button
						onclick={() => toggleExpand(release.tag)}
						class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bg-tertiary transition-colors"
						aria-expanded={isExpanded}
					>
						<!-- Expand chevron -->
						<svg
							class="w-4 h-4 text-text-secondary shrink-0 transition-transform {isExpanded ? 'rotate-90' : ''}"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							stroke-width="2"
						>
							<path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
						</svg>

						<!-- Version -->
						<span class="text-base font-bold font-mono text-accent-cyan">{release.tag}</span>

						<!-- Name (if different from tag) -->
						{#if release.name && release.name !== release.tag}
							<span class="text-sm text-text-primary truncate">{release.name}</span>
						{/if}

						<!-- Badges -->
						<div class="flex items-center gap-1.5 ml-auto shrink-0">
							{#if release.draft}
								<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded bg-accent-yellow/20 text-accent-yellow">Draft</span>
							{/if}
							{#if release.prerelease}
								<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded bg-accent-purple/20 text-accent-purple">Pre-release</span>
							{/if}
							<span class="px-1.5 py-0.5 text-[0.65rem] font-medium rounded {release.source === 'github' ? 'bg-accent-green/20 text-accent-green' : 'bg-accent-blue/20 text-accent-blue'}">
								{release.source === 'github' ? 'GitHub' : 'Git Tag'}
							</span>
							<span class="text-xs text-text-secondary ml-2">{formatDate(release.date)}</span>
						</div>
					</button>

					{#if isExpanded}
						<div class="px-4 pb-4 border-t border-border">
							{#if release.body}
								<pre class="mt-3 text-xs text-text-secondary whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">{release.body}</pre>
							{:else}
								<p class="mt-3 text-xs text-text-secondary italic">No changelog provided</p>
							{/if}
							{#if release.htmlUrl}
								<a
									href={release.htmlUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 mt-3 text-xs text-accent-blue hover:underline"
								>
									<svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
										<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
									</svg>
									View on GitHub
								</a>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Create Release Modal -->
{#if showModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		onkeydown={(e) => { if (e.key === 'Escape') showModal = false; }}
		onclick={(e) => { if (e.target === e.currentTarget) showModal = false; }}
		role="dialog"
		aria-modal="true"
		aria-label="Create Release"
	>
		<div class="bg-bg-secondary border border-border rounded-lg shadow-lg w-full max-w-lg mx-4">
			<div class="flex items-center justify-between p-4 border-b border-border">
				<h2 class="text-sm font-medium text-text-primary">Create Release</h2>
				<button
					onclick={() => (showModal = false)}
					class="text-text-secondary hover:text-text-primary transition-colors"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
			<form class="p-4 space-y-4" onsubmit={(e) => { e.preventDefault(); createRelease(); }}>
				<!-- gh CLI warning inside modal -->
				{#if !data.hasGh}
					<div class="flex items-center gap-2 px-3 py-2 rounded bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow text-xs">
						<svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
						</svg>
						<span>GitHub CLI not installed. Release creation will fail.</span>
					</div>
				{/if}

				<!-- Bump Type -->
				<div>
					<label class="block text-xs text-text-secondary mb-1.5">Bump Type</label>
					<div class="flex gap-2">
						<button
							type="button"
							onclick={() => { bumpType = 'patch'; customVersion = ''; }}
							class="flex-1 px-3 py-1.5 rounded text-xs font-medium border transition-colors {bumpType === 'patch' && !customVersion ? 'border-accent-blue bg-accent-blue/20 text-accent-blue' : 'border-border text-text-secondary hover:text-text-primary'}"
						>
							Patch
						</button>
						<button
							type="button"
							onclick={() => { bumpType = 'minor'; customVersion = ''; }}
							class="flex-1 px-3 py-1.5 rounded text-xs font-medium border transition-colors {bumpType === 'minor' && !customVersion ? 'border-accent-blue bg-accent-blue/20 text-accent-blue' : 'border-border text-text-secondary hover:text-text-primary'}"
						>
							Minor
						</button>
						<button
							type="button"
							onclick={() => { bumpType = 'major'; customVersion = ''; }}
							class="flex-1 px-3 py-1.5 rounded text-xs font-medium border transition-colors {bumpType === 'major' && !customVersion ? 'border-accent-blue bg-accent-blue/20 text-accent-blue' : 'border-border text-text-secondary hover:text-text-primary'}"
						>
							Major
						</button>
					</div>
				</div>

				<!-- Version -->
				<div>
					<label class="block text-xs text-text-secondary mb-1" for="release-version">Version</label>
					<div class="flex items-center gap-2">
						<input
							id="release-version"
							type="text"
							bind:value={customVersion}
							placeholder={data.suggestedBump?.[bumpType] || '0.0.1'}
							class="flex-1 bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary font-mono focus:outline-none focus:border-accent-blue"
						/>
						<span class="text-xs text-text-secondary shrink-0">
							will tag as <span class="font-mono text-accent-cyan">v{suggestedVersion}</span>
						</span>
					</div>
				</div>

				<!-- Changelog -->
				<div>
					<div class="flex items-center justify-between mb-1">
						<label class="block text-xs text-text-secondary" for="release-changelog">Release Notes</label>
						{#if data.generatedNotes && data.generatedNotes !== 'No changes.'}
							<button
								type="button"
								onclick={() => { changelog = data.generatedNotes; }}
								class="text-[0.65rem] text-accent-blue hover:text-accent-blue/80 transition-colors"
							>
								Fill from commits
							</button>
						{/if}
					</div>
					<textarea
						id="release-changelog"
						bind:value={changelog}
						placeholder="Describe what changed in this release..."
						rows="8"
						class="w-full bg-bg-primary border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary font-mono focus:outline-none focus:border-accent-blue resize-y"
					></textarea>
				</div>

				<!-- Options -->
				<div class="flex items-center gap-6">
					<label class="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
						<input
							type="checkbox"
							bind:checked={isDraft}
							class="accent-accent-blue"
						/>
						Draft
					</label>
					<label class="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
						<input
							type="checkbox"
							bind:checked={isPrerelease}
							class="accent-accent-blue"
						/>
						Pre-release
					</label>
				</div>

				<!-- Actions -->
				<div class="flex items-center justify-end gap-2 pt-2">
					<button
						type="button"
						onclick={() => (showModal = false)}
						class="px-3 py-1.5 rounded text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={creating || !changelog.trim() || !data.hasGh}
						class="px-4 py-1.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors disabled:opacity-50"
					>
						{creating ? 'Creating...' : 'Create Release'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}
