<script lang="ts">
	import type { PageData } from './$types.js';

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
