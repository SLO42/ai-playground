<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigating, page } from '$app/stores';
	import { apiDelete } from '$lib/api-client.js';
	import { notifications } from '$lib/stores/notifications.js';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

<<<<<<< HEAD
	// Show error toast when server returns an error
	$effect(() => {
		if (data.error) {
			notifications.push('error', 'Settings Error', data.error);
		}
	});

	// Loading: true during client-side navigation to this page
	let loading = $derived($navigating?.to?.route?.id === '/projects/[id]/settings');

	// Empty: settings loaded successfully but object is null/empty
	let isEmpty = $derived(!data.error && (!data.settings || Object.keys(data.settings).length === 0));

	// Form state — seeded from server data
	let name = $state(data.settings?.name ?? '');
	let description = $state(data.settings?.description ?? '');
	let branch = $state(data.settings?.branch ?? 'main');
	let topology = $state(data.settings?.agentConfig?.topology ?? 'hierarchical-mesh');
	let maxAgents = $state(data.settings?.agentConfig?.maxAgents ?? 15);
	let memoryBackend = $state(data.settings?.agentConfig?.memoryBackend ?? 'hybrid (HNSW + SQLite)');
	let consensus = $state(data.settings?.agentConfig?.consensus ?? 'raft');

	// Feedback states
	let saving = $state(false);
	let saveStatus = $state<'idle' | 'saved' | 'error'>('idle');
	let saveError = $state('');

	// Validation
	let nameError = $derived(name.trim().length === 0 ? 'Project name is required' : name.trim().length > 100 ? 'Name must be 100 characters or fewer' : '');
	let branchError = $derived(branch.trim().length === 0 ? 'Default branch is required' : '');
	let maxAgentsError = $derived(maxAgents < 1 || maxAgents > 100 ? 'Must be between 1 and 100' : '');
	let hasErrors = $derived(!!nameError || !!branchError || !!maxAgentsError);

	// Delete modal
	let showDeleteModal = $state(false);
	let confirmText = $state('');
	let deleting = $state(false);

	async function handleSave() {
		if (hasErrors || saving) return;
		saving = true;
		saveStatus = 'idle';
		saveError = '';

		try {
			const projectId = $page.params.id;
			const res = await fetch(`/api/projects/${projectId}/settings`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					description: description.trim(),
					branch: branch.trim(),
					agentConfig: { topology, maxAgents, memoryBackend, consensus },
					build: data.settings?.build ?? {}
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: 'Unknown error' }));
				saveError = body.error ?? 'Failed to save settings';
				saveStatus = 'error';
				notifications.push('error', 'Save Failed', saveError);
			} else {
				saveStatus = 'saved';
				notifications.push('success', 'Settings Saved', 'Project settings updated successfully.');
				setTimeout(() => { if (saveStatus === 'saved') saveStatus = 'idle'; }, 3000);
			}
		} catch {
			saveError = 'Network error — could not reach server';
			saveStatus = 'error';
			notifications.push('error', 'Save Failed', saveError);
=======
	// General
	let name = $state(data.general.name);
	let description = $state(data.general.description);
	let branch = $state(data.general.branch);

	// Build commands
	let devCommand = $state(data.build.dev.command);
	let devLabel = $state(data.build.dev.label);
	let buildCommand = $state(data.build.build.command);
	let buildLabel = $state(data.build.build.label);
	let testCommand = $state(data.build.test.command);
	let testLabel = $state(data.build.test.label);

	// Agent config
	let topology = $state(data.agentConfig.topology);
	let maxAgents = $state(data.agentConfig.maxAgents);
	let memoryBackend = $state(data.agentConfig.memoryBackend);
	let consensus = $state(data.agentConfig.consensus);

	// Services
	let autoStart = $state(data.autoStart);

	// Save state
	let saving = $state(false);
	let saveMessage = $state('');

	async function saveSettings() {
		saving = true;
		saveMessage = '';
		try {
			const res = await fetch(`/api/projects/${data.projectId}/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					general: { name, description, branch },
					build: {
						dev: { command: devCommand, label: devLabel },
						build: { command: buildCommand, label: buildLabel },
						test: { command: testCommand, label: testLabel }
					},
					agentConfig: { topology, maxAgents, memoryBackend, consensus },
					autoStart
				})
			});
			const result = await res.json();
			if (res.ok) {
				saveMessage = 'Settings saved';
				setTimeout(() => (saveMessage = ''), 2500);
			} else {
				saveMessage = result.error ?? 'Save failed';
			}
		} catch {
			saveMessage = 'Network error';
>>>>>>> worktree-agent-a97739c0
		} finally {
			saving = false;
		}
	}
<<<<<<< HEAD

	async function handleDelete() {
		if (confirmText !== name) return;
		deleting = true;
		const projectId = $page.params.id;
		const ok = await apiDelete(`/api/projects/${projectId}`);
		deleting = false;
		if (ok) {
			showDeleteModal = false;
			notifications.push('success', 'Project Removed', `${name} has been removed.`);
			goto('/projects');
		}
	}
=======
>>>>>>> worktree-agent-a97739c0
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Settings</h1>
<<<<<<< HEAD
			<p class="text-sm text-text-secondary mt-1">Configuration for {data.settings?.name ?? 'this project'}</p>
=======
			<p class="text-sm text-text-secondary mt-1">Configuration scoped to {name}</p>
		</div>
		<div class="flex items-center gap-3">
			{#if saveMessage}
				<span class="text-xs {saveMessage === 'Settings saved' ? 'text-accent-green' : 'text-accent-red'}">{saveMessage}</span>
			{/if}
			<button
				onclick={saveSettings}
				disabled={saving}
				class="px-5 py-2 text-sm font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
			>
				{saving ? 'Saving...' : 'Save Settings'}
			</button>
		</div>
	</div>

	<!-- General -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">General</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Project Name</span>
				<input
					type="text"
					bind:value={name}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Project Path</span>
				<input
					type="text"
					value={data.general.path ?? ''}
					readonly
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono opacity-60"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Default Branch</span>
				<input
					type="text"
					bind:value={branch}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
			</div>
			<div class="flex items-start gap-4">
				<span class="text-sm text-text-secondary w-32 pt-1.5">Description</span>
				<textarea
					bind:value={description}
					rows="2"
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-accent-blue resize-none"
				></textarea>
			</div>
>>>>>>> worktree-agent-a97739c0
		</div>
		{#if !loading && !data.error && !isEmpty}
			<div class="flex items-center gap-3">
				{#if saveStatus === 'saved'}
					<span class="text-sm text-accent-green">Saved</span>
				{/if}
				{#if saveStatus === 'error'}
					<span class="text-sm text-accent-red">{saveError}</span>
				{/if}
				<button
					onclick={handleSave}
					disabled={hasErrors || saving}
					class="px-4 py-2 text-sm rounded-lg transition-colors {hasErrors || saving ? 'bg-bg-tertiary text-text-secondary cursor-not-allowed' : 'bg-accent-blue text-white hover:bg-accent-blue/90'}"
				>
					{saving ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
		{/if}
	</div>

	{#if loading}
		<div class="flex flex-col items-center justify-center py-20 gap-3">
			<div class="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin"></div>
			<p class="text-sm text-text-secondary">Loading settings…</p>
		</div>
	{:else if data.error}
		<div class="bg-accent-red/10 border border-accent-red/30 rounded-lg p-4 text-center">
			<p class="text-sm text-accent-red font-medium mb-1">Failed to load settings</p>
			<p class="text-xs text-text-secondary">{data.error}</p>
		</div>
	{:else if isEmpty}
		<div class="flex flex-col items-center justify-center py-20 gap-3 text-center">
			<div class="w-12 h-12 rounded-full bg-bg-tertiary flex items-center justify-center text-text-secondary text-xl">⚙</div>
			<p class="text-sm text-text-secondary">No settings found for this project.</p>
			<p class="text-xs text-text-secondary">Settings will appear once the project is configured.</p>
		</div>
	{:else}
		<!-- General -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">General</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				<div class="flex items-start gap-4">
					<span class="text-sm text-text-secondary w-32 pt-1.5">Project Name</span>
					<div class="flex-1">
						<input
							type="text"
							bind:value={name}
							class="w-full bg-bg-tertiary border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none {nameError ? 'border-accent-red focus:border-accent-red' : 'border-border focus:border-accent-blue'}"
						/>
						{#if nameError}
							<p class="text-xs text-accent-red mt-1">{nameError}</p>
						{/if}
					</div>
				</div>
<<<<<<< HEAD
				<div class="flex items-center gap-4">
					<span class="text-sm text-text-secondary w-32">Project Path</span>
					<input
						type="text"
						value={data.settings?.path ?? ''}
						readonly
						class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono opacity-60"
					/>
				</div>
				<div class="flex items-start gap-4">
					<span class="text-sm text-text-secondary w-32 pt-1.5">Default Branch</span>
					<div class="flex-1">
						<input
							type="text"
							bind:value={branch}
							class="w-full bg-bg-tertiary border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none {branchError ? 'border-accent-red focus:border-accent-red' : 'border-border focus:border-accent-blue'}"
						/>
						{#if branchError}
							<p class="text-xs text-accent-red mt-1">{branchError}</p>
						{/if}
					</div>
				</div>
				<div class="flex items-start gap-4">
					<span class="text-sm text-text-secondary w-32 pt-1.5">Description</span>
					<textarea
						bind:value={description}
						rows="2"
						class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue resize-none"
					></textarea>
=======
			{/each}
		</div>
		<p class="text-[11px] text-text-secondary mt-1">Environment variables are read from .env and cannot be edited here for security.</p>
	</div>

	<!-- Build & Development -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Build & Development</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Dev Command</span>
				<input
					type="text"
					bind:value={devCommand}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
				<input
					type="text"
					bind:value={devLabel}
					class="w-40 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-blue"
					placeholder="Label"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Build Command</span>
				<input
					type="text"
					bind:value={buildCommand}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
				<input
					type="text"
					bind:value={buildLabel}
					class="w-40 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-blue"
					placeholder="Label"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Test Command</span>
				<input
					type="text"
					bind:value={testCommand}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
				<input
					type="text"
					bind:value={testLabel}
					class="w-40 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-blue"
					placeholder="Label"
				/>
			</div>
		</div>
	</div>

	<!-- Agent Configuration -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Agent Configuration</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="grid grid-cols-2 gap-4">
				<div class="flex items-center justify-between gap-3">
					<span class="text-sm text-text-secondary">Topology</span>
					<select
						bind:value={topology}
						class="bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
					>
						<option value="hierarchical">Hierarchical</option>
						<option value="hierarchical-mesh">Hierarchical Mesh</option>
						<option value="mesh">Mesh</option>
						<option value="adaptive">Adaptive</option>
					</select>
				</div>
				<div class="flex items-center justify-between gap-3">
					<span class="text-sm text-text-secondary">Max Agents</span>
					<input
						type="number"
						min="1"
						max="100"
						bind:value={maxAgents}
						class="w-20 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono text-right focus:outline-none focus:border-accent-blue"
					/>
				</div>
				<div class="flex items-center justify-between gap-3">
					<span class="text-sm text-text-secondary">Memory Backend</span>
					<select
						bind:value={memoryBackend}
						class="bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
					>
						<option value="hybrid (HNSW + SQLite)">Hybrid (HNSW + SQLite)</option>
						<option value="sqlite">SQLite</option>
						<option value="hnsw">HNSW</option>
						<option value="memory">In-Memory</option>
					</select>
				</div>
				<div class="flex items-center justify-between gap-3">
					<span class="text-sm text-text-secondary">Consensus</span>
					<select
						bind:value={consensus}
						class="bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
					>
						<option value="raft">Raft</option>
						<option value="pbft">PBFT</option>
						<option value="none">None</option>
					</select>
>>>>>>> worktree-agent-a97739c0
				</div>
			</div>
		</div>

<<<<<<< HEAD
		<!-- Build & Development -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Build & Development</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
				{#each Object.entries(data.settings?.build ?? {}) as [key, cmd]}
					<div class="flex items-center gap-4">
						<span class="text-sm text-text-secondary w-32 capitalize">{key} Command</span>
						<code class="text-sm font-mono text-text-primary bg-bg-tertiary px-3 py-1.5 rounded flex-1">{cmd.command}</code>
						<span class="text-xs text-text-secondary">{cmd.label}</span>
					</div>
				{/each}
			</div>
		</div>

		<!-- Agent Configuration -->
		<div>
			<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Agent Configuration</h2>
			<div class="bg-bg-secondary border border-border rounded-lg p-4">
				<div class="grid grid-cols-2 gap-4">
					<div class="flex items-center justify-between">
						<span class="text-sm text-text-secondary">Topology</span>
						<select
							bind:value={topology}
							class="bg-bg-tertiary border border-border rounded px-2 py-1 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-blue"
						>
							<option value="hierarchical-mesh">hierarchical-mesh</option>
							<option value="hierarchical">hierarchical</option>
							<option value="mesh">mesh</option>
							<option value="star">star</option>
							<option value="ring">ring</option>
						</select>
					</div>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm text-text-secondary">Max Agents</span>
						<div>
							<input
								type="number"
								bind:value={maxAgents}
								min="1"
								max="100"
								class="w-20 bg-bg-tertiary border rounded px-2 py-1 text-sm font-mono text-text-primary text-right focus:outline-none {maxAgentsError ? 'border-accent-red' : 'border-border focus:border-accent-blue'}"
							/>
							{#if maxAgentsError}
								<p class="text-xs text-accent-red mt-1">{maxAgentsError}</p>
							{/if}
						</div>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-sm text-text-secondary">Memory Backend</span>
						<select
							bind:value={memoryBackend}
							class="bg-bg-tertiary border border-border rounded px-2 py-1 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-blue"
						>
							<option value="hybrid (HNSW + SQLite)">hybrid (HNSW + SQLite)</option>
							<option value="sqlite">sqlite</option>
							<option value="memory">memory</option>
						</select>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-sm text-text-secondary">Consensus</span>
						<select
							bind:value={consensus}
							class="bg-bg-tertiary border border-border rounded px-2 py-1 text-sm font-mono text-text-primary focus:outline-none focus:border-accent-blue"
						>
							<option value="raft">raft</option>
							<option value="pbft">pbft</option>
							<option value="none">none</option>
						</select>
					</div>
				</div>
			</div>
		</div>

		<!-- Danger Zone -->
		<div>
			<h2 class="text-xs text-accent-red uppercase tracking-wider mb-3">Danger Zone</h2>
			<div class="bg-bg-secondary border border-accent-red/30 rounded-lg p-4 flex items-center justify-between">
				<span class="text-sm text-text-secondary">Remove this project from the dashboard. This does not delete files.</span>
				<button
					onclick={() => { showDeleteModal = true; confirmText = ''; }}
					class="px-4 py-2 text-sm border border-accent-red text-accent-red rounded-lg hover:bg-accent-red/10 transition-colors"
				>
					Remove Project
				</button>
			</div>
		</div>
	{/if}
</div>

<!-- Delete Confirmation Modal -->
{#if showDeleteModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onkeydown={(e) => { if (e.key === 'Escape') showDeleteModal = false; }}
		role="dialog"
		aria-modal="true"
		aria-label="Remove Project"
	>
		<div class="absolute inset-0" onclick={() => (showDeleteModal = false)} role="presentation"></div>
		<div class="relative bg-bg-primary border border-border rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
			<h3 class="text-lg font-bold text-text-primary">Remove Project</h3>
			<p class="text-sm text-text-secondary">
				This will remove <strong class="text-text-primary">{name}</strong> from the dashboard. Project files on disk will not be deleted.
			</p>
			<div>
				<label for="confirm-delete" class="text-xs text-text-secondary block mb-1">
					Type <strong class="text-text-primary">{name}</strong> to confirm
				</label>
				<input
					id="confirm-delete"
					type="text"
					bind:value={confirmText}
					placeholder={name}
					class="w-full bg-bg-secondary border border-border rounded px-3 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-red"
				/>
			</div>
			<div class="flex items-center justify-end gap-3 pt-2">
				<button
					onclick={() => (showDeleteModal = false)}
					class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={handleDelete}
					disabled={confirmText !== name || deleting}
					class="px-4 py-2 text-sm rounded-lg transition-colors {confirmText === name && !deleting ? 'bg-accent-red text-white hover:bg-accent-red/90' : 'bg-bg-tertiary text-text-secondary cursor-not-allowed'}"
				>
					{deleting ? 'Removing...' : 'Remove Project'}
				</button>
			</div>
=======
	<!-- Services -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Services</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4">
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm text-text-primary">Auto-start services on project open</p>
					<p class="text-xs text-text-secondary">Automatically start dev server, Ollama, and gateway when this project loads</p>
				</div>
				<label class="relative inline-flex items-center cursor-pointer">
					<input type="checkbox" bind:checked={autoStart} class="sr-only peer" />
					<div class="w-9 h-5 bg-bg-primary peer-checked:bg-accent-blue rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-text-secondary after:peer-checked:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>
				</label>
			</div>
		</div>
	</div>

	<!-- Danger Zone -->
	<div>
		<h2 class="text-xs text-accent-red uppercase tracking-wider mb-3">Danger Zone</h2>
		<div class="bg-bg-secondary border border-accent-red/30 rounded-lg p-4 flex items-center justify-between">
			<span class="text-sm text-text-secondary">Remove this project from the dashboard. This does not delete files.</span>
			<button class="px-4 py-2 text-sm border border-accent-red text-accent-red rounded-lg hover:bg-accent-red/10 transition-colors">
				Remove Project
			</button>
>>>>>>> worktree-agent-a97739c0
		</div>
	</div>
{/if}
