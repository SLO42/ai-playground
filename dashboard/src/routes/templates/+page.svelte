<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let search = $state('');
	let langFilter = $state('');
	let tagFilter = $state('');

	let filtered = $derived(
		data.templates.filter((t) => {
			if (langFilter && t.language !== langFilter) return false;
			if (tagFilter && !t.tags.includes(tagFilter)) return false;
			if (search) {
				const q = search.toLowerCase();
				return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
			}
			return true;
		})
	);

	const langColors: Record<string, string> = {
		TypeScript: 'bg-accent-cyan/20 text-accent-cyan',
		Python: 'bg-accent-green/20 text-accent-green',
		Go: 'bg-accent-blue/20 text-accent-blue',
		Rust: 'bg-accent-red/20 text-accent-red',
		Java: 'bg-accent-yellow/20 text-accent-yellow'
	};

	function langClass(lang: string): string {
		return langColors[lang] ?? 'bg-bg-secondary text-text-secondary';
	}
</script>

<PageHeader title="Templates" subtitle="{filtered.length} of {data.templates.length} templates" />

<div class="flex flex-wrap items-center gap-3 mb-6">
	<input
		type="text"
		placeholder="Search templates..."
		bind:value={search}
		class="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent-cyan w-56"
	/>
	<select
		bind:value={langFilter}
		class="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-cyan"
	>
		<option value="">All languages</option>
		{#each data.languages as lang}
			<option value={lang}>{lang}</option>
		{/each}
	</select>
	<select
		bind:value={tagFilter}
		class="rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-cyan"
	>
		<option value="">All tags</option>
		{#each data.tags as tag}
			<option value={tag}>{tag}</option>
		{/each}
	</select>
</div>

{#if filtered.length === 0}
	<p class="text-text-secondary text-sm">No templates match your filters.</p>
{:else}
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
		{#each filtered as t (t.id)}
			<div class="rounded-lg border border-border bg-bg-secondary p-4 flex flex-col gap-2 hover:border-accent-cyan/50 transition-colors">
				<div class="flex items-center gap-2">
					<span class="text-lg">{t.icon}</span>
					<h3 class="font-semibold text-text-primary">{t.name}</h3>
				</div>
				<p class="text-sm text-text-secondary flex-1">{t.description}</p>
				<div class="flex flex-wrap items-center gap-1.5 mt-1">
					{#if t.language}
						<span class="text-xs px-1.5 py-0.5 rounded {langClass(t.language)}">{t.language}</span>
					{/if}
					{#each t.tags as tag}
						<span class="text-xs px-1.5 py-0.5 rounded bg-bg-primary text-text-secondary">{tag}</span>
					{/each}
					{#if t.params && t.params.length > 0}
						<span class="text-xs text-text-secondary ml-auto">{t.params.length} param{t.params.length > 1 ? 's' : ''}</span>
					{/if}
				</div>
				<a
					href="/projects/create?template={t.id}"
					class="mt-2 inline-flex items-center justify-center rounded-md bg-accent-cyan/15 px-3 py-1.5 text-sm font-medium text-accent-cyan hover:bg-accent-cyan/25 transition-colors"
				>
					Use template
				</a>
			</div>
		{/each}
	</div>
{/if}
