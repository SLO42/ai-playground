<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let hooks = $state(data.hooks ?? []);
	let loading = $state(false);
	let error = $state(data.error ?? '');
	let showAddForm = $state(false);
	let initialLoading = $state(!data.hooks);

	let currentPage = $state(data.page ?? 1);
	let totalPages = $state(data.totalPages ?? 1);
	let total = $state(data.total ?? 0);
	let pageSize = $state(data.pageSize ?? 10);

	// Lazy-load heavy components
	const HookFormPromise = () => import('./HookForm.svelte');
	const HookListPromise = () => import('./HookList.svelte');

	let HookForm = $state<typeof import('./HookForm.svelte')['default'] | null>(null);
	let HookList = $state<typeof import('./HookList.svelte')['default'] | null>(null);

	// Load HookList on mount
	$effect(() => {
		HookListPromise().then((m) => (HookList = m.default));
	});

	// Load HookForm only when user opens the form
	$effect(() => {
		if (showAddForm && !HookForm) {
			HookFormPromise().then((m) => (HookForm = m.default));
		}
	});

	async function handleAddHook(hook: { name: string; type: string; description: string; command: string }) {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${data.projectId}/hooks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...hook, enabled: true })
			});
			const result = await res.json();
			if (!res.ok) {
				error = result.error ?? 'Failed to add hook';
				return;
			}
			hooks = [...hooks, result.hook];
			showAddForm = false;
		} catch (e) {
			error = 'Network error adding hook';
		} finally {
			loading = false;
		}
	}

	// Keyboard shortcut: press "n" to toggle Add Hook form (ignore when typing in inputs)
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			if ((e.target as HTMLElement)?.isContentEditable) return;
			e.preventDefault();
			showAddForm = !showAddForm;
		}
	}

	async function toggleHook(name: string, enabled: boolean) {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${data.projectId}/hooks`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, enabled })
			});
			const result = await res.json();
			if (!res.ok) {
				error = result.error ?? 'Failed to update hook';
				return;
			}
			hooks = hooks.map((h) => (h.name === name ? { ...h, enabled } : h));
		} catch (e) {
			error = 'Network error updating hook';
		} finally {
			loading = false;
		}
	}

	async function deleteHook(name: string) {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/projects/${data.projectId}/hooks`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const result = await res.json();
			if (!res.ok) {
				error = result.error ?? 'Failed to delete hook';
				return;
			}
			hooks = hooks.filter((h) => h.name !== name);
		} catch (e) {
			error = 'Network error deleting hook';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>Project Hooks | AI Playground</title>
	<meta name="description" content="Configure and manage hooks for this project — add, remove, and monitor event-driven automation hooks." />
	<meta property="og:title" content="Project Hooks | AI Playground" />
	<meta property="og:description" content="Configure and manage hooks for this project — add, remove, and monitor event-driven automation hooks." />
	<meta property="og:type" content="website" />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Project Hooks | AI Playground" />
	<meta name="twitter:description" content="Configure and manage hooks for this project — add, remove, and monitor event-driven automation hooks." />
</svelte:head>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Hooks</h1>
			<p class="text-sm text-text-secondary mt-1">Manage hooks for this project</p>
		</div>
		<button
			onclick={() => (showAddForm = !showAddForm)}
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors"
		>
			{showAddForm ? 'Cancel' : '+ Add Hook'}
			<kbd class="ml-2 px-1.5 py-0.5 text-[10px] font-mono bg-white/10 rounded border border-white/20">N</kbd>
		</button>
	</div>

	<!-- Error banner -->
	{#if error}
		<div role="alert" class="bg-accent-red/10 border border-accent-red/30 rounded-lg px-4 py-3 flex items-center justify-between">
			<span class="text-sm text-accent-red">{error}</span>
			<button onclick={() => (error = '')} class="text-accent-red text-xs hover:underline" aria-label="Dismiss error">Dismiss</button>
		</div>
	{/if}

	<!-- Add Hook Form (lazy-loaded) -->
	{#if showAddForm}
		{#if HookForm}
			<HookForm {loading} onsubmit={handleAddHook} />
		{:else}
			<div class="bg-bg-secondary border border-border rounded-lg p-4 text-center">
				<span class="text-xs text-text-secondary animate-pulse">Loading form...</span>
			</div>
		{/if}
	{/if}

	<!-- Action loading indicator -->
	<div aria-live="polite" role="status">
		{#if loading}
			<div class="text-center py-2">
				<span class="text-xs text-text-secondary animate-pulse">Processing...</span>
			</div>
		{/if}
	</div>

	<!-- Hooks List (lazy-loaded) -->
	{#if initialLoading}
		<!-- Loading skeleton -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden" aria-busy="true" aria-label="Loading hooks">
			{#each Array(3) as _}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0 animate-pulse">
					<div class="h-4 w-28 bg-bg-tertiary rounded"></div>
					<div class="h-4 w-12 bg-bg-tertiary rounded"></div>
					<div class="h-4 flex-1 bg-bg-tertiary rounded"></div>
					<div class="h-4 w-16 bg-bg-tertiary rounded"></div>
				</div>
			{/each}
		</div>
	{:else if error && hooks.length === 0}
		<!-- Error state (server-side) -->
		<div class="bg-bg-secondary border border-border rounded-lg px-6 py-10 text-center" role="alert">
			<div class="text-3xl mb-3" aria-hidden="true">!</div>
			<p class="text-sm text-accent-red font-medium">{error}</p>
			<p class="text-xs text-text-secondary mt-2">Could not load hooks for this project.</p>
			<button
				onclick={() => location.reload()}
				class="mt-4 px-4 py-2 text-xs bg-bg-tertiary text-text-primary rounded-lg hover:bg-border transition-colors"
			>
				Retry
			</button>
		</div>
	{:else if HookList}
		<HookList {hooks} {total} {currentPage} {totalPages} {pageSize} {loading} ondelete={deleteHook} ontoggle={toggleHook} />
	{:else}
		<div class="bg-bg-secondary border border-border rounded-lg p-4 text-center">
			<span class="text-xs text-text-secondary animate-pulse">Loading hooks...</span>
		</div>
	{/if}
</div>
