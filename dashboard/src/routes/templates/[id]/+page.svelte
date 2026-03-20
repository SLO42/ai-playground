<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
	const t = $derived(data.template);
</script>

<PageHeader title="{t.icon} {t.name}" subtitle={t.description}>
	{#snippet actions()}
		<a href="/templates" class="text-sm text-accent-cyan hover:underline">&larr; Back to Templates</a>
	{/snippet}
</PageHeader>

<div class="space-y-6">
	<!-- Badges -->
	<div class="flex flex-wrap gap-2">
		{#if t.language}
			<span class="px-2 py-0.5 rounded text-xs font-medium bg-accent-cyan/15 text-accent-cyan">{t.language}</span>
		{/if}
		{#each t.tags as tag}
			<span class="px-2 py-0.5 rounded text-xs font-medium bg-bg-tertiary text-text-secondary">{tag}</span>
		{/each}
	</div>

	<!-- Parameters -->
	{#if t.params && t.params.length > 0}
		<section>
			<h2 class="text-sm font-semibold text-text-primary mb-3">Parameters</h2>
			<div class="rounded-lg border border-border-primary bg-bg-secondary overflow-hidden">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border-primary text-text-secondary text-left">
							<th class="px-4 py-2 font-medium">Name</th>
							<th class="px-4 py-2 font-medium">Type</th>
							<th class="px-4 py-2 font-medium">Default</th>
							<th class="px-4 py-2 font-medium">Description</th>
						</tr>
					</thead>
					<tbody>
						{#each t.params as param}
							<tr class="border-b border-border-primary last:border-0">
								<td class="px-4 py-2 font-mono text-text-primary">{param.key}</td>
								<td class="px-4 py-2 text-text-secondary">{param.type}{#if param.options} ({param.options.join(', ')}){/if}</td>
								<td class="px-4 py-2 font-mono text-accent-cyan">{String(param.default)}</td>
								<td class="px-4 py-2 text-text-secondary">{param.description ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- File Structure -->
	<section>
		<h2 class="text-sm font-semibold text-text-primary mb-3">File Structure</h2>
		<pre class="rounded-lg border border-border-primary bg-bg-secondary p-4 text-sm font-mono text-text-secondary overflow-x-auto">{data.fileTree.join('\n')}</pre>
	</section>

	<!-- Actions -->
	<div class="flex gap-3">
		<a
			href="/projects/create?template={t.id}"
			class="px-4 py-2 rounded-lg bg-accent-cyan text-black text-sm font-medium hover:opacity-90 transition-opacity"
		>
			Create Project
		</a>
		<a
			href="/projects/create-ai"
			class="px-4 py-2 rounded-lg border border-border-primary text-text-primary text-sm font-medium hover:bg-bg-tertiary transition-colors"
		>
			Create with AI
		</a>
	</div>
</div>
