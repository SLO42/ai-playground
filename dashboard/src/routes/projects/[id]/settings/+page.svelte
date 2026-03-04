<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">Project Settings</h1>
		<p class="text-sm text-text-secondary mt-1">Configuration scoped to ai-playground</p>
	</div>

	<!-- General -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">General</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Project Name</span>
				<input
					type="text"
					value={data.general.name}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Project Path</span>
				<input
					type="text"
					value={data.general.path}
					readonly
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono opacity-60"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Default Branch</span>
				<input
					type="text"
					value={data.general.branch}
					class="flex-1 bg-bg-tertiary border border-border rounded px-3 py-1.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
			</div>
			<div class="flex items-center gap-4">
				<span class="text-sm text-text-secondary w-32">Description</span>
				<span class="text-sm text-text-primary">{data.general.description}</span>
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
	</div>

	<!-- Build & Development -->
	<div>
		<h2 class="text-xs text-text-secondary uppercase tracking-wider mb-3">Build & Development</h2>
		<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-3">
			{#each Object.entries(data.build) as [key, cmd]}
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
					<span class="text-sm font-mono font-bold text-text-primary">{data.agentConfig.topology}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-sm text-text-secondary">Max Agents</span>
					<span class="text-sm font-mono font-bold text-text-primary">{data.agentConfig.maxAgents}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-sm text-text-secondary">Memory Backend</span>
					<span class="text-sm font-mono font-bold text-text-primary">{data.agentConfig.memoryBackend}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-sm text-text-secondary">Consensus</span>
					<span class="text-sm font-mono font-bold text-text-primary">{data.agentConfig.consensus}</span>
				</div>
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
