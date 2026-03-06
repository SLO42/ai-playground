<script lang="ts">
	let {
		loading = false,
		onsubmit,
	}: {
		loading: boolean;
		onsubmit: (hook: { name: string; type: string; description: string; command: string }) => void;
	} = $props();

	let newName = $state('');
	let newType = $state('pre');
	let newDescription = $state('');
	let newCommand = $state('');
	let announcement = $state('');

	const hookTypes = ['pre', 'post', 'lifecycle', 'routing', 'learning'];

	function handleSubmit() {
		if (!newName.trim()) return;
		onsubmit({
			name: newName.trim(),
			type: newType,
			description: newDescription.trim(),
			command: newCommand.trim()
		});
		newName = '';
		newDescription = '';
		newCommand = '';
		newType = 'pre';
		announcement = 'Hook added successfully.';
		setTimeout(() => { announcement = ''; }, 3000);
	}
</script>

<form
	onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
	class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3"
	aria-label="Add new hook"
>
	<h2 class="text-sm font-bold text-text-primary">New Hook</h2>
	<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
		<div>
			<label for="hook-name" class="text-xs text-text-secondary block mb-1">Name <span aria-hidden="true">*</span></label>
			<input
				id="hook-name"
				type="text"
				bind:value={newName}
				placeholder="e.g. pre-build"
				required
				aria-required="true"
				class="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue"
			/>
		</div>
		<div>
			<label for="hook-type" class="text-xs text-text-secondary block mb-1">Type</label>
			<select
				id="hook-type"
				bind:value={newType}
				class="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent-blue"
			>
				{#each hookTypes as t}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</div>
		<div class="md:col-span-2">
			<label for="hook-desc" class="text-xs text-text-secondary block mb-1">Description</label>
			<input
				id="hook-desc"
				type="text"
				bind:value={newDescription}
				placeholder="What does this hook do?"
				class="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue"
			/>
		</div>
		<div class="md:col-span-2">
			<label for="hook-cmd" class="text-xs text-text-secondary block mb-1">Command</label>
			<input
				id="hook-cmd"
				type="text"
				bind:value={newCommand}
				placeholder="e.g. npm run lint"
				class="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-blue font-mono"
			/>
		</div>
	</div>
	<div class="flex justify-end">
		<button
			type="submit"
			disabled={loading || !newName.trim()}
			class="px-4 py-2 text-sm bg-accent-green text-white rounded-lg hover:bg-accent-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
		>
			{loading ? 'Adding...' : 'Add Hook'}
		</button>
	</div>
</form>
<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">{announcement}</div>
