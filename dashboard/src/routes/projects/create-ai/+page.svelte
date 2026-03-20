<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let prompt = $state('');
	let selectedTemplate = $state('blank');
	let selectedTags = $state<string[]>([]);
	let projectName = $state('');
	let isGenerating = $state(false);
	let error = $state<string | null>(null);
	let generationResult = $state<{ success: boolean; projectId: string; message: string } | null>(
		null
	);

	let autoName = $derived(
		prompt
			.trim()
			.split(/\s+/)
			.slice(0, 4)
			.join('-')
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '') || 'my-project'
	);
	let displayName = $derived(projectName || autoName);
	let canSubmit = $derived(prompt.trim().length > 0 && !isGenerating);

	function toggleTag(tag: string) {
		if (selectedTags.includes(tag)) {
			selectedTags = selectedTags.filter((t) => t !== tag);
		} else {
			selectedTags = [...selectedTags, tag];
		}
	}

	async function handleSubmit() {
		if (!canSubmit) return;
		isGenerating = true;
		error = null;
		generationResult = null;

		try {
			const res = await fetch('/api/projects/create-ai', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: prompt.trim(),
					template: selectedTemplate,
					tags: selectedTags,
					name: displayName
				})
			});

			const result = await res.json();

			if (!res.ok) {
				error = result.error || 'Failed to generate project';
				return;
			}

			generationResult = result;
		} catch (e: unknown) {
			const err = e as { message?: string };
			error = err.message ?? 'Network error';
		} finally {
			isGenerating = false;
		}
	}
</script>

<div class="space-y-6 max-w-4xl">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Create with AI</h1>
		<p class="text-sm text-text-secondary mt-1">
			Describe your project and let AI scaffold it
		</p>
	</div>

	<!-- Prompt -->
	<div>
		<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2"
			>Project Description</label
		>
		<textarea
			bind:value={prompt}
			placeholder="Describe what you want to build..."
			rows="4"
			class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan resize-y"
		></textarea>
	</div>

	<!-- Template Selector -->
	<div>
		<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2"
			>Starting Template</label
		>
		<div class="grid grid-cols-2 md:grid-cols-3 gap-2">
			{#each data.templates as tpl}
				<button
					class="text-left border rounded-lg p-3 transition-colors {selectedTemplate === tpl.id
						? 'border-accent-cyan bg-accent-cyan/10'
						: 'border-border bg-bg-secondary hover:border-border/80'}"
					onclick={() => (selectedTemplate = tpl.id)}
				>
					<span class="text-sm font-medium text-text-primary">{tpl.name}</span>
					<p class="text-[10px] text-text-secondary mt-0.5">{tpl.description}</p>
				</button>
			{/each}
		</div>
	</div>

	<!-- Tech Tags -->
	<div>
		<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2"
			>Tech Preferences</label
		>
		<div class="flex flex-wrap gap-2">
			{#each data.techTags as tag}
				<button
					class="px-3 py-1.5 text-xs rounded-full border transition-colors {selectedTags.includes(
						tag
					)
						? 'border-accent-purple bg-accent-purple/15 text-accent-purple'
						: 'border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}"
					onclick={() => toggleTag(tag)}
				>
					{tag}
				</button>
			{/each}
		</div>
	</div>

	<!-- Project Name -->
	<div>
		<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2"
			>Project Name</label
		>
		<input
			type="text"
			bind:value={projectName}
			placeholder={autoName}
			class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary font-mono placeholder:text-text-secondary focus:outline-none focus:border-accent-cyan"
		/>
		<p class="text-[10px] text-text-secondary mt-1">
			Auto-generated from prompt. Override above if needed. Final name: <span
				class="font-mono text-accent-green">{displayName}</span
			>
		</p>
	</div>

	<!-- Error -->
	{#if error}
		<div class="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
			{error}
		</div>
	{/if}

	<!-- Progress / Result -->
	{#if isGenerating}
		<div
			class="bg-bg-secondary border border-border rounded-lg px-4 py-4 flex items-center gap-3"
		>
			<span class="relative flex h-3 w-3">
				<span
					class="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-cyan opacity-75"
				></span>
				<span class="relative inline-flex rounded-full h-3 w-3 bg-accent-cyan"></span>
			</span>
			<span class="text-sm text-text-secondary">Generating project...</span>
		</div>
	{:else if generationResult}
		<div
			class="bg-accent-green/10 border border-accent-green/30 rounded-lg px-4 py-3 text-sm text-accent-green"
		>
			{generationResult.message}
		</div>
	{/if}

	<!-- Actions -->
	<div class="flex items-center justify-end gap-3">
		<a
			href="/projects"
			class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
		>
			Cancel
		</a>
		<button
			onclick={handleSubmit}
			disabled={!canSubmit}
			class="px-6 py-2 text-sm bg-accent-cyan text-white rounded-lg hover:bg-accent-cyan/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
		>
			{isGenerating ? 'Generating...' : 'Generate Project'}
		</button>
	</div>
</div>
