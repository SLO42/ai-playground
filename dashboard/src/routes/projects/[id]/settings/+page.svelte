<script lang="ts">
	import type { PageData } from './$types.js';
	import type { ProjectEnvironment } from '$lib/types/projects.js';

	let { data }: { data: PageData } = $props();

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

	// Environments
	let environments = $state<ProjectEnvironment[]>(data.environments ?? []);
	let showEnvForm = $state(false);
	let editingEnv = $state<string | null>(null);
	let envName = $state('');
	let envBranch = $state('');
	let envUrl = $state('');
	let envStatus = $state<'active' | 'inactive' | 'deploying'>('active');
	let envVariables = $state<Array<{ key: string; value: string }>>([]);
	let revealedVars = $state<Set<string>>(new Set());
	let envSaving = $state(false);
	let envMessage = $state('');

	function resetEnvForm() {
		envName = '';
		envBranch = '';
		envUrl = '';
		envStatus = 'active';
		envVariables = [];
		editingEnv = null;
		showEnvForm = false;
	}

	function editEnvironment(env: ProjectEnvironment) {
		editingEnv = env.name;
		envName = env.name;
		envBranch = env.branch ?? '';
		envUrl = env.url ?? '';
		envStatus = env.status;
		envVariables = Object.entries(env.variables).map(([key, value]) => ({ key, value }));
		showEnvForm = true;
	}

	function addEnvVariable() {
		envVariables = [...envVariables, { key: '', value: '' }];
	}

	function removeEnvVariable(idx: number) {
		envVariables = envVariables.filter((_, i) => i !== idx);
	}

	function toggleReveal(envName: string) {
		const next = new Set(revealedVars);
		if (next.has(envName)) {
			next.delete(envName);
		} else {
			next.add(envName);
		}
		revealedVars = next;
	}

	async function saveEnvironment() {
		envSaving = true;
		envMessage = '';
		try {
			const variables: Record<string, string> = {};
			for (const v of envVariables) {
				if (v.key.trim()) variables[v.key.trim()] = v.value;
			}
			const res = await fetch(`/api/projects/${data.projectId}/environments`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: envName.trim().toLowerCase(),
					branch: envBranch || undefined,
					url: envUrl || undefined,
					status: envStatus,
					variables
				})
			});
			const result = await res.json();
			if (res.ok) {
				// Refresh environments list
				const listRes = await fetch(`/api/projects/${data.projectId}/environments`);
				if (listRes.ok) {
					const listData = await listRes.json();
					environments = listData.environments;
				}
				resetEnvForm();
				envMessage = 'Environment saved';
				setTimeout(() => (envMessage = ''), 2500);
			} else {
				envMessage = result.error ?? 'Save failed';
			}
		} catch {
			envMessage = 'Network error';
		} finally {
			envSaving = false;
		}
	}

	async function deleteEnvironment(envNameToDelete: string) {
		try {
			const res = await fetch(`/api/projects/${data.projectId}/environments`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: envNameToDelete })
			});
			if (res.ok) {
				environments = environments.filter((e) => e.name !== envNameToDelete);
			}
		} catch {
			// silent
		}
	}

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
		} finally {
			saving = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-bold text-text-primary">Project Settings</h1>
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
		</div>
	</div>

	<!-- Environment Variables -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Environment Variables</h2>
		<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden">
			{#each data.envVars as env}
				<div class="flex items-center gap-4 px-4 py-3 border-b border-border last:border-0">
					<span class="text-sm font-mono text-accent-cyan w-48">{env.key}</span>
					<span class="text-sm font-mono text-text-primary flex-1">{env.value}</span>
					<span class="text-xs text-text-secondary">{env.source}</span>
				</div>
			{/each}
		</div>
		<p class="text-[11px] text-text-secondary mt-1">Environment variables are read from .env and cannot be edited here for security.</p>
	</div>

	<!-- Environments -->
	<div>
		<div class="flex items-center justify-between mb-3">
			<h2 class="text-xs text-text-secondary uppercase tracking-wider">Environments</h2>
			<div class="flex items-center gap-2">
				{#if envMessage}
					<span class="text-xs {envMessage === 'Environment saved' ? 'text-accent-green' : 'text-accent-red'}">{envMessage}</span>
				{/if}
				<button
					onclick={() => { resetEnvForm(); showEnvForm = !showEnvForm; }}
					class="px-3 py-1 text-xs font-medium text-accent-blue border border-accent-blue/30 rounded-lg hover:bg-accent-blue/10 transition-colors"
				>
					{showEnvForm ? 'Cancel' : '+ Add Environment'}
				</button>
			</div>
		</div>

		{#if showEnvForm}
			<div class="bg-bg-secondary border border-accent-blue/30 rounded-lg p-4 mb-3 space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<div class="flex items-center gap-3">
						<span class="text-sm text-text-secondary w-20">Name</span>
						<input
							type="text"
							bind:value={envName}
							placeholder="staging"
							disabled={editingEnv !== null}
							class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue disabled:opacity-50"
						/>
					</div>
					<div class="flex items-center gap-3">
						<span class="text-sm text-text-secondary w-20">Status</span>
						<select
							bind:value={envStatus}
							class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
						>
							<option value="active">Active</option>
							<option value="inactive">Inactive</option>
							<option value="deploying">Deploying</option>
						</select>
					</div>
					<div class="flex items-center gap-3">
						<span class="text-sm text-text-secondary w-20">Branch</span>
						<input
							type="text"
							bind:value={envBranch}
							placeholder="main"
							class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
						/>
					</div>
					<div class="flex items-center gap-3">
						<span class="text-sm text-text-secondary w-20">URL</span>
						<input
							type="text"
							bind:value={envUrl}
							placeholder="https://staging.example.com"
							class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
						/>
					</div>
				</div>

				<!-- Variables -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<span class="text-xs text-text-secondary uppercase tracking-wider">Variables</span>
						<button
							onclick={addEnvVariable}
							class="text-xs text-accent-blue hover:underline"
						>+ Add Variable</button>
					</div>
					{#each envVariables as variable, idx}
						<div class="flex items-center gap-2 mb-1.5">
							<input
								type="text"
								bind:value={variable.key}
								placeholder="KEY"
								class="w-40 bg-bg-tertiary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-blue"
							/>
							<input
								type="text"
								bind:value={variable.value}
								placeholder="value"
								class="flex-1 bg-bg-tertiary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:outline-none focus:border-accent-blue"
							/>
							<button
								onclick={() => removeEnvVariable(idx)}
								class="text-xs text-accent-red hover:underline shrink-0"
							>Remove</button>
						</div>
					{/each}
				</div>

				<div class="flex justify-end">
					<button
						onclick={saveEnvironment}
						disabled={envSaving || !envName.trim()}
						class="px-4 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-lg hover:bg-accent-blue/80 transition-colors disabled:opacity-50"
					>
						{envSaving ? 'Saving...' : editingEnv ? 'Update Environment' : 'Create Environment'}
					</button>
				</div>
			</div>
		{/if}

		{#if environments.length > 0}
			<div class="bg-bg-secondary border border-border rounded-lg overflow-hidden divide-y divide-border">
				{#each environments as env}
					<div class="px-4 py-3">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<span class="w-2 h-2 rounded-full {env.status === 'active' ? 'bg-accent-green' : env.status === 'deploying' ? 'bg-accent-yellow' : 'bg-text-secondary/40'}"></span>
								<span class="text-sm font-medium text-text-primary font-mono">{env.name}</span>
								<span class="text-[10px] px-1.5 py-0.5 rounded font-medium {env.status === 'active' ? 'bg-accent-green/20 text-accent-green' : env.status === 'deploying' ? 'bg-accent-yellow/20 text-accent-yellow' : 'bg-bg-tertiary text-text-secondary'}">
									{env.status}
								</span>
							</div>
							<div class="flex items-center gap-2">
								<button
									onclick={() => editEnvironment(env)}
									class="text-xs text-accent-blue hover:underline"
								>Edit</button>
								<button
									onclick={() => deleteEnvironment(env.name)}
									class="text-xs text-accent-red hover:underline"
								>Delete</button>
							</div>
						</div>
						<div class="flex items-center gap-4 mt-1.5 text-xs text-text-secondary">
							{#if env.branch}
								<span>Branch: <span class="font-mono text-text-primary">{env.branch}</span></span>
							{/if}
							{#if env.url}
								<a href={env.url} target="_blank" rel="noopener noreferrer" class="text-accent-blue hover:underline truncate max-w-xs">{env.url}</a>
							{/if}
							{#if env.lastDeployedAt}
								<span>Deployed: {env.lastDeployedAt}</span>
							{/if}
							{#if env.lastDeployedVersion}
								<span class="font-mono">{env.lastDeployedVersion}</span>
							{/if}
						</div>
						{#if Object.keys(env.variables).length > 0}
							<div class="mt-2">
								<button
									onclick={() => toggleReveal(env.name)}
									class="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
								>
									{revealedVars.has(env.name) ? 'Hide' : 'Show'} {Object.keys(env.variables).length} variable{Object.keys(env.variables).length === 1 ? '' : 's'}
								</button>
								{#if revealedVars.has(env.name)}
									<div class="mt-1 space-y-0.5">
										{#each Object.entries(env.variables) as [key, value]}
											<div class="flex items-center gap-2 text-xs">
												<span class="font-mono text-accent-cyan w-36 truncate">{key}</span>
												<span class="font-mono text-text-secondary">{value}</span>
											</div>
										{/each}
									</div>
								{:else}
									<div class="mt-1 space-y-0.5">
										{#each Object.keys(env.variables) as key}
											<div class="flex items-center gap-2 text-xs">
												<span class="font-mono text-accent-cyan w-36 truncate">{key}</span>
												<span class="font-mono text-text-secondary">••••••••</span>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{:else if !showEnvForm}
			<div class="bg-bg-secondary border border-border rounded-lg p-6 text-center">
				<p class="text-sm text-text-secondary">No environments configured. Add one to manage deployment targets.</p>
			</div>
		{/if}
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
				</div>
			</div>
		</div>
	</div>

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
		</div>
	</div>
</div>
