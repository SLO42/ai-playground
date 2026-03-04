<script lang="ts">
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let projectName = $state('my-new-project');
	let projectDir = $state(`${data.defaultWorkspace}\\${projectName}`);
	let selectedTemplate = $state('sveltekit');
	let description = $state('');
	let initGit = $state(true);
	let createGithub = $state(false);
	let primaryModel = $state('GPT-OSS 20B (local)');
	let escalation = $state('Claude Sonnet 4.6');
	let memoryNamespace = $state('my-new-project');
	let isolateMemory = $state(true);
	let sharePatterns = $state(true);
	let maxAgents = $state(8);
	let topology = $state('hierarchical-mesh');

	let serviceToggles = $state(data.autoStartServices.map((s) => s.default));

	$effect(() => {
		projectDir = `${data.defaultWorkspace}\\${projectName}`;
		memoryNamespace = projectName;
	});

	const willCreate = $derived([
		'CLAUDE.md',
		'.mcp.json',
		'package.json',
		'svelte.config.js',
		'.env.example',
		'.gitignore'
	]);
</script>

<div class="space-y-6">
	<!-- Header -->
	<div>
		<h1 class="text-xl font-bold text-text-primary">New Project</h1>
		<p class="text-sm text-text-secondary mt-1">
			Create a new project or import an existing one into the OpenClaw ecosystem
		</p>
	</div>

	<!-- Tab Nav -->
	<div class="flex gap-2">
		<a
			href="/projects/create"
			class="px-4 py-2 text-sm bg-accent-blue text-white rounded-lg"
		>
			+ Create New Project
		</a>
		<a
			href="/projects/import"
			class="px-4 py-2 text-sm border border-border text-text-secondary rounded-lg hover:text-text-primary hover:bg-bg-tertiary transition-colors"
		>
			Import Existing
		</a>
	</div>

	<!-- Main Form Grid -->
	<div class="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
		<!-- Left: Form -->
		<div class="space-y-5">
			<!-- Project Name -->
			<div>
				<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Project Name</label>
				<input
					type="text"
					bind:value={projectName}
					class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
			</div>

			<!-- Project Directory -->
			<div>
				<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Project Directory</label>
				<input
					type="text"
					bind:value={projectDir}
					class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary font-mono focus:outline-none focus:border-accent-blue"
				/>
				<p class="text-xs text-accent-green mt-1">Default workspace: {data.defaultWorkspace} (change in Settings &gt; General)</p>
			</div>

			<!-- Template Selection -->
			<div>
				<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Project Template</label>
				<div class="grid grid-cols-2 md:grid-cols-3 gap-2">
					{#each data.templates as tpl}
						<button
							class="text-left border rounded-lg p-3 transition-colors
								{selectedTemplate === tpl.id
								? 'border-accent-blue bg-accent-blue/10'
								: 'border-border bg-bg-secondary hover:border-border/80'}"
							onclick={() => (selectedTemplate = tpl.id)}
						>
							<div class="flex items-center gap-2 mb-1">
								<span>{tpl.icon}</span>
								<span class="text-sm font-medium text-text-primary">{tpl.name}</span>
							</div>
							<p class="text-[10px] text-text-secondary">{tpl.description}</p>
						</button>
					{/each}
				</div>
			</div>

			<!-- Description -->
			<div>
				<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Description (optional)</label>
				<input
					type="text"
					bind:value={description}
					placeholder="A dashboard for managing AI agent workflows..."
					class="w-full bg-bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent-blue"
				/>
			</div>

			<!-- Version Control -->
			<div>
				<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Version Control</label>
				<div class="space-y-2">
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="checkbox" bind:checked={initGit} class="accent-accent-blue" />
						<span class="text-sm text-text-primary">Initialize git repository</span>
					</label>
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="checkbox" bind:checked={createGithub} class="accent-accent-blue" />
						<span class="text-sm text-text-primary">Create GitHub repository (private)</span>
					</label>
				</div>
			</div>
		</div>

		<!-- Right: OpenClaw Integration -->
		<div class="space-y-5">
			<div class="bg-bg-secondary border border-border rounded-lg p-4 space-y-4">
				<div>
					<h3 class="text-sm font-bold text-text-primary mb-1">OpenClaw Integration</h3>
					<p class="text-xs text-text-secondary">Configure how this project connects to the OpenClaw ecosystem</p>
				</div>

				<!-- Auto-Start Services -->
				<div>
					<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Auto-Start Services</label>
					{#each data.autoStartServices as svc, i}
						<div class="flex items-center justify-between py-2 border-b border-border last:border-0">
							<div>
								<p class="text-sm text-text-primary">{svc.name}</p>
								<p class="text-[10px] text-text-secondary">{svc.description}</p>
							</div>
							<button
								class="w-10 h-5 rounded-full transition-colors {serviceToggles[i] ? 'bg-accent-green' : 'bg-bg-tertiary'}"
								onclick={() => (serviceToggles[i] = !serviceToggles[i])}
							>
								<div
									class="w-4 h-4 bg-white rounded-full transition-transform {serviceToggles[i] ? 'translate-x-5' : 'translate-x-0.5'}"
								></div>
							</button>
						</div>
					{/each}
				</div>

				<!-- Model Routing -->
				<div>
					<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Model Routing</label>
					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<span class="text-xs text-text-secondary">Primary Model</span>
							<span class="text-xs font-mono text-text-primary bg-bg-tertiary px-2 py-1 rounded">{primaryModel}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-xs text-text-secondary">Escalation</span>
							<span class="text-xs font-mono text-text-primary bg-bg-tertiary px-2 py-1 rounded">{escalation}</span>
						</div>
					</div>
				</div>

				<!-- Memory & Context -->
				<div>
					<label class="block text-xs text-text-secondary uppercase tracking-wider mb-2">Memory & Context</label>
					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<span class="text-xs text-text-secondary">Memory Namespace</span>
							<span class="text-xs font-mono text-text-primary bg-bg-tertiary px-2 py-1 rounded">{memoryNamespace}</span>
						</div>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={isolateMemory} class="accent-accent-blue" />
							<span class="text-xs text-text-primary">Isolate memory from other projects</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={sharePatterns} class="accent-accent-blue" />
							<span class="text-xs text-text-primary">Share learned patterns with global memory</span>
						</label>
					</div>
				</div>

				<!-- Agent Config -->
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<span class="text-xs text-text-secondary">Max Concurrent Agents</span>
						<span class="text-xs font-mono text-text-primary bg-bg-tertiary px-2 py-1 rounded">{maxAgents}</span>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-xs text-text-secondary">Topology</span>
						<span class="text-xs font-mono text-text-primary bg-bg-tertiary px-2 py-1 rounded">{topology}</span>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Will Create Preview -->
	<div class="bg-bg-secondary border border-border rounded-lg p-4">
		<p class="text-xs text-text-secondary mb-2">Will create:</p>
		<div class="flex flex-wrap gap-2">
			{#each willCreate as file}
				<span class="text-xs font-mono px-2 py-1 bg-accent-blue/20 text-accent-blue rounded">{file}</span>
			{/each}
		</div>
	</div>

	<!-- Actions -->
	<div class="flex items-center justify-end gap-3">
		<a href="/projects" class="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">
			Cancel
		</a>
		<button class="px-6 py-2 text-sm bg-accent-blue text-white rounded-lg hover:bg-accent-blue/90 transition-colors">
			Create Project
		</button>
	</div>
</div>
