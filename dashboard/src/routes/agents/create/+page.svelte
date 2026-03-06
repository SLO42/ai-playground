<script lang="ts">
	import { enhance } from '$app/forms';

	interface PageData {
		categories: string[];
		templates: { id: string; label: string }[];
	}

	let { data, form }: { data: PageData; form: { error?: string } | null } = $props();

	let name = $state('');
	let description = $state('');
	let category = $state(data.categories[0] ?? 'custom');
	let customCategory = $state('');
	let template = $state('basic');
	let useCustomCategory = $state(false);

	const effectiveCategory = $derived(useCustomCategory ? customCategory.toLowerCase().replace(/[^a-z0-9-]/g, '-') : category);
</script>

<div class="space-y-6 max-w-2xl">
	<div>
		<div class="flex items-center gap-2 mb-1">
			<a href="/agents" class="text-text-secondary hover:text-text-primary text-sm transition-colors">
				Agents
			</a>
			<span class="text-text-secondary text-xs">/</span>
		</div>
		<h1 class="type-page-title text-text-primary">Create New Agent</h1>
	</div>

	{#if form?.error}
		<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-3">
			<p class="text-accent-red text-sm">{form.error}</p>
		</div>
	{/if}

	<form method="POST" use:enhance class="space-y-5">
		<!-- Template -->
		<div class="space-y-1.5">
			<label for="template" class="text-xs font-medium text-text-secondary uppercase tracking-wider">Template</label>
			<select
				id="template"
				name="template"
				bind:value={template}
				class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
					focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25"
			>
				{#each data.templates as tmpl}
					<option value={tmpl.id}>{tmpl.label}</option>
				{/each}
			</select>
		</div>

		<!-- Name -->
		<div class="space-y-1.5">
			<label for="name" class="text-xs font-medium text-text-secondary uppercase tracking-wider">Agent Name</label>
			<input
				id="name"
				name="name"
				type="text"
				bind:value={name}
				required
				placeholder="e.g. my-custom-agent"
				class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
					placeholder:text-text-secondary
					focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25"
			/>
		</div>

		<!-- Description -->
		<div class="space-y-1.5">
			<label for="description" class="text-xs font-medium text-text-secondary uppercase tracking-wider">Description</label>
			<input
				id="description"
				name="description"
				type="text"
				bind:value={description}
				placeholder="Brief description of the agent's purpose"
				class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
					placeholder:text-text-secondary
					focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25"
			/>
		</div>

		<!-- Category -->
		<div class="space-y-1.5">
			<label class="text-xs font-medium text-text-secondary uppercase tracking-wider">Category</label>
			<div class="flex items-center gap-3 mb-2">
				<label class="flex items-center gap-1.5 text-sm text-text-primary cursor-pointer">
					<input type="radio" bind:group={useCustomCategory} value={false} class="accent-accent-blue" />
					Existing
				</label>
				<label class="flex items-center gap-1.5 text-sm text-text-primary cursor-pointer">
					<input type="radio" bind:group={useCustomCategory} value={true} class="accent-accent-blue" />
					New category
				</label>
			</div>

			{#if useCustomCategory}
				<input
					name="category"
					type="text"
					bind:value={customCategory}
					required
					placeholder="e.g. my-category"
					class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
						placeholder:text-text-secondary
						focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25"
				/>
			{:else}
				<select
					name="category"
					bind:value={category}
					class="w-full bg-bg-secondary border border-border rounded-lg px-3 py-2 text-sm text-text-primary
						focus:outline-none focus:border-accent-blue/50 focus:ring-1 focus:ring-accent-blue/25"
				>
					{#each data.categories as cat}
						<option value={cat}>{cat}</option>
					{/each}
				</select>
			{/if}
		</div>

		<!-- Preview -->
		{#if name}
			<div class="bg-bg-secondary border border-border rounded-lg p-3">
				<span class="text-[10px] uppercase tracking-wider text-text-secondary">Will create</span>
				<p class="text-sm font-mono text-text-primary mt-0.5">
					.claude/agents/{effectiveCategory}/{name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md
				</p>
			</div>
		{/if}

		<!-- Actions -->
		<div class="flex items-center gap-3 pt-2">
			<button
				type="submit"
				class="px-4 py-2 text-sm rounded-md bg-accent-blue text-white hover:bg-accent-blue/80 transition-colors"
			>
				Create Agent
			</button>
			<a
				href="/agents"
				class="px-4 py-2 text-sm rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
			>
				Cancel
			</a>
		</div>
	</form>
</div>
