<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/stores';
	import { notifications } from '$lib/stores/notifications.js';
	import { apiPut } from '$lib/api-client.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let editing = $state(false);
	let editContent = $state('');
	let saving = $state(false);
	let copied = $state(false);

	let validationErrors = $derived(validateConfig(editContent, data.language));
	let hasErrors = $derived(validationErrors.length > 0);

	function validateConfig(content: string, language: string): string[] {
		const errors: string[] = [];
		if (!content.trim()) {
			errors.push('Config content cannot be empty.');
			return errors;
		}
		if (language === 'json') {
			try {
				JSON.parse(content);
			} catch (e: unknown) {
				const msg = e instanceof SyntaxError ? e.message : 'Invalid JSON';
				errors.push(`JSON syntax error: ${msg}`);
			}
		}
		if (language === 'yaml') {
			const lines = content.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line.includes('\t')) {
					errors.push(`Line ${i + 1}: YAML must not contain tabs — use spaces for indentation.`);
					break;
				}
			}
			// Check for duplicate top-level keys
			const topKeys: string[] = [];
			for (const line of lines) {
				const match = line.match(/^([a-zA-Z_][\w.-]*):/);
				if (match) {
					if (topKeys.includes(match[1])) {
						errors.push(`Duplicate top-level key: "${match[1]}".`);
					}
					topKeys.push(match[1]);
				}
			}
		}
		// Check for lines that look like numeric values are out of typical port range
		const portMatch = content.match(/port\s*[:=]\s*(\d+)/i);
		if (portMatch) {
			const port = parseInt(portMatch[1], 10);
			if (port < 1 || port > 65535) {
				errors.push(`Invalid port number ${port} — must be between 1 and 65535.`);
			}
		}
		return errors;
	}

	function startEditing() {
		editContent = data.content;
		editing = true;
	}

	function cancelEditing() {
		editing = false;
		editContent = '';
	}

	async function saveConfig() {
		if (hasErrors) return;
		saving = true;
		try {
			const id = $page.params.id;
			const result = await apiPut<{ success: boolean; message: string }>(
				`/api/services/${id}/config`,
				{ content: editContent },
				{ silent: true }
			);
			if (result?.success) {
				notifications.push('success', 'Config Saved', result.message);
				editing = false;
				await invalidateAll();
			} else {
				notifications.push('error', 'Save Failed', result?.message ?? 'Unknown error');
			}
		} catch (e: unknown) {
			const err = e as { message?: string };
			notifications.push('error', 'Save Failed', err.message ?? 'Failed to save config');
		} finally {
			saving = false;
		}
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(editing ? editContent : data.content);
			copied = true;
			setTimeout(() => { copied = false; }, 2000);
		} catch {
			// fallback
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (editing && !saving && !hasErrors) saveConfig();
		}
		if (e.key === 'Escape' && editing) {
			cancelEditing();
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="space-y-4">
	<!-- Config Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<span class="text-xs text-text-secondary font-mono">{data.path}</span>
			<span class="text-xs text-text-secondary px-1.5 py-0.5 bg-bg-tertiary rounded">{data.language}</span>
		</div>
		<div class="flex items-center gap-2">
			<button
				onclick={copyToClipboard}
				class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors"
			>
				{copied ? 'Copied!' : 'Copy'}
			</button>
			{#if editing}
				<button
					onclick={cancelEditing}
					class="px-2 py-1 text-xs text-text-secondary border border-border rounded hover:bg-bg-tertiary transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={saveConfig}
					disabled={saving || hasErrors}
					class="px-2 py-1 text-xs text-accent-green border border-accent-green/30 rounded hover:bg-accent-green/10 transition-colors disabled:opacity-50"
				>
					{saving ? 'Saving...' : 'Save'}
				</button>
			{:else}
				<button
					onclick={startEditing}
					class="px-2 py-1 text-xs text-accent-cyan border border-accent-cyan/30 rounded hover:bg-accent-cyan/10 transition-colors"
				>
					Edit
				</button>
			{/if}
		</div>
	</div>

	<!-- Config Editor / Viewer -->
	{#if editing}
		<textarea
			bind:value={editContent}
			class="w-full bg-[#0d1117] border rounded-lg p-4 font-mono text-xs leading-relaxed text-gray-300 resize-y min-h-[calc(100vh-16rem)] focus:outline-none {hasErrors ? 'border-accent-red/60 focus:border-accent-red' : 'border-accent-cyan/30 focus:border-accent-cyan/60'}"
			spellcheck="false"
		></textarea>
		{#if hasErrors}
			<div class="space-y-1">
				{#each validationErrors as err}
					<p class="text-xs text-accent-red flex items-start gap-1.5">
						<span class="shrink-0 mt-px">&#x26A0;</span>
						<span>{err}</span>
					</p>
				{/each}
			</div>
		{/if}
		<p class="text-xs text-text-secondary">
			Press <kbd class="font-mono bg-bg-tertiary px-1 rounded">Ctrl+S</kbd> to save,
			<kbd class="font-mono bg-bg-tertiary px-1 rounded">Esc</kbd> to cancel.
		</p>
	{:else}
		<div class="bg-[#0d1117] border border-border rounded-lg p-4 overflow-auto max-h-[calc(100vh-16rem)] font-mono text-xs leading-relaxed">
			{#if data.content}
				{#each data.content.split('\n') as line, i}
					<div class="hover:bg-white/5 px-1 {line.startsWith('#') || line.startsWith('//') ? 'text-gray-500' : 'text-gray-300'}">
						<span class="text-gray-600 select-none mr-3">{String(i + 1).padStart(4)}</span>{line}
					</div>
				{/each}
			{:else}
				<p class="text-gray-500">Config file is empty</p>
			{/if}
		</div>
		<p class="text-xs text-text-secondary">
			Click <strong>Edit</strong> to modify this config, or edit directly at
			<code class="font-mono bg-bg-tertiary px-1 rounded">{data.path}</code>
		</p>
	{/if}
</div>
