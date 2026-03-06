<script lang="ts">
	import { enhance } from '$app/forms';

	interface PageData {
		filename: string;
		content: string | null;
		frontmatter: Record<string, string> | null;
		body: string | null;
		categories: string[];
		error: string | null;
	}

	let { data, form }: { data: PageData; form: { success?: boolean; error?: string } | null } = $props();

	let mode = $state<'view' | 'edit'>('view');
	let editContent = $state(data.content ?? '');
	let showDeleteConfirm = $state(false);
	let saving = $state(false);

	const agentName = $derived(data.frontmatter?.name ?? data.filename?.split('/').pop()?.replace('.md', '') ?? 'Unknown');
	const category = $derived(data.filename?.split('/')[0] ?? 'uncategorized');

	function startEdit() {
		editContent = data.content ?? '';
		mode = 'edit';
	}

	function cancelEdit() {
		editContent = data.content ?? '';
		mode = 'view';
	}

	$effect(() => {
		if (form?.success) {
			mode = 'view';
			saving = false;
		}
	});
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-start justify-between gap-4">
		<div>
			<div class="flex items-center gap-2 mb-1">
				<a href="/agents" class="text-text-secondary hover:text-text-primary text-sm transition-colors">
					Agents
				</a>
				<span class="text-text-secondary text-xs">/</span>
				<span class="text-text-secondary text-sm">{category}</span>
				<span class="text-text-secondary text-xs">/</span>
			</div>
			<h1 class="type-page-title text-text-primary">{agentName}</h1>
			{#if data.frontmatter?.description}
				<p class="text-sm text-text-secondary mt-1">{data.frontmatter.description}</p>
			{/if}
		</div>

		{#if !data.error}
			<div class="flex items-center gap-2 shrink-0">
				{#if mode === 'view'}
					<button
						class="px-3 py-1.5 text-xs rounded-md border border-border bg-bg-secondary text-text-primary hover:bg-bg-tertiary transition-colors"
						onclick={startEdit}
					>
						Edit
					</button>
					<button
						class="px-3 py-1.5 text-xs rounded-md border border-accent-red/30 bg-accent-red/10 text-accent-red hover:bg-accent-red/20 transition-colors"
						onclick={() => (showDeleteConfirm = true)}
					>
						Delete
					</button>
				{:else}
					<button
						class="px-3 py-1.5 text-xs rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
						onclick={cancelEdit}
					>
						Cancel
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if data.error}
		<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-6 text-center">
			<p class="text-accent-red text-sm">{data.error}</p>
			<a href="/agents" class="text-accent-blue text-xs mt-2 inline-block hover:underline">
				Back to agents
			</a>
		</div>
	{:else}
		<!-- Metadata Cards -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
			{#if data.frontmatter?.type}
				<div class="bg-bg-secondary border border-border rounded-lg p-3">
					<span class="text-[10px] uppercase tracking-wider text-text-secondary">Type</span>
					<p class="text-sm font-mono text-text-primary mt-0.5">{data.frontmatter.type}</p>
				</div>
			{/if}
			<div class="bg-bg-secondary border border-border rounded-lg p-3">
				<span class="text-[10px] uppercase tracking-wider text-text-secondary">Category</span>
				<p class="text-sm font-mono text-text-primary mt-0.5">{category}</p>
			</div>
			{#if data.frontmatter?.priority}
				<div class="bg-bg-secondary border border-border rounded-lg p-3">
					<span class="text-[10px] uppercase tracking-wider text-text-secondary">Priority</span>
					<p class="text-sm font-mono text-text-primary mt-0.5">{data.frontmatter.priority}</p>
				</div>
			{/if}
			{#if data.frontmatter?.color}
				<div class="bg-bg-secondary border border-border rounded-lg p-3">
					<span class="text-[10px] uppercase tracking-wider text-text-secondary">Color</span>
					<div class="flex items-center gap-2 mt-0.5">
						<span
							class="w-3 h-3 rounded-full border border-border"
							style="background-color: {data.frontmatter.color}"
						></span>
						<span class="text-sm font-mono text-text-primary">{data.frontmatter.color}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Source Viewer / Editor -->
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			<div class="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-tertiary">
				<div class="flex items-center gap-3">
					<span class="text-xs font-mono text-text-secondary">{data.filename}</span>
					{#if mode === 'edit'}
						<span class="px-2 py-0.5 text-[10px] rounded-full bg-accent-yellow/15 text-accent-yellow border border-accent-yellow/30">
							editing
						</span>
					{/if}
				</div>
				{#if mode === 'view'}
					<span class="text-[10px] text-text-secondary">
						{data.content?.split('\n').length ?? 0} lines
					</span>
				{/if}
			</div>

			{#if mode === 'view'}
				<div class="overflow-x-auto">
					<pre class="p-4 text-sm font-mono text-text-primary leading-relaxed whitespace-pre-wrap break-words">{data.content}</pre>
				</div>
			{:else}
				<form method="POST" action="?/save" use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update();
						saving = false;
					};
				}}>
					<textarea
						name="content"
						bind:value={editContent}
						class="w-full min-h-[500px] p-4 text-sm font-mono text-text-primary bg-bg-secondary border-none resize-y
							focus:outline-none focus:ring-0"
						spellcheck="false"
					></textarea>
					<div class="flex items-center justify-between px-4 py-2.5 border-t border-border bg-bg-tertiary">
						<span class="text-[10px] text-text-secondary">
							{editContent.split('\n').length} lines
						</span>
						<button
							type="submit"
							disabled={saving}
							class="px-4 py-1.5 text-xs rounded-md bg-accent-blue text-white hover:bg-accent-blue/80 disabled:opacity-50 transition-colors"
						>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				</form>
			{/if}
		</div>

		{#if form?.error}
			<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-3">
				<p class="text-accent-red text-sm">{form.error}</p>
			</div>
		{/if}

		{#if form?.success}
			<div class="bg-accent-green/10 border border-accent-green/30 rounded-lg p-3">
				<p class="text-accent-green text-sm">Agent saved successfully.</p>
			</div>
		{/if}
	{/if}

	<!-- Delete Confirmation Modal -->
	{#if showDeleteConfirm}
		<div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog">
			<div class="bg-bg-primary border border-border rounded-lg p-6 max-w-md mx-4 space-y-4">
				<h3 class="type-section-title text-text-primary">Delete Agent</h3>
				<p class="text-sm text-text-secondary">
					Are you sure you want to delete <strong class="text-text-primary">{agentName}</strong>?
					This will remove the file <code class="text-xs font-mono">{data.filename}</code> permanently.
				</p>
				<div class="flex justify-end gap-2">
					<button
						class="px-3 py-1.5 text-xs rounded-md border border-border bg-bg-secondary text-text-secondary hover:text-text-primary transition-colors"
						onclick={() => (showDeleteConfirm = false)}
					>
						Cancel
					</button>
					<form method="POST" action="?/delete" use:enhance>
						<button
							type="submit"
							class="px-3 py-1.5 text-xs rounded-md bg-accent-red text-white hover:bg-accent-red/80 transition-colors"
						>
							Delete Permanently
						</button>
					</form>
				</div>
			</div>
		</div>
	{/if}
</div>
